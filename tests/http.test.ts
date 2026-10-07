import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerily, dnsProvider, wellKnownProvider } from '../src/server/index.js';
import type { ArtifactProvider, Provider } from '../src/core/index.js';
import {
  alice,
  bob,
  fakeArtifactProvider,
  fakeDocumentProvider,
  fakeProvider,
  MemoryStorage,
} from './helpers.js';

function fixture(providers: Provider[] = [fakeProvider()]) {
  const app = createVerily({
    storage: new MemoryStorage(),
    providers,
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'Self-hosted Site',
    profileOrigins: ['https://site.test'],
    reportUrl: 'mailto:reports@site.test',
    authenticate: async (r) =>
      r.headers.get('cookie')?.includes('local=alice')
        ? alice
        : r.headers.get('cookie')?.includes('local=bob')
          ? bob
          : undefined,
  });

  const request = (path: string, options: RequestInit = {}) =>
    app.handle(new Request(`https://site.test/api/verily${path}`, options));

  async function connect(visibility = 'unlisted') {
    const start = await request('/sessions', {
      method: 'POST',
      headers: { origin: 'https://site.test', cookie: 'local=alice' },
      body: 'kind=connect',
    });

    assert.equal(start.status, 303);
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await request(`/callback?state=${state}&code=ok`, { headers: { cookie } });
    const path = callback.headers.get('location')!.replace('/api/verily', '');
    const review = await request(path, { headers: { cookie: `${cookie}; local=alice` } });

    assert.match(await review.text(), /value="unlisted" checked/);

    const approve = await request(`${path}/approve`, {
      method: 'POST',
      headers: { origin: 'https://site.test', cookie: `${cookie}; local=alice` },
      body: `visibility=${visibility}&action=approve&localId=attacker&verified=true`,
    });

    assert.equal(approve.status, 200);
    const id = (await app.service.mine(alice))[0]!.id;

    return id;
  }

  return { app, request, connect };
}

test('HTTP full flow and visibility across HTML/JSON, generic secret failures and security headers', async () => {
  const f = fixture(),
    id = await f.connect();

  const expected = await (await f.request('/s/missing')).text();

  for (const path of [
    `/connections/${id}`,
    `/connections/${id}?format=json`,
    `/connections/${id}/badge`,
    '/s/invalid',
  ]) {
    const response = await f.request(path, { headers: { cookie: 'local=alice' } });

    assert.equal(response.status, 404);
    assert.equal(await response.text(), expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  }

  const share = (await f.app.service.share(id, alice))!;
  const response = await f.request(share.url.replace('https://site.test/api/verily', ''));

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Anyone with this link/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const token = share.url.split('/').at(-1)!;

  assert.equal(
    (
      await f.request(`/connections/${id}/disconnect`, {
        method: 'POST',
        headers: { origin: 'https://site.test', Authorization: `Bearer ${token}` },
        body: '{}',
      })
    ).status,
    404,
  );

  await f.app.service.revoke(id, alice);
  assert.equal(await (await f.request(`/s/${token}`)).text(), expected);
});

test('a served page draws the logotype white on its own plate, in either colour scheme', async () => {
  const f = fixture();
  const page = await (await f.request('/verify', { headers: { cookie: 'local=alice' } })).text();
  const logo = page.match(/<svg[^>]*class="logo".*?<\/svg>/s)![0];

  assert.match(logo, /<rect [^>]*fill="#0d1117"\/>/);
  assert.match(logo, /fill="#ffffff"/);
  // Nothing in it follows the page's text colour, which is what changes with the scheme.
  assert.ok(!logo.includes('currentColor'));
});

test('the verify page names what is linked, which is not always an account', async () => {
  const said = async (providers: Provider[]) =>
    (
      await (
        await fixture(providers).request('/verify', { headers: { cookie: 'local=alice' } })
      ).text()
    ).match(/between this \w+ and your ([^<]*)\.<\/p>/)![1];

  assert.equal(await said([fakeProvider()]), 'GitHub account');

  // A key and a domain are not accounts, and two ways of showing one domain name it once.
  assert.equal(
    await said([fakeProvider(), fakeDocumentProvider(), dnsProvider(), wellKnownProvider()]),
    'GitHub account, Keys key or domain',
  );
});

test('forged origins, missing local authentication, and cross-account mutations fail', async () => {
  const f = fixture(),
    id = await f.connect('public');

  for (const origin of [undefined, 'https://evil.test', 'null']) {
    const response = await f.request(`/connections/${id}/disconnect`, {
      method: 'POST',
      headers: { cookie: 'local=alice', ...(origin ? { origin } : {}) },
      body: '{}',
    });

    assert.equal(response.status, 404);
  }

  for (const cookie of ['', 'local=bob'])
    assert.equal(
      (
        await f.request(`/connections/${id}/disconnect`, {
          method: 'POST',
          headers: { origin: 'https://site.test', cookie },
          body: '{}',
        })
      ).status,
      404,
    );

  assert.equal(
    (
      await f.request('/connect', {
        method: 'POST',
        headers: { origin: 'https://site.test', 'content-type': 'application/json' },
        body: '{"provider":"github","localId":"private-local-1"}',
      })
    ).status,
    404,
  );

  const evidence = await (await f.request(`/connections/${id}?format=json`)).json();

  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.verifierName, 'Self-hosted Site');
  assert.ok(!JSON.stringify(evidence).includes('private-local-1'));
});

test('static sites can read public evidence across origins without gaining management or sharing access', async () => {
  const f = fixture(),
    id = await f.connect('public');

  const headers = { origin: 'https://other.test', cookie: 'local=alice' };

  const response = await f.request(`/connections/${id}?format=json`, { headers });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).status, 'verified');

  for (const path of ['/mine', `/manage/${id}`, `/connections/${id}`]) {
    const result = await f.request(path, { headers });

    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }

  const mutation = await f.request(`/connections/${id}/disconnect`, {
    method: 'POST',
    headers,
    body: '{}',
  });

  assert.equal(mutation.status, 404);
  assert.equal(mutation.headers.get('access-control-allow-origin'), null);
  assert.equal((await f.app.service.read(id)).status, 'verified');

  await f.app.service.revoke(id, alice);
  const revoked = await f.request(`/connections/${id}?format=json`, { headers });

  assert.equal(revoked.headers.get('access-control-allow-origin'), '*');
  assert.equal((await revoked.json()).status, 'revoked');

  const privateFixture = fixture(),
    privateId = await privateFixture.connect(),
    share = (await privateFixture.app.service.share(privateId, alice))!;

  for (const path of [
    `/connections/${privateId}?format=json`,
    '/connections/missing?format=json',
    `/s/${share.url.split('/').at(-1)}?format=json`,
  ]) {
    const result = await privateFixture.request(path, { headers });

    assert.equal(result.headers.get('access-control-allow-origin'), null);

    if (path.startsWith('/connections/')) assert.equal(result.status, 404);
  }
});

test('the evidence page names how each side was established, without ranking them', async () => {
  const f = fixture(),
    id = await f.connect('public');

  const body = await (await f.request(`/connections/${id}`)).text();

  // Each side is described next to that side, so neither reads as a note on the other.
  assert.match(body, /Stated by Site/);
  assert.match(body, /Signed in with GitHub/);
  // Nothing outside a provider's own lines may name that provider.
  assert.ok(!/GitHub[^<]*approved/.test(body));

  // The old sentence assigned one method to both sides and named neither.
  assert.ok(!body.includes('proved control of it with'));
  assert.ok(!body.includes('does not check'));

  // No artifact exists for oauth, so nothing invites the reader to open one.
  assert.ok(!body.includes('View the proof'));

  // An artifact url reaches an href only after it is confirmed http(s).
  await f.app.service.options.storage.transaction(async (tx) => {
    const stored = (await tx.get('connections', id))!;

    stored.attestations = {
      local: { by: 'backend', method: 'declared', confirmedAt: 1 },
      external: [
        {
          by: 'provider',
          method: 'gist',
          artifactUrl: 'javascript:alert(1)',
          confirmedAt: 2,
        },
      ],
    };

    await tx.put('connections', id, stored);
  });

  const hostile = await (await f.request(`/connections/${id}`)).text();

  assert.match(hostile, /Published a proof on GitHub/);
  assert.ok(!hostile.includes('javascript:'));
  assert.ok(!hostile.includes('View the proof'));
});

test('a holder-paced proof is published here, submitted here, and approved here', async () => {
  const provider = fakeArtifactProvider();
  const f = fixture([provider]);

  // No redirect away: the flow stays on this origin while the holder publishes.
  const start = await f.request('/sessions?kind=connect', { headers: { cookie: 'local=alice' } });

  assert.equal(start.status, 303);
  const location = start.headers.get('location')!;

  assert.match(location, /^\/api\/verily\/flows\//);
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const path = location.replace('/api/verily', '');

  const waiting = await f.request(path, { headers: { cookie: `${cookie}; local=alice` } });
  const body = await waiting.text();

  assert.match(body, /Publish this line/);
  assert.match(body, /Verily proof for Site: /);
  assert.match(body, /name="artifact"/);

  // Another local account cannot watch someone else's flow.
  const stranger = await f.request(path, { headers: { cookie: `${cookie}; local=bob` } });

  assert.equal(stranger.status, 404);

  const expect = body.match(/<code>([^<]+)<\/code>/)![1]!;
  const url = 'https://notes.test/alice/1';

  provider.artifacts.set(url, expect);

  const submitted = await f.request(`${path}/submit`, {
    method: 'POST',
    headers: {
      origin: 'https://site.test',
      cookie: `${cookie}; local=alice`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `artifact=${encodeURIComponent(url)}`,
  });

  assert.equal(submitted.status, 303);

  const review = await f.request(path, { headers: { cookie: `${cookie}; local=alice` } });

  assert.match(await review.text(), /value="unlisted" checked/);

  const approved = await f.request(`${path}/approve`, {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: `${cookie}; local=alice` },
    body: 'visibility=public&action=approve',
  });

  assert.equal(approved.status, 200);
  const evidence = (await f.app.service.mine(alice))[0]!;

  assert.equal(evidence.attestations!.external[0].artifactUrl, url);
  assert.equal(evidence.attestations!.external[0].method, 'gist');

  // The published proof is offered to the reader on the evidence page.
  const page = await (await f.request(`/connections/${evidence.id}`)).text();

  assert.match(page, /Published a proof on Notes/);
  assert.match(page, /View the proof/);
  assert.ok(page.includes(url));
});

test('a refused proof says why where it was handed back, and any other failure does not', async () => {
  const provider = fakeArtifactProvider();
  const f = fixture([provider]);

  async function submit(artifact: string) {
    const start = await f.request('/sessions?kind=connect', { headers: { cookie: 'local=alice' } });
    const cookie = `${start.headers.get('set-cookie')!.split(';')[0]!}; local=alice`;
    const path = start.headers.get('location')!.replace('/api/verily', '');

    await f.request(`${path}/submit`, {
      method: 'POST',
      headers: {
        origin: 'https://site.test',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `artifact=${encodeURIComponent(artifact)}`,
    });

    return (await f.request(path, { headers: { cookie } })).text();
  }

  const refused = await submit('https://notes.test/alice/1');

  // The same step, with what was handed back still in the field to be put right.
  assert.match(refused, /<p>That did not check out: Line not found\. 4 tries are left\.<\/p>/);
  assert.match(refused, /name="artifact" type="url" value="https:\/\/notes\.test\/alice\/1"/);
  assert.match(refused, /Check my proof/);

  const broken = await submit('https://evil.test/alice');

  assert.match(broken, /<p>That could not be checked\. 4 tries are left\.<\/p>/);
  assert.doesNotMatch(broken, /Not a notes address/);
});

test('several methods are offered one by one, and a second one joins the record', async () => {
  const oauth = fakeProvider();
  const notes = { ...fakeArtifactProvider(), id: 'github', name: 'GitHub' };
  const f = fixture([oauth, notes]);

  const choice = await (
    await f.request('/verify?provider=github', { headers: { cookie: 'local=alice' } })
  ).text();

  assert.match(choice, /Sign in with GitHub/);
  assert.match(choice, /Publish a proof on GitHub/);
  assert.match(choice, /name="method" value="gist"/);

  const id = await f.connect('public');

  // The same account, shown the other way.
  const start = await f.request('/sessions?kind=connect&provider=github&method=gist', {
    headers: { cookie: 'local=alice' },
  });

  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const path = start.headers.get('location')!.replace('/api/verily', '');

  const waiting = await (
    await f.request(path, { headers: { cookie: `${cookie}; local=alice` } })
  ).text();

  const url = 'https://notes.test/alice/1';

  notes.artifacts.set(url, waiting.match(/<code>([^<]+)<\/code>/)![1]!);

  await f.request(`${path}/submit`, {
    method: 'POST',
    headers: {
      origin: 'https://site.test',
      cookie: `${cookie}; local=alice`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `artifact=${encodeURIComponent(url)}`,
  });

  const review = await (
    await f.request(path, { headers: { cookie: `${cookie}; local=alice` } })
  ).text();

  // Entered by a link, which any site can send a browser down, so it waits on an approval
  // that only a form posted from here can give.
  assert.match(review, /Add to connection/);
  assert.match(review, /stays public/);
  assert.ok(!review.includes('value="unlisted" checked'));

  await f.request(`${path}/approve`, {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: `${cookie}; local=alice` },
    body: 'visibility=unlisted&action=approve',
  });

  const page = await (await f.request(`/connections/${id}`)).text();

  assert.match(
    page,
    /Signed in with GitHub<\/p><p class="how additional">\+ <a href="[^"]+" rel="noreferrer" title="View the proof at [^"|]+ \| Last checked [^"]+">Published a proof on GitHub<\/a><\/p>/,
  );

  assert.equal((await f.app.service.mine(alice)).length, 1);
});

test('a proof handed over is taken as text, published here, and served as text', async () => {
  const provider = fakeDocumentProvider();
  const f = fixture([provider]);

  const start = await f.request('/sessions?kind=connect', { headers: { cookie: 'local=alice' } });
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const path = start.headers.get('location')!.replace('/api/verily', '');

  const body = await (
    await f.request(path, { headers: { cookie: `${cookie}; local=alice` } })
  ).text();

  // Nowhere to publish and no address to give back, so the page takes the proof itself.
  assert.match(body, /name="artifact"/);
  assert.match(body, /<textarea/);
  assert.ok(!body.includes('type="url"'));

  // What the holder has to reproduce exactly is set as a block, never as prose.
  assert.match(body, /<pre><code>/);

  // The copy button is made by that script, so a reader without it sees no dead control.
  assert.match(body, /\/copy\.js"/);
  assert.ok(!body.includes('class="copy"'));

  const script = await f.request('/copy.js');

  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript');
  assert.match(await script.text(), /clipboard/);

  // The sheet's address carries its version, so a release never renders in an old one.
  assert.match(body, /\/style\.css\?v=[a-z0-9]+"/);

  const expect = body.match(/<code>([^<]+)<\/code>/)![1]!;
  const proof = `-----BEGIN SOMETHING-----\n${expect}\n-----END SOMETHING-----`;

  const submitted = await f.request(`${path}/submit`, {
    method: 'POST',
    headers: {
      origin: 'https://site.test',
      cookie: `${cookie}; local=alice`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `artifact=${encodeURIComponent(proof)}`,
  });

  assert.equal(submitted.status, 303);

  await f.request(`${path}/approve`, {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: `${cookie}; local=alice` },
    body: 'visibility=public&action=approve',
  });

  const evidence = (await f.app.service.mine(alice))[0]!;
  const at = `/connections/${evidence.id}/proof`;

  assert.equal(evidence.attestations!.external[0].artifactUrl, `https://site.test/api/verily${at}`);
  assert.equal(evidence.attestations!.external[0].hosted, true);

  const served = await f.request(at);

  // Served as the bytes it is, so a reader can put it into their own tools unchanged.
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await served.text(), proof);

  // The evidence page points a reader at it rather than describing what it said.
  const page = await (await f.request(`/connections/${evidence.id}`)).text();

  assert.match(page, /Proved with a signature/);
  assert.match(page, /View the proof/);

  // A key is named by what it is. The @ that marks a handle would claim there is an
  // account behind it, issued by somebody who could also hand it to somebody else.
  assert.match(page, /AAAA BBBB/);
  assert.ok(!page.includes('@AAAA'));

  // A connection with no proof of its own has nothing to serve under that address.
  const missing = await f.request('/connections/nonexistent/proof');

  assert.equal(missing.status, 404);
});

test('the in-page dialog runs a proof start to finish in JSON, and only for its own holder', async () => {
  const provider = fakeArtifactProvider();
  const f = fixture([fakeProvider(), provider]);

  const post = (path: string, data: Record<string, string>, cookie = 'local=alice') =>
    f.request(path, {
      method: 'POST',
      headers: { origin: 'https://site.test', cookie, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });

  assert.equal((await f.request('/methods')).status, 404);

  const offered = await (
    await f.request('/methods', { headers: { cookie: 'local=alice' } })
  ).json();

  assert.deepEqual(
    offered.methods.map((m: { action: string }) => m.action),
    ['Sign in with GitHub', 'Publish a proof on Notes'],
  );

  assert.equal(offered.local.value, 'Alice');
  assert.ok(!JSON.stringify(offered).includes(alice.id));

  const start = await post('/sessions', { kind: 'connect', provider: 'notes', method: 'gist' });
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const pending = await start.json();

  assert.equal(pending.phase, 'pending');
  assert.equal(pending.field, 'Address of your published proof');
  const expect = pending.instructions[1].code;

  // The flow is bound to this browser and this holder; neither half is enough alone.
  assert.equal((await f.request(`/flows/${pending.id}?format=json`)).status, 404);

  assert.equal(
    (
      await f.request(`/flows/${pending.id}?format=json`, {
        headers: { cookie: `${cookie}; local=bob` },
      })
    ).status,
    404,
  );

  assert.equal(
    (await post(`/flows/${pending.id}/submit`, { artifact: 'x' }, `${cookie}; local=bob`)).status,
    404,
  );

  provider.artifacts.set('https://notes.test/alice/1', expect);

  const review = await (
    await post(
      `/flows/${pending.id}/submit`,
      { artifact: 'https://notes.test/alice/1' },
      `${cookie}; local=alice`,
    )
  ).json();

  assert.equal(review.phase, 'approval');
  assert.equal(review.external.handle, 'alice');
  assert.equal(review.joined, undefined);

  const done = await (
    await post(
      `/flows/${pending.id}/approve`,
      { action: 'approve', visibility: 'public' },
      `${cookie}; local=alice`,
    )
  ).json();

  assert.equal(done.outcome, 'complete');
  assert.equal((await f.app.service.read(done.connectionId)).visibility, 'public');
});

test('the dialog watches a sign-in flow until the provider sends the holder back', async () => {
  const f = fixture();

  const start = await f.request('/sessions', {
    method: 'POST',
    headers: {
      origin: 'https://site.test',
      cookie: 'local=alice',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ kind: 'connect' }),
  });

  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const view = await start.json();

  assert.match(view.authorizationUrl, /^https:\/\/provider\.test\/authorize/);

  const read = async () =>
    (
      await f.request(`/flows/${view.id}?format=json`, {
        headers: { cookie: `${cookie}; local=alice` },
      })
    ).json();

  assert.equal((await read()).phase, 'pending');
  const state = new URL(view.authorizationUrl).searchParams.get('state')!;

  await f.request(`/callback?state=${state}&code=ok`, { headers: { cookie } });
  assert.equal((await read()).phase, 'approval');
});

test('a link in the instructions is a link on the page, and only if it is http(s)', async () => {
  const provider = fakeArtifactProvider();

  provider.instructions = (expect) => [
    [
      'Publish at ',
      { text: 'notes.test', href: 'https://notes.test/' },
      ' or ',
      { text: 'here', href: 'javascript:alert(1)' },
      '.',
    ],
    { code: expect },
  ];

  const f = fixture([provider]);
  const start = await f.request('/sessions?kind=connect', { headers: { cookie: 'local=alice' } });
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const path = start.headers.get('location')!.replace('/api/verily', '');

  const body = await (
    await f.request(path, { headers: { cookie: `${cookie}; local=alice` } })
  ).text();

  assert.match(
    body,
    /<p>Publish at <a href="https:\/\/notes\.test\/" rel="noreferrer" target="_blank">notes\.test<\/a> or here\.<\/p>/,
  );

  assert.doesNotMatch(body, /javascript:/);
});

test('pages allow forms to redirect to each sign-in provider and nowhere else', async () => {
  const f = fixture();

  const policy = (await f.request('/verify', { headers: { cookie: 'local=alice' } })).headers.get(
    'content-security-policy',
  )!;

  assert.match(policy, /form-action 'self' https:\/\/provider\.test$/);
});

test('the approval page says a link back was found and will be recorded', async () => {
  const backlink: ArtifactProvider = {
    id: 'github',
    name: 'GitHub',
    method: 'backlink',
    artifact: 'location',
    expect: (local) => local.profileUrl!,
    instructions: (expect) => [{ code: expect }],
    known: (account) => account.profileUrl,
    verify: ({ artifact }) =>
      Promise.resolve({
        id: artifact,
        kind: 'account',
        handle: 'known-alice',
        profileUrl: artifact,
      }),
  };

  const f = fixture([fakeProvider(), backlink]);

  const start = await f.request('/sessions', {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: 'local=alice' },
    body: 'kind=connect&provider=github&method=oauth',
  });

  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const callback = await f.request(`/callback?state=${state}&code=ok`, { headers: { cookie } });
  const path = callback.headers.get('location')!.replace('/api/verily', '');
  const headers = { cookie: `${cookie}; local=alice` };

  assert.match(
    await (await f.request(path, { headers })).text(),
    /This account already links back to Site\. Confirming records that too\./,
  );

  const view = (await (await f.request(`${path}?format=json`, { headers })).json()) as {
    standingNote?: string;
  };

  assert.equal(
    view.standingNote,
    'This account already links back to Site. Confirming records that too.',
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVerily,
  emailProvider,
  resendSender,
  type EmailMessage,
} from '../src/server/index.js';
import { VerilyService } from '../src/server/service.js';
import type { Provider } from '../src/core/index.js';
import { alice, bob, fakeProvider, MemoryStorage } from './helpers.js';

/** The code a message carries: the one thing in it the holder types back. */
const codeIn = (message: EmailMessage) => /^[0-9A-Z]{4}-[0-9A-Z]{4}$/m.exec(message.text)![0];

function fixture(extra: Provider[] = [], sendLimits?: { day?: number; address?: number }) {
  let now = 1000000;
  const outbox: EmailMessage[] = [];
  const mail = { fail: false };

  const email = emailProvider({
    async send(message) {
      if (mail.fail) throw new Error('Relay said no to smtp.internal');

      outbox.push(message);
    },
  });

  const storage = new MemoryStorage();

  const service = new VerilyService({
    storage,
    providers: [email, ...extra],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'verifier.test',
    profileOrigins: ['https://site.test'],
    now: () => now,
    sendLimits,
  });

  /** Starts a flow and names the address, leaving the code in the outbox. */
  async function ask(
    address: string,
    kind: 'connect' | 'renew' | 'revoke' = 'connect',
    id?: string,
  ) {
    const flow = await service.start(kind === 'revoke' ? undefined : alice, id, kind);

    await service.submit(flow.flowId, flow.binding, address);

    return flow;
  }

  async function connect(address = 'alice@example.test') {
    const flow = await ask(address);

    await service.submit(flow.flowId, flow.binding, codeIn(outbox.at(-1)!));

    return (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;
  }

  return {
    service,
    storage,
    outbox,
    mail,
    ask,
    connect,
    advance: (ms: number) => (now += ms),
  };
}

test('a code read back from the mailbox links it, named by its address', async () => {
  const f = fixture();
  const flow = await f.ask('  Alice@Example.TEST ');

  assert.equal(f.outbox.length, 1);
  assert.equal(f.outbox[0]!.to, 'alice@example.test');
  assert.match(f.outbox[0]!.subject, /Site/);

  // Nothing is established by asking: the address is a claim until the code comes back.
  const pending = await f.service.flow(flow.flowId, flow.binding);

  assert.equal(pending.phase, 'pending');
  assert.equal(pending.external, undefined);

  // Only a hash is kept, so reading the store does not hand over the proof.
  assert.ok(!JSON.stringify([...f.storage.rows]).includes(codeIn(f.outbox[0]!)));

  await f.service.submit(flow.flowId, flow.binding, codeIn(f.outbox[0]!));

  const id = (await f.service.approve(flow.flowId, flow.binding, alice, 'public'))!;
  const evidence = await f.service.read(id);

  assert.deepEqual(evidence.external, {
    id: 'alice@example.test',
    kind: 'mailbox',
    handle: 'alice@example.test',
    profileUrl: 'mailto:alice@example.test',
  });

  assert.equal(evidence.provider, 'email');
  assert.equal(evidence.status, 'verified');

  // Like a sign-in it happened once: there is no proof to fetch and none to go stale.
  assert.deepEqual(evidence.attestations.external, [
    { by: 'provider', method: 'code', confirmedAt: 1000000 },
  ]);

  f.advance(20 * 86400000);
  assert.equal(await f.service.recheck(), 0);
  assert.equal((await f.service.read(id)).status, 'verified');
});

test('a code is read as it was meant, however it was typed', async () => {
  const f = fixture();
  const flow = await f.ask('alice@example.test');

  const typed = codeIn(f.outbox[0]!)
    .toLowerCase()
    .replace('-', ' ')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l');

  await f.service.submit(flow.flowId, flow.binding, ` ${typed} `);

  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'approval');
});

test('wrong codes are counted, and a flow that runs out of tries is dead', async () => {
  const f = fixture();
  const flow = await f.ask('alice@example.test');
  const code = codeIn(f.outbox[0]!);

  for (let tries = 1; tries < 5; tries++) {
    await f.service.submit(flow.flowId, flow.binding, 'AAAA-AAAA');

    const now = await f.service.flow(flow.flowId, flow.binding);

    assert.equal(now.phase, 'pending');
    assert.equal(now.sent!.attempts, tries);
  }

  await f.service.submit(flow.flowId, flow.binding, 'AAAA-AAAA');

  const dead = await f.service.flow(flow.flowId, flow.binding);

  assert.equal(dead.phase, 'failed');
  assert.equal(dead.reason, 'Too many wrong codes');

  // The right code is no use once the tries are spent, and nothing more was sent.
  await assert.rejects(f.service.submit(flow.flowId, flow.binding, code));
  assert.equal(f.outbox.length, 1);
});

test('a code completes only the flow it was sent for, and only while that flow lasts', async () => {
  const f = fixture();
  const first = await f.ask('alice@example.test');
  const second = await f.ask('alice@example.test');

  await f.service.submit(second.flowId, second.binding, codeIn(f.outbox[0]!));
  assert.equal((await f.service.flow(second.flowId, second.binding)).phase, 'pending');

  f.advance(600000);
  await assert.rejects(f.service.submit(first.flowId, first.binding, codeIn(f.outbox[0]!)));
});

test('an address that is not one is refused with a reason, and nothing is sent', async () => {
  for (const address of [
    'alice',
    '@example.test',
    'alice@localhost',
    'alice@127.0.0.1',
    'a b@example.test',
    'alice@example.test\nBcc: victim@example.test',
    'alice@example.test, bob@example.test',
    '"alice"@example.test',
    '.alice@example.test',
    `${'a'.repeat(65)}@example.test`,
  ]) {
    const f = fixture();
    const flow = await f.ask(address);
    const ended = await f.service.flow(flow.flowId, flow.binding);

    assert.equal(ended.phase, 'failed', address);
    assert.equal(ended.reason, 'Not an email address this can send to');
    assert.equal(f.outbox.length, 0);
  }
});

test('mail that could not be sent fails the flow without saying why', async () => {
  const f = fixture();

  f.mail.fail = true;

  const flow = await f.ask('alice@example.test');
  const ended = await f.service.flow(flow.flowId, flow.binding);

  assert.equal(ended.phase, 'failed');
  assert.equal(ended.reason, undefined);
  assert.equal(ended.sent, undefined);
});

test('the message carries the code and the site, and nothing a visitor chose', async () => {
  const f = fixture();

  const flow = await f.service.start({
    ...alice,
    label: 'Click https://evil.test',
    siteName: 'Other\r\nSite',
  });

  await f.service.submit(flow.flowId, flow.binding, 'alice@example.test');

  const message = f.outbox[0]!;

  assert.ok(!/[\r\n]/.test(message.subject));
  assert.match(message.subject, /Other Site/);
  assert.ok(!message.text.includes('evil.test'));
  assert.ok(!message.html.includes('evil.test'));
});

test('a mailbox renews and removes its own link, and no other mailbox can', async () => {
  const f = fixture();
  const id = await f.connect();

  // Renewing with another address proves a different mailbox, which is not this link's.
  const other = await f.ask('mallory@example.test', 'renew', id);

  await f.service.submit(other.flowId, other.binding, codeIn(f.outbox.at(-1)!));

  const refused = await f.service.flow(other.flowId, other.binding);

  assert.equal(refused.phase, 'failed');
  assert.match(refused.reason!, /different account/);

  const stranger = await f.ask('mallory@example.test', 'revoke', id);

  await f.service.submit(stranger.flowId, stranger.binding, codeIn(f.outbox.at(-1)!));
  assert.equal((await f.service.flow(stranger.flowId, stranger.binding)).phase, 'failed');
  assert.equal((await f.service.read(id)).status, 'verified');

  // Removal from the mailbox's side needs nobody signed in, only the code.
  const holder = await f.ask('ALICE@example.test', 'revoke', id);

  await f.service.submit(holder.flowId, holder.binding, codeIn(f.outbox.at(-1)!));
  await f.service.approve(holder.flowId, holder.binding, undefined, 'unlisted');
  assert.equal((await f.service.read(id)).status, 'revoked');
});

test('a mailed code starts with nothing to publish or visit, and a sign-in takes no code', async () => {
  const f = fixture([fakeProvider()]);
  const flow = await f.service.start(alice, undefined, 'connect', { provider: 'email' });

  assert.equal(flow.authorizationUrl, undefined);
  assert.equal(flow.expect, undefined);

  const signIn = await f.service.start(alice, undefined, 'connect', { provider: 'github' });

  await assert.rejects(f.service.submit(signIn.flowId, signIn.binding, 'alice@example.test'));
  assert.equal(f.outbox.length, 0);
});

function pages() {
  const outbox: EmailMessage[] = [];

  const app = createVerily({
    storage: new MemoryStorage(),
    providers: [emailProvider({ send: async (message) => void outbox.push(message) })],
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

  return { app, outbox, request };
}

test('the flow pages ask for the address, then the code, and say when a code was wrong', async () => {
  const f = pages();

  const start = await f.request('/sessions', {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: 'local=alice' },
    body: 'kind=connect',
  });

  const cookie = `${start.headers.get('set-cookie')!.split(';')[0]!}; local=alice`;
  const path = start.headers.get('location')!.replace('/api/verily', '');
  const post = { method: 'POST', headers: { origin: 'https://site.test', cookie } };

  // The form posts to this origin alone: there is no provider to be redirected to.
  const first = await f.request(path, { headers: { cookie } });

  assert.match(first.headers.get('content-security-policy')!, /form-action 'self'(;|$)/);

  const asking = await first.text();

  assert.match(asking, /Verify with Email/);
  assert.match(asking, /type="email"/);
  assert.match(asking, /Send the email/);

  // Another holder in the same browser is not shown somebody else's flow.
  const flowCookie = cookie.split(';')[0]!;

  assert.equal(
    (await f.request(path, { headers: { cookie: `${flowCookie}; local=bob` } })).status,
    404,
  );

  await f.request(`${path}/submit`, { ...post, body: 'artifact=alice%40example.test' });

  const sent = await (await f.request(path, { headers: { cookie } })).text();

  assert.match(sent, /A message was sent to alice@example\.test/);
  assert.match(sent, /autocomplete="one-time-code"/);
  assert.ok(!sent.includes('did not match'));

  await f.request(`${path}/submit`, { ...post, body: 'artifact=AAAA-AAAA' });

  assert.match(
    await (await f.request(path, { headers: { cookie } })).text(),
    /did not match. 4 tries are left/,
  );

  const code = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/m.exec(f.outbox[0]!.text)![0];

  await f.request(`${path}/submit`, { ...post, body: `artifact=${code}` });

  const review = await (await f.request(path, { headers: { cookie } })).text();

  // The address is its own name: no @ put in front, no link, and no second identifier.
  assert.match(review, /<p class="name">alice@example\.test<\/p>/);
  assert.ok(!review.includes('mailto:alice'));
  assert.equal(review.split('alice@example.test').length - 1, 1);

  await f.request(`${path}/approve`, { ...post, body: 'visibility=public&action=approve' });

  const id = (await f.app.service.mine(alice))[0]!.id;
  const evidence = await (await f.request(`/connections/${id}`)).text();

  assert.match(evidence, /Entered a code sent to this address/);
  assert.ok(!evidence.includes('mailto:alice'));
});

test('the dialog is told which step a mailed code is at, and never the code', async () => {
  const f = pages();
  const json = { origin: 'https://site.test', 'content-type': 'application/json' };

  const start = await f.request('/sessions', {
    method: 'POST',
    headers: { ...json, cookie: 'local=alice' },
    body: JSON.stringify({ kind: 'connect' }),
  });

  const cookie = `${start.headers.get('set-cookie')!.split(';')[0]!}; local=alice`;
  const begun = await start.json();

  assert.deepEqual(begun.provider, { id: 'email', name: 'Email', method: 'code' });
  assert.deepEqual(begun.code, { field: 'Your email address', input: 'email' });
  assert.equal(begun.authorizationUrl, undefined);

  const submit = async (artifact: string) =>
    (
      await f.request(`/flows/${begun.id}/submit`, {
        method: 'POST',
        headers: { ...json, cookie },
        body: JSON.stringify({ artifact }),
      })
    ).json();

  const sent = await submit('alice@example.test');

  assert.deepEqual(sent.code, {
    field: 'Your email address',
    input: 'email',
    sentTo: 'alice@example.test',
    wrong: false,
    triesLeft: 5,
  });

  const wrong = await submit('AAAA-AAAA');

  assert.equal(wrong.code.wrong, true);
  assert.equal(wrong.code.triesLeft, 4);
  assert.ok(!JSON.stringify(wrong).includes('codeHash'));

  const done = await submit(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/m.exec(f.outbox[0]!.text)![0]);

  assert.equal(done.phase, 'approval');
  assert.equal(done.external.kind, 'mailbox');

  const methods = await (await f.request('/methods', { headers: { cookie } })).json();

  assert.deepEqual(methods.methods, [
    { provider: 'email', method: 'code', name: 'Email', action: 'Continue with Email' },
  ]);
});

test('the Resend sender posts one message with the key, and rejects what Resend refuses', async () => {
  const calls: { url: string; init: RequestInit }[] = [];

  const image = {
    contentId: 'verily-logo',
    filename: 'v.png',
    contentType: 'image/png',
    content: 'AAAA',
  };

  let status = 200;

  const send = resendSender({
    apiKey: 're_test',
    from: 'Verily <verify@site.test>',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });

      return new Response('{"id":"1","message":"account detail"}', { status });
    },
  });

  await send({
    to: 'alice@example.test',
    subject: 'Your Site verification code',
    text: 'K7QM-2XPD',
    html: '<p>K7QM-2XPD</p>',
    images: [image],
  });

  assert.equal(calls[0]!.url, 'https://api.resend.com/emails');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer re_test');

  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    from: 'Verily <verify@site.test>',
    to: ['alice@example.test'],
    subject: 'Your Site verification code',
    text: 'K7QM-2XPD',
    html: '<p>K7QM-2XPD</p>',
    attachments: [
      { filename: 'v.png', content: 'AAAA', content_type: 'image/png', content_id: 'verily-logo' },
    ],
  });

  status = 403;

  // What Resend answered stays out of the error, which a caller may end up showing.
  await assert.rejects(
    send({ to: 'alice@example.test', subject: 's', text: 't', html: '<p>t</p>', images: [] }),
    (error: Error) => error.message === 'Mail was not accepted',
  );
});

/** The address of the button in a message, as the path and token this backend serves it at. */
const linkIn = (message: EmailMessage) => {
  const url = new URL(/^https:\/\/\S+$/m.exec(message.text)![0]);

  return {
    id: url.pathname.split('/').at(-1)!,
    token: url.searchParams.get('token')!,
    path: `${url.pathname.replace('/api/verily', '')}${url.search}`,
  };
};

test('the message is a button to press, with the code beneath it and nothing fetched', async () => {
  const f = fixture();

  const flow = await f.service.start({ ...alice, siteName: 'Tom & <b>Jerry</b>' });

  await f.service.submit(flow.flowId, flow.binding, 'alice@example.test');

  const { html, text, subject } = f.outbox[0]!;
  const link = linkIn(f.outbox[0]!);

  assert.equal(subject, 'Confirm your address for Tom & <b>Jerry</b>');
  assert.equal(link.id, flow.flowId);

  // The same link is the button.
  assert.ok(html.includes(`/confirm/${link.id}?token=${link.token}"`));
  assert.match(html, />Confirm this address<\/a>/);
  assert.ok(html.includes(codeIn(f.outbox[0]!)));
  assert.ok(text.includes(codeIn(f.outbox[0]!)));

  // The site's name is written as text wherever it appears.
  assert.ok(html.includes('Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;'));
  assert.ok(!html.includes('<b>Jerry'));

  // Nothing loads from anywhere: no image to block, and nothing that reports an opening.
  assert.ok(!/<link|<script|url\(/i.test(html));

  // Its one image is the logotype, which the message carries with it.
  assert.deepEqual(
    [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]),
    ['cid:verily-logo'],
  );

  const [image] = f.outbox[0]!.images;

  assert.equal(f.outbox[0]!.images.length, 1);
  assert.equal(image!.contentId, 'verily-logo');
  assert.equal(image!.contentType, 'image/png');
  // A PNG, of the size the HTML shows it at three times over.
  const bytes = Buffer.from(image!.content, 'base64');

  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [281, 120]);

  assert.deepEqual(
    [...html.matchAll(/https?:\/\/[^"\s<]+/g)].map((m) => new URL(m[0]).origin),
    ['https://site.test'],
  );
});

test('pressing the button proves the mailbox from any browser, and only once', async () => {
  const f = fixture();
  const flow = await f.ask('alice@example.test');
  const { id, token } = linkIn(f.outbox[0]!);

  await assert.rejects(f.service.confirm(id, 'not-the-token'));
  await assert.rejects(f.service.confirm('not-the-flow', token));

  // Looking at what the link is for changes nothing.
  const asked = await f.service.confirming(id, token);

  assert.equal(asked.account.handle, 'alice@example.test');
  assert.equal(asked.local!.label, 'Alice');
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'pending');

  // No binding is given: the link is used wherever the mail is read.
  assert.equal((await f.service.confirm(id, token)).phase, 'approval');

  // It proves the mailbox and no more. The browser that started the flow still approves it.
  assert.equal((await f.service.mine(alice)).length, 0);
  await assert.rejects(f.service.confirm(id, token));
  await assert.rejects(f.service.submit(flow.flowId, flow.binding, codeIn(f.outbox[0]!)));

  const linked = (await f.service.approve(flow.flowId, flow.binding, alice, 'public'))!;

  assert.equal((await f.service.read(linked)).external.handle, 'alice@example.test');
});

test('a link is no use once its code was entered, its flow ran out, or its tries were spent', async () => {
  const f = fixture();

  const entered = await f.ask('alice@example.test');

  await f.service.submit(entered.flowId, entered.binding, codeIn(f.outbox[0]!));
  await assert.rejects(f.service.confirm(entered.flowId, linkIn(f.outbox[0]!).token));

  const spent = await f.ask('alice@example.test');

  for (let tries = 0; tries < 5; tries++)
    await f.service.submit(spent.flowId, spent.binding, 'AAAA-AAAA');

  await assert.rejects(f.service.confirm(spent.flowId, linkIn(f.outbox[1]!).token));

  const late = await f.ask('alice@example.test');

  f.advance(600000);
  await assert.rejects(f.service.confirm(late.flowId, linkIn(f.outbox[2]!).token));
});

test("a link for somebody else's record names no subject, and a stranger's press removes nothing", async () => {
  const f = fixture();
  const id = await f.connect();

  const stranger = await f.ask('mallory@example.test', 'revoke', id);
  const link = linkIn(f.outbox.at(-1)!);
  const asked = await f.service.confirming(link.id, link.token);

  // Whoever was mailed this has shown nothing yet, so the record's subject is not theirs to read.
  assert.equal(asked.kind, 'revoke');
  assert.equal(asked.local, undefined);

  const ended = await f.service.confirm(link.id, link.token);

  assert.equal(ended.phase, 'failed');
  assert.match(ended.reason!, /different account/);
  await assert.rejects(f.service.approve(stranger.flowId, stranger.binding, undefined, 'unlisted'));
  assert.equal((await f.service.read(id)).status, 'verified');
});

test('opening the link confirms nothing, pressing its button does, and the first browser carries on', async () => {
  const f = pages();

  const start = await f.request('/sessions', {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: 'local=alice' },
    body: 'kind=connect',
  });

  const cookie = `${start.headers.get('set-cookie')!.split(';')[0]!}; local=alice`;
  const path = start.headers.get('location')!.replace('/api/verily', '');

  await f.request(`${path}/submit`, {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie },
    body: 'artifact=alice%40example.test',
  });

  const waiting = await (await f.request(path, { headers: { cookie } })).text();

  assert.match(waiting, /Press the button in it/);
  assert.match(waiting, /I pressed the button/);

  const link = linkIn(f.outbox[0]!);

  // A mail scanner follows every link it finds. It carries no cookie and presses nothing.
  for (let opened = 0; opened < 3; opened++) {
    const shown = await f.request(link.path);

    assert.equal(shown.status, 200);

    const text = await shown.text();

    assert.match(text, /Confirm this address/);
    assert.match(text, /alice@example\.test/);
    assert.match(text, /link it to this/);
  }

  assert.match(await (await f.request(path, { headers: { cookie } })).text(), /Press the button/);
  assert.equal((await f.request(`/confirm/${link.id}?token=wrong`)).status, 404);

  // Pressing is a form post from this origin, which a link in a message cannot be.
  const forged = await f.request(`/confirm/${link.id}`, {
    method: 'POST',
    headers: { origin: 'https://evil.test' },
    body: `token=${link.token}`,
  });

  assert.equal(forged.status, 404);

  // Another browser, with no cookie of the flow's: the phone the mail was read on.
  const pressed = await f.request(`/confirm/${link.id}`, {
    method: 'POST',
    headers: { origin: 'https://site.test' },
    body: `token=${link.token}`,
  });

  const confirmed = await pressed.text();

  assert.match(confirmed, /Address confirmed/);
  assert.match(confirmed, /Go back to the page where you started/);
  assert.ok(!confirmed.includes('carry on in this window'));

  // The page that was waiting has moved on to the approval, and only it can approve.
  const review = await (await f.request(path, { headers: { cookie } })).text();

  assert.match(review, /Confirm connection/);
  assert.equal((await f.app.service.mine(alice)).length, 0);
  assert.equal((await f.request(link.path)).status, 404);
});

test('the browser that started the flow is offered the way on from the confirmation', async () => {
  const f = pages();

  const start = await f.request('/sessions', {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: 'local=alice' },
    body: 'kind=connect',
  });

  const cookie = `${start.headers.get('set-cookie')!.split(';')[0]!}; local=alice`;
  const path = start.headers.get('location')!.replace('/api/verily', '');
  const post = { method: 'POST', headers: { origin: 'https://site.test', cookie } };

  await f.request(`${path}/submit`, { ...post, body: 'artifact=alice%40example.test' });

  const link = linkIn(f.outbox[0]!);
  const pressed = await f.request(`/confirm/${link.id}`, { ...post, body: `token=${link.token}` });

  assert.match(
    await pressed.text(),
    new RegExp(`href="/api/verily${path}">Or carry on in this window`),
  );
});

test("a removal anybody can start is mailed in the installation's name, never the record's site", async () => {
  const f = fixture();

  // One installation serving several sites: this subject belongs to one of them, and its
  // link is unlisted, so which site that is has been shown to nobody.
  const member = { ...alice, siteName: 'Partner' };
  const flow = await f.service.start(member);

  await f.service.submit(flow.flowId, flow.binding, 'alice@example.test');
  assert.match(f.outbox[0]!.subject, /Partner/);
  await f.service.submit(flow.flowId, flow.binding, codeIn(f.outbox[0]!));

  const id = (await f.service.approve(flow.flowId, flow.binding, member, 'unlisted'))!;

  // A stranger who knows the id asks for its removal and names a mailbox of their own.
  for (const kind of ['revoke', 'share-revoke'] as const) {
    const stranger = await f.service.start(undefined, id, kind);

    await f.service.submit(stranger.flowId, stranger.binding, 'mallory@example.test');

    const message = f.outbox.at(-1)!;

    assert.equal(message.to, 'mallory@example.test');
    assert.equal(message.subject, 'Confirm your address for verifier.test');

    for (const part of [message.subject, message.text, message.html]) {
      assert.ok(!part.includes('Partner'), kind);
      assert.ok(!part.includes('Alice'), kind);
    }

    // What the link shows them before they press it says no more than the message did.
    const link = linkIn(message);
    const asked = await f.service.confirming(link.id, link.token);

    assert.equal(asked.local, undefined);
  }

  // The holder renewing their own link is signed in, and is told which site as before.
  const renewal = await f.service.start(member, id, 'renew');

  await f.service.submit(renewal.flowId, renewal.binding, 'alice@example.test');
  assert.match(f.outbox.at(-1)!.subject, /Partner/);
});

/** How a flow stands once an address has been named for it: mailed, or refused and why. */
async function asked(f: ReturnType<typeof fixture>, address: string) {
  const flow = await f.ask(address);
  const now = await f.service.flow(flow.flowId, flow.binding);

  return now.phase === 'pending' ? 'sent' : now.reason;
}

const tooMany = 'Too many messages have been sent today, so try again tomorrow';

test('one address is sent five messages a day, however it is spelled, and no sixth', async () => {
  const f = fixture();

  for (let sent = 1; sent <= 5; sent++) assert.equal(await asked(f, 'Victim@example.test'), 'sent');

  assert.equal(await asked(f, 'victim@EXAMPLE.test'), tooMany);
  assert.equal(f.outbox.length, 5);

  // Somebody else's address is not held to what was sent to this one.
  assert.equal(await asked(f, 'other@example.test'), 'sent');

  // A day on, the count has run out and starts again.
  f.advance(86400000 - 1);
  assert.equal(await asked(f, 'victim@example.test'), tooMany);
  f.advance(1);
  assert.equal(await asked(f, 'victim@example.test'), 'sent');
});

test('the day has a ceiling across every address, and a refusal spends none of it', async () => {
  const f = fixture([], { day: 3, address: 2 });

  assert.equal(await asked(f, 'one@example.test'), 'sent');
  assert.equal(await asked(f, 'one@example.test'), 'sent');

  // Refused by the address's own limit, which leaves the day's count where it was.
  assert.equal(await asked(f, 'one@example.test'), tooMany);
  assert.equal(await asked(f, 'two@example.test'), 'sent');
  assert.equal(await asked(f, 'three@example.test'), tooMany);
  assert.equal(f.outbox.length, 3);

  // And refused by the day, which leaves that address its own count for tomorrow.
  f.advance(86400000);
  assert.equal(await asked(f, 'three@example.test'), 'sent');
  assert.equal(await asked(f, 'three@example.test'), 'sent');
});

test('a message that failed to send is still counted, and an address that is not one is not', async () => {
  const f = fixture([], { day: 2 });

  assert.equal(await asked(f, 'not an address'), 'Not an email address this can send to');

  f.mail.fail = true;
  assert.equal(await asked(f, 'alice@example.test'), undefined);
  assert.equal(await asked(f, 'alice@example.test'), undefined);

  f.mail.fail = false;
  assert.equal(await asked(f, 'bob@example.test'), tooMany);
});

test('send limits keep no address, are pruned once spent, and can be lifted', async () => {
  const f = fixture();

  await asked(f, 'victim@example.test');

  const stored = () => [...f.storage.rows.keys()].filter((key) => key.startsWith('limits:'));

  assert.equal(stored().length, 2);
  assert.ok(stored().includes('limits:send/email/day'));
  assert.ok(!stored().join().includes('victim'));

  await f.service.prune();
  assert.equal(stored().length, 2);
  f.advance(86400000);
  await f.service.prune();
  assert.equal(stored().length, 0);

  const open = fixture([], { day: Infinity, address: Infinity });

  for (let sent = 0; sent < 8; sent++)
    assert.equal(await asked(open, 'alice@example.test'), 'sent');

  assert.equal([...open.storage.rows.keys()].filter((key) => key.startsWith('limits:')).length, 0);

  for (const bad of [{ day: 0 }, { address: -1 }, { day: 1.5 }, { address: Number.NaN }])
    assert.throws(() => fixture([], bad), /Invalid send limit/);
});

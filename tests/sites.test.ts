import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse } from 'miniflare';
import { buildWorker } from './fixtures/worker.js';

const origin = 'https://verifier.test';
const partnerKey = 'r'.repeat(43);
const otherKey = 'o'.repeat(43);

const sites = [
  {
    id: 'partner',
    name: 'Partner',
    origin: 'https://partner.test',
    authorizeUrl: 'https://partner.test/verity/authorize',
    returnUrl: 'https://partner.test/verity/return',
  },
  {
    id: 'other',
    name: 'Other',
    origin: 'https://other.test',
    authorizeUrl: 'https://other.test/verity/authorize',
    returnUrl: 'https://other.test/verity/return',
  },
];

let directory: string;
let scriptPath: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'verity-sites-'));
  scriptPath = join(directory, 'worker.mjs');
  await buildWorker(scriptPath);
});

after(() => rm(directory, { recursive: true, force: true }));

/** A fresh instance with two registered sites and a GitHub that signs anyone in as octocat. */
function instance() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'verity-sites-test',
      rootPath: directory,
      modules: true,
      scriptPath,
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: {
        VERITY: { className: 'VerityStore', useSQLite: true },
        PROBE: { className: 'StorageProbe', useSQLite: true },
      },
      bindings: {
        PUBLIC_ORIGIN: origin,
        SITE_NAME: 'shirkadeh.test',
        OWNER_KIND: 'site',
        OWNER_LABEL: 'shirkadeh.test',
        OWNER_REFERENCE: 'shirkadeh.test',
        OWNER_PROFILE_URL: 'https://shirkadeh.test/',
        REPORT_URL: 'mailto:owner@shirkadeh.test',
        OWNER_KEY: 'a'.repeat(43),
        GITHUB_CLIENT_ID: 'test-client',
        GITHUB_CLIENT_SECRET: 'test-secret',
        SITES: JSON.stringify(sites),
        SITE_PARTNER_KEY: partnerKey,
        SITE_OTHER_KEY: otherKey,
      },
      outboundService: async (request: { url: string }) => {
        if (request.url === 'https://github.com/login/oauth/access_token')
          return WorkerResponse.json({ access_token: 'provider-secret' });

        if (request.url === 'https://api.github.com/user')
          return WorkerResponse.json({ id: 123, login: 'octocat' });

        throw new Error(`Unexpected outbound URL: ${new URL(request.url).origin}`);
      },
    }),
  );

  /** The object's own storage and alarm, through the fixture's test-only door. */
  const probe = async (path: string, init?: RequestInit) => {
    const namespace = await mf.getDurableObjectNamespace('VERITY');
    const stub = namespace.get(namespace.idFromName('site-owner'));

    return (await (await stub.fetch(`https://probe${path}`, init as never)).json()) as Record<
      string,
      { expiresAt: number; closed?: boolean }
    >;
  };

  return { mf, probe, browser: (ip: string) => new Browser(mf, ip) };
}

/** One browser: its own cookies and its own address. */
class Browser {
  cookies = new Map<string, string>();

  constructor(
    private readonly mf: Miniflare,
    private readonly ip: string,
  ) {}

  async fetch(path: string, init: { method?: string; body?: string } = {}) {
    const response = await this.mf.dispatchFetch(
      path.startsWith('http') ? path : `${origin}${path}`,
      {
        method: init.method ?? 'GET',
        body: init.body,
        redirect: 'manual',
        headers: {
          'cf-connecting-ip': this.ip,
          ...(init.method === 'POST' ? { origin } : {}),
          cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        },
      },
    );

    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair!.split('=') as [string, string];

      if (/Max-Age=0/.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    return response;
  }

  post(path: string, body = '') {
    return this.fetch(path, { method: 'POST', body });
  }

  /** Starts a handoff and returns the state the site was sent. */
  async begin(site = 'partner', purpose = 'connect') {
    const response = await this.fetch(`/begin?site=${site}&purpose=${purpose}`);

    assert.equal(response.status, 303);

    return new URL(response.headers.get('location')!).searchParams.get('state')!;
  }

  /** Runs a GitHub sign-in flow from its first request to its approval page's path. */
  async signIn(start: string) {
    const begun = start.startsWith('/api/verity/sessions?')
      ? await this.fetch(start)
      : await this.post('/api/verity/sessions', start);

    assert.equal(begun.status, 303, await begun.text());
    const state = new URL(begun.headers.get('location')!).searchParams.get('state')!;
    const callback = await this.fetch(`/api/verity/callback?state=${state}&code=fixture`);

    return callback.headers.get('location')!;
  }
}

const now = () => Math.floor(Date.now() / 1000);

/** What a registered site's backend signs, made independently of the worker's own code. */
function sign(payload: object, key = partnerKey) {
  const bytes = Buffer.from(JSON.stringify(payload));

  return `${bytes.toString('base64url')}.${createHmac('sha256', key).update(bytes).digest('base64url')}`;
}

function handoff(state: string, overrides: Record<string, unknown> = {}, key = partnerKey) {
  return sign(
    {
      site: 'partner',
      state,
      id: '123',
      kind: 'account',
      label: 'Alice',
      reference: 'alice',
      profileUrl: 'https://partner.test/u/alice',
      txn: 'txn-1',
      exp: now() + 120,
      ...overrides,
    },
    key,
  );
}

/** A result as the site reads it: the payload, once its MAC is checked. */
function result(location: string, key = partnerKey) {
  const url = new URL(location);
  const [payload, mac] = url.searchParams.get('result')!.split('.') as [string, string];
  const bytes = Buffer.from(payload, 'base64url');

  assert.equal(createHmac('sha256', key).update(bytes).digest('base64url'), mac);

  return { at: `${url.origin}${url.pathname}`, ...JSON.parse(bytes.toString()) };
}

test('a handoff binds to the browser that asked for it, and every bad one is refused alike', async () => {
  const { mf, probe, browser } = instance();

  try {
    const a = browser('192.0.2.1'),
      b = browser('192.0.2.2');

    const state = await a.begin();

    assert.ok(a.cookies.has('verity_handoff'));
    const token = handoff(state);

    // Binding: an unused handoff sent to another browser is refused there, whether that
    // browser holds no handoff at all or one of its own, and still works where it began.
    const refusal = await b.fetch(`/start?token=${token}`);

    assert.equal(refusal.status, 403);
    const refused = await refusal.text();

    await b.begin();
    assert.equal((await b.fetch(`/start?token=${token}`)).status, 403);

    const accepted = await a.fetch(`/start?token=${token}`);

    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get('location'), '/api/verity/verify');
    assert.ok(a.cookies.has('verity_site'));
    assert.ok(!a.cookies.has('verity_handoff'));

    const verify = await (await a.fetch('/api/verity/verify')).text();

    assert.match(verify, /Account on Partner/);
    assert.ok(!verify.includes('shirkadeh.test'));

    // Replay: redeemed once, refused after, in the same browser.
    const replay = await a.fetch(`/start?token=${token}`);

    assert.equal(replay.status, 403);
    assert.equal(await replay.text(), refused);

    // Each check alone, each against a handoff that is otherwise good.
    const bad: [string, (state: string) => string][] = [
      ['an unregistered site', (s) => handoff(s, { site: 'nowhere' })],
      ['a MAC under another key', (s) => handoff(s, {}, otherKey)],
      ['a MAC under another registered site', (s) => handoff(s, { site: 'other' }, partnerKey)],
      [
        'a payload changed after signing',
        (s) =>
          handoff(s).replace(
            /^[^.]+/,
            Buffer.from(
              JSON.stringify({
                site: 'partner',
                state: s,
                id: '999',
                label: 'Mallory',
                reference: 'mallory',
                txn: 'x',
                exp: now() + 60,
              }),
            ).toString('base64url'),
          ),
      ],
      ['an expired token', (s) => handoff(s, { exp: now() - 1 })],
      ['a token more than five minutes ahead', (s) => handoff(s, { exp: now() + 400 })],
      [
        'a state this browser was not given',
        (s) => handoff(s.replace(/^./, s[0] === 'A' ? 'B' : 'A')),
      ],
      [
        'a profile on another site',
        (s) => handoff(s, { profileUrl: 'https://other.test/u/alice' }),
      ],
      [
        'a profile on the instance owner',
        (s) => handoff(s, { profileUrl: 'https://shirkadeh.test/' }),
      ],
      ['no transaction', (s) => handoff(s, { txn: '' })],
      ['a kind that is not one', (s) => handoff(s, { kind: 'admin' })],
      ['a malformed token', () => 'not-a-token'],
    ];

    for (const [i, [name, make]] of bad.entries()) {
      const c = browser(`192.0.2.${100 + i}`);
      const s = await c.begin();
      const response = await c.fetch(`/start?token=${make(s)}`);

      assert.equal(response.status, 403, name);
      assert.equal(await response.text(), refused, name);
      // Refusing a handoff does not spend its state: the good token still works.
      assert.equal((await c.fetch(`/start?token=${handoff(s)}`)).status, 303, name);
    }

    // A state stored for one site does not redeem another site's token.
    const c = browser('192.0.2.4');
    const forOther = await c.begin('other');

    assert.equal((await c.fetch(`/start?token=${handoff(forOther)}`)).status, 403);

    // A state past its five minutes is refused though it is still stored.
    const d = browser('192.0.2.5');
    const stale = await d.begin();
    const stored = Object.keys(await probe('/list?prefix=site/state/'));

    for (const key of stored)
      await probe('/put', {
        method: 'POST',
        body: JSON.stringify({
          key,
          value: { site: 'partner', purpose: 'connect', expiresAt: Date.now() - 1 },
        }),
      });

    assert.equal((await d.fetch(`/start?token=${handoff(stale)}`)).status, 403);

    assert.equal((await a.fetch('/begin?site=nowhere&purpose=connect')).status, 404);
    assert.equal((await a.fetch('/begin?site=partner&purpose=admin')).status, 404);
  } finally {
    await mf.dispose();
  }
});

test('a site holder connects, returns with a signed result, and manages from a site session', async () => {
  const { mf, probe, browser } = instance();

  try {
    const a = browser('192.0.2.10');

    const open = async (purpose: string, txn: string) => {
      const response = await a.fetch(
        `/start?token=${handoff(await a.begin('partner', purpose), { txn })}`,
      );

      assert.equal(response.status, 303);

      return response.headers.get('location')!;
    };

    assert.equal(await open('connect', 'txn-1'), '/api/verity/verify');

    const binding = () => [...a.cookies].find(([name]) => name.startsWith('verity_flow_'))!;

    // Two more flows from the same handoff: one left at the provider, one at its approval page.
    const early = await a.fetch('/api/verity/sessions?kind=connect&provider=github&method=oauth');
    const earlyState = new URL(early.headers.get('location')!).searchParams.get('state')!;
    const earlyBinding = binding();

    const stranded = await a.signIn(
      '/api/verity/sessions?kind=connect&provider=github&method=oauth',
    );

    const strandedBinding = binding();
    const flow = await a.signIn('/api/verity/sessions?kind=connect&provider=github&method=oauth');
    const review = await a.fetch(flow);
    const page = await review.text();

    assert.match(page, /Account on Partner/);
    assert.match(page, /Partner receives the result\. Verified via verifier\.test\./);

    assert.match(
      review.headers.get('content-security-policy')!,
      /form-action 'self' https:\/\/github\.com https:\/\/partner\.test https:\/\/other\.test/,
    );

    const approved = await a.post(`${flow}/approve`, 'action=approve&visibility=unlisted');

    assert.equal(approved.status, 303);

    const connected = result(approved.headers.get('location')!);

    assert.equal(connected.at, 'https://partner.test/verity/return');
    assert.equal(connected.site, 'partner');
    assert.equal(connected.id, '123');
    assert.equal(connected.operation, 'connect');
    assert.equal(connected.outcome, 'complete');
    assert.equal(connected.visibility, 'unlisted');
    assert.equal(connected.txn, 'txn-1');
    assert.ok(connected.exp > now() && connected.exp <= now() + 600);

    // Loading the result again gives the same signed result, not a new one.
    const again = await a.fetch(flow);

    assert.equal(again.headers.get('location'), approved.headers.get('location'));

    // Reloading after a lost response resubmits the POST, which gets the same result too.
    const resubmitted = await a.post(`${flow}/approve`, 'action=approve&visibility=unlisted');

    assert.equal(resubmitted.status, 303);
    assert.equal(resubmitted.headers.get('location'), approved.headers.get('location'));

    // But a flow that had not ended cannot be approved once the session has returned.
    const flowBinding = binding();

    a.cookies.set(...strandedBinding);

    assert.equal(
      (await a.post(`${stranded}/approve`, 'action=approve&visibility=public')).status,
      404,
    );

    // Nor does one that ends afterwards return a second result for the same transaction.
    a.cookies.set(...earlyBinding);

    const late = await a.fetch(`/api/verity/callback?state=${earlyState}&error=access_denied`);
    const lateEnd = await a.fetch(late.headers.get('location')!);

    assert.equal(lateEnd.status, 200);
    assert.match(await lateEnd.text(), /data-outcome="cancelled"/);
    a.cookies.set(...flowBinding);
    assert.equal((await a.fetch(flow)).headers.get('location'), approved.headers.get('location'));

    // The return closed the session: nothing new starts from that handoff.
    assert.equal((await a.fetch('/api/verity/verify')).status, 404);
    assert.equal((await a.fetch('/api/verity/sessions?kind=connect')).status, 404);
    assert.match(await (await a.fetch('/')).text(), /Session ended/);

    // A manage handoff lands on the settings page for that subject, without sharing or embeds.
    assert.equal(await open('manage', 'txn-2'), '/');

    const landing = await a.fetch('/');
    const settings = await landing.text();

    // Its disconnect form redirects on to the site, which form-action has to allow.
    assert.match(
      landing.headers.get('content-security-policy')!,
      /form-action 'self' https:\/\/partner\.test https:\/\/other\.test$/,
    );

    assert.match(settings, /<h1>Your connections<\/h1>/);
    assert.match(settings, /Account on Partner/);
    assert.match(settings, /Partner keeps this connection in its records and shows no badge/);
    assert.match(settings, /action="\/disconnect"/);
    assert.ok(!settings.includes('verity-badge'));
    assert.ok(!settings.includes('Sign out'));

    for (const route of ['disconnect', 'share', 'share-revoke'])
      assert.equal(
        (await a.post(`/api/verity/connections/${connected.connection}/${route}`)).status,
        404,
        route,
      );

    // Making it public is the existing visibility flow, and returns as one.
    const visibility = await a.signIn(`kind=visibility&connectionId=${connected.connection}`);
    const changed = await a.post(`${visibility}/approve`, 'action=approve&visibility=public');
    const made = result(changed.headers.get('location')!);

    assert.equal(made.operation, 'visibility');
    assert.equal(made.outcome, 'complete');
    assert.equal(made.visibility, 'public');
    assert.equal(made.connection, connected.connection);
    assert.equal(made.txn, 'txn-2');

    const evidence = `/api/verity/connections/${connected.connection}?format=json`;

    const status = async () =>
      ((await (await a.fetch(evidence)).json()) as { status: string }).status;

    assert.equal(await status(), 'verified');

    // A failure before the revocation commits reports nothing, and a retry finishes it.
    await open('manage', 'txn-3');

    // A visibility flow is already at the provider when the disconnect is attempted.
    const waiting = await a.post(
      '/api/verity/sessions',
      `kind=visibility&connectionId=${connected.connection}`,
    );

    const waitingState = new URL(waiting.headers.get('location')!).searchParams.get('state')!;

    await probe('/put', {
      method: 'POST',
      body: JSON.stringify({ key: 'test/fault', value: 'before' }),
    });

    const failed = await a.post('/disconnect', `connection=${connected.connection}`);

    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('location'), null);
    assert.equal(await status(), 'verified');

    // The pending disconnect holds the session's one result, so nothing else starts.
    assert.equal((await a.fetch(`/api/verity/visibility/${connected.connection}`)).status, 404);

    assert.equal(
      (await a.post('/api/verity/sessions', `kind=visibility&connectionId=${connected.connection}`))
        .status,
      404,
    );

    assert.match(await (await a.fetch('/')).text(), /Disconnect not finished/);

    // That earlier flow ends when the holder comes back from the provider, which needs no
    // session. It ends on its own page: the disconnect holds this transaction's result.
    const declined = await a.fetch(
      `/api/verity/callback?state=${waitingState}&error=access_denied`,
    );

    const ending = await a.fetch(declined.headers.get('location')!);

    assert.equal(ending.status, 200);
    assert.equal(ending.headers.get('location'), null);
    assert.match(await ending.text(), /data-outcome="cancelled"/);

    const retried = await a.post('/disconnect', `connection=${connected.connection}`);
    const removed = result(retried.headers.get('location')!);

    assert.deepEqual(
      { ...removed, exp: undefined },
      {
        at: 'https://partner.test/verity/return',
        site: 'partner',
        id: '123',
        operation: 'disconnect',
        outcome: 'complete',
        connection: connected.connection,
        visibility: 'public',
        txn: 'txn-3',
        exp: undefined,
      },
    );

    assert.equal(await status(), 'revoked');

    // A failure after it commits, before the result is marked, is finished by a retry with
    // the one result, however many times it is asked again.
    await open('connect', 'txn-4');
    const second = await a.signIn('/api/verity/sessions?kind=connect&provider=github&method=oauth');

    const secondId = result(
      (await a.post(`${second}/approve`, 'action=approve&visibility=unlisted')).headers.get(
        'location',
      )!,
    ).connection;

    await open('manage', 'txn-5');

    await probe('/put', {
      method: 'POST',
      body: JSON.stringify({ key: 'test/fault', value: 'after' }),
    });

    assert.equal((await a.post('/disconnect', `connection=${secondId}`)).status, 503);

    const finished = await a.post('/disconnect', `connection=${secondId}`);
    const once = result(finished.headers.get('location')!);

    assert.equal(once.operation, 'disconnect');
    assert.equal(once.txn, 'txn-5');

    assert.equal(
      (await a.post('/disconnect', `connection=${secondId}`)).headers.get('location'),
      finished.headers.get('location'),
    );

    // Closed now, the session starts nothing else, and never removes another subject's link.
    assert.equal((await a.post('/disconnect', `connection=${connected.connection}`)).status, 404);

    await open('manage', 'txn-6');
    const owner = browser('192.0.2.11');

    await owner.post('/login', `key=${'a'.repeat(43)}`);
    const ownFlow = await owner.signIn('kind=connect');

    const ownApproval = await owner.post(`${ownFlow}/approve`, 'action=approve&visibility=public');

    // The owner's flows have no site, so they end on the ordinary result page.
    assert.equal(ownApproval.status, 200);
    assert.match(await ownApproval.text(), /data-outcome="complete"/);

    const ownerRecords = (await (await owner.fetch('/api/verity/mine')).json()) as {
      id: string;
      siteName: string;
      local: { kind: string };
    }[];

    // The owner's own record is unchanged: no site of its own, so the instance's name.
    assert.equal(ownerRecords[0]!.siteName, 'shirkadeh.test');
    assert.match(await (await owner.fetch('/')).text(), /Owner settings/);
    assert.equal((await a.post('/disconnect', `connection=${ownerRecords[0]!.id}`)).status, 404);

    // The owner, having gone through a site's handoff that has since returned, is the
    // owner again, with the owner's own management.
    await owner.fetch(`/start?token=${handoff(await owner.begin(), { txn: 'txn-owner' })}`);

    const cancelled = await owner.signIn(
      '/api/verity/sessions?kind=connect&provider=github&method=oauth',
    );

    assert.equal(
      (await owner.post(`${cancelled}/approve`, 'action=cancel&visibility=unlisted')).status,
      303,
    );

    assert.match(await (await owner.fetch('/')).text(), /Owner settings/);

    assert.equal(
      (await owner.post(`/api/verity/connections/${ownerRecords[0]!.id}/disconnect`)).status,
      200,
    );

    const sessions = await probe('/list?prefix=site/session/');

    assert.ok(Object.values(sessions).filter((s) => s.closed).length >= 5);
  } finally {
    await mf.dispose();
  }
});

test('requests are limited per session, per client and per site, GETs that create state included', async () => {
  const { mf, browser } = instance();

  try {
    // A browser still holding a session for one site, handing off to another.
    const holder = browser('198.51.100.9');

    assert.equal((await holder.fetch(`/start?token=${handoff(await holder.begin())}`)).status, 303);

    const one = browser('198.51.100.1');

    for (let i = 0; i < 30; i++)
      assert.equal((await one.fetch('/begin?site=other&purpose=connect')).status, 303);

    assert.equal((await one.fetch('/begin?site=other&purpose=connect')).status, 429);
    assert.equal((await one.fetch('/start?token=x')).status, 429);
    assert.equal((await one.post('/login', 'key=wrong')).status, 429);
    // Reading is not limited.
    assert.equal((await one.fetch('/')).status, 200);

    // Another client is untouched by the first one's traffic.
    assert.equal((await browser('198.51.100.2').fetch('/start?token=x')).status, 403);

    // A cookie that is no session earns no bucket of its own.
    const forged = browser('198.51.100.1');

    forged.cookies.set('verity_owner', 'forged');
    assert.equal((await forged.fetch('/api/verity/sessions?kind=connect')).status, 429);

    const real = browser('198.51.100.3');

    // A signed-in holder counts against their own session, not their address.
    await real.post('/login', `key=${'a'.repeat(43)}`);

    for (let i = 0; i < 60; i++)
      assert.equal((await real.fetch('/api/verity/callback?state=x')).status, 404);

    assert.equal((await real.fetch('/api/verity/callback?state=x')).status, 429);
    assert.equal((await browser('198.51.100.3').fetch('/api/verity/callback?state=x')).status, 404);

    // One site's traffic reaches its ceiling without reaching another site's.
    for (let client = 0; client < 20; client++) {
      const c = browser(`203.0.113.${client}`);

      await Promise.all(
        Array.from({ length: 30 }, () => c.fetch('/begin?site=partner&purpose=connect')),
      );
    }

    const fresh = browser('203.0.113.200');

    assert.equal((await fresh.fetch('/begin?site=partner&purpose=connect')).status, 429);
    assert.equal((await fresh.fetch('/begin?site=other&purpose=connect')).status, 303);

    // A handoff goes against the site it is for, not the one this browser has a session with.
    assert.equal((await holder.fetch('/begin?site=other&purpose=connect')).status, 303);

    for (let client = 0; client < 20; client++) {
      const c = browser(`203.0.114.${client}`);

      await Promise.all(
        Array.from({ length: 30 }, () => c.fetch('/begin?site=other&purpose=connect')),
      );
    }

    assert.equal((await holder.fetch('/begin?site=other&purpose=connect')).status, 429);
  } finally {
    await mf.dispose();
  }
});

test('the alarm deletes abandoned handoffs, expired sessions and idle buckets, and keeps live ones', async () => {
  const { mf, probe, browser } = instance();

  try {
    const live = browser('192.0.2.20');

    await live.begin();
    const session = browser('192.0.2.21');

    assert.equal(
      (await session.fetch(`/start?token=${handoff(await session.begin())}`)).status,
      303,
    );

    const stale = randomBytes(8).toString('hex');

    for (const [key, value] of [
      [`site/state/${stale}`, { site: 'partner', purpose: 'connect', expiresAt: Date.now() - 1 }],
      [
        `site/session/${stale}`,
        { site: 'partner', purpose: 'connect', txn: 't', local: {}, expiresAt: Date.now() - 1 },
      ],
      [`rate/client/${stale}`, { count: 3, expiresAt: Date.now() - 1 }],
    ] as const)
      await probe('/put', { method: 'POST', body: JSON.stringify({ key, value }) });

    const before = await probe('/list');
    const everything = await probe('/alarm');

    for (const prefix of ['site/state/', 'site/session/', 'rate/client/']) {
      assert.ok(`${prefix}${stale}` in before);
      assert.ok(!(`${prefix}${stale}` in everything), prefix);

      // What is still live stays.
      assert.ok(
        Object.keys(everything).some((key) => key.startsWith(prefix)),
        prefix,
      );
    }

    assert.match(await (await session.fetch('/api/verity/verify')).text(), /Account on Partner/);
  } finally {
    await mf.dispose();
  }
});

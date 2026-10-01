import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse } from 'miniflare';
import { buildWorker } from './fixtures/worker.js';
import { createSiteClient } from '../src/site/index.js';

const origin = 'https://verifier.test';
const partnerKey = 'r'.repeat(43);
const otherKey = 'o'.repeat(43);
const quietKey = 'q'.repeat(43);

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
    // This site's holders are offered Discord and nothing else the instance has.
    providers: ['discord'],
  },
  {
    id: 'quiet',
    name: 'Quiet',
    origin: 'https://quiet.test',
    authorizeUrl: 'https://quiet.test/verity/authorize',
    returnUrl: 'https://quiet.test/verity/return',
    // This site's holders make unlisted links only, which the site reads with its key.
    visibility: ['unlisted'],
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
        DISCORD_CLIENT_ID: 'discord-client',
        DISCORD_CLIENT_SECRET: 'discord-secret',
        SITES: JSON.stringify(sites),
        SITE_PARTNER_KEY: partnerKey,
        SITE_OTHER_KEY: otherKey,
        SITE_QUIET_KEY: quietKey,
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
      /form-action 'self' https:\/\/github\.com https:\/\/discord\.com https:\/\/partner\.test$/,
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
      /form-action 'self' https:\/\/partner\.test$/,
    );

    assert.match(settings, /<h1>Your connections<\/h1>/);
    assert.match(settings, /Account on Partner/);

    assert.match(
      settings,
      /Only Partner can read this connection, and it chooses who there sees it/,
    );

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

    // A dialog's handoff arrives with no cookie to say whose it is, and still counts
    // against the site that signed it. One that does not verify spends nothing of a site's.
    const trade = (key: string) =>
      mf.dispatchFetch(`${origin}/api/verity/site/session`, {
        method: 'POST',
        body: JSON.stringify({
          token: sign(
            {
              site: 'partner',
              op: 'dialog',
              id: '9',
              label: 'Alice',
              reference: 'alice',
              txn: 'limited',
              exp: now() + 120,
            },
            key,
          ),
        }),
        headers: {
          'cf-connecting-ip': '203.0.113.201',
          origin: 'https://partner.test',
          'content-type': 'application/json',
        },
      });

    assert.equal((await trade(otherKey)).status, 404);
    assert.equal((await trade(partnerKey)).status, 429);

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

test('a site that lists its providers has its holders offered those, and held to them', async () => {
  const { mf, browser } = instance();

  try {
    const member = browser('192.0.2.30');

    const token = handoff(
      await member.begin('other'),
      { site: 'other', profileUrl: 'https://other.test/u/alice' },
      otherKey,
    );

    assert.equal((await member.fetch(`/start?token=${token}`)).status, 303);

    const offered = await (await member.fetch('/api/verity/verify')).text();

    assert.match(offered, /<h1>Verify with Discord<\/h1>/);
    assert.match(offered, /Account on Other/);
    assert.ok(!offered.includes('GitHub'));

    // Asking for another provider by hand is refused, either way a flow can be started.
    for (const method of ['oauth', 'backlink']) {
      const query = `kind=connect&provider=github&method=${method}`;

      assert.equal((await member.fetch(`/api/verity/sessions?${query}`)).status, 404, method);
      assert.equal((await member.post('/api/verity/sessions', query)).status, 404, method);
    }

    assert.equal((await member.fetch('/api/verity/verify?provider=github')).status, 404);

    // Asking for nothing runs the first one the site lists, not the first one configured.
    for (const start of [
      await member.fetch('/api/verity/sessions?kind=connect'),
      await member.post('/api/verity/sessions', 'kind=connect'),
    ]) {
      assert.equal(start.status, 303);
      assert.equal(new URL(start.headers.get('location')!).host, 'discord.com');
    }

    // A site that lists none keeps everything, as does the owner.
    const all = browser('192.0.2.31');

    await all.fetch(`/start?token=${handoff(await all.begin())}`);
    const everything = await (await all.fetch('/api/verity/verify')).text();

    assert.match(everything, /Sign in with GitHub/);
    assert.match(everything, /Sign in with Discord/);

    const owner = browser('192.0.2.32');

    await owner.post('/login', `key=${'a'.repeat(43)}`);
    assert.match(await (await owner.fetch('/api/verity/verify')).text(), /Sign in with GitHub/);
  } finally {
    await mf.dispose();
  }
});

test('a site held to unlisted links reads its own subjects with its key, and nobody else can', async () => {
  const { mf, browser } = instance();

  try {
    const member = browser('192.0.2.40');

    const token = handoff(
      await member.begin('quiet'),
      { site: 'quiet', id: 'u-1', profileUrl: undefined },
      quietKey,
    );

    assert.equal((await member.fetch(`/start?token=${token}`)).status, 303);

    const flow = await member.signIn(
      '/api/verity/sessions?kind=connect&provider=github&method=oauth',
    );

    const page = await (await member.fetch(flow)).text();

    assert.match(page, /Unlisted\. Only Quiet can read this link/);
    assert.ok(!page.includes('value="public"'));

    assert.equal(
      (await member.post(`${flow}/approve`, 'action=approve&visibility=public')).status,
      404,
    );

    const approved = await member.post(`${flow}/approve`, 'action=approve&visibility=unlisted');
    const connected = result(approved.headers.get('location')!, quietKey);

    assert.equal(connected.visibility, 'unlisted');

    // Nothing about it is readable by the public, or listed anywhere.
    assert.equal(
      (
        await browser('192.0.2.41').fetch(
          `/api/verity/connections/${connected.connection}?format=json`,
        )
      ).status,
      404,
    );

    assert.deepEqual(await (await member.fetch('/api/verity/published')).json(), []);

    // The settings page offers no change of visibility either.
    await member.fetch(
      `/start?token=${handoff(await member.begin('quiet', 'manage'), { site: 'quiet', id: 'u-1', profileUrl: undefined, txn: 'txn-2' }, quietKey)}`,
    );

    const settings = await (await member.fetch('/')).text();

    assert.match(settings, /Only Quiet can read this connection/);
    assert.ok(!settings.includes('Change visibility'));

    /** A read as the site's backend sends it: no cookies, a token in the header. */
    const read = (bearer: string | undefined, ip = '192.0.2.50') =>
      mf.dispatchFetch(`${origin}/site/connections`, {
        headers: {
          'cf-connecting-ip': ip,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      });

    const asking = (overrides: Record<string, unknown> = {}, key = quietKey) =>
      sign({ site: 'quiet', op: 'read', ids: ['u-1', 'u-2'], exp: now() + 60, ...overrides }, key);

    const answer = await read(asking());

    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.equal(answer.headers.get('access-control-allow-origin'), null);

    const body = (await answer.json()) as {
      connections: Record<
        string,
        {
          id: string;
          provider: string;
          visibility: string;
          status: string;
          external: { handle: string };
        }[]
      >;
    };

    assert.deepEqual(Object.keys(body.connections), ['u-1', 'u-2']);
    assert.deepEqual(body.connections['u-2'], []);
    assert.equal(body.connections['u-1']!.length, 1);
    assert.equal(body.connections['u-1']![0]!.id, connected.connection);
    assert.equal(body.connections['u-1']![0]!.provider, 'github');
    assert.equal(body.connections['u-1']![0]!.external.handle, 'octocat');
    assert.equal(body.connections['u-1']![0]!.visibility, 'unlisted');
    assert.equal(body.connections['u-1']![0]!.status, 'verified');
    // The private id the site sent never comes back inside a record.
    assert.ok(!JSON.stringify(body.connections['u-1']).includes('quiet:u-1'));

    // Another site's key reads only under that site's own prefix, where this subject is not.
    const other = await read(asking({ site: 'partner', ids: ['u-1', 'quiet:u-1'] }, partnerKey));

    assert.deepEqual(await other.json(), { connections: { 'u-1': [], 'quiet:u-1': [] } });

    // An id that names something on every object comes back as an entry like any other.
    const odd = await read(asking({ ids: ['__proto__', 'constructor', 'u-1'] }));
    const oddBody = JSON.parse(await odd.text()) as { connections: Record<string, unknown[]> };

    assert.deepEqual(Object.keys(oddBody.connections), ['__proto__', 'constructor', 'u-1']);
    assert.deepEqual(oddBody.connections['__proto__'], []);

    const bad: [string, string | undefined][] = [
      ['no token', undefined],
      ['another key', asking({}, partnerKey)],
      ['a handoff token', handoff('s', { site: 'quiet', id: 'u-1' }, quietKey)],
      ['no read mark', asking({ op: undefined })],
      ['an expired token', asking({ exp: now() - 1 })],
      ['a token too far ahead', asking({ exp: now() + 400 })],
      ['no ids', asking({ ids: [] })],
      ['too many ids', asking({ ids: Array.from({ length: 51 }, (_, i) => `u-${i}`) })],
      ['an id that is not a string', asking({ ids: [1] })],
      ['an unregistered site', asking({ site: 'nowhere' })],
    ];

    for (const [i, [name, bearer]] of bad.entries())
      assert.equal((await read(bearer, `192.0.2.${60 + i}`)).status, 404, name);

    // Refused reads count against the caller's address, good ones against the site.
    for (let i = 0; i < 29; i++) await read(undefined, '192.0.2.99');

    assert.equal((await read(undefined, '192.0.2.99')).status, 404);
    assert.equal((await read(undefined, '192.0.2.99')).status, 429);
    assert.equal((await read(asking(), '192.0.2.99')).status, 200);
  } finally {
    await mf.dispose();
  }
});

test('the site client carries a holder through the instance and reads the link back', async () => {
  const { mf, browser } = instance();

  try {
    const client = createSiteClient({
      instance: origin,
      site: 'quiet',
      key: quietKey,
      fetch: ((url: string, init: { headers: Record<string, string> }) =>
        mf.dispatchFetch(url, { headers: init.headers })) as unknown as typeof fetch,
    });

    const member = browser('192.0.2.70');

    // The site's button, then its authorize endpoint, which is one call.
    const begun = await member.fetch(client.beginUrl());
    const state = new URL(begun.headers.get('location')!).searchParams.get('state')!;

    const handed = await client.authorize(state, {
      id: 'u-9',
      kind: 'account',
      label: 'Alice',
      reference: 'quiet-ABCD',
    });

    assert.equal((await member.fetch(handed.url)).status, 303);
    assert.deepEqual({ ...(await client.connections(['u-9'])) }, { 'u-9': [] });

    const flow = await member.signIn(
      '/api/verity/sessions?kind=connect&provider=github&method=oauth',
    );

    const approved = await member.post(`${flow}/approve`, 'action=approve&visibility=unlisted');

    // The site's return endpoint can check the result, or ignore it and read instead.
    const returned = await client.result(
      new URL(approved.headers.get('location')!).searchParams.get('result')!,
    );

    assert.equal(returned!.id, 'u-9');
    assert.equal(returned!.txn, handed.txn);
    assert.equal(returned!.outcome, 'complete');

    const read = await client.connections(['u-9', 'u-10', '__proto__']);

    assert.deepEqual(Object.keys(read), ['u-9', 'u-10', '__proto__']);

    assert.deepEqual(read['u-10'], []);
    assert.equal(read['u-9']!.length, 1);
    assert.equal(read['u-9']![0]!.id, returned!.connection);
    assert.equal(read['u-9']![0]!.status, 'verified');
    assert.equal(read['u-9']![0]!.visibility, 'unlisted');
    assert.equal(read['u-9']![0]!.external.handle, 'octocat');
    assert.equal(read['u-9']![0]!.siteName, 'Quiet');
    assert.equal(read['u-9']![0]!.local.reference, 'quiet-ABCD');
  } finally {
    await mf.dispose();
  }
});

test('nothing the instance sends an outsider says which sites it serves', async () => {
  const { mf, browser } = instance();

  try {
    // Each site's origin, and each way a page names a site.
    const named = /partner|other\.test|quiet\.test|(on|Only|to) (Other|Quiet)\b/i;

    /** Every header and the whole body, as one text to search. */
    const everything = async (response: Awaited<ReturnType<Browser['fetch']>>) =>
      `${[...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n')}\n${await response.text()}`;

    // A holder one site sent here, with a public record of the owner's to look at.
    const member = browser('192.0.2.80');

    await member.fetch(`/start?token=${handoff(await member.begin())}`);

    const owner = browser('192.0.2.81');

    await owner.post('/login', `key=${'a'.repeat(43)}`);
    const flow = await owner.signIn('kind=connect');

    await owner.post(`${flow}/approve`, 'action=approve&visibility=public');
    const [record] = (await (await owner.fetch('/api/verity/mine')).json()) as { id: string }[];

    const outsider = browser('192.0.2.82');

    for (const path of [
      '/',
      '/nothing-here',
      '/start?token=x',
      '/site/connections',
      '/begin?site=nowhere&purpose=connect',
      '/api/verity/verify',
      '/api/verity/published',
      '/api/verity/style.css',
      '/api/verity/mine',
      `/api/verity/connections/${record!.id}`,
      `/api/verity/connections/${record!.id}?format=json`,
      `/api/verity/external-revoke/${record!.id}`,
    ])
      assert.doesNotMatch(await everything(await outsider.fetch(path)), named, path);

    assert.doesNotMatch(await everything(await outsider.post('/login', 'key=wrong')), named);

    // Signed in as the owner is an outsider to every site too.
    assert.doesNotMatch(await everything(await owner.fetch('/')), named);
    assert.doesNotMatch(await everything(await owner.fetch('/api/verity/verify')), named);

    // The holder is told their own site, and no other.
    const own = await everything(await member.fetch('/api/verity/verify'));

    assert.match(
      own,
      /form-action 'self' https:\/\/github\.com https:\/\/discord\.com https:\/\/partner\.test\n/,
    );

    assert.doesNotMatch(own, /other\.test|quiet\.test/i);
  } finally {
    await mf.dispose();
  }
});

test('a site with a missing or malformed key is left out, and the rest are still served', async () => {
  const { registry } = await import('../cloudflare/sites.js');

  const site = (id: string) => ({
    id,
    name: `${id}.test`,
    origin: `https://${id}.test`,
    authorizeUrl: `https://${id}.test/authorize`,
    returnUrl: `https://${id}.test/return`,
  });

  const errors: unknown[] = [];
  const error = console.error;

  console.error = (...said: unknown[]) => errors.push(said);

  try {
    const sites = registry([site('good'), site('padded'), site('missing')], {
      SITE_GOOD_KEY: randomBytes(32).toString('base64url'),
      // What plain base64 gives: the right bytes, in the wrong alphabet.
      SITE_PADDED_KEY: randomBytes(32).toString('base64'),
    });

    assert.deepEqual([...sites.keys()], ['good']);
    assert.equal(errors.length, 2);
  } finally {
    console.error = error;
  }

  // A mistake in the list itself still refuses to start.
  assert.throws(() => registry([{ ...site('bad'), origin: 'http://bad.test' }], {}));
});

test('the dialog on a site page connects with a session and a binding carried in headers', async () => {
  const { mf, browser } = instance();

  try {
    const site = 'https://partner.test';

    const dialogToken = (overrides: Record<string, unknown> = {}, key = partnerKey) =>
      sign(
        {
          site: 'partner',
          op: 'dialog',
          id: '123',
          label: 'Alice',
          reference: 'alice',
          txn: 'dialog-1',
          exp: now() + 120,
          ...overrides,
        },
        key,
      );

    /** A request as the site's page sends it: its origin, no cookie, what it holds in headers. */
    const page = (
      path: string,
      init: {
        from?: string;
        session?: string;
        binding?: string;
        body?: object | string;
        method?: string;
        ip?: string;
      } = {},
    ) =>
      mf.dispatchFetch(`${origin}${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        body:
          typeof init.body === 'string'
            ? init.body
            : init.body
              ? JSON.stringify(init.body)
              : undefined,
        redirect: 'manual',
        headers: {
          'cf-connecting-ip': init.ip ?? '192.0.2.40',
          origin: init.from ?? site,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.session ? { authorization: `Bearer ${init.session}` } : {}),
          ...(init.binding ? { 'x-verity-flow': init.binding } : {}),
        },
      });

    // A browser asks first, and is told nothing about which origins are sites.
    for (const from of [site, 'https://stranger.test']) {
      const asked = await page('/api/verity/site/session', { method: 'OPTIONS', from });

      assert.equal(asked.status, 204);
      assert.equal(asked.headers.get('access-control-allow-origin'), from);
      assert.match(asked.headers.get('access-control-allow-headers')!, /Authorization/);
    }

    // Every handoff that is not this site's own, marked for the dialog and in date, is refused.
    for (const [token, from] of [
      [dialogToken({ txn: 'bad-1' }), 'https://other.test'],
      [dialogToken({ txn: 'bad-2' }, otherKey), site],
      [dialogToken({ txn: 'bad-3', op: 'read' }), site],
      [dialogToken({ txn: 'bad-4', op: undefined }), site],
      [dialogToken({ txn: 'bad-5', exp: now() - 1 }), site],
      [dialogToken({ txn: 'bad-6', profileUrl: 'https://other.test/u/alice' }), site],
    ] as const)
      assert.equal((await page('/api/verity/site/session', { body: { token }, from })).status, 404);

    const traded = await page('/api/verity/site/session', { body: { token: dialogToken() } });

    assert.equal(traded.status, 200);
    assert.equal(traded.headers.get('access-control-allow-origin'), site);
    assert.equal(traded.headers.get('set-cookie'), null);

    const { session } = (await traded.json()) as { session: string };

    // The handoff works once.
    assert.equal(
      (await page('/api/verity/site/session', { body: { token: dialogToken() } })).status,
      404,
    );

    // A dialog handoff is not a redirect handoff, nor the other way round.
    const b = browser('192.0.2.41');

    await b.begin();
    assert.equal((await b.fetch(`/start?token=${dialogToken({ txn: 'dialog-2' })}`)).status, 403);

    // The session is good from its own site's origin and from nowhere else.
    assert.equal(
      (await page('/api/verity/methods', { session, from: 'https://other.test' })).status,
      404,
    );

    const methods = await page('/api/verity/methods', { session });

    assert.equal(methods.status, 200);
    assert.equal(((await methods.json()) as { siteName: string }).siteName, 'Partner');

    // It reaches the dialog's requests and nothing else the library serves.
    assert.equal((await page('/api/verity/mine', { session })).status, 404);

    assert.equal(
      (
        await page('/api/verity/sessions', {
          session,
          body: { kind: 'renew', connectionId: 'x', provider: 'github' },
        })
      ).status,
      404,
    );

    const started = await page('/api/verity/sessions', {
      session,
      body: { kind: 'connect', provider: 'github', method: 'oauth' },
    });

    assert.equal(started.status, 200);
    assert.equal(started.headers.get('set-cookie'), null);
    assert.equal(started.headers.get('access-control-expose-headers'), 'X-Verity-Flow');

    const binding = started.headers.get('x-verity-flow')!;
    const flow = (await started.json()) as { id: string; authorizationUrl: string };
    const state = new URL(flow.authorizationUrl).searchParams.get('state')!;

    // Without its binding the flow is nobody's.
    assert.equal((await page(`/api/verity/flows/${flow.id}?format=json`, { session })).status, 404);

    // The sign-in window: a page of this origin that takes the binding from the site's page.
    const popup = browser('192.0.2.40');
    const entered = await popup.fetch('/api/verity/site/enter');

    assert.equal(entered.status, 200);
    assert.match(entered.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.doesNotMatch(await entered.text(), /partner/i);

    // The window's own script sends the binding: JSON, from this origin, saying where the
    // page that handed it over is.
    const enter = async (
      from: string,
      sent: { flow: string; binding: string } = { flow: flow.id, binding },
      headers: Record<string, string> = { origin, 'content-type': 'application/json' },
    ) => {
      const response = await mf.dispatchFetch(`${origin}/api/verity/site/enter`, {
        method: 'POST',
        body: JSON.stringify({ ...sent, origin: from }),
        headers: { 'cf-connecting-ip': '192.0.2.40', ...headers },
      });

      for (const header of response.headers.getSetCookie()) {
        const [name, value] = header.split(';')[0]!.split('=') as [string, string];

        popup.cookies.set(name, value);
      }

      return response.status;
    };

    // Sent by a page on any other origin, the binding is not taken.
    assert.equal(await enter('https://stranger.test'), 404);
    assert.equal(await enter('https://other.test'), 404);

    // Nor from anything but that script. A form can post from a sandboxed frame, whose
    // origin is opaque, or from another site, and can name any origin in its body. No form
    // can send JSON, and no other page can send this origin.
    for (const headers of [
      { origin: 'null', 'content-type': 'text/plain' },
      { origin: 'null', 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
      { origin, 'content-type': 'text/plain' },
      { origin: site, 'content-type': 'application/json' },
    ] as Record<string, string>[])
      assert.equal(await enter(site, undefined, headers), 403, JSON.stringify(headers));

    assert.equal(popup.cookies.size, 0);

    assert.equal(await enter(site), 204);
    assert.equal([...popup.cookies.values()][0], binding);

    const callback = await popup.fetch(`/api/verity/callback?state=${state}&code=fixture`);

    assert.equal(callback.status, 303);

    // The window signed in and can do no more: approving is the dialog's, with the session.
    assert.equal(
      (
        await popup.post(
          `${callback.headers.get('location')!}/approve`,
          'action=approve&visibility=unlisted',
        )
      ).status,
      404,
    );

    const review = await page(`/api/verity/flows/${flow.id}?format=json`, { session, binding });
    const view = (await review.json()) as { phase: string; external: { handle: string } };

    assert.equal(view.phase, 'approval');
    assert.equal(view.external.handle, 'octocat');

    const approved = await page(`/api/verity/flows/${flow.id}/approve`, {
      session,
      binding,
      body: { action: 'approve', visibility: 'unlisted' },
    });

    assert.equal(approved.status, 200);

    const outcome = (await approved.json()) as { outcome: string; connectionId: string };

    assert.equal(outcome.outcome, 'complete');

    // The site reads the link back with its key, as it does one made through a redirect.
    const client = createSiteClient({
      instance: origin,
      site: 'partner',
      key: partnerKey,
      fetch: ((url: string, init: RequestInit) =>
        mf.dispatchFetch(url, init as never)) as unknown as typeof fetch,
    });

    const { '123': links } = await client.connections(['123']);

    assert.equal(links!.length, 1);
    assert.equal(links![0]!.id, outcome.connectionId);
    assert.equal(links![0]!.visibility, 'unlisted');

    // The dialog only connects, whatever a body says twice: the kind held to is the one
    // the library will read, which is the last.
    assert.equal(
      (
        await page('/api/verity/sessions', {
          session,
          body: `{"kind":"connect","kind":"renew","connectionId":"${outcome.connectionId}"}`,
        })
      ).status,
      404,
    );

    // A request that is refused is counted against its sender, so guessing sessions is
    // limited like anything else from an address with no session.
    const guess = () =>
      page('/api/verity/sessions', {
        session: 'g'.repeat(43),
        body: { kind: 'connect', provider: 'github', method: 'oauth' },
        ip: '192.0.2.77',
      });

    for (let i = 0; i < 30; i++) assert.equal((await guess()).status, 404);

    const limited = await guess();

    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('access-control-allow-origin'), site);

    // A sign-in refused at the provider ends that flow and nothing else. The window is
    // not sent back to the site, the dialog reads how the flow ended, and it can start
    // another with the same session.
    const second = await page('/api/verity/sessions', {
      session,
      body: { kind: 'connect', provider: 'github', method: 'oauth' },
    });

    const secondBinding = second.headers.get('x-verity-flow')!;
    const refusedFlow = (await second.json()) as { id: string; authorizationUrl: string };

    popup.cookies.clear();

    assert.equal(await enter(site, { flow: refusedFlow.id, binding: secondBinding }), 204);

    const denied = await popup.fetch(
      `/api/verity/callback?state=${new URL(refusedFlow.authorizationUrl).searchParams.get('state')!}&error=access_denied`,
    );

    const ended = await popup.fetch(denied.headers.get('location')!);

    assert.equal(ended.status, 200);
    assert.match(await ended.text(), /data-outcome="cancelled"/);

    const read = await page(`/api/verity/flows/${refusedFlow.id}?format=json`, {
      session,
      binding: secondBinding,
    });

    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { phase: string }).phase, 'cancelled');

    assert.equal(
      (
        await page('/api/verity/sessions', {
          session,
          body: { kind: 'connect', provider: 'github', method: 'oauth' },
        })
      ).status,
      200,
    );

    // The holder removes their own link from the dialog too, and no other request about a
    // connection is the dialog's to make.
    const remove = (id: string, action = 'disconnect') =>
      page(`/api/verity/connections/${id}/${action}`, { session, body: {} });

    assert.equal((await remove('no-such-connection')).status, 404);
    // Not the dialog's, so held to this origin like any other request, which the page is not on.
    assert.equal((await remove(outcome.connectionId, 'share')).status, 403);
    assert.equal((await remove(outcome.connectionId, 'visibility')).status, 403);

    const removed = await remove(outcome.connectionId);

    assert.equal(removed.status, 200);
    assert.equal(removed.headers.get('access-control-allow-origin'), site);

    const { '123': after } = await client.connections(['123']);

    assert.equal(after!.find((link) => link.id === outcome.connectionId)!.status, 'revoked');
  } finally {
    await mf.dispose();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dnsProvider, wellKnownProvider } from '../src/server/domain.js';
import { VerilyService } from '../src/server/service.js';
import { attestationLabel, externalName } from '../src/core/index.js';
import { alice, bob, MemoryStorage, written } from './helpers.js';

const expect = 'https://site.test/users/1';

const lookup = 'https://dns.google/resolve?name=_verily.example.test&type=TXT';
const file = 'https://example.test/.well-known/verily.txt';

// A domain is named by itself: what was shown is control of the name.
const shown = {
  id: 'example.test',
  kind: 'domain',
  handle: 'example.test',
  profileUrl: 'https://example.test/',
};

/** A resolver that answers every lookup with these TXT records, as the JSON API writes them. */
function dns(records: string[], answer: Record<string, unknown> = {}, init: ResponseInit = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];

  const instance = dnsProvider({
    fetch: ((url: string, requestInit?: RequestInit) => {
      calls.push({ url: String(url), init: requestInit });

      return Promise.resolve(
        new Response(
          JSON.stringify({
            Status: 0,
            TC: false,
            Answer: records.map((data) => ({ name: '_verily.example.test.', type: 16, data })),
            ...answer,
          }),
          init,
        ),
      );
    }) as unknown as typeof fetch,
  });

  return { instance, calls };
}

function wellKnown(
  body: string,
  init: ResponseInit = {},
  options: Parameters<typeof wellKnownProvider>[0] = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];

  const instance = wellKnownProvider({
    ...options,
    fetch: ((url: string, requestInit?: RequestInit) => {
      calls.push({ url: String(url), init: requestInit });

      return Promise.resolve(
        new Response(body, {
          status: 200,
          ...init,
          headers: { 'content-type': 'text/plain; charset=utf-8', ...init.headers },
        }),
      );
    }) as unknown as typeof fetch,
  });

  return { instance, calls };
}

test('a TXT record naming the subject proves the domain it is published under', async () => {
  const { instance, calls } = dns(['v=spf1 -all', expect]);

  assert.deepEqual(await instance.verify({ artifact: lookup, expect }), shown);

  // One resolver, asked about the name this built and nothing the holder wrote.
  assert.equal(calls[0]!.url, lookup);
  assert.equal(calls[0]!.init?.redirect, 'manual');
  assert.equal(externalName(shown as never), 'example.test');

  const told = written(instance.instructions(expect));

  assert.match(told, /TXT record/);
  assert.ok(told.includes('_verily'));
  assert.ok(told.includes(expect));
});

test('a domain is taken as it is written, and kept as the lookup that was run', () => {
  const { instance } = dns([]);

  for (const typed of [
    'example.test',
    ' Example.TEST ',
    'example.test.',
    'https://example.test',
    'http://example.test/',
  ])
    assert.equal(instance.resolve!(typed), lookup, typed);

  // Another script is the name DNS compares, which is what the record sits under.
  assert.equal(
    instance.resolve!('bücher.test'),
    'https://dns.google/resolve?name=_verily.xn--bcher-kva.test&type=TXT',
  );

  // Not a domain: a page, an address literal, a single label, a name inside the network.
  for (const typed of [
    'example.test/about',
    'https://example.test/?q=1',
    '127.0.0.1',
    'localhost',
    'printer.local',
    'user@example.test',
    'example.test:8443',
    '',
  ])
    assert.equal(instance.resolve!(typed), typed, typed);
});

test('the holder cannot point the lookup anywhere but the resolver', async () => {
  for (const artifact of [
    'https://evil.test/resolve?name=_verily.example.test&type=TXT',
    'http://dns.google/resolve?name=_verily.example.test&type=TXT',
    'https://dns.google/resolve?name=example.test&type=TXT',
    'https://dns.google/resolve?name=_verily.example.test&type=A',
    'https://dns.google/resolve?name=_verily.example.test&type=TXT&edns_client_subnet=1.2.3.4',
    'https://dns.google/query?name=_verily.example.test&type=TXT',
    'https://dns.google/resolve?name=_verily.localhost&type=TXT',
    'example.test',
  ]) {
    const { instance, calls } = dns([expect]);

    await assert.rejects(instance.verify({ artifact, expect }), `accepted ${artifact}`);
    assert.deepEqual(calls, [], `fetched ${artifact}`);
  }
});

test('a record is read as its text, however the resolver writes it', async () => {
  // Quoted, and split into the strings a long record is stored as.
  const half = Math.floor(expect.length / 2);

  for (const data of [
    `"${expect}"`,
    `"${expect.slice(0, half)}" "${expect.slice(half)}"`,
    `"${expect.replace('/', '\\047')}"`,
    ` ${expect} `,
  ])
    assert.deepEqual(await dns([data]).instance.verify({ artifact: lookup, expect }), shown, data);
});

test('a record that does not name the subject proves nothing', async () => {
  const cases: [string, ReturnType<typeof dns>][] = [
    ['no record', dns([])],
    ['no such name', dns([], { Status: 3, Answer: undefined })],
    ['another subject', dns(['https://site.test/users/2'])],
    // The whole text is the claim: a longer address is some other subject.
    ['a longer address', dns([`${expect}0`])],
    ['a shorter address', dns([expect.slice(0, -1)])],
    ['the address among other words', dns([`me=${expect}`])],
    ['an unreadable record', dns([`"${expect}`])],
    ['a record of another type', dns([], { Answer: [{ type: 5, data: expect }] })],
  ];

  for (const [name, { instance }] of cases)
    await assert.rejects(
      instance.verify({ artifact: lookup, expect }),
      /No TXT record at _verily\.example\.test/,
      `accepted ${name}`,
    );
});

test('a lookup that could not be made is unread, never absent', async () => {
  const cases: [string, ReturnType<typeof dns>][] = [
    ['resolver failure', dns([expect], { Status: 2 })],
    ['cut-off answer', dns([expect], { TC: true })],
    ['resolver error', dns([expect], {}, { status: 500 })],
    ['resolver redirect', dns([expect], {}, { status: 302, headers: { location: '/' } })],
  ];

  for (const [name, { instance }] of cases)
    await assert.rejects(
      instance.verify({ artifact: lookup, expect }),
      /DNS could not be read/,
      `accepted ${name}`,
    );

  const down = dnsProvider({
    fetch: (() => Promise.reject(new Error('ECONNREFUSED 10.0.0.1'))) as unknown as typeof fetch,
  });

  // Why the resolver was unreachable is about this network, and is not passed on.
  await assert.rejects(down.verify({ artifact: lookup, expect }), /^Error: DNS could not be read$/);
});

test('a line in the well-known file proves the domain that serves it', async () => {
  const { instance, calls } = wellKnown(`https://other.test/u/1\r\n  ${expect}  \n`);

  assert.equal(instance.resolve!('Example.test'), file);
  assert.deepEqual(await instance.verify({ artifact: file, expect }), shown);

  assert.equal(calls[0]!.url, file);
  // Workers refuse 'error', so a redirect must come back as a response to be refused.
  assert.equal(calls[0]!.init?.redirect, 'manual');
  assert.ok(written(instance.instructions(expect)).includes('/.well-known/verily.txt'));
});

test('the holder cannot point the read at anything but the file', async () => {
  for (const artifact of [
    'http://example.test/.well-known/verily.txt',
    'https://example.test/.well-known/other.txt',
    'https://example.test/.well-known/verily.txt?x=1',
    'https://example.test:8443/.well-known/verily.txt',
    'https://user@example.test/.well-known/verily.txt',
    'https://127.0.0.1/.well-known/verily.txt',
    'https://printer.local/.well-known/verily.txt',
    'https://localhost/.well-known/verily.txt',
  ]) {
    const { instance, calls } = wellKnown(expect);

    await assert.rejects(instance.verify({ artifact, expect }), `accepted ${artifact}`);
    assert.deepEqual(calls, [], `fetched ${artifact}`);
  }

  // A deployment that named its hosts reads no others.
  const { instance, calls } = wellKnown(expect, {}, { hosts: ['mine.test'] });

  await assert.rejects(instance.verify({ artifact: file, expect }), /Not a host/);
  assert.deepEqual(calls, []);
});

test('a file that does not carry the line proves nothing', async () => {
  const cases: [string, ReturnType<typeof wellKnown>, RegExp][] = [
    ['missing line', wellKnown('nothing here'), /no line with this value/],
    ['the address inside a longer line', wellKnown(`see ${expect}`), /no line with this value/],
    ['a longer address', wellKnown(`${expect}0`), /no line with this value/],
    ['a missing file', wellKnown('', { status: 404 }), /unavailable/],
    [
      'a redirect',
      wellKnown(expect, { status: 301, headers: { location: 'https://elsewhere.test/' } }),
      /redirect/,
    ],
    // Markup that shows the line is an example of it.
    ['html', wellKnown(expect, { headers: { 'content-type': 'text/html' } }), /not plain text/],
  ];

  for (const [name, { instance }, why] of cases)
    await assert.rejects(instance.verify({ artifact: file, expect }), why, `accepted ${name}`);
});

test('a file too large to finish reading is unread, and its cut-off line is no match', async () => {
  const { instance } = wellKnown(
    `${'x'.repeat(40)}\n${expect}0`,
    {},
    { maxBytes: 41 + expect.length },
  );

  await assert.rejects(instance.verify({ artifact: file, expect }), /too large/);

  // Found before the cut, the line is there whatever follows it.
  const early = wellKnown(`${expect}\n${'x'.repeat(200)}`, {}, { maxBytes: 64 });

  assert.deepEqual(await early.instance.verify({ artifact: file, expect }), shown);
});

test('both methods name the subject by its address and need it to have one', () => {
  for (const instance of [dns([]).instance, wellKnown('').instance]) {
    assert.equal(instance.id, 'domain');
    assert.equal(instance.expect!(alice), alice.profileUrl);
    // A subject with no address has nothing to name, and is proved by a minted string
    // that says nothing of the site.
    assert.equal(instance.expect!(bob), undefined);
    assert.equal(instance.mint!('abc'), 'verily-proof=abc');
    assert.equal(instance.known!(shown as never), 'example.test');
    // A page on the domain is not the domain.
    assert.equal(instance.known!({ ...shown, kind: 'page' } as never), undefined);
  }

  const names = { site: 'Site', provider: 'Domain' };

  assert.equal(attestationLabel('dns', names), 'Published a proof in its DNS');
  assert.equal(attestationLabel('wellknown', names), 'Published a proof in a file it serves');
});

test('a domain is linked by its record, joined by its file, and unconfirmed once unread', async () => {
  let now = 1000000;
  let records = [alice.profileUrl];
  let body = alice.profileUrl;

  const answer = (url: string) =>
    url.startsWith('https://dns.google/')
      ? new Response(
          JSON.stringify({ Status: 0, Answer: records.map((data) => ({ type: 16, data })) }),
        )
      : new Response(body, { headers: { 'content-type': 'text/plain' } });

  const request = ((url: string) =>
    Promise.resolve(answer(String(url)))) as unknown as typeof fetch;

  const service = new VerilyService({
    storage: new MemoryStorage(),
    providers: [dnsProvider({ fetch: request }), wellKnownProvider({ fetch: request })],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
    now: () => now,
    validityMs: 30 * 86400000,
    recheckMs: 1000,
    freshnessMs: 5000,
  });

  const flow = await service.start(alice, undefined, 'connect', {
    provider: 'domain',
    method: 'dns',
  });

  assert.equal(flow.expect, alice.profileUrl);
  await service.submit(flow.flowId, flow.binding, 'Example.test');

  const id = (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;
  const evidence = await service.read(id);

  assert.deepEqual(evidence.external, shown);
  assert.equal(evidence.status, 'verified');

  // The file was already there, so the record carries it beneath the method that was asked for.
  assert.deepEqual(
    evidence.attestations.external.map((a) => [a.method, a.artifactUrl]),
    [
      ['dns', lookup],
      ['wellknown', file],
    ],
  );

  // The record is taken out of DNS: nothing is revoked, and it stops confirming.
  records = [];
  now += 6000;
  assert.equal(await service.recheck(), 1);
  assert.equal((await service.read(id)).status, 'unconfirmed');

  // Put back, it confirms again with nothing asked of the holder.
  records = [alice.profileUrl];
  body = '';
  now += 2000;
  assert.equal(await service.recheck(), 1);
  assert.equal((await service.read(id)).status, 'verified');
});

test('a subject with no address is proved by a minted record, kept across renewals', async () => {
  let now = 1000000;
  let records: string[] = [];
  const asked: string[] = [];

  const request = ((url: string) => {
    asked.push(String(url));

    return Promise.resolve(
      String(url).startsWith('https://dns.google/')
        ? new Response(
            JSON.stringify({ Status: 0, Answer: records.map((data) => ({ type: 16, data })) }),
          )
        : new Response('', { status: 404 }),
    );
  }) as unknown as typeof fetch;

  const service = new VerilyService({
    storage: new MemoryStorage(),
    providers: [dnsProvider({ fetch: request }), wellKnownProvider({ fetch: request })],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
    now: () => now,
    validityMs: 30 * 86400000,
    recheckMs: 1000,
    freshnessMs: 5000,
  });

  const choice = { provider: 'domain', method: 'dns' };
  const flow = await service.start(bob, undefined, 'connect', choice);

  // Unguessable, and silent about the site: DNS is read by anyone, and this subject's site
  // gave it no public page to name.
  assert.match(flow.expect!, /^verily-proof=[\w-]{20,}$/);
  assert.ok(!flow.expect!.includes('Site'));

  records = [flow.expect!];
  await service.submit(flow.flowId, flow.binding, 'example.test');

  const id = (await service.approve(flow.flowId, flow.binding, bob, 'unlisted'))!;

  assert.deepEqual((await service.read(id, bob)).external, shown);
  // A minted string is in no file the holder was not asked to put it in.
  assert.ok(!asked.includes(file));

  // The record is reread like any other standing proof.
  now += 2000;
  assert.equal(await service.recheck(), 1);

  // Renewing asks for the record already there, and finds it without asking for anything.
  const renewal = await service.start(bob, id, 'renew', choice, undefined, true);

  assert.equal(renewal.expect, flow.expect);
  assert.equal((await service.flow(renewal.flowId, renewal.binding)).phase, 'complete');

  // Another subject is given a string of its own, so one record proves one link.
  const other = await service.start(
    { ...bob, id: 'private-local-9' },
    undefined,
    'connect',
    choice,
  );

  assert.notEqual(other.expect, flow.expect);
  await service.submit(other.flowId, other.binding, 'example.test');
  assert.equal((await service.flow(other.flowId, other.binding)).phase, 'pending');
});

test('a proof of an address the subject no longer has is not kept as a minted one', async () => {
  let records = [alice.profileUrl];
  let body = '';

  const request = ((url: string) =>
    Promise.resolve(
      String(url).startsWith('https://dns.google/')
        ? new Response(
            JSON.stringify({ Status: 0, Answer: records.map((data) => ({ type: 16, data })) }),
          )
        : new Response(body, { headers: { 'content-type': 'text/plain' } }),
    )) as unknown as typeof fetch;

  const service = new VerilyService({
    storage: new MemoryStorage(),
    providers: [dnsProvider({ fetch: request }), wellKnownProvider({ fetch: request })],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
  });

  const dns = { provider: 'domain', method: 'dns' };
  const first = await service.start(alice, undefined, 'connect', dns);

  await service.submit(first.flowId, first.binding, 'example.test');

  const id = (await service.approve(first.flowId, first.binding, alice, 'unlisted'))!;

  // The site takes the subject's page away, so there is no address left to publish.
  const { profileUrl: _, ...hidden } = alice;

  // The same domain shown another way is not added to a record of the old address.
  const other = await service.start(hidden, undefined, 'connect', {
    provider: 'domain',
    method: 'wellknown',
  });

  assert.match(other.expect!, /^verily-proof=/);
  body = other.expect!;
  await service.submit(other.flowId, other.binding, 'example.test');

  const second = (await service.approve(other.flowId, other.binding, hidden, 'unlisted'))!;

  assert.notEqual(second, id);

  assert.deepEqual(
    (await service.read(id, hidden)).attestations.external.map((a) => [a.method, a.expect]),
    [['dns', alice.profileUrl]],
  );

  // A record first shown by a minted string does hold, and is joined. Its own proof of an
  // address goes the same way once the subject has none: replaced, never kept beside.
  const [minted] = (await service.read(second, hidden)).attestations.external;

  assert.deepEqual([minted.method, minted.minted], ['wellknown', true]);

  const named = await service.start(alice, undefined, 'connect', dns);

  await service.submit(named.flowId, named.binding, 'example.test');
  await service.approve(named.flowId, named.binding, alice, 'unlisted');

  const again = await service.start(hidden, undefined, 'connect', dns);

  records = [again.expect!];
  await service.submit(again.flowId, again.binding, 'example.test');
  await service.approve(again.flowId, again.binding, hidden, 'unlisted');

  assert.deepEqual(
    (await service.read(second, hidden)).attestations.external.map((a) => [a.method, a.expect]),
    [
      ['wellknown', other.expect],
      ['dns', again.expect],
    ],
  );
});

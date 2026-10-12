import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Change } from '../src/core/index.js';
import { VerilyService } from '../src/server/service.js';
import { alice, fakeProvider, MemoryStorage } from './helpers.js';

function fixture(notify = true, timeoutMs?: number) {
  let now = 1000000;
  const changes: Change[] = [];
  const storage = new MemoryStorage();

  // Set to make the next deliveries fail.
  const failing = { on: false };

  const service = new VerilyService({
    storage,
    providers: [fakeProvider()],
    baseUrl: 'https://site.test/api/verily',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
    now: () => now,
    validityMs: 1000,
    ...(timeoutMs ? { recheckTimeoutMs: timeoutMs } : {}),
    ...(notify
      ? {
          onChange: (change: Change) => {
            if (failing.on) throw new Error('Site is down');

            changes.push(change);
          },
        }
      : {}),
  });

  async function run(kind: 'connect' | 'renew', id?: string) {
    const flow = await service.start(alice, id, kind);
    const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

    await service.callback(state, flow.binding, 'code');

    return (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;
  }

  return {
    service,
    storage,
    changes,
    failing,
    run,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a new record, a renewal and a revocation are each reported once', async () => {
  const f = fixture();
  const id = await f.run('connect');

  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0]!.evidence.id, id);
  assert.equal(f.changes[0]!.evidence.status, 'verified');
  // The subject comes with its private id, which evidence leaves out.
  assert.equal(f.changes[0]!.local.id, alice.id);
  assert.equal(f.changes[0]!.previous, undefined);

  f.advance(100);
  await f.run('renew', id);

  assert.equal(f.changes.length, 2);
  assert.equal(f.changes[1]!.previous!.expiresAt, 1001000);
  assert.equal(f.changes[1]!.evidence.expiresAt, 1001100);

  await f.service.revoke(id, alice);

  assert.equal(f.changes.length, 3);
  assert.equal(f.changes[2]!.previous!.status, 'verified');
  assert.equal(f.changes[2]!.evidence.status, 'revoked');

  // Nothing has changed since, so there is nothing more to report.
  assert.equal(await f.service.announce(), 0);
  assert.equal(f.changes.length, 3);
});

test('a record that expires is reported by the next announce() or recheck()', async () => {
  const f = fixture();

  await f.run('connect');
  f.advance(1000);

  // Time alone changed the record, so nothing has been delivered yet.
  assert.equal(f.changes.length, 1);

  assert.equal(await f.service.announce(), 1);
  assert.equal(f.changes[1]!.previous!.status, 'verified');
  assert.equal(f.changes[1]!.evidence.status, 'expired');

  await f.service.recheck();
  assert.equal(f.changes.length, 2);
});

test('a delivery that fails does not fail the request, and is retried', async () => {
  const f = fixture();

  f.failing.on = true;
  const id = await f.run('connect');

  assert.equal((await f.service.read(id)).status, 'verified');
  assert.equal(f.changes.length, 0);

  f.failing.on = false;

  assert.equal(await f.service.announce(), 1);
  assert.equal(f.changes[0]!.evidence.id, id);
  assert.equal(f.changes[0]!.previous, undefined);
});

test('without onChange nothing is delivered and records are left as they were', async () => {
  const f = fixture(false);
  const id = await f.run('connect');

  assert.equal(await f.service.announce(), 0);

  const stored = await f.storage.transaction((tx) => tx.get('connections', id));

  assert.equal(stored!.reported, undefined);
});

test('a change made while another record is being delivered is not followed by an older state', async () => {
  const f = fixture();

  // Two records that have not been delivered yet.
  f.failing.on = true;
  const a = await f.run('connect');
  const b = await f.run('connect');

  f.failing.on = false;

  // Hold the first delivery open, as a slow site would.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const order: string[] = [];

  f.service.options.onChange = async (change) => {
    if (first) {
      first = false;
      await held;
    }

    order.push(`${change.evidence.id === a ? 'a' : 'b'} ${change.evidence.status}`);
  };

  const sweep = f.service.announce();

  // Let the sweep reach its first delivery, then revoke the other record.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const revoked = f.service.revoke(b, alice);

  release();
  await Promise.all([sweep, revoked]);

  // b is reported as revoked, and never as verified after that.
  assert.ok(order.includes('b revoked'));
  assert.ok(!order.slice(order.indexOf('b revoked')).includes('b verified'));
  assert.equal(await f.service.announce(), 0);
});

test('a record that keeps failing does not hold up the others', async () => {
  const f = fixture();

  f.failing.on = true;
  const a = await f.run('connect');
  const b = await f.run('connect');

  const got: string[] = [];
  let broken = '';

  f.service.options.onChange = (change) => {
    if (change.evidence.id === broken) throw new Error('Site is down');

    got.push(change.evidence.id);
  };

  // One record per run. Whichever is tried first fails every time.
  f.advance(1);
  broken = (await f.storage.transaction((tx) => tx.list('connections')))[0]!.id;
  assert.equal(await f.service.announce(undefined, 1), 0);

  f.advance(1);
  assert.equal(await f.service.announce(undefined, 1), 1);
  assert.deepEqual(got, [broken === a ? b : a]);

  // The failing one is still retried once it works.
  broken = '';
  f.advance(1);
  assert.equal(await f.service.announce(undefined, 1), 1);
  assert.equal(got.length, 2);
});

test('a delivery that may have arrived is sent again even if the state goes back', async () => {
  const f = fixture();
  const id = await f.run('connect');

  // What the receiver holds: the callback applies a change, then fails to acknowledge it.
  let held = '';
  let acknowledge = false;

  f.service.options.onChange = (change) => {
    held = change.evidence.mark ?? 'current';

    if (!acknowledge) throw new Error('Acknowledgment lost');
  };

  await f.service.mark(id, alice, 'unused');
  assert.equal(held, 'unused');

  // Back to the state last confirmed. The receiver still holds "unused".
  acknowledge = true;
  await f.service.mark(id, alice, 'current');

  assert.equal(held, 'current');
  assert.equal(await f.service.announce(), 0);
});

test('a callback that finishes after its deadline carries a lower revision than a newer one', async () => {
  const f = fixture(true, 20);

  // A receiver that keeps the last revision it applied, as the documentation asks.
  const held = { status: '', revision: 0 };
  let slow = true;
  const late: Promise<void>[] = [];

  f.service.options.onChange = (change) => {
    const apply = () => {
      if (change.revision <= held.revision) return;

      held.status = change.evidence.status;
      held.revision = change.revision;
    };

    if (!slow) return apply();

    // The first delivery applies long after the service has stopped waiting for it.
    slow = false;

    const done = new Promise<void>((resolve) =>
      setTimeout(() => {
        apply();
        resolve();
      }, 60),
    );

    late.push(done);

    return done;
  };

  const id = await f.run('connect');

  await f.service.revoke(id, alice);
  assert.equal(held.status, 'revoked');

  // The slow "verified" delivery finishes now, and the receiver ignores it.
  await Promise.all(late);
  assert.equal(held.status, 'revoked');
  assert.equal(await f.service.announce(), 0);
});

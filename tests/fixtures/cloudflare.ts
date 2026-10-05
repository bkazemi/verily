import type { DurableObjectState } from '@cloudflare/workers-types';
import { CloudflareStorage } from '../../cloudflare/storage.js';
import { VerilyStore as Store, type Env } from '../../cloudflare/worker.js';
import type { LocalAccount } from '../../src/core/index.js';

/** Test-only entry point; never included in the deployment bundle. */
export { default } from '../../cloudflare/worker.js';

/**
 * The worker's object with a door only tests reach, since nothing routes the host `probe`
 * to it: raw storage, the alarm on demand, and a failure injected around one revocation.
 */
export class VerilyStore extends Store {
  constructor(
    private readonly probe: DurableObjectState,
    env: Env,
  ) {
    super(probe, env);
  }

  protected override async revoke(id: string, local: LocalAccount) {
    const fault = await this.probe.storage.get<string>('test/fault');

    await this.probe.storage.delete('test/fault');

    if (fault === 'before') throw new Error('Injected before revoking');

    await super.revoke(id, local);

    if (fault === 'after') throw new Error('Injected after revoking');
  }

  override async fetch(request: Request) {
    const url = new URL(request.url);
    const storage = this.probe.storage;

    if (url.host !== 'probe') return super.fetch(request);

    if (url.pathname === '/put') {
      const { key, value } = (await request.json()) as { key: string; value: unknown };

      await storage.put(key, value);
    }

    if (url.pathname === '/alarm') await this.alarm();

    return Response.json(
      Object.fromEntries(await storage.list({ prefix: url.searchParams.get('prefix') ?? '' })),
    );
  }
}

/** Checks the storage adapter's own guarantees, apart from the worker. */
export class StorageProbe {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request) {
    const storage = new CloudflareStorage(this.ctx.storage);
    const path = new URL(request.url).pathname;

    if (path === '/rollback') {
      try {
        await storage.transaction(async (tx) => {
          await tx.put('audit', 'rollback', {
            id: 'rollback',
            action: 'test',
            actor: 'local',
            at: 0,
          });

          throw new Error('Expected rollback');
        });
      } catch {
        // Check persisted state in a new transaction below.
      }

      return Response.json(
        await storage.transaction(async (tx) => !(await tx.get('audit', 'rollback'))),
      );
    }

    if (path === '/increment') {
      const count = await storage.transaction(async (tx) => {
        const record = await tx.get('audit', 'counter');
        const at = (record?.at ?? 0) + 1;

        await tx.put('audit', 'counter', { id: 'counter', action: 'test', actor: 'local', at });

        return at;
      });

      return Response.json(count);
    }

    if (path === '/detached') {
      await storage.transaction(async (tx) => {
        const record = (await tx.get('audit', 'counter'))!;

        record.at = -1;
      });
    }

    return Response.json(await storage.transaction((tx) => tx.list('audit')));
  }
}

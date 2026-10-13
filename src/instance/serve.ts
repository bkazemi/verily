import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import { createInstance } from './index.js';
import { fromEnv, type InstanceEnv } from './env.js';
import { nodeListener } from './node.js';
import { PostgresStore } from './postgres.js';
import type { Store } from './store.js';

/** What the Node server reads besides the instance's own settings. */
export interface ServeEnv extends InstanceEnv {
  /** A Postgres connection string. The instance keeps everything in one table there. */
  DATABASE_URL?: string;
  /** Separates installations sharing a database. `verily` by default. */
  VERILY_NAMESPACE?: string;
  /** 3000 by default. */
  PORT?: string;
  /** 127.0.0.1 by default, for a proxy on the same machine that terminates TLS. */
  HOST?: string;
  /**
   * The header a proxy in front sets to the client's address, such as `X-Real-IP`. Rate
   * limits count by it. It must be one the proxy sets outright: a header a client can add
   * to, as `X-Forwarded-For` usually is, lets a client pick the address it is counted as.
   * Left out, the address is the connection's, which behind a proxy is the proxy's.
   */
  CLIENT_ADDRESS_HEADER?: string;
}

const hour = 3600000;

/**
 * Runs an instance on Node from its settings: Postgres for the store, plain HTTP for a
 * proxy to sit in front of, and upkeep once an hour. Resolves once it is listening.
 */
export async function serve(
  env: ServeEnv,
  /** A store to use instead of Postgres. */
  given?: Store,
): Promise<{ server: Server; close(): Promise<void> }> {
  const options = fromEnv(env);
  let store = given;
  let pool: Pool | undefined;

  if (!store) {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL must be set');

    pool = new Pool({ connectionString: env.DATABASE_URL });

    const postgres = new PostgresStore(pool, env.VERILY_NAMESPACE || 'verily');

    await postgres.migrate();
    store = postgres;
  }

  const instance = createInstance({ ...options, store });
  const header = env.CLIENT_ADDRESS_HEADER?.toLowerCase();

  const server = createServer(
    nodeListener(instance, {
      origin: options.origin,
      ...(header
        ? { address: (request) => String(request.headers[header] ?? '').trim() || null }
        : {}),
    }),
  );

  const upkeep = () => void instance.upkeep().catch(() => console.error('Verily upkeep failed'));
  const timer = setInterval(upkeep, hour);

  upkeep();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(env.PORT || 3000), env.HOST || '127.0.0.1', resolve);
  });

  return {
    server,
    async close() {
      clearInterval(timer);
      await new Promise((resolve) => server.close(resolve));
      await pool?.end();
    },
  };
}

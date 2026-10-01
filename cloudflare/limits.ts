import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { hash } from '../src/server/service.js';

interface Bucket {
  count: number;
  expiresAt: number;
}

/**
 * Requests a minute for one signed-in holder, one client without a session, one site's
 * holders, and one site's backend reading its subjects' connections.
 */
export const limits = { session: 60, client: 30, site: 600, read: 600 };

const windowMs = 60000;

/**
 * Counts a request against every bucket it falls in, and refuses it if any is full. All or
 * nothing, in one transaction, so a refused request spends nothing from the others.
 */
export async function allow(
  storage: DurableObjectStorage,
  buckets: { key: string; limit: number }[],
): Promise<boolean> {
  return storage.transaction(async (tx) => {
    const now = Date.now();
    const next: [string, Bucket][] = [];

    for (const { key, limit } of buckets) {
      const previous = await tx.get<Bucket>(`rate/${key}`);

      const bucket =
        previous && previous.expiresAt > now ? previous : { count: 0, expiresAt: now + windowMs };

      if (bucket.count >= limit) return false;

      next.push([`rate/${key}`, { ...bucket, count: bucket.count + 1 }]);
    }

    for (const [key, bucket] of next) await tx.put(key, bucket);

    return true;
  });
}

/** The bucket for a client with no session. The address is hashed, never stored as it is. */
export const client = (request: Request) =>
  `client/${hash(request.headers.get('cf-connecting-ip') ?? 'unknown')}`;

/**
 * Deletes every record the handoff and the limits leave behind once it has expired:
 * handoffs that never reached `/start`, site sessions, and idle buckets. Each is written
 * with its expiry under its own prefix for exactly this.
 */
export async function prune(storage: DurableObjectStorage): Promise<void> {
  const now = Date.now();

  for (const prefix of ['site/state/', 'site/session/', 'rate/']) {
    const expired = [...(await storage.list<{ expiresAt: number }>({ prefix })).entries()]
      .filter(([, value]) => !(value.expiresAt > now))
      .map(([key]) => key);

    // The storage API deletes at most 128 keys a call.
    for (let i = 0; i < expired.length; i += 128) await storage.delete(expired.slice(i, i + 128));
  }
}

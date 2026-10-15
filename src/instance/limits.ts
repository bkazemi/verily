import type { Store } from './store.js';
import { hash } from '../server/service.js';

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
  storage: Store,
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

/**
 * The bucket for a client with no session, by the address the host says the request came
 * from. The address is hashed, never stored as it is.
 */
export const client = (address: string | null) => `client/${hash(address ?? 'unknown')}`;

/**
 * Deletes every record the handoff and the limits leave behind once it has expired:
 * handoffs that never reached `/handoff/accept`, site and dashboard sessions, and idle
 * buckets. Each is written with its expiry under its own prefix for exactly this.
 */
export async function prune(storage: Store): Promise<void> {
  const now = Date.now();

  for (const prefix of ['site/state/', 'site/session/', 'site/dashboard/', 'rate/']) {
    for (const [key, value] of await storage.list<{ expiresAt: number }>(prefix))
      if (!(value.expiresAt > now)) await storage.delete(key);
  }
}

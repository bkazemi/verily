import type { DurableObjectStorage, DurableObjectTransaction } from '@cloudflare/workers-types';
import type { Storage } from '../src/core/index.js';
import { recordStorage, type KeyValue, type Store } from '../src/instance/store.js';

/** Values are copied on the way in and out, so a caller never shares one with storage. */
const keyValue = (storage: DurableObjectStorage | DurableObjectTransaction): KeyValue => ({
  get: async <T>(key: string) => structuredClone(await storage.get<T>(key)),
  put: (key, value) => storage.put(key, structuredClone(value)),
  delete: async (key) => {
    await storage.delete(key);
  },
  list: async <T>(prefix: string) =>
    [...(await storage.list<T>({ prefix })).entries()].map(
      ([key, value]) => [key, structuredClone(value)] as [string, T],
    ),
});

/** A Durable Object's storage as an instance store. It is SQLite-backed, not Workers KV. */
export function cloudflareStore(storage: DurableObjectStorage): Store {
  return {
    ...keyValue(storage),
    transaction: (work) => storage.transaction((tx) => work(keyValue(tx))),
  };
}

/** The library's record storage on a Durable Object. */
export class CloudflareStorage implements Storage {
  private readonly records: Storage;

  constructor(storage: DurableObjectStorage) {
    this.records = recordStorage(cloudflareStore(storage));
  }

  transaction: Storage['transaction'] = (work) => this.records.transaction(work);
}

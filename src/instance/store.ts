import type { Records, Storage } from '../core/index.js';

/** Reads and writes values by key. Values are plain JSON. */
export interface KeyValue {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every entry whose key starts with `prefix`. */
  list<T>(prefix: string): Promise<[string, T][]>;
}

/**
 * Where an instance keeps everything: the library's records and its own data, such as
 * owner sessions, site sessions, handoffs and rate limits. A host supplies one of these.
 *
 * `transaction` must run one at a time and write nothing if `work` rejects.
 */
export interface Store extends KeyValue {
  transaction<T>(work: (tx: KeyValue) => Promise<T>): Promise<T>;
}

/** The library's record storage, kept in a store under `verily/<kind>/<id>`. */
export function recordStorage(store: Store): Storage {
  return {
    transaction: (work) =>
      store.transaction((tx) =>
        work({
          get: <K extends keyof Records>(kind: K, id: string) =>
            tx.get<Records[K]>(`verily/${kind}/${id}`),
          put: (kind, id, value) => tx.put(`verily/${kind}/${id}`, value),
          delete: (kind, id) => tx.delete(`verily/${kind}/${id}`),
          list: async <K extends keyof Records>(kind: K) =>
            (await tx.list<Records[K]>(`verily/${kind}/`)).map(([, value]) => value),
        }),
      ),
  };
}

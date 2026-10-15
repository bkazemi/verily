import type { Storage } from '../core/index.js';
import { admit, createInstance, type Instance } from './index.js';
import { fromEnv, type InstanceEnv } from './env.js';
import { respond } from './page.js';
import { html } from '../server/html.js';
import { recordStorage, type KeyValue, type Store } from './store.js';

/**
 * The parts of Cloudflare's own types this file uses, written out here so the package
 * needs none of Cloudflare's to be installed. A Durable Object's real storage, state and
 * namespace each fit the one below.
 */
interface ObjectKeyValue {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

export interface ObjectStorage extends ObjectKeyValue {
  transaction<T>(work: (tx: ObjectKeyValue) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

export interface ObjectState {
  storage: ObjectStorage;
  blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T>;
}

interface ObjectNamespace {
  idFromName(name: string): unknown;
  // The id is whatever `idFromName` gave, which only Cloudflare's own types can name.
  get(id: never): { fetch(url: string, init: RequestInit): Promise<Response> };
}

/** The instance's settings, as vars and secrets, and the binding of the object that runs it. */
export interface Env extends InstanceEnv {
  VERILY: ObjectNamespace;
}

/** Values are copied on the way in and out, so a caller never shares one with storage. */
const keyValue = (storage: ObjectKeyValue): KeyValue => ({
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
export function cloudflareStore(storage: ObjectStorage): Store {
  return {
    ...keyValue(storage),
    transaction: (work) => storage.transaction((tx) => work(keyValue(tx))),
  };
}

/** The library's record storage on a Durable Object, for a Worker that embeds the backend. */
export class CloudflareStorage implements Storage {
  private readonly records: Storage;

  constructor(storage: ObjectStorage) {
    this.records = recordStorage(cloudflareStore(storage));
  }

  transaction: Storage['transaction'] = (work) => this.records.transaction(work);
}

const hour = 3600000;

/** The Worker: turns away what needs no storage, and passes the rest to the one object. */
export default {
  async fetch(request: Request, env: Env) {
    // Turned away here, a request never wakes the object.
    const admitted = await admit(request, env.PUBLIC_ORIGIN);

    if (admitted instanceof Response) return admitted;

    try {
      // One installation, with an identity that survives deployments and hostname changes.
      return await env.VERILY.get(env.VERILY.idFromName('site-owner') as never).fetch(
        admitted.url,
        {
          method: admitted.method,
          headers: Object.fromEntries(admitted.headers),
          body: admitted.method === 'POST' ? await admitted.arrayBuffer() : undefined,
          redirect: 'manual',
        },
      );
    } catch {
      return respond('Temporarily unavailable', html``, 503);
    }
  },
};

/** The instance on a Durable Object: its storage, an hourly alarm, and settings from `env`. */
export class VerilyStore {
  protected readonly instance: Instance;

  constructor(
    private readonly ctx: ObjectState,
    env: Env,
  ) {
    this.instance = createInstance({ ...fromEnv(env), store: cloudflareStore(ctx.storage) });

    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + hour);
    });
  }

  async alarm() {
    // Schedule first so transient cleanup failures never permanently stop maintenance.
    await this.ctx.storage.setAlarm(Date.now() + hour);
    await this.instance.upkeep();
  }

  fetch(request: Request): Promise<Response> {
    return this.instance.handle(request, request.headers.get('cf-connecting-ip'));
  }
}

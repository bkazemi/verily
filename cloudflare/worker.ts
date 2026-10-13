import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';
import { admit, createInstance, type Instance } from '../src/instance/index.js';
import { fromEnv, type InstanceEnv } from '../src/instance/env.js';
import { html } from '../src/instance/page.js';
import { cloudflareStore } from './storage.js';

/** The instance's settings, as vars and secrets, and the binding of the object that runs it. */
export interface Env extends InstanceEnv {
  VERILY: DurableObjectNamespace;
}

const hour = 3600000;

export default {
  async fetch(request: Request, env: Env) {
    // Turned away here, a request never wakes the object.
    const admitted = await admit(request, env.PUBLIC_ORIGIN);

    if (admitted instanceof Response) return admitted;

    try {
      // One installation, with an identity that survives deployments and hostname changes.
      return await env.VERILY.get(env.VERILY.idFromName('site-owner')).fetch(admitted.url, {
        method: admitted.method,
        headers: Object.fromEntries(admitted.headers),
        body: admitted.method === 'POST' ? await admitted.arrayBuffer() : undefined,
        redirect: 'manual',
      });
    } catch {
      return html('Temporarily unavailable', '', 503);
    }
  },
};

/** The instance on a Durable Object: its storage, an hourly alarm, and settings from `env`. */
export class VerilyStore {
  protected readonly instance: Instance;

  constructor(
    private readonly ctx: DurableObjectState,
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

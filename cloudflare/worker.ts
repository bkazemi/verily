import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';
import type { LocalKind } from '../src/core/index.js';
import {
  discordProvider,
  dnsProvider,
  emailProvider,
  pgpProvider,
  resendSender,
  youtubeProvider,
  githubLinkProvider,
  githubProvider,
} from '../src/server/index.js';
import { admit, createInstance, html, registry, type Instance } from '../src/instance/index.js';
import { cloudflareStore } from './storage.js';

export interface Env {
  VERILY: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
  SITE_NAME: string;
  /** What this deployment links: one of its accounts, a page, or the site. Defaults to account. */
  OWNER_KIND?: LocalKind;
  OWNER_LABEL: string;
  OWNER_REFERENCE: string;
  OWNER_PROFILE_URL: string;
  REPORT_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Discord sign-in is offered only when both are set. */
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /** YouTube sign-in is offered only when both are set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Email is offered only when both are set: a Resend API key, and the sender its codes
   * come from, as `Name <address>` or an address on a domain verified with Resend.
   */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** How many codes may be mailed in a day, where the mail allowance is not the default. */
  EMAIL_DAILY_LIMIT?: string | number;
  OWNER_KEY: string;
  /**
   * Public records are signed unless this is `off`. The key is made on first use and kept
   * in the object's storage, or is the secret `SIGNING_KEY` where one is set: an armored
   * key, which then outlives the deployment.
   */
  SIGNING?: string;
  SIGNING_KEY?: string;
  /**
   * The sites that send their users here instead of hosting Verily, as a JSON list of
   * `{ id, name, origin, authorizeUrl, returnUrl }`. Each needs its key in the secret
   * `SITE_<ID>_KEY`, such as `SITE_PARTNER_KEY`.
   */
  SITES?: string | unknown[];
  [key: `SITE_${string}_KEY`]: string | undefined;
}

/** The configured count of mailed messages a day, if it is a count at all. */
function dailyMail(configured: string | number | undefined): number | undefined {
  const count = Number(configured);

  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
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

/** The instance on a Durable Object: its storage, an hourly alarm, and config from `env`. */
export class VerilyStore {
  protected readonly instance: Instance;

  constructor(
    private readonly ctx: DurableObjectState,
    env: Env,
  ) {
    this.instance = createInstance({
      store: cloudflareStore(ctx.storage),
      origin: env.PUBLIC_ORIGIN,
      siteName: env.SITE_NAME,
      owner: {
        kind: env.OWNER_KIND,
        label: env.OWNER_LABEL,
        reference: env.OWNER_REFERENCE,
        profileUrl: env.OWNER_PROFILE_URL,
      },
      ownerKey: env.OWNER_KEY,
      reportUrl: env.REPORT_URL,
      // Two ways of showing one GitHub account. Whichever is used first is the record's
      // main method, and the other is listed beneath it once used. Discord, YouTube and
      // email are offered only when their secrets are set.
      providers: [
        githubProvider({
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
        }),
        githubLinkProvider(),
        // A domain shown by a record in its DNS, which is one fetch to a fixed resolver. The
        // file method reads a host the holder names, and a Worker cannot check where that
        // resolves, so it is not offered here.
        dnsProvider(),
        // A key needs no registration and no secret. A Worker cannot read a web key
        // directory safely, so an address on a key is shown only when the keyserver confirms it.
        pgpProvider(),
        ...(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
          ? [
              discordProvider({
                clientId: env.DISCORD_CLIENT_ID,
                clientSecret: env.DISCORD_CLIENT_SECRET,
              }),
            ]
          : []),
        ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? [
              youtubeProvider({
                clientId: env.GOOGLE_CLIENT_ID,
                clientSecret: env.GOOGLE_CLIENT_SECRET,
              }),
            ]
          : []),
        ...(env.RESEND_API_KEY && env.EMAIL_FROM
          ? [
              emailProvider({
                send: resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
              }),
            ]
          : []),
      ],
      sites: registry(env.SITES, env as unknown as Record<string, unknown>),
      signingKey: env.SIGNING === 'off' ? false : env.SIGNING_KEY,
      mailPerDay: dailyMail(env.EMAIL_DAILY_LIMIT),
    });

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

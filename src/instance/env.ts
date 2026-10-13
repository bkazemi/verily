import type { LocalKind } from '../core/index.js';
import {
  discordProvider,
  dnsProvider,
  emailProvider,
  githubLinkProvider,
  githubProvider,
  pgpProvider,
  resendSender,
  youtubeProvider,
} from '../server/index.js';
import type { InstanceOptions } from './index.js';
import { registry } from './sites.js';

/** The settings an instance reads, under the same names on every host. */
export interface InstanceEnv {
  /** The origin the instance is served from. HTTPS, with no trailing slash. */
  PUBLIC_ORIGIN: string;
  SITE_NAME: string;
  /** What the owner links: one of their accounts, a page, or the site. Defaults to account. */
  OWNER_KIND?: LocalKind;
  OWNER_LABEL: string;
  OWNER_REFERENCE: string;
  OWNER_PROFILE_URL: string;
  /** The secret the owner signs in with: at least 32 random bytes, base64url. */
  OWNER_KEY: string;
  REPORT_URL: string;
  /** GitHub sign-in is offered only when both are set. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
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
  /**
   * Public records are signed unless this is `off`. The key is `SIGNING_KEY` where one is
   * set, armored. Otherwise one is made on first use and kept in the store.
   */
  SIGNING?: string;
  SIGNING_KEY?: string;
  /**
   * The sites that send their users here instead of hosting Verily, as a JSON list of
   * `{ id, name, origin, authorizeUrl, returnUrl }`. Each needs its key in
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

/**
 * An instance's options from its settings. Every host builds them here, so two hosts given
 * the same settings offer the same methods and behave the same. The host adds the store.
 */
export function fromEnv(env: InstanceEnv): Omit<InstanceOptions, 'store'> {
  for (const name of [
    'PUBLIC_ORIGIN',
    'SITE_NAME',
    'OWNER_LABEL',
    'OWNER_REFERENCE',
    'OWNER_PROFILE_URL',
    'OWNER_KEY',
    'REPORT_URL',
  ] as const)
    if (!env[name]) throw new Error(`${name} must be set`);

  return {
    origin: env.PUBLIC_ORIGIN,
    siteName: env.SITE_NAME,
    owner: {
      // A site with no user accounts must not have its subject described as one.
      kind: env.OWNER_KIND || undefined,
      label: env.OWNER_LABEL,
      reference: env.OWNER_REFERENCE,
      profileUrl: env.OWNER_PROFILE_URL,
    },
    ownerKey: env.OWNER_KEY,
    reportUrl: env.REPORT_URL,
    // The same methods on every host, so only ones every host can run safely. The file
    // method and a web key directory read a host the holder names, and a Cloudflare Worker
    // cannot check where that resolves, so neither is offered.
    providers: [
      // Two ways of showing one GitHub account. Whichever is used first is the record's
      // main method, and the other is listed beneath it once used.
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? [
            githubProvider({
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
            }),
          ]
        : []),
      githubLinkProvider(),
      // A domain shown by a record in its DNS, which is one fetch to a fixed resolver.
      dnsProvider(),
      // A key needs no registration and no secret. An address on a key is shown only when
      // the keyserver confirms it.
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
    signingKey: env.SIGNING === 'off' ? false : env.SIGNING_KEY || undefined,
    mailPerDay: dailyMail(env.EMAIL_DAILY_LIMIT),
  };
}

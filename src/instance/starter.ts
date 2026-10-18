import { version } from '../version.js';

/** The package as a project depends on it: this release, and later ones compatible with it. */
const release = `^${version.slice(1)}`;

const wrangler = `// Your instance's Cloudflare settings. Fill in account_id and the vars below.
//
// Secrets are never set here. Use \`npx wrangler secret put NAME\` for OWNER_KEY, the
// secret you sign in with: at least 32 random bytes, base64url, such as the output of
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
//
// A link back from a GitHub profile, a DNS record and an OpenPGP signature are always
// offered. Each sign-in is offered once both of its secrets are set:
//   GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
//   DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET
//   GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (YouTube)
// Each app needs <PUBLIC_ORIGIN>/callback as a redirect.
// Email is offered once the RESEND_API_KEY secret and EMAIL_FROM below are set.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "verily",
  "account_id": "YOUR_CLOUDFLARE_ACCOUNT_ID",
  "main": "worker.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  // The library loads undici only on Node, so the Worker build gets a stand-in for it.
  "alias": { "undici": "@bkazemi/verily/instance/undici" },

  // Serve the backend from a host a reader can tie to the site making the
  // claim. Keep workers_dev true until the custom domain answers, then set it
  // false: the Worker rejects every origin except PUBLIC_ORIGIN, so only one
  // of the two can serve at a time.
  "workers_dev": true,
  // "routes": [{ "pattern": "verily.example.org", "custom_domain": true }],
  "preview_urls": false,
  "observability": { "enabled": false },

  // Keep the object name, binding and class identity stable across deploys:
  // changing them abandons the stored connections.
  "durable_objects": {
    "bindings": [{ "name": "VERILY", "class_name": "VerilyStore" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["VerilyStore"] }],

  "vars": {
    // Drives baseUrl, every evidenceUrl and the verifier name. HTTPS, no
    // trailing slash, and it must match the origin actually serving requests.
    "PUBLIC_ORIGIN": "https://verily.example.org",
    // The site whose local subject is being linked. This is a claim the
    // evidence attributes to the site, not something the backend demonstrates.
    "SITE_NAME": "example.org",
    // What is linked: "account", "page" or "site". Omit for an account.
    "OWNER_KIND": "site",
    "OWNER_LABEL": "your-handle",
    "OWNER_REFERENCE": "example.org author",
    "OWNER_PROFILE_URL": "https://example.org/about/",
    "REPORT_URL": "mailto:you@example.org",
    // The sender of emailed codes, on a domain verified with Resend. Email is offered
    // only when this and the RESEND_API_KEY secret are both set.
    // "EMAIL_FROM": "Verily <verify@example.org>",
    // Messages mailed in a day, across everyone. Omit for 100, Resend's free allowance.
    // "EMAIL_DAILY_LIMIT": 100,
    // Public records are signed with a key this installation makes and keeps. Set "off"
    // to sign nothing, or set the SIGNING_KEY secret to supply the key yourself.
    // "SIGNING": "off",
    // Sites that send their users here instead of hosting Verily; each also needs
    // its key as the secret SITE_<ID>_KEY.
    // "SITES": [
    //   {
    //     "id": "partner",
    //     "name": "partner.example",
    //     "origin": "https://partner.example",
    //     "authorizeUrl": "https://partner.example/verily/authorize",
    //     "returnUrl": "https://partner.example/verily/return",
    //     // Optional: the provider ids its holders may use. Omit for all of them.
    //     "providers": ["discord", "youtube"],
    //     // Optional: the visibilities its holders may choose. Omit for both.
    //     "visibility": ["unlisted"],
    //   },
    // ],
  },
}
`;

/**
 * The files of a project that runs an instance on Cloudflare. All of the instance is in the
 * package, so the project is its settings and one line that names the entry, and it takes
 * a new release by updating the dependency.
 */
export const cloudflareStarter: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'verily-instance',
      private: true,
      type: 'module',
      scripts: { dev: 'wrangler dev --local', deploy: 'wrangler deploy' },
      dependencies: { '@bkazemi/verily': release },
      devDependencies: { wrangler: '^4.132.0' },
    },
    null,
    2,
  )}\n`,
  'worker.ts': "export { default, VerilyStore } from '@bkazemi/verily/instance/cloudflare';\n",
  'wrangler.jsonc': wrangler,
  '.gitignore': 'node_modules\n.wrangler\n.dev.vars\n',
};

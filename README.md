<h1 align="center">
  <img src="docs/design/verily-logo-plate.svg" alt="Verily" width="320" />
</h1>

<p align="center">
  Let your users prove they own an account elsewhere, and show it on their profile with a badge anyone can check.
</p>

<p align="center">
  <a href="https://github.com/bkazemi/verily/actions/workflows/ci.yml"><img src="https://github.com/bkazemi/verily/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@bkazemi/verily"><img src="https://img.shields.io/npm/v/@bkazemi/verily" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

<p align="center">
  <img src="docs/images/badge.png" alt="A profile card with a Verily badge showing a GitHub account" width="480" />
</p>

Verily comes as a library you embed in your own backend, or as a ready-made server you run on Node or Cloudflare. A signed-in user of your site proves they control an external account, such as a GitHub account, a domain or an email address, by one of several [proof methods](#proof-methods). They approve the connection and choose who can read it. A public one is a record anyone can inspect, with a badge for their profile. An unlisted one is kept off public pages.

It doesn't sign anyone into your site, and it doesn't establish legal identity.

## Contents

- **Start here:** [How it works](#how-it-works) · [Ways to use it](#ways-to-use-it)
- **Embedding the backend:** [Install](#install) · [Embed the backend in your app](#embed-the-backend-in-your-app) · [Show the badge](#show-the-badge) · [Proof methods](#proof-methods) · [Operations](#operations)
- **Running an instance:** [Run an instance](#run-an-instance) · [A badge on a static site](#a-badge-on-a-static-site)
- **Using someone else's instance:** [Using a hosted instance](#using-a-hosted-instance)
- **Reference:** [Serving other sites](#serving-other-sites) · [Signed records](#signed-records) · [What DNS says of the verifier](#what-dns-says-of-the-verifier) · [Development](#development) · [License](#license)

## How it works

1. Your site tells Verily who is signed in. Verily never handles your logins.
2. The user opens Verily's connect dialog on your site, picks a method, and proves they control the external account.
3. They approve the connection and choose who can read it. Verily stores it, and publishes the evidence of a public one at a public URL.
4. A `<verily-badge>` on their profile shows the external account. Clicking it opens the evidence.
5. Verily keeps the record honest: published proofs are re-read, records expire, and either side can revoke.

## Ways to use it

Verily's backend comes in two forms, and a site can also use one that someone else runs.

- **Embed it in your app.** `createVerily` runs inside your backend and links your app's own accounts. Your app says who is signed in and registers with each sign-in provider. See [Embed the backend in your app](#embed-the-backend-in-your-app).
- **Run an instance.** `createInstance` is a complete app with one owner, who signs in with a key. Other sites can send their users to it. A running one is called an instance. See [Run an instance](#run-an-instance).
- **Use an instance someone else runs.** It holds the provider apps and the records. Your backend makes two calls. See [Using a hosted instance](#using-a-hosted-instance).

All three give your backend the same records, so the code that shows them stays the same if you switch.

## Install

```sh
npm install @bkazemi/verily
```

Requires Node.js 22.13+ or 24+. In Node, `@bkazemi/verily` exports the server. Browser bundlers get a browser-only entry with no server or database code. `@bkazemi/verily/instance` is the standalone backend, and `@bkazemi/verily/site` is the client for a site that uses someone else's instance. With TypeScript, use `moduleResolution: "NodeNext"` for the server and `"Bundler"` for the browser.

## Embed the backend in your app

### 1. Storage

```ts
import { Pool, PostgresStorage } from '@bkazemi/verily';

const storage = new PostgresStorage(
  new Pool({ connectionString: process.env.DATABASE_URL }),
);
// creates its one table if it doesn't exist
await storage.migrate();
```

Postgres ships with the package. Anything implementing the `Storage` interface in [`src/core/index.ts`](src/core/index.ts) works too.

### 2. Create the handler

```ts
import { createVerily, githubProvider } from '@bkazemi/verily';

const verily = createVerily({
  storage,
  providers: [
    githubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  baseUrl: 'https://community.example/api/verily',
  siteName: 'Example Community',
  verifierName: 'community.example',
  profileOrigins: ['https://community.example'],
  reportUrl: 'mailto:reports@community.example',
  authenticate: async (request) => {
    // your own session lookup
    const user = await getSignedInUser(request);
    if (!user) return undefined;

    return {
      // private, stable, never reused
      id: user.id,
      label: user.displayName,
      // public and durable; never an email
      reference: user.username,
      // optional
      profileUrl: `https://community.example/users/${user.username}`,
    };
  },
});
```

| Option           | Meaning                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `providers`      | How users prove an external account, as a list; see [Proof methods](#proof-methods).      |
| `baseUrl`        | The public URL you mount Verily at. Every route it serves is under this path.             |
| `siteName`       | Your site's name, shown on evidence.                                                      |
| `verifierName`   | Who vouches for the record, shown on evidence. Usually the backend's domain.              |
| `profileOrigins` | The origins a local `profileUrl` may be on, or a function returning them.                 |
| `reportUrl`      | Where readers report a bad record (`https:` or `mailto:`).                                |
| `authenticate`   | Returns the signed-in local account for a request, or `undefined` if nobody is signed in. |

Sign-in methods need an app registered with the provider. The callback URL is always `<baseUrl>/callback`, and every place you run Verily, development included, needs its own registered.

- **GitHub:** [register an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) and set its callback URL. An OAuth app has only one, so development and production each need their own app.
- **Discord:** create an application in the [Discord developer portal](https://discord.com/developers/applications) and add the callback URL under **OAuth2 → Redirects**. One application can list several. Discord shows the client secret only when you reset it.
- **YouTube:** in the [Google Cloud console](https://console.cloud.google.com/), enable the YouTube Data API v3, create an OAuth client of type **Web application**, and add the callback URL as an authorized redirect URI. One client can list several. The `youtube.readonly` scope is sensitive: until Google verifies your app, users see a warning and only 100 accounts can ever use it, so apply for verification before offering it publicly.

Pass the app's client id and secret to `githubProvider()`, `discordProvider()` or `youtubeProvider()`, and keep them on the server. The other methods need no registration.

### 3. Mount it

`verily.handle` takes a `Request` and returns a `Response`, so it plugs into any fetch-style router. For `node:http`, wrap it with `nodeHandler` and route the requests under `baseUrl` to it:

```ts
import { createServer } from 'node:http';
import { nodeHandler } from '@bkazemi/verily';

const handleVerily = nodeHandler(verily.handle, 'https://community.example');

createServer((req, res) => {
  if (req.url?.startsWith('/api/verily')) return handleVerily(req, res);
  // ...the rest of your site
}).listen(3000);
```

### 4. Let users connect an account

Put the connect pill on your settings page. Clicking it opens a dialog where the user picks a method, proves it and approves the connection, without leaving the page:

```html
<script src="/assets/verily.js" defer></script>
<verily-connect backend-url="/api/verily"></verily-connect>
```

A provider's sign-in opens in a small window, and the dialog carries on when the user returns. When a connection is recorded, the element fires `verily-result`, whose `detail` holds the new `connectionId`. The backend must be on the page's origin.

The full-page flow at `<baseUrl>/verify` still works, for links and for browsers without JavaScript. `<baseUrl>/mine` returns the user's connections as JSON, for your settings page.

**Public or unlisted.** At approval the user chooses who can read the connection; unlisted is the default. A public connection has an evidence page anyone can open, which is what a badge with a `connection-id` reads. An unlisted one has none. Its holder can make one sharing link at a time, good for 7 days (`shareTtlMs`), with `client.issueShare(id)`, and end it with `client.revokeShare(id)`. The user changes visibility at `<baseUrl>/visibility/<id>`, and `service.mine(account)` returns a user's own records, unlisted included.

Then schedule the upkeep described under [Operations](#operations).

## Show the badge

With a bundler:

```js
// also registers <verily-badge>
import { init } from '@bkazemi/verily';

const client = init({ backendUrl: '/api/verily' });
```

Without one, serve `node_modules/@bkazemi/verily/dist/verily.js` yourself, or load it from a CDN such as `https://cdn.jsdelivr.net/npm/@bkazemi/verily@0.8.1/dist/verily.js`. The script defines a global `Verily`.

Then place the badge wherever the account appears:

```html
<script src="/assets/verily.js" defer></script>
<verily-badge
  backend-url="/api/verily"
  connection-id="CONNECTION_ID"
></verily-badge>
```

Clicking the badge opens the verification details:

<p align="center">
  <img src="docs/images/dialog.png" alt="The verification details dialog: the local account, the linked GitHub account and when it joined, its status, how it was shown, and when it was approved and expires" width="448" />
</p>

A user with several accounts gets one badge for all of them. Give it every connection id, in any order:

```html
<verily-badge
  backend-url="/api/verily"
  connection-ids="ID_ONE ID_TWO ID_THREE"
></verily-badge>
```

It shows the first account connected, then a count of the rest, such as `+2`. Clicking it opens the details with one card per account. Only accounts verified now are counted, and an account on more than one record is shown once. The ids must all belong to the same user.

A holder can change the order. An account marked preferred leads the badge, and ones marked unused come last but still count. A retired account is kept as history: never counted, grouped at the foot of the details, and shown with the date it was last verified. A badge with only retired accounts is a quiet pill; to show nothing, leave retired records out.

On a desktop, hovering or focusing the badge opens a small panel naming up to eight of the accounts. It needs the Popover API. Add `peek="off"` to leave it out.

Add `stacked` to name the accounts in the badge itself, one to a row:

```html
<verily-badge
  backend-url="/api/verily"
  connection-ids="ID_ONE ID_TWO ID_THREE"
  stacked
></verily-badge>
```

<img src="docs/images/stacked.png" alt="A stacked badge listing four accounts, one to a row, then +2 more" width="213" />

It lists up to four verified accounts, then counts the rest, such as `+2 more`. It is as tall as its rows, so give it a line of its own. `mountBadges` and `presentConnections` take the same choices as `{ stacked: true }` and `{ peek: false }`.

With several accounts, each card shows the name, status and verifier, with the method and dates behind a Details toggle. Add `details-open`, or pass `{ detailsOpen: true }`, to start every card open.

The badge refreshes every 30 seconds and reads only public evidence. The client can also start and end connections, and draw a badge into your own element:

```js
// the connect dialog; call from a click
await client.openConnect();
// opens <baseUrl>/verify in a popup; call from a click
await client.connect({ provider: 'github' });
// draws once; call again to refresh
await client.mountBadge(element, { connectionId });
await client.disconnect(connectionId);
// or 'unused', 'current', 'retired'
await client.mark(connectionId, 'preferred');
```

`mark` acts on the account, across every record of it the user has. Preferring one account takes the mark from another. Retiring freezes its records: they are never rechecked or read as verified, cannot change visibility, and are kept until removed. Only a renewal by a record's first method brings it back.

To match your site's look, set any of these CSS variables on an ancestor: `--verily-surface`, `--verily-text`, `--verily-border`, `--verily-muted`, `--verily-hover`, `--verily-font-family`, `--verily-font-size`.

## Proof methods

```ts
import {
  githubProvider,
  discordProvider,
  youtubeProvider,
  githubGistProvider,
  linkProvider,
  githubLinkProvider,
  dnsProvider,
  wellKnownProvider,
  pgpProvider,
  emailProvider,
} from '@bkazemi/verily';
```

| Provider               | The user proves it by                                                                                        | Setup                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `githubProvider()`     | signing in with GitHub.                                                                                      | A GitHub OAuth app.                     |
| `discordProvider()`    | signing in with Discord.                                                                                     | A Discord application.                  |
| `youtubeProvider()`    | signing in with Google and choosing their YouTube channel.                                                   | A Google OAuth client.                  |
| `githubGistProvider()` | publishing a public gist containing a line Verily gives them.                                                | None.                                   |
| `linkProvider()`       | adding a `rel="me"` link to their profile on a page they control.                                            | The local account needs a `profileUrl`. |
| `githubLinkProvider()` | putting their profile URL in the website field of their GitHub profile, then entering their GitHub username. | The local account needs a `profileUrl`. |
| `dnsProvider()`        | adding a TXT record to their domain's DNS, then entering the domain.                                         | None.                                   |
| `wellKnownProvider()`  | serving a text file at a fixed path on their domain, then entering the domain.                               | None.                                   |
| `pgpProvider()`        | signing a line Verily gives them with their OpenPGP key, then pasting it and the key.                        | None.                                   |
| `emailProvider()`      | pressing a button, or entering a code, that Verily mails to their address.                                   | A function that sends one message.      |

Apart from the sign-ins and the mailed code, the user publishes the proof in their own time and comes back. A proof that fails can be fixed and resubmitted up to five times. Gists, link-backs, DNS records and files can be taken down later, so Verily re-reads them on a schedule. A PGP signature is kept by Verily and published at `<baseUrl>/connections/<id>/proof`.

**How old an account is.** Signing in with GitHub, Discord or YouTube also reads when the account was made. It is kept on the record as `external.createdAt`, in milliseconds, shown as "Joined" beside the account's name, and covered by a signed record. The other methods learn no date, so a record first shown by one of them has none until its holder also signs in. A provider of your own sets it by returning `createdAt` from `authenticate()`.

**Several at once.** List more than one, and `/verify` offers each method as its own button:

```ts
providers: [githubProvider({ clientId, clientSecret }), githubLinkProvider()],
```

Proving the same account a second way adds that proof to the existing record instead of creating another.

**Approval only where there is something to decide.** A new connection ends with the user choosing who can read it and confirming. A renewal, or a second proof of an account already linked, is recorded as soon as the proof checks out. That holds for flows started from your own pages. A flow entered through a link to `GET <baseUrl>/sessions` still ends on an approval, because any site can send a browser down a link.

If you call `service.start()` yourself, pass `true` as its last argument only when the request provably came from the user's own page, as a same-origin POST does. Without it the flow always ends on an approval.

**A link-back found at sign-in.** With `githubProvider()` and `githubLinkProvider()` both listed, signing in with GitHub also reads the profile that signed in. If its website field already links to the user's `profileUrl`, the approval step says so, and confirming records the link-back beside the sign-in. A link with `http://` in place of `https://` counts; a different host, port or path does not.

**Link-backs.** GitHub and Mastodon already mark profile links `rel="me"`. By default the page may be on any public host, and the account is named by the page's address. That needs Node, because Verily checks each connection so the address cannot point inside your network. Pass `hosts` to read only certain hosts (required on Cloudflare Workers), and `profile` to name the account by handle. Your own `fetch` replaces that network check, so it must enforce the same rule. Only `<a>` and `<link>` elements in HTML, or a `Link:` header, count; [`src/server/link.ts`](src/server/link.ts) has the exact rules.

**Domains.** `dnsProvider()` proves a domain, including one that serves no page. The user adds a TXT record named `_verily` whose value is their `profileUrl`, and enters the domain. Verily looks it up through `https://dns.google/resolve`, so it runs on Cloudflare Workers, and the evidence links to that lookup. `wellKnownProvider()` reads `https://<domain>/.well-known/verily.txt` instead. It fetches a host the user names, so it follows the link-back's rules: Node, or `hosts`. Both name the exact domain entered and say nothing about its subdomains. Where the resolver validated the answer with DNSSEC, the evidence says so. A local account with no `profileUrl` is given a random value, `verily-proof=…`, to publish instead, and a renewal asks for the same one. List both providers and a domain proved one way picks up the other if it is already there.

**Your own method.** A provider is an object, and [`src/core/index.ts`](src/core/index.ts) documents each shape. An artifact provider may also set `field` and `input` to name what it asks for, `resolve` to turn something short such as a username into the address to read, and `known` to say where to look for an account already on record. A sign-in provider's `authorizationUrl` is passed `account` on a renewal or visibility change, so it can ask for that account by name.

**OpenPGP.** The key's fingerprint is the identity. An email address is shown only when the key signed it **and** either keys.openpgp.org has confirmed it or the address's domain publishes the key in its [web key directory](https://datatracker.ietf.org/doc/draft-koch-openpgp-webkey-service/). The key must be valid when the proof is checked (not expired or revoked), SHA-1 signatures are refused, and a signing subkey must be properly bound to its key.

**Email.** Verily sends no mail itself. Give `emailProvider()` a `send` function and it hands it one message per flow, as HTML and plain text:

```ts
emailProvider({
  send: ({ to, subject, text, html, images }) =>
    mailer.send({
      from: 'verify@community.example',
      to,
      subject,
      text,
      html,
      // The logo travels in the message. Attach each image inline under
      // its content id.
      attachments: images.map((image) => ({
        filename: image.filename,
        content: Buffer.from(image.content, 'base64'),
        contentType: image.contentType,
        cid: image.contentId,
      })),
    }),
}),
```

The HTML loads nothing remote. Its one image, the Verily logo, is attached; a sender that drops `images` still sends a complete message.

The user types an address and Verily mails it a button, with an eight-character code beneath as the other way in. In the browser that started the flow, opening the link proves the mailbox. In any other browser the page asks for one press of **Confirm**, so a mail scanner that follows links confirms nothing. The link and the code last the flow's ten minutes, and the code gets five tries. The address is the account's name on the record, so a public link shows it to everyone; the user is told before the code is sent. Like a sign-in, it proves the mailbox could be read that day, and nothing is re-read later.

A visitor chooses where the message goes, so Verily sends at most 100 messages in twenty-four hours and 5 to any one address. Set `sendLimits: { day, address }` to change them, or `Infinity` to lift one. The day's count is shared, so also rate limit `POST <baseUrl>/sessions` and `POST <baseUrl>/flows/*/submit`.

`resendSender({ apiKey, from })` is a ready-made `send` for [Resend](https://resend.com), using only `fetch`:

```ts
emailProvider({
  send: resendSender({
    apiKey: process.env.RESEND_API_KEY!,
    from: 'Verily <verify@community.example>',
  }),
}),
```

**Matching accounts.** Two methods agree on an account when the provider's account ids match. A link-back only knows an address, so it's matched by profile URL instead, and only in flows the user starts themselves. Removing a connection from the external side always needs a matching provider account id.

## Run an instance

An instance runs on Cloudflare or on Node from the same settings. `PUBLIC_ORIGIN`, `SITE_NAME`, `OWNER_LABEL`, `OWNER_REFERENCE`, `OWNER_PROFILE_URL`, `REPORT_URL` and `OWNER_KEY` are required. `OWNER_KEY` is the secret you sign in with: at least 32 random bytes, base64url.

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

A link back from a GitHub profile, a DNS record and an OpenPGP signature are always offered. GitHub, Discord and YouTube sign-in and email are each offered once their secrets are set. Each sign-in app needs `<PUBLIC_ORIGIN>/callback` as a redirect. [`src/instance/env.ts`](src/instance/env.ts) lists every setting.

**On Cloudflare.**

```sh
npx @bkazemi/verily init cloudflare my-instance
cd my-instance && npm install
```

Fill in `wrangler.jsonc`, run `npx wrangler secret put OWNER_KEY`, then `npm run deploy`. To take a new release, update the dependency and deploy again.

**On Node.** Install the package, set the settings and `DATABASE_URL` in the environment, and run `npx verily serve`. It keeps everything in one Postgres table, which it creates, and listens on `127.0.0.1:3000` for a proxy that terminates TLS. `HOST` and `PORT` change where. Set `CLIENT_ADDRESS_HEADER` to the header your proxy sets to the client's address, such as `X-Real-IP`. Without it every visitor is counted as the proxy and shares one rate limit.

**In your own server.** `createInstance` from `@bkazemi/verily/instance` takes the same options and a store, and returns a request handler and an `upkeep()` to run hourly.

Cloudflare and `verily serve` both run the hourly upkeep themselves.

**Serving other sites.** List each site in `SITES`, as JSON, with `id`, `name`, `origin`, `authorizeUrl` and `returnUrl`, and put its key in `SITE_<ID>_KEY`. Give the site its id and key, and it uses the client under [Using a hosted instance](#using-a-hosted-instance). A site may also carry `providers` and `visibility`, to narrow what its users are offered.

## A badge on a static site

A static site only needs the script and the badge markup; the backend runs somewhere else over HTTPS. The quickest backend is an instance of your own on Cloudflare:

1. Set one up and deploy it, as [Run an instance](#run-an-instance) describes.
2. On the instance, sign in with `OWNER_KEY`, verify, and approve a **public** connection. Its id is on your settings page there, in the markup to embed.
3. Add the script and the badge to your site:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@bkazemi/verily@0.8.1/dist/verily.js"
  defer
></script>
<verily-badge
  backend-url="https://verily.your-site.example"
  connection-id="CONNECTION_ID"
></verily-badge>
```

Run the instance on a domain readers can connect to your site, because `PUBLIC_ORIGIN` is shown as the verifier. If your site sets a Content Security Policy, allow the instance in `connect-src`.

## Using a hosted instance

The instance's operator registers your site and gives you its id and a key. You register with no sign-in provider, store no records and run no backend. Your backend sends a signed-in user to the instance and reads their connections back.

You are trusting that operator. They can read every record made through their instance, unlisted ones included, and for sign-in and email methods a reader has only the operator's word that the account was verified. Link-back, gist and PGP proofs can be rechecked by anyone. A site that does not want to rely on an operator runs its own instance.

```ts
import { createSiteClient } from '@bkazemi/verily/site';

const verily = createSiteClient({
  instance: 'https://verily.example',
  site: 'your-site-id',
  key: process.env.VERILY_SITE_KEY,
});
```

The client has no dependencies and uses only Web Crypto and `fetch`, so it runs on Node, Next.js, Workers, Deno and Bun. Use it only on your backend: the key is what the instance believes.

When your key is replaced and the old one is kept for 24 hours, deploy with the new key as `key` and the old one as `previousKey`. A user who began before the switch comes back with a result signed with the old key, and `result()` accepts either. Nothing is signed with `previousKey`. Remove it on a later deploy, once the 24 hours are over.

**1. Mount the handler.** It serves the endpoints the instance and the pill need. Give it your own session lookup, and mount it on every path under one prefix:

```ts
const handle = verily.handler({
  authenticate: async (request) => {
    const user = await yourSession(request);
    if (!user) return undefined;

    return {
      // private and stable; the instance never shows it
      id: user.id,
      label: user.displayName,
      // durable and safe to show; never an email
      reference: user.handle,
    };
  },
  // where a signed-out user is sent
  signInUrl: '/login',
  // where a user lands when they come back
  returnUrl: '/settings',
});

// GET and POST /api/verily/*
app.all('/api/verily/*', (request) => handle(request));
```

The authorize and return URLs the instance's operator registers for you are `<prefix>/authorize` and `<prefix>/return`.

**2. Show the connect pill.** The user verifies in a dialog on your page, without leaving it. Only the provider's own sign-in opens in a small window:

```html
<script src="/assets/verily.js" defer></script>
<verily-connect
  backend-url="https://verily.example"
  handoff-url="/api/verily/handoff"
></verily-connect>
```

The element fires `verily-result` when a link is made, so read the user's connections again then.

Once a user has a link, show their badge in place of the pill, and give it the same two attributes. On the user's own page only: they mark the reader as the holder.

```html
<verily-badge
  connections="[...the records, as JSON...]"
  backend-url="https://verily.example"
  handoff-url="/api/verily/handoff"
></verily-badge>
```

The badge's dialog then has Renew and Remove under each account, the controls that mark or retire it, and Add account. Renew extends the record under the same id, so embeds keep working. It fires `verily-result` on each change. `verily.beginUrl('manage')` opens a user's links on the instance, for a site that would rather link there.

**3. Read connections where you show them.**

```ts
const { [user.id]: connections } = await verily.connections([user.id]);
const verified = connections.filter((c) => c.status === 'verified');
```

Show only `verified` records as verified. A `retired` record carries `retiredAt` and can be shown as history, never as a current account. `mark` is `preferred` or `unused` where the user set one; it is their ordering, not something checked.

To show them, hand the records to the badge. It draws them as given and fetches nothing, so it works for unlisted links, which a browser cannot read for itself:

```html
<verily-badge connections="[...the records, as JSON...]"></verily-badge>
```

From script, set the property instead: `badge.connections = records`. Send a page only the records its reader may see: whatever is in the page, the reader has. Several records become one badge, as under [Show the badge](#show-the-badge), and an unlisted one opens its details without linking anywhere.

Unlisted records are included, and only your site can read them. `connections()` takes any number of ids, so read a whole page of users in one call. Every call reads the instance, so a removed or expired link stops showing on the next page load. `cacheMs` reuses an answer for that long, during which a revoked connection still shows as verified, so leave it unset or keep it to a few seconds. `{ fresh: true }` makes one call read anyway.

If you would rather your user ids never left your site, give the client a secret:

```ts
const verily = createSiteClient({
  instance,
  site,
  key,
  idSecret: process.env.VERILY_ID_SECRET,
});
```

The instance is then sent a stand-in for each id, and for a subject with no `reference`. The same secret and user always give the same stand-in, so nothing is stored. The secret must never change, so keep one for this alone.

A site that would rather write its own endpoints can: `verily.authorize(state, subject)` signs the redirect handoff, `verily.handoff(subject)` the pill's, and `verily.result(token)` checks what a user returns with.

**Moving off someone else's instance.** To [run an instance](#run-an-instance) of your own, register your site with it and change the client's `instance`, `site` and `key`; the code above stays. To embed the backend, replace `verily.connections([id])` with `service.mine(account)`, which returns the same records, and the three steps above with the handler from [Embed the backend in your app](#embed-the-backend-in-your-app). Either way records are not moved, so users verify again.

## Serving other sites

One backend can serve sites that don't run Verily themselves, so none of them registers anything with a sign-in provider. An instance does this already, from its `SITES` setting. This section is for an embedded backend that does it itself. A subject from such a site names it in `LocalAccount.siteName`, and every page, proof line and record describing that subject uses the name in place of the `siteName` option. The backend stays the verifier.

Three options tie a flow to the site that sent the holder:

| Option                                   | Meaning                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context(request)`                       | What to store on a flow when it starts, such as which site sent the holder. Never called for removal from the external side.                                                 |
| `finish({ id, context, local, result })` | Where to send the holder once a flow has ended, or `undefined` for the result page. It runs each time the result page loads, so it must depend only on what it is given.     |
| `formTargets`                            | Origins `finish` may send a holder to. Browsers hold a form's redirects to `form-action`, and the approval form is what redirects, so these origins are added to the policy. |

Two more narrow what a subject is offered, for a backend whose sites don't all want the same. `providersFor(local)` returns the provider ids a subject may use: it is offered those alone, in that order, and a flow for any other is refused. `visibilityFor(local)` returns the visibilities it may choose: with one, the approval page states it and offers no choice.

`result` is recorded when the flow ends and never changes: its kind, how it ended, the connection and its visibility at that moment, and `finishedAt`. An instance is built on these hooks, and [`src/instance/sites.ts`](src/instance/sites.ts) is a worked example of them.

## Signed records

Evidence is normally believed because the verifier's own origin serves it. Set a signing key and each public record can also be downloaded as a file signed with OpenPGP, which anyone can check later with `gpg`, without the verifier being up.

```ts
import { createVerily, generateSigningKey } from '@bkazemi/verily';

// Make the key once and keep it with your other secrets. It is an armored
// OpenPGP private key, so it spans several lines.
console.log(await generateSigningKey('verifier.example'));

createVerily({
  // ...
  signingKey: process.env.VERILY_SIGNING_KEY,
});
```

With a key set:

- **`GET <baseUrl>/connections/<id>?format=signed`** returns the signed file for a public record that is currently verified: the record as JSON under an OpenPGP cleartext signature. It is signed when asked for, so it says the record stood at that moment. An unlisted, revoked or expired record has no signed form. A public retired record has one, signed as `version: 2` with `status: "retired"` and `retiredAt`, so a reader that knows only version 1 refuses it and never takes it for a record that stood.
- **`GET <baseUrl>/keys.asc`** is the public key as `gpg --import` reads it. **`GET <baseUrl>/keys`** lists the same keys as JSON, each with its fingerprint. An instance also serves that list at `/.well-known/verily-keys.json`.
- **`<baseUrl>/check`** is a page where a saved file can be pasted and read back.
- The evidence page links to the signed record. The badge's dialog checks the signature in the browser and shows a `signed` pill after the verifier. A record whose signature fails is shown as unconfirmed, with `bad signature` in the pill's place.
- The approval step tells the holder that a saved signed record outlives removal.

To check a file yourself:

```sh
curl https://verifier.example/api/verily/keys.asc | gpg --import
gpg --verify verily-<id>.asc
```

Or in code, which runs in a browser too:

```ts
import { verifySigned } from '@bkazemi/verily';

const { keys } = await (
  await fetch('https://verifier.example/api/verily/keys')
).json();
// undefined if no key signed it
const record = await verifySigned(file, keys);
```

A signed record proves what the verifier claimed and when (`issuedAt`). It does not prove the claim was true, and it does not say whether the record still stands: ask `evidenceUrl` for that. Save the keys with the file if it has to outlive the verifier's domain. When you change keys, list the old key from `/keys` in `retiredKeys` so what it signed still checks.

`generateSigningKey()` makes an Ed25519 key in the OpenPGP form GnuPG reads, with no subkeys. Any OpenPGP key that signs with its primary key works as `signingKey`; one that is revoked, expired or passphrase-protected is refused. Checking is done by OpenPGP.js under the format's own rules: a key is judged as it stood when the record was signed, so an expired key, or one revoked as retired or superseded, still answers for records it signed before then, and a key revoked as compromised signs nothing at all.

An instance signs by default, with a key it makes and stores itself. Set `SIGNING_KEY` to supply your own, or `SIGNING` to `off` to sign nothing.

## What DNS says of the verifier

Two TXT records let a reader check the verifier against DNS instead of taking its word. Both sit at `_verily.<domain>`, the name the domain method uses, and neither is required.

| Record                                  | Published on          | Says                                                    |
| --------------------------------------- | --------------------- | ------------------------------------------------------- |
| `verily-key=<fingerprint>`              | the verifier's domain | this OpenPGP key signs the verifier's records.          |
| `verily-verifier=<the verifier's host>` | a site's domain       | this verifier speaks for the site's accounts and pages. |

**The signing key.** A signed record is checked against keys the verifier's own server lists, so a reader has nowhere else to confirm them and nothing once the server is gone. Publish one `verily-key=` record for each key, current and retired, on the host in `baseUrl`. `GET <baseUrl>/keys` returns the exact records under `dns`. A reader then confirms the key against the domain, for as long as the domain is kept:

```ts
import { dnsKeys, signedBy, verifySigned } from '@bkazemi/verily';

// keys saved with the file, or from /keys
const record = await verifySigned(file, keys);
const named = await dnsKeys(new URL(record.evidenceUrl).hostname);

// the verifier's domain names the key that signed it
named.ids.includes(await signedBy(file));
// whether the resolver validated that answer
named.dnssec;
```

**The site's verifier.** A record's local side is the verifier's statement of what the site told it. On the site's own pages that is enough, since the site put the badge there. On a shared evidence link or a saved signed record, nothing shows the site chose this verifier. A site whose verifier is on another domain publishes `verily-verifier=<host>` on the domain of its `profileUrl`, with the port if `baseUrl` has one. `dnsVerifiers(domain)` reads it back. A verifier on the site's own domain, or a subdomain of it, needs no record and none is looked for.

Set `dns: true` and the backend reads both through `https://dns.google/resolve`, the resolver the domain method asks:

```ts
createVerily({
  // ...
  // or { fetch, timeoutMs }
  dns: true,
});
```

- The evidence page and `<baseUrl>/check` say the signing key is named in the verifier's DNS, with a link to the lookup, once it is. The answer is kept for ten minutes.
- When a link is approved, the site's domain is looked up. If it names this verifier, the record's local side carries the lookup as `artifactUrl` and the record as `expect`, the evidence reads "Stated by … whose DNS names this verifier" and links to the lookup, and the signed record includes it. `recheck()` reads each site again every `recheckMs`, one lookup for all of a site's records. A record loses the proof when the site stops naming the verifier, or when the lookup has gone unread for `freshnessMs`; its status is unaffected either way.

An instance sets `dns: true`.

## Operations

Verification lasts 30 days, flows 10 minutes, and sharing links 7 days. Change them with `validityMs`, `flowTtlMs` and `shareTtlMs`. Evidence is never cached.

A user's DNS setup is saved for seven days. If propagation outlasts a flow's ten minutes, they choose DNS again and get the same TXT value and the last domain entered. Each return reads the proof afresh. The TXT record has to stay after verification, for the ongoing checks.

Run the upkeep on a schedule, for example hourly. An instance does this itself.

```ts
setInterval(
  async () => {
    try {
      await verily.service.prune();
      // only needed if you use a method other than signing in
      await verily.service.recheck();
    } catch (error) {
      console.error('Verily upkeep failed', error);
    }
  },
  60 * 60 * 1000,
);
```

- **`prune()`** deletes expired flows and DNS drafts, and deletes expired or revoked records after 90 days. A retired record is kept until it is removed.
- **`recheck()`** re-reads gists, link-backs, DNS records and files that are due, up to 5 per provider per run (its `budget` argument), each every 24 hours (`recheckMs`). A read that finds the proof gone makes the connection unconfirmed at once. A read that fails, such as a timeout, changes nothing, and the proof stays current for 7 days after its last successful read (`freshnessMs`). Either way it is read again after a quarter of `recheckMs`, and the connection is verified again as soon as a read finds the proof. A provider of your own says a proof is gone by throwing `Absent` from `verify`. For PGP, it asks the keyserver whether the key has been revoked, and revokes the connection if so.

- **`onChange`** is an option, not a call. Set it to hear when a record's status, visibility, expiry or mark changes, so your site can update its own copy without polling:

  ```ts
  createVerily({
    // ...
    onChange: async ({ evidence, local, revision }) => {
      await db.saveConnectionIfNewer(local.id, evidence, revision);
    },
  });
  ```

  `evidence` is the record now, `local` is your subject with its private id, `previous` is what was last delivered, and `revision` counts that record's deliveries. Ignore a change whose `revision` is not higher than the last you applied, since a slow call can finish after a newer one. A change made by a request is delivered before the request returns, so keep the call quick. Changes that come with time alone, such as expiry, are delivered by `recheck()`, or by `service.announce()` if you do not recheck. Delivery is at least once: a call that throws is retried on the next run, and turning the option on reports every existing record once, 50 per run. A record removed by `prune()` is not reported.

**If you never call `recheck()`, set `freshnessMs: Infinity`.** Otherwise connections proved by gist, link-back, DNS record, file or PGP lapse after a week.

## Development

Clone the repository and run `npm ci`. `npm run preview` then shows the badge in every state at http://localhost:3001, with no other setup.

The full example also needs Postgres and a GitHub OAuth app, a Discord application or a Google OAuth client (any of them) with the callback URL `http://localhost:3000/api/verily/callback`:

```sh
npm run build
docker compose up -d --wait
# add credentials for at least one sign-in, and a long EXAMPLE_PASSWORD
cp example/.env.example .env
node --env-file=.env --import tsx example/server.ts
```

Checks and tests:

```sh
npm run build
npm run check
# npm run format fixes formatting
npm run format:check
npm test
TEST_DATABASE_URL=postgres://verily:verily@localhost:5432/verily npm test
npm run test:consumer
npm run starter:check
```

The Postgres and example tests only run when `TEST_DATABASE_URL` is set. The other tests use a fake provider and in-memory storage, so a live GitHub sign-in still has to be tried by hand. `test:consumer` installs the packed package into a separate project and checks its Node and browser imports. `starter:check` writes the project `verily init cloudflare` gives a new instance and bundles it as a deploy would, without deploying. CI runs all of it, Postgres included, on Node 22.13, 24 and 26.

## License

MIT. Signed records and `pgpProvider()` use [OpenPGP.js](https://github.com/openpgpjs/openpgpjs), which is LGPL-3.0-or-later. The badge script `verily.js` includes it, unmodified, to check signatures; its license is in [`docs/licenses/openpgp.txt`](docs/licenses/openpgp.txt).

<h1 align="center">
  <img src="docs/design/verity-logo-plate.svg" alt="Verity" width="320" />
</h1>

<p align="center">
  Let your users prove they own an account elsewhere, and show it on their profile with a badge anyone can check.
</p>

<p align="center">
  <a href="https://github.com/bkazemi/verity/actions/workflows/ci.yml"><img src="https://github.com/bkazemi/verity/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@bkazemi/verity"><img src="https://img.shields.io/npm/v/@bkazemi/verity" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

<p align="center">
  <img src="docs/images/badge.png" alt="A profile card with a Verity badge showing a GitHub account" width="480" />
</p>

Verity is a self-hosted library for Node.js. A signed-in user of your site proves they control an external account, by signing in with GitHub, publishing a gist, linking back with `rel="me"`, or signing with an OpenPGP key. They approve the connection, and Verity publishes it as a record anyone can inspect, with a badge for their profile.

It doesn't sign anyone into your site, and it doesn't establish legal identity.

## How it works

1. Your site tells Verity who is signed in. Verity never handles your logins.
2. The user opens `<baseUrl>/verify`, picks a method, and proves they control the external account.
3. They approve the connection. Verity stores it and publishes the evidence at a public URL.
4. A `<verity-badge>` on their profile shows the external account. Clicking it opens the evidence.
5. Verity keeps the record honest: published proofs are re-read, records expire, and either side can revoke.

## Two ways to use it

- **Run it yourself.** Your site hosts Verity beside its own backend and registers its own app with each sign-in provider. Everything from [Install](#install) to [Operations](#operations) is this. Nothing else is needed, and nothing depends on anyone else's server.
- **Use an instance someone else runs.** The instance holds the provider apps and the records, and your site registers nothing with any provider. Your backend makes two calls. See [Using a hosted instance](#using-a-hosted-instance).

Both give your backend the same records in the same shape, so the code that shows them does not change if you move from one to the other.

## Install

```sh
npm install @bkazemi/verity
```

Requires Node.js 22.13+ or 24+. In Node, `@bkazemi/verity` exports the server. Browser bundlers get a browser-only entry with no server or database code. With TypeScript, use `moduleResolution: "NodeNext"` for the server and `"Bundler"` for the browser.

## Set up the server

### 1. Storage

```ts
import { Pool, PostgresStorage } from '@bkazemi/verity';

const storage = new PostgresStorage(new Pool({ connectionString: process.env.DATABASE_URL }));
await storage.migrate(); // creates its one table if it doesn't exist
```

### 2. Create the handler

```ts
import { createVerity, githubProvider } from '@bkazemi/verity';

const verity = createVerity({
  storage,
  providers: [
    githubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  baseUrl: 'https://community.example/api/verity',
  siteName: 'Example Community',
  verifierName: 'community.example',
  profileOrigins: ['https://community.example'],
  reportUrl: 'mailto:reports@community.example',
  authenticate: async (request) => {
    const user = await getSignedInUser(request); // your own session lookup
    if (!user) return undefined;

    return {
      id: user.id, // private, stable, never reused
      label: user.displayName,
      reference: user.username, // public and durable; never an email
      profileUrl: `https://community.example/users/${user.username}`, // optional
    };
  },
});
```

| Option           | Meaning                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `provider`       | How users prove an external account. One provider or an array; see [Proof methods](#proof-methods). |
| `baseUrl`        | The public URL you mount Verity at. Every route it serves is under this path.                       |
| `siteName`       | Your site's name, shown on evidence.                                                                |
| `verifierName`   | Who vouches for the record, shown on evidence. Usually the backend's domain.                        |
| `profileOrigins` | The origins a local `profileUrl` may be on.                                                         |
| `reportUrl`      | Where readers report a bad record (`https:` or `mailto:`).                                          |
| `authenticate`   | Returns the signed-in local account for a request, or `undefined` if nobody is signed in.           |

Sign-in methods need an app registered with the provider, and each site running Verity registers its own. The callback URL is always `<baseUrl>/callback`, so for `baseUrl: 'https://example.com/api/verity'` it is `https://example.com/api/verity/callback`. The provider redirects only to URLs registered in advance, so each place you run Verity, a local one for development included, needs its callback registered.

- **GitHub:** [register an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) and set its callback URL. An OAuth app has only one, so development and production each need their own app.
- **Discord:** create an application in the [Discord developer portal](https://discord.com/developers/applications) and add the callback URL under **OAuth2 → Redirects**. One application can list several. Discord shows the client secret only when you reset it.
- **YouTube:** in the [Google Cloud console](https://console.cloud.google.com/), enable the YouTube Data API v3, create an OAuth client of type **Web application**, and add the callback URL as an authorized redirect URI. One client can list several. The `youtube.readonly` scope is sensitive: until Google verifies your app, users see an unverified-app warning and the project can only ever be used by 100 accounts, so apply for verification before offering it publicly. Reading the channel is free, within the default quota of 10,000 units a day.

Pass the app's client id and secret to `githubProvider()`, `discordProvider()` or `youtubeProvider()`, and keep them on the server. The other methods need no registration.

### 3. Mount it

`verity.handle` takes a `Request` and returns a `Response`, so it plugs into any fetch-style router. For `node:http`, wrap it with `nodeHandler` and route the requests under `baseUrl` to it:

```ts
import { createServer } from 'node:http';
import { nodeHandler } from '@bkazemi/verity';

const handleVerity = nodeHandler(verity.handle, 'https://community.example');

createServer((req, res) => {
  if (req.url?.startsWith('/api/verity')) return handleVerity(req, res);
  // ...the rest of your site
}).listen(3000);
```

### 4. Let users connect an account

Put the connect pill on your settings page. Clicking it opens a dialog where the user picks a method, proves it and approves the connection, without leaving the page:

```html
<script src="/assets/verity.js" defer></script>
<verity-connect backend-url="/api/verity"></verity-connect>
```

GitHub sign-in still happens on GitHub, in a small window. The dialog picks the flow back up when the user returns. When a connection is recorded, the element fires a `verity-result` event whose `detail` holds the new `connectionId`. The backend must be on the same origin as the page.

The full-page flow at `<baseUrl>/verify` still works, for links and for browsers without JavaScript. `<baseUrl>/mine` returns the user's connections as JSON, for your settings page.

Then schedule the upkeep described under [Operations](#operations).

## Show the badge

With a bundler:

```js
import { init } from '@bkazemi/verity'; // also registers <verity-badge>

const client = init({ backendUrl: '/api/verity' });
```

Without one, serve `node_modules/@bkazemi/verity/dist/verity.js` yourself, or load it from a CDN such as `https://cdn.jsdelivr.net/npm/@bkazemi/verity@0.0.10/dist/verity.js`. The script defines a global `Verity`.

Then place the badge wherever the account appears:

```html
<script src="/assets/verity.js" defer></script>
<verity-badge backend-url="/api/verity" connection-id="CONNECTION_ID"></verity-badge>
```

Clicking the badge opens the verification details:

<p align="center">
  <img src="docs/images/dialog.png" alt="The verification details dialog: the local account, the linked GitHub account, its status, and when it was approved, expires and was last checked" width="448" />
</p>

A user with several accounts gets one badge for all of them. Give it every connection id, in any order:

```html
<verity-badge backend-url="/api/verity" connection-ids="ID_ONE ID_TWO ID_THREE"></verity-badge>
```

It shows the account that was connected first, then how many more there are, such as `+2`. Clicking it opens the same details, with each account on its own card in the order they were connected. Only accounts that are verified now are counted, and one of those leads if the first has lapsed. An account that appears on more than one record, because it was shown a second way or removed and connected again, is shown once. The ids must all belong to the same user.

On a desktop, resting the pointer on that badge, or reaching it with the keyboard, opens a small panel beside it naming the accounts the number stands for: up to eight, then the rest as a count. The panel floats over the page, so nothing moves, and clicking still opens the details. It needs a browser with the Popover API; without one the badge simply has no panel. Add `peek="off"` to the badge to leave it out.

Add `stacked` to name the accounts in the badge itself, one to a row:

```html
<verity-badge
  backend-url="/api/verity"
  connection-ids="ID_ONE ID_TWO ID_THREE"
  stacked
></verity-badge>
```

It lists up to four verified accounts in the order they were connected, then counts the rest as `+2 more`. It is still one badge that opens the one set of details. It is as tall as its rows, so give it a line of its own. With one verified account it is the ordinary badge. `mountBadges` and `presentConnections` take the same choices as `{ stacked: true }` and `{ peek: false }`.

The badge refreshes every 30 seconds, and only ever reads public evidence. The client can also start and end connections, and draw a badge into an element of your own:

```js
await client.openConnect(); // the connect dialog; call from a click
await client.connect({ provider: 'github' }); // opens <baseUrl>/verify in a popup; call from a click
await client.mountBadge(element, { connectionId }); // draws once; call again to refresh
await client.disconnect(connectionId);
```

To match your site's look, set any of these CSS variables on an ancestor: `--verity-surface`, `--verity-text`, `--verity-border`, `--verity-muted`, `--verity-hover`, `--verity-font-family`, `--verity-font-size`.

## Proof methods

```ts
import {
  githubProvider,
  discordProvider,
  youtubeProvider,
  githubGistProvider,
  linkProvider,
  githubLinkProvider,
  pgpProvider,
} from '@bkazemi/verity';
```

| Provider               | The user proves it by                                                                 | Setup                                   |
| ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| `githubProvider()`     | signing in with GitHub.                                                               | A GitHub OAuth app.                     |
| `discordProvider()`    | signing in with Discord.                                                              | A Discord application.                  |
| `youtubeProvider()`    | signing in with Google and choosing their YouTube channel.                            | A Google OAuth client.                  |
| `githubGistProvider()` | publishing a public gist containing a line Verity gives them.                         | None.                                   |
| `linkProvider()`       | adding a `rel="me"` link to their profile on a page they control.                     | The local account needs a `profileUrl`. |
| `githubLinkProvider()` | putting their profile URL in the website field of their GitHub profile.               | The local account needs a `profileUrl`. |
| `pgpProvider()`        | signing a line Verity gives them with their OpenPGP key, then pasting it and the key. | None.                                   |
| `emailProvider()`      | entering a code Verity mails to their address.                                        | A function that sends one message.      |

All methods except the sign-ins and the mailed code let the user publish the proof in their own time and come back. Gists and link-backs can be taken down later, so Verity re-reads them on a schedule. A PGP signature is kept by Verity and published at `<baseUrl>/connections/<id>/proof`.

**Several at once.** List more than one, and `/verify` offers each method as its own button:

```ts
providers: [githubProvider({ clientId, clientSecret }), githubLinkProvider()],
```

Proving the same account a second way adds that proof to the existing record instead of creating another.

**Link-backs.** Many people already have one, since GitHub and Mastodon mark profile links `rel="me"`. By default the page may be on any public host, and the account is named by the page's address. This mode needs Node, because Verity checks every connection it makes to stop the page's address from pointing inside your network. Pass `hosts` to read only certain hosts (required on Cloudflare Workers), and `profile` to name the account by handle, as `githubLinkProvider()` does for github.com. If you pass your own `fetch`, it replaces that network check, so it must enforce the same rule itself. Only real `<a>` and `<link>` elements in HTML pages, or a `Link:` header, count; [`src/server/link.ts`](src/server/link.ts) has the exact rules.

**OpenPGP.** The key's fingerprint is the identity. An email address is shown only when the key signed it **and** either keys.openpgp.org has confirmed it or the address's domain publishes the key in its [web key directory](https://datatracker.ietf.org/doc/draft-koch-openpgp-webkey-service/). The key must be valid when the proof is checked (not expired or revoked), SHA-1 signatures are refused, and a signing subkey must be properly bound to its key.

**Email.** Verity sends no mail itself. Give `emailProvider()` a `send` function and it hands that one message per flow, written as both HTML and plain text, through whatever already sends your mail:

```ts
emailProvider({
  send: ({ to, subject, text, html, images }) =>
    mailer.send({
      from: 'verify@community.example',
      to,
      subject,
      text,
      html,
      // The logo travels in the message. Attach each image inline under its content id.
      attachments: images.map((image) => ({
        filename: image.filename,
        content: Buffer.from(image.content, 'base64'),
        contentType: image.contentType,
        cid: image.contentId,
      })),
    }),
}),
```

The HTML loads nothing from anywhere, so nothing in it is blocked and it tells nobody it was opened. Its one image, the Verity logo, is attached to the message; a sender that drops `images` still sends a whole message, with the word in the logo's place.

The user types an address and Verity mails it a button to press, with an eight-character code beneath it as the other way in. The button opens a page on your backend, in whatever browser the mail is read in, and pressing **Confirm** there proves the mailbox; the page the user started on then carries on to the approval. Opening the link alone confirms nothing, so a mail scanner that follows links cannot answer for anyone. Both the link and the code last the flow's ten minutes, and the code gets five tries. The address is the account's name on the record, so a public link shows it to everyone; the user is told before the code is sent. It proves somebody could read that mailbox on the day, like a sign-in, and nothing is published or re-read later.

A visitor chooses where the message goes, so Verity counts what it sends: at most 100 messages in any twenty-four hours, and at most 5 to any one address. Past either, the flow fails and tells the user to try again tomorrow. Set `sendLimits: { day, address }` beside `providers` to change them, or `Infinity` to lift one. The day's count is shared, so one visitor can still spend it; rate limit `POST <baseUrl>/sessions` and `POST <baseUrl>/flows/*/submit` as well.

`resendSender({ apiKey, from })` is a ready-made `send` for [Resend](https://resend.com), using only `fetch`:

```ts
emailProvider({
  send: resendSender({ apiKey: process.env.RESEND_API_KEY!, from: 'Verity <verify@community.example>' }),
}),
```

**Matching accounts.** Two methods agree on an account when the provider's account ids match. A link-back only knows an address, so it's matched by profile URL instead, and only in flows the user starts themselves. Removing a connection from the external side always needs a matching provider account id.

## A badge on a static site

A static site only needs the script and the badge markup; the backend runs somewhere else over HTTPS. The quickest backend is the Cloudflare Worker in this repository, which fits the free plan:

1. Clone this repository, run `npm ci`, and copy `wrangler.example.jsonc` to `wrangler.jsonc`. Fill in your account, origin and owner details.
2. Run `wrangler secret put` for `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OWNER_KEY`, then `npm run cloudflare:deploy`.
3. On the backend's site, sign in with `OWNER_KEY`, verify, and approve a **public** connection. Its id is listed at `/api/verity/mine`.
4. Add the script and the badge to your site:

```html
<script src="https://cdn.jsdelivr.net/npm/@bkazemi/verity@0.0.10/dist/verity.js" defer></script>
<verity-badge
  backend-url="https://your-backend.example/api/verity"
  connection-id="CONNECTION_ID"
></verity-badge>
```

Run the backend on a domain readers can connect to your site, because `PUBLIC_ORIGIN` is shown as the verifier. If your site sets a Content Security Policy, allow the backend in `connect-src`.

## Using a hosted instance

A site can use an instance someone else runs. The instance's operator registers your site and gives you its id and a key. You register nothing with any sign-in provider, store no Verity records and run no Verity backend. Your backend sends a signed-in user to the instance and reads their connections back.

```ts
import { createSiteClient } from '@bkazemi/verity/site';

const verity = createSiteClient({
  instance: 'https://verity.example',
  site: 'your-site-id',
  key: process.env.VERITY_SITE_KEY,
});
```

The client has no dependencies and uses only Web Crypto and `fetch`, so it runs on Node, Next.js, Workers, Deno and Bun. Use it only on your backend: the key is what the instance believes.

**1. Mount the handler.** It serves the endpoints the instance and the pill need. Give it your own session lookup, and mount it on every path under one prefix:

```ts
const handle = verity.handler({
  authenticate: async (request) => {
    const user = await yourSession(request);
    if (!user) return undefined;

    return {
      id: user.id, // private and stable; the instance never shows it
      label: user.displayName,
      reference: user.handle, // durable and safe to show; never an email
    };
  },
  signInUrl: '/login', // where a signed-out user is sent
  returnUrl: '/settings', // where a user lands when they come back
});

// GET and POST /api/verity/*
app.all('/api/verity/*', (request) => handle(request));
```

The authorize and return URLs the instance's operator registers for you are `<prefix>/authorize` and `<prefix>/return`.

**2. Show the connect pill.** The user verifies in a dialog on your page, without leaving it. Only the provider's own sign-in opens in a small window:

```html
<script src="/assets/verity.js" defer></script>
<verity-connect
  backend-url="https://verity.example/api/verity"
  handoff-url="/api/verity/handoff"
></verity-connect>
```

The element fires `verity-result` when a link is made, so read the user's connections again then.

Once a user has a link, show their badge in place of the pill, and give it the same two attributes. On the user's own page only: they mark the reader as the holder.

```html
<verity-badge
  connections="[...the records, as JSON...]"
  backend-url="https://verity.example/api/verity"
  handoff-url="/api/verity/handoff"
></verity-badge>
```

The badge's dialog then has Renew and Remove under each account, and Add account below them, which opens the verify flow in the dialog's place with a way back. It fires `verity-result` on each change. `verity.beginUrl('manage')` still opens a user's links on the instance, for a site that would rather link there.

**3. Read connections where you show them.**

```ts
const { [user.id]: connections } = await verity.connections([user.id]);
const verified = connections.filter((c) => c.status === 'verified');
```

To show them, hand the records to the badge. It draws them as given and fetches nothing, so it works for unlisted links, which a browser cannot read for itself:

```html
<verity-badge connections="[...the records, as JSON...]"></verity-badge>
```

From script, set the property instead: `badge.connections = records`. Send a page only the records its reader may see: whatever is in the page, the reader has. Several records become one badge, as under [Show the badge](#show-the-badge), and an unlisted one opens its details without linking anywhere.

Each record has the provider, the external account's handle and profile address, the visibility and the expiry. Unlisted records are included, and only your site can read them, so you can show a link to your own users without making it public. `connections()` takes any number of ids, so read a whole page of users in one call. Pass `cacheMs` to the client to reuse an answer for that long, and `{ fresh: true }` to a call that must not.

If you would rather your user ids never left your site, give the client a secret:

```ts
const verity = createSiteClient({ instance, site, key, idSecret: process.env.VERITY_ID_SECRET });
```

Every id you pass is then your own, and the instance is sent a stand-in. A subject with no `reference` gets one made the same way. The same secret and user always give the same stand-in, so nothing is stored. That secret must never change, so keep one for this alone.

A site that would rather write its own endpoints can: `verity.authorize(state, subject)` signs the redirect handoff, `verity.handoff(subject)` the pill's, and `verity.result(token)` checks what a user returns with.

**Moving to your own instance.** Hosting Verity yourself replaces `verity.connections([id])` with `service.mine(account)`, which returns the same records, and the three steps above with the handler from [Set up the server](#set-up-the-server). Records are not moved between instances, so users verify again.

## Serving other sites

One backend can serve sites that don't run Verity themselves, so none of them registers anything with a sign-in provider. A subject from such a site names it in `LocalAccount.siteName`, and every page, proof line and record describing that subject uses the name in place of the `siteName` option. The backend stays the verifier.

Three options tie a flow to the site that sent the holder:

| Option                                   | Meaning                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context(request)`                       | What to store on a flow when it starts, such as which site sent the holder. Never called for removal from the external side.                                                 |
| `finish({ id, context, local, result })` | Where to send the holder once a flow has ended, or `undefined` for the result page. It runs each time the result page loads, so it must depend only on what it is given.     |
| `formTargets`                            | Origins `finish` may send a holder to. Browsers hold a form's redirects to `form-action`, and the approval form is what redirects, so these origins are added to the policy. |

Two more narrow what a subject is offered, for a backend whose sites don't all want the same. `providersFor(local)` returns the provider ids a subject may use: it is offered those alone, in that order, and a flow for any other is refused. `visibilityFor(local)` returns the visibilities it may choose: with one, the approval page states it and offers no choice.

`result` is recorded when the flow ends and never changes: its kind, how it ended, the connection and its visibility at that moment, and `finishedAt`. The Cloudflare Worker uses these hooks to serve registered sites ([`cloudflare/sites.ts`](cloudflare/sites.ts)). The sites it serves use the client under [Using a hosted instance](#using-a-hosted-instance).

## Operations

Verification lasts 30 days, flows 10 minutes, and sharing links 7 days. Change them with `validityMs`, `flowTtlMs` and `shareTtlMs`. Evidence is never cached.

Run the upkeep on a schedule, for example hourly:

```ts
setInterval(
  async () => {
    try {
      await verity.service.prune();
      await verity.service.recheck(); // only needed if you use a method other than signing in
    } catch (error) {
      console.error('Verity upkeep failed', error);
    }
  },
  60 * 60 * 1000,
);
```

- **`prune()`** deletes expired flows, and deletes expired or revoked records after 90 days.
- **`recheck()`** re-reads gists and link-backs that are due, up to 5 per run (its `budget` argument). Each proof is re-read every 24 hours (`recheckMs`) and stays current for 7 days after its last successful read (`freshnessMs`); after that it shows as unconfirmed until a read succeeds. A failed read changes nothing. For PGP, it asks the keyserver whether the key has been revoked, and revokes the connection if so.

**If you never call `recheck()`, set `freshnessMs: Infinity`.** Otherwise connections proved by gist, link-back or PGP lapse after a week.

## Development

Clone the repository and run `npm ci`. `npm run preview` then shows the badge in every state at http://localhost:3001, with no other setup.

The full example also needs Postgres and a GitHub OAuth app, a Discord application or a Google OAuth client (any of them) with the callback URL `http://localhost:3000/api/verity/callback`:

```sh
npm run build
docker compose up -d --wait
cp example/.env.example .env   # add credentials for at least one sign-in, and a long EXAMPLE_PASSWORD
node --env-file=.env --import tsx example/server.ts
```

Checks and tests:

```sh
npm run build
npm run check
npm run format:check   # npm run format fixes formatting
npm test
TEST_DATABASE_URL=postgres://verity:verity@localhost:5432/verity npm test
npm run test:consumer
```

The Postgres and example tests only run when `TEST_DATABASE_URL` is set. The other tests use a fake provider and in-memory storage, so a live GitHub sign-in still has to be tried by hand. `test:consumer` installs the packed package into a separate project and checks its Node and browser imports. CI runs all of it, Postgres included, on Node 22.13, 24 and 26.

## License

MIT. `pgpProvider()` uses [OpenPGP.js](https://github.com/openpgpjs/openpgpjs), which is LGPL-3.0-or-later.

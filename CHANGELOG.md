# Changelog

Changes that matter to people using Verily, newest first. Versions before 0.7.0 are in the
[git history](https://github.com/bkazemi/verily/commits/v0.6.0).

## [0.9.0] - 2026-10-15

### Added

- **Sites can register themselves on an instance.** With `REGISTRATION=open`, a site
  registers at `/register` by publishing two DNS TXT records: a one-time claim, and
  `verily-verifier=<instance host>`, which stays up for as long as the site is served.
  The site gets a site key for its backend and a dashboard key for whoever manages it.
- **A dashboard for registered sites,** at `/site/dashboard`. An operator signs in with
  the site id and dashboard key to change the authorize and return URLs, providers and
  visibility, replace the site key, or delete the site.
- **A site key can be replaced without downtime.** The old key can be kept for 24 hours
  while the new one is deployed, or stopped at once if it may have leaked.
- **The site client takes `previousKey`,** so results signed with the old key are still
  accepted while a replaced key is kept.
- **The instance owner oversees registered sites** at `/sites`: suspends or unsuspends
  one by hand, sets its request limit, and approves it for YouTube.
- **A registered site whose DNS record goes is suspended, and deleted a month later.**
  It starts nothing new while suspended, but its backend can still read its connections.
  A deleted site's id is never given out again.
- **A self-registered site gets 60 requests a minute** instead of 600, until the owner
  raises it, and no YouTube until the owner approves it.

### Changed

- **`profileOrigins` may be a function** returning the origins, asked each time.

## [0.8.1] - 2026-10-14

### Changed

- **`/verify` lists several methods as one stack of equal buttons,** each with its
  provider's mark, as the connect dialog does.
- **Each `/verify` page says what proving control is for:** linking, renewing, changing
  visibility, removing a connection or revoking a sharing link. Changing visibility and
  revoking a sharing link have headings of their own.
- **The evidence, signed-record and approval pages have a tidier layout.**

### Fixed

- **Removing a connection from its evidence page offers only the record's own provider.**
  It offered every method, and named every kind of account as the one on the connection.

## [0.8.0] - 2026-10-14

### Added

- **The standalone backend is in the package.** `createInstance` from
  `@bkazemi/verily/instance` is the complete app that was the Cloudflare Worker in this
  repository: one owner who signs in with a key, registered sites, rate limits and upkeep.
  It takes a store and returns a request handler and `upkeep()`.
- **Instances run on Node.** `verily serve` runs one from the environment, with Postgres
  for storage. `PostgresStore` and `nodeListener` are exported for a server of your own.
- **A Cloudflare instance installs from npm.** `npx @bkazemi/verily init cloudflare <dir>`
  writes a project of four files that imports `@bkazemi/verily/instance/cloudflare`. It
  takes a new release by updating the dependency.
- **The `verily` command,** with `serve` and `init cloudflare`.
- **One set of settings for every host.** `fromEnv` reads the same names on Node and
  Cloudflare, so both offer the same methods.

### Changed

- **GitHub sign-in on an instance is optional.** It is offered when `GITHUB_CLIENT_ID` and
  `GITHUB_CLIENT_SECRET` are both set, like Discord and YouTube.
- **An instance names a missing setting.** It stops at startup with the name of a required
  setting that is not set.
- **An instance's settings page shows each connection as one card:** the account with its
  link, id and join date, its state, and its actions. Expiry reads as a date and a
  distance, such as "Nov 13, 2026 (in 30 days)".
- **Retiring an account or removing a connection asks first,** on a page of its own at
  `/confirm`.
- **`/records` groups connections by site,** live ones first, and draws each as the
  settings page does, join date included, with who it is linked to on a line of its own.
- **Server pages draw the badge's marks.** A card's heading shows the provider's mark, and
  a record's state shows the badge's V in the same colours: on an instance's cards, the
  evidence page's heading and each account's status line.
- **An instance's short pages, such as sign-in, sit centred in a narrower column.**
- **A refusal page links back to the start page.**

### Fixed

- **The embed snippet on an instance's settings page loads the badge script from the
  published package.** It named `/assets/verily.js`, a path on the site it was pasted
  into. It also has a copy button now.
- **Buttons on every Verily page use the page's font.** The stylesheet's `font` line for
  buttons was invalid, so browsers drew them in their default font.

### Removed

- **`wrangler.example.jsonc`.** `verily init cloudflare` writes the same settings file.

### Upgrading

- A Cloudflare instance deployed from a clone of this repository keeps working after a
  pull: `cloudflare/worker.ts` is still the entry. Deploy it with `npx wrangler deploy`,
  since the `cloudflare:deploy` script is gone.
- To move that instance to an installed project, run `init cloudflare` and copy your
  `account_id`, `name`, routes and `vars` into the new `wrangler.jsonc`. Keep `name`, the
  `VERILY` binding, the `VerilyStore` class and the `v1` migration as they are: the stored
  connections belong to that Worker and that class.

[Full changelog](https://github.com/bkazemi/verily/compare/v0.7.0...v0.8.0)

## [0.7.0] - 2026-10-12

### Added

- **Account age.** Signing in with GitHub, Discord or YouTube records when the account was
  created, as `external.createdAt`. Evidence pages and the badge dialog show it as "Joined"
  beside the account's name, and signed records cover it.
- **`onChange`.** A service option called when a record's status, visibility, expiry or
  mark changes. Each call carries a `revision` that goes up by one per record.
  `service.announce()` delivers changes that happen with time alone, such as expiry.
- **`Absent`.** An error a provider throws when a proof was read and is not there.
- **Saved DNS setup.** A DNS verification can be left and picked up again within seven days.
- **Signed pill.** A record's signature shows as a pill after its verifier.

### Changed

- **A missing proof is unconfirmed at once.** When a recheck reads a gist, page, file or DNS
  record and the proof is gone, the connection becomes unconfirmed on that read. Before, it
  stayed verified for up to `freshnessMs`. A read that fails still changes nothing.
- **`recheck(budget)` counts per provider.** The default of 5 is now 5 for each provider.
- **Failed and missing proofs are retried sooner,** after a quarter of `recheckMs`, and
  after proofs that have waited longer.
- **The Cloudflare instance rechecks every six hours,** up to 10 proofs per provider each
  hour. It was every 24 hours and 5 in total.

### Upgrading

- Connections whose proof is already gone will show as unconfirmed after the next recheck.
- A provider of your own keeps the old behaviour until it throws `Absent`.
- Existing records get a "Joined" date the next time their holder renews by signing in.

[Full changelog](https://github.com/bkazemi/verily/compare/v0.6.0...v0.7.0)

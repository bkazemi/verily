# Changelog

Changes that matter to people using Verily, newest first. Versions before 0.7.0 are in the
[git history](https://github.com/bkazemi/verily/commits/v0.6.0).

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

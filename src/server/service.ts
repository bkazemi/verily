import { createHash, randomBytes } from 'node:crypto';
import {
  fresh,
  freshnessMs,
  isArtifactProvider,
  isCodeProvider,
  isRedirectProvider,
  providerMethod,
  Refused,
  status,
  type ArtifactProvider,
  type CodeProvider,
  type Attestation,
  type Attestations,
  type Connection,
  type Evidence,
  type ExternalAccount,
  type Flow,
  type FlowResult,
  type Limit,
  type LocalAccount,
  type Mark,
  type Method,
  type Proved,
  type Provider,
  type Records,
  type RedirectProvider,
  type SignedDocument,
  type SignedEvidence,
  type Signer,
  type Storage,
  type Transaction,
  type VerifierKey,
  type Visibility,
  verifySigned,
} from '../core/index.js';
import {
  domainOf,
  keyRecord,
  namedKeys,
  namedVerifiers,
  published,
  type DnsOptions,
  type Published,
} from './domain.js';
import { signer } from './signing.js';

export const secret = () => randomBytes(32).toString('base64url');

export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

export class Unavailable extends Error {
  constructor() {
    super('Unavailable');
  }
}

export interface ServiceOptions {
  storage: Storage;
  /**
   * The methods this instance offers. Several may share a provider id: `githubProvider()`,
   * `githubGistProvider()` and `githubLinkProvider()` are three ways to show one GitHub
   * account, and a record shown by more than one keeps them all. The first is the default.
   */
  providers: Provider[];
  baseUrl: string;
  siteName: string;
  verifierName: string;
  profileOrigins: string[];
  validityMs?: number;
  flowTtlMs?: number;
  shareTtlMs?: number;
  /** How stale a published proof may be before it stops counting. Infinity never expires. */
  freshnessMs?: number;
  /** How often recheck() reads a given proof again. Must be well under freshnessMs. */
  recheckMs?: number;
  recheckTimeoutMs?: number;
  /**
   * How many messages a code provider may send in any twenty-four hours: in all, and to
   * any one address. A visitor chooses where a message goes, so the first bounds what one
   * of them can spend of the deployment's mail allowance and the second what an address
   * whose holder never asked can be sent. A hundred and five unless set; `Infinity` lifts
   * one. Each provider is counted on its own.
   */
  sendLimits?: { day?: number; address?: number };
  /**
   * Signs public records, so a saved signed record can be checked away from this
   * instance, with `gpg` or anything else that reads OpenPGP. A key from
   * `generateSigningKey()`, or a function giving one where it is read from storage.
   * Unset signs nothing. Losing the key puts every record it signed out of reach of a
   * check, so keep it wherever the instance's other secrets are kept.
   */
  signingKey?: string | (() => Promise<string>);
  /** Public keys this instance signed with before, so what they signed still checks. */
  retiredKeys?: VerifierKey[];
  /**
   * Reads what DNS says of this verifier, through the one resolver `dnsProvider()` asks.
   * Two statements are looked for, both TXT records at `_verily.<domain>`. On this
   * verifier's own domain, `verily-key=<fingerprint>` names a signing key, and the pages
   * that name the key then link to that lookup. On the domain of a subject's `profileUrl`,
   * `verily-verifier=<this verifier's host>` names this verifier as the site's own, and
   * the record's local side then carries that lookup as its proof. That one is read when a
   * link is approved and again by `recheck()`, and is not looked for where this verifier
   * is on the site's domain or a subdomain of it. Unset reads nothing.
   */
  dns?: boolean | DnsOptions;
  now?: () => number;
}

export class VerilyService {
  readonly now: () => number;
  readonly baseUrl: string;
  readonly providers: Provider[];

  constructor(readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.providers = options.providers;

    // A flow names its method by provider id and method, so that pair must say which.
    const keys = this.providers.map((p) => `${p.id} ${providerMethod(p)}`);

    if (!keys.length || new Set(keys).size !== keys.length)
      throw new Error('Configure each provider method once');

    const url = new URL(this.baseUrl);

    if (
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new Error('Use HTTPS (HTTP allowed on localhost)');

    for (const duration of [
      options.validityMs,
      options.flowTtlMs,
      options.shareTtlMs,
      options.recheckMs,
      options.recheckTimeoutMs,
    ]) {
      if (duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0))
        throw new Error('Invalid duration');
    }

    if (
      options.freshnessMs !== undefined &&
      options.freshnessMs !== Infinity &&
      (!Number.isSafeInteger(options.freshnessMs) || options.freshnessMs <= 0)
    )
      throw new Error('Invalid duration');

    if (this.freshness <= (options.recheckMs ?? 86400000))
      throw new Error('freshnessMs must exceed recheckMs');

    for (const limit of Object.values(this.sendLimits))
      if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit <= 0))
        throw new Error('Invalid send limit');
  }

  private signing?: Promise<Signer>;

  /** The key this instance signs with, read once. */
  private signer(): Promise<Signer> | undefined {
    const { signingKey } = this.options;

    if (signingKey === undefined) return undefined;

    this.signing ??= Promise.resolve(
      typeof signingKey === 'string' ? signingKey : signingKey(),
    ).then(signer);

    return this.signing;
  }

  /** Every key a record of this instance may be signed by: the current one first. */
  async keys(): Promise<VerifierKey[]> {
    const current = await this.signer();

    return [...(current ? [current.key] : []), ...(this.options.retiredKeys ?? [])];
  }

  /**
   * What this verifier's domain publishes to name its keys: one TXT record for each, all
   * under the one name. Nothing where it signs nothing, or is not on a domain at all.
   */
  async keyRecords(): Promise<{ name: string; values: string[] } | undefined> {
    const domain = domainOf(this.baseUrl);
    const keys = await this.keys();

    return domain && keys.length
      ? { name: `_verily.${domain}`, values: keys.map((key) => keyRecord(key.id)) }
      : undefined;
  }

  /**
   * Where a reader can see this verifier's domain name a key, if it was read doing so, and
   * which domain that was. It is always the domain this instance is on now: a record it
   * signed while on another names that one, and nothing here was asked about it. The
   * answer is kept for ten minutes, so a page that asks on every view costs one lookup.
   */
  async keyNamed(
    id: string,
  ): Promise<(Pick<Published, 'lookup' | 'dnssec'> & { domain: string }) | undefined> {
    const domain = domainOf(this.baseUrl);
    const found = domain && this.options.dns ? await this.lookedUp(domain, 600000) : undefined;

    // Read as `dnsKeys()` reads it, so a fingerprint published in lower case counts here too.
    return found && namedKeys(found.values).includes(id.toUpperCase())
      ? { domain: domain!, lookup: found.lookup, dnssec: found.dnssec }
      : undefined;
  }

  /** What each domain was last read publishing, and when. Nothing found is a failed read. */
  private readonly lookups = new Map<string, { at: number; found?: Published }>();

  /**
   * What a domain publishes for Verily, read again once the last read is older than
   * `maxAgeMs`. Nothing where it could not be read, which is never the same as nothing
   * published.
   */
  private async lookedUp(domain: string, maxAgeMs: number): Promise<Published | undefined> {
    const held = this.lookups.get(domain);

    if (held && this.now() - held.at < maxAgeMs) return held.found;

    const found = await this.deadline(
      published(domain, this.options.dns === true ? {} : this.options.dns || {}),
    ).catch(() => undefined);

    this.lookups.set(domain, { at: this.now(), found });

    return found;
  }

  /**
   * The domain whose DNS can say a subject's site chose this verifier, or nothing where
   * there is nothing to ask: no address, or a site this verifier shares a domain with,
   * since whoever holds a domain already holds every name beneath it.
   */
  private siteDomain(local: LocalAccount): string | undefined {
    const site = this.options.dns && local.profileUrl ? domainOf(local.profileUrl) : undefined;
    const own = new URL(this.baseUrl).hostname.toLowerCase();

    return site && site !== own && !own.endsWith(`.${site}`) && !site.endsWith(`.${own}`)
      ? site
      : undefined;
  }

  /**
   * The local side as a site's DNS bears it out: the site's word, with the lookup that
   * found the site naming this verifier. Nothing where it does not, or could not be read.
   */
  private stated(found: Published | undefined): Attestation | undefined {
    const own = new URL(this.baseUrl).host.toLowerCase();

    // Read as `dnsVerifiers()` reads it: a host is the same host in any case. What is kept
    // is the record as published, since that is what a reader finds at the lookup.
    const named = found && namedVerifiers(found.values).find(({ host }) => host === own);

    return found && named
      ? {
          by: 'backend',
          method: 'declared',
          confirmedAt: this.now(),
          artifactUrl: found.lookup,
          expect: named.record,
          ...(found.dnssec ? { dnssec: true } : {}),
        }
      : undefined;
  }

  /** The same keys as one armored text, which is what `gpg --import` takes. */
  async armoredKeys(): Promise<string> {
    return (await this.keys()).map((key) => key.publicKey.trim()).join('\n\n') + '\n';
  }

  /**
   * A public record that stands, signed as of now. Signed when asked for, not when
   * approved, so a signed record says the record stood on the day it was taken and none can be
   * made once it is removed.
   *
   * A retired record is signed too, as what it is: the durable form of the claim that the
   * account was the holder's when it was last proved. It did not stand when it was signed,
   * so it is a version of its own that says so, which a reader of the first refuses.
   */
  async signed(id: string): Promise<SignedEvidence> {
    const current = await this.signer();

    if (!current) throw new Unavailable();

    const {
      status,
      revokedAt: _revokedAt,
      signedUrl: _signedUrl,
      mark: _mark,
      retiredAt,
      ...record
    } = await this.read(id);

    const document = { type: 'verily-evidence' as const, issuedAt: this.now(), ...record };

    if (status === 'retired')
      return current.sign({ ...document, version: 2, status, retiredAt: retiredAt! });

    if (status !== 'verified') throw new Unavailable();

    return current.sign({ ...document, version: 1 });
  }

  /** What a signed record says, if this instance signed it. */
  async checked(signed: unknown): Promise<SignedDocument | undefined> {
    return verifySigned(signed, await this.keys());
  }

  private get sendLimits(): { day: number; address: number } {
    return {
      day: this.options.sendLimits?.day ?? 100,
      address: this.options.sendLimits?.address ?? 5,
    };
  }

  /** A proof is only as fresh as the schedule that reads it, so both live together. */
  private get freshness(): number {
    return this.options.freshnessMs ?? freshnessMs;
  }

  validateLocal(local: LocalAccount): LocalAccount {
    if (
      ![local.id, local.label, local.reference].every(
        (v) => typeof v === 'string' && v.length > 0 && v.length <= 500,
      )
    )
      throw new Error('Invalid local subject adapter result');

    if (local.kind !== undefined && !['account', 'page', 'site'].includes(local.kind))
      throw new Error('Invalid local subject kind');

    if (
      local.siteName !== undefined &&
      (typeof local.siteName !== 'string' || !local.siteName || local.siteName.length > 500)
    )
      throw new Error('Invalid local subject site name');

    if (local.profileUrl) {
      const url = new URL(local.profileUrl);

      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !this.options.profileOrigins.includes(url.origin)
      )
        throw new Error('Unregistered profile origin');
    }

    return structuredClone(local);
  }

  /** The site a subject belongs to: its own name where it has one, else this instance's. */
  siteOf(local: Pick<LocalAccount, 'siteName'>): string {
    return local.siteName ?? this.options.siteName;
  }

  /**
   * The configured method a caller asked for: a provider id and, where that provider is
   * shown more than one way, which way. Nothing asked for means the first configured.
   */
  resolve(provider?: string, method?: string): Provider {
    const found = this.providers.find(
      (p) =>
        (provider === undefined || p.id === provider) &&
        (method === undefined || providerMethod(p) === method),
    );

    if (!found) throw new Unavailable();

    return found;
  }

  /** The method a flow was started with. A flow from before methods were recorded ran the first. */
  providerOf(flow: Flow): Provider {
    return flow.provider === undefined
      ? this.providers[0]!
      : this.resolve(flow.provider, flow.method);
  }

  async start(
    local?: LocalAccount,
    connectionId?: string,
    kind: Flow['kind'] = 'connect',
    choice: { provider?: string; method?: string } = {},
    context?: Record<string, string>,
    /**
     * Whether the caller has shown the holder asked for this themselves, as a form posted
     * from their own page shows and following a link does not. Without it the flow reads
     * nothing at its start and ends on an approval, however little there is to approve.
     */
    attended = false,
  ) {
    if (kind === 'connect' && !local) throw new Unavailable();

    if (
      context !== undefined &&
      (typeof context !== 'object' ||
        Object.values(context).some((v) => typeof v !== 'string' || v.length > 500))
    )
      throw new Error('Invalid flow context');

    if (local) local = this.validateLocal(local);

    if (kind !== 'connect' && !connectionId) throw new Unavailable();

    const state = secret(),
      binding = secret(),
      verifier = secret();

    const flow: Flow = {
      id: hash(state),
      stateHash: hash(state),
      bindingHash: hash(binding),
      verifier,
      kind,
      local,
      connectionId,
      phase: 'pending',
      expiresAt: this.now() + (this.options.flowTtlMs ?? 600000),
      ...(attended ? { attended } : {}),
    };

    // Removal from the external side answers to nobody local, so nothing local rides on it.
    if (context && !['revoke', 'share-revoke'].includes(kind)) flow.context = { ...context };

    // The account a sign-in is asked for by name. Only where the local holder of the record
    // started the flow: removal from the external side is started by anyone, and is told
    // nothing about the account it would have to show.
    let account: ExternalAccount | undefined;

    const provider = await this.transaction(async (tx) => {
      // Whose link this is. A flow against an existing connection may carry no local
      // subject of its own, and the record is the authority on it in any case.
      let subject = local;

      let connection: Connection | undefined;

      if (kind !== 'connect') {
        connection = await tx.get('connections', connectionId!);

        // No account disclosure at entry; only the matching provider account can inspect later.
        if (
          !connection ||
          connection.revokedAt !== undefined ||
          (['visibility', 'renew'].includes(kind) && connection.local.id !== local?.id)
        )
          throw new Unavailable();

        // Who can read a retired record is frozen with the rest of it.
        if (kind === 'visibility' && connection.retiredAt !== undefined) throw new Unavailable();

        subject = connection.local;

        if (['renew', 'visibility'].includes(kind)) account = connection.external;
      }

      const provider = this.chosen(kind, choice, connection);

      flow.provider = provider.id;
      flow.method = providerMethod(provider);
      const artifact = isArtifactProvider(provider) ? provider : undefined;

      // Unguessable and per-flow, so an artifact published for one flow cannot complete
      // another, and naming the site means the holder can see what they are agreeing to
      // before they publish anything. A method that points back at the subject has no such
      // freedom: the subject's address is the whole claim, so that method states it here
      // and gives up per-flow uniqueness for a standing link that is read again on a
      // schedule instead.
      //
      // Where such a method has nothing of the subject's to state, it publishes a minted
      // string like any other, and then keeps the one it has: a flow the local holder runs
      // on their own record asks for the string already standing, as it would ask for the
      // same address, and not for a new record in DNS every time the link is renewed.
      //
      // Only a minted string is kept this way. A record that published an address the
      // subject no longer has is a proof of that address, and is not asked for again.
      if (artifact) {
        const stated = artifact.expect?.(subject!);

        const standing =
          artifact.expect && connection && ['renew', 'visibility'].includes(kind)
            ? connection.attestations?.external.find(
                (a) => a.method === artifact.method && a.minted,
              )?.expect
            : undefined;

        flow.expect =
          stated ??
          standing ??
          (artifact.mint
            ? artifact.mint(secret())
            : `Verily proof for ${this.siteOf(subject!)}: ${secret()}`);

        if (artifact.expect && stated === undefined) flow.minted = true;
      }

      // These kinds are all started by the local holder, whose own record this is. Removal
      // from the external side is started by anyone, and is told nothing.
      if (artifact?.known && ['connect', 'renew', 'visibility'].includes(kind)) {
        const suggested = connection
          ? artifact.known(connection.external)
          : await this.known(tx, subject!, artifact);

        if (suggested) flow.suggested = suggested;
      }

      await tx.put('flows', flow.id, flow);

      return provider;
    });

    const artifact = isArtifactProvider(provider) ? provider : undefined;

    // Where a record already says whose account this is, there is nothing to ask the
    // holder: the proof is either there to be read or it is not.
    if (artifact && flow.suggested && attended)
      await this.offered(flow.id, binding, artifact, flow.expect!, flow.suggested);

    // A redirect provider hands the holder to its own site; an artifact provider tells
    // them what to publish and waits for them to say where they put it; a code provider
    // has nothing to say until the holder names the address to send to.
    return artifact
      ? {
          flowId: flow.id,
          binding,
          expect: flow.expect!,
          instructions: artifact.instructions(flow.expect!),
        }
      : isRedirectProvider(provider)
        ? {
            flowId: flow.id,
            binding,
            authorizationUrl: provider.authorizationUrl({
              state,
              challenge: hash(verifier),
              redirectUri: `${this.baseUrl}/callback`,
              ...(account ? { account } : {}),
            }),
          }
        : { flowId: flow.id, binding };
  }

  /**
   * What a new flow can offer the holder to hand back: the one account this subject has
   * already shown some other way, which is the record the flow would join. With several,
   * which one they mean is theirs to say.
   */
  private async known(
    tx: Transaction,
    local: LocalAccount,
    provider: ArtifactProvider,
  ): Promise<string | undefined> {
    const offers = (await tx.list('connections'))
      .filter(
        (c) =>
          c.revokedAt === undefined &&
          c.retiredAt === undefined &&
          c.local.id === local.id &&
          c.provider === provider.id &&
          (c.attestations?.external[0].method ?? 'oauth') !== provider.method,
      )
      .map((c) => provider.known!(c.external))
      .filter((offer) => offer !== undefined);

    return new Set(offers.map((offer) => offer.toLowerCase())).size === 1 ? offers[0] : undefined;
  }

  /**
   * Reads the proof at the account a record already names, before the holder is asked for
   * anything. Found, the flow goes straight to approval, as if they had handed it back.
   * Not found is no failure: they have not been told what to publish yet, so the flow
   * stays where it was and tells them.
   */
  private async offered(
    id: string,
    binding: string,
    provider: ArtifactProvider,
    expect: string,
    suggested: string,
  ) {
    try {
      const handed = provider.resolve?.(suggested) ?? suggested;
      const found = await this.deadline(read(provider, { artifact: handed, expect }));

      await this.transaction(async (tx) => {
        const flow = await this.bound(tx, id, binding);

        flow.phase = 'exchanging';
        await tx.put('flows', id, flow);
      });

      await this.established(id, binding, found.account, handed, found.dnssec);
    } catch {
      await this.transaction(async (tx) => {
        const flow = await tx.get('flows', id);

        if (flow?.phase === 'exchanging') {
          flow.phase = 'pending';
          await tx.put('flows', id, flow);
        }
      });
    }
  }

  /**
   * Which method a flow runs. A flow on an existing record stays in that record's
   * namespace, and without a choice it uses the method the record was first shown by.
   *
   * Removing a link from the external side takes a method whose proof is fresh. A standing
   * proof, such as a link back, is there for anyone to point at: handing one back shows
   * the link exists, not that whoever handed it back holds the account.
   *
   * A retired record is renewed by the method it was first shown by and no other. Another
   * would be listed beneath a main proof nobody has read since, and the record would come
   * back unconfirmed.
   */
  private chosen(
    kind: Flow['kind'],
    choice: { provider?: string; method?: string },
    connection?: Connection,
  ): Provider {
    let provider: Provider;

    if (choice.provider === undefined && choice.method === undefined && connection) {
      const main = connection.attestations?.external[0].method ?? 'oauth';

      provider =
        this.providers.find((p) => p.id === connection.provider && providerMethod(p) === main) ??
        this.resolve(connection.provider);
    } else provider = this.resolve(choice.provider, choice.method);

    if (connection && provider.id !== connection.provider) throw new Unavailable();

    if (kind === 'renew' && connection && !revives(connection, provider)) throw new Unavailable();

    if (
      ['revoke', 'share-revoke'].includes(kind) &&
      isArtifactProvider(provider) &&
      provider.expect
    )
      throw new Unavailable();

    return provider;
  }

  /**
   * Accepts what the holder hands back: the address they published the flow's string at,
   * or the proof itself. Both are holder-supplied, so the provider decides what counts.
   * A code provider is handed two things in turn, the address to send to and then the
   * code that arrived there.
   */
  async submit(id: string, binding: string, artifact: string): Promise<string> {
    const asked = this.providerOf(await this.flow(id, binding));

    if (isCodeProvider(asked)) {
      await this.answer(id, binding, asked, artifact);

      return id;
    }

    const { provider, expect } = await this.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);
      const provider = this.providerOf(flow);

      if (flow.phase !== 'pending' || !flow.expect || !isArtifactProvider(provider))
        throw new Unavailable();

      flow.phase = 'exchanging';
      await tx.put('flows', id, flow);

      return { provider, expect: flow.expect };
    });

    try {
      // Kept as the address that was read, never as the shorthand that named it: it is
      // where a reader is sent, and what is read again later.
      const handed = provider.resolve?.(artifact) ?? artifact;
      const found = await read(provider, { artifact: handed, expect });

      await this.established(id, binding, found.account, handed, found.dnssec);
    } catch (error) {
      await this.refused(id, error, artifact);
    }

    return id;
  }

  /**
   * Takes a refused proof as something the holder can put right, and leaves the flow
   * waiting for it. What they must publish is minted per flow, so a flow ended here would
   * have them publish or sign all over again for a mistyped address. The tries are counted
   * all the same: each one is a fetch somewhere the holder chose.
   */
  private async refused(id: string, error: unknown, artifact: string) {
    await this.transaction(async (tx) => {
      const flow = await tx.get('flows', id);

      if (flow?.phase !== 'exchanging') return;

      flow.tries = (flow.tries ?? 0) + 1;
      // Only a `Refused` reason is kept: any other error may describe this backend.
      flow.reason = error instanceof Refused ? error.message : undefined;

      if (flow.tries >= artifactAttempts) await this.ended(tx, flow, 'failed');
      else {
        flow.phase = 'pending';
        flow.artifact = artifact;
      }

      await tx.put('flows', id, flow);
    });
  }

  /**
   * One step of a mailed code. The first answer is an address: a code is minted, sent
   * there, and only its hash kept. The second is the code, which the holder could only
   * have read at that address. The code is the whole proof and short enough to type, so
   * the guesses are counted and a flow that runs out of them is dead.
   */
  private async answer(id: string, binding: string, provider: CodeProvider, answer: string) {
    const step = await this.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (flow.phase !== 'pending') throw new Unavailable();

      if (!flow.sent) {
        // The record is the authority on whose link this is, as it is when a flow starts.
        const subject = flow.connectionId
          ? (await tx.get('connections', flow.connectionId))?.local
          : flow.local;

        if (!subject) throw new Unavailable();

        // Held here while the message is on its way, so the address is named only once.
        flow.phase = 'exchanging';
        await tx.put('flows', id, flow);

        // Removal from the external side is started by anybody who knows the record's id,
        // and the message goes wherever they say. Which site the record belongs to is not
        // theirs to read until the matching account is shown, so that message names this
        // installation, which says nothing about any one record.
        const siteName = ['revoke', 'share-revoke'].includes(flow.kind)
          ? this.options.verifierName
          : this.siteOf(subject);

        return { send: { siteName, expiresAt: flow.expiresAt } };
      }

      if (flow.sent.codeHash === codeHash(id, answer)) {
        const { account } = flow.sent;

        delete flow.sent;
        flow.phase = 'exchanging';
        await tx.put('flows', id, flow);

        return { account };
      }

      flow.sent.attempts += 1;

      if (flow.sent.attempts >= codeAttempts) {
        flow.reason = 'Too many wrong codes';
        await this.ended(tx, flow, 'failed');
      }

      await tx.put('flows', id, flow);

      return {};
    });

    try {
      if (step.account) await this.established(id, binding, step.account);

      if (!step.send) return;

      const account = provider.account(answer);

      if (!(await this.spend(provider, account)))
        throw new Refused('Too many messages have been sent today, so try again tomorrow');

      const code = mintCode();
      const token = secret();

      await provider.deliver({
        account,
        link: `${this.baseUrl}/confirm/${id}?token=${token}`,
        code,
        ...step.send,
      });

      await this.transaction(async (tx) => {
        const flow = await this.bound(tx, id, binding);

        if (flow.phase !== 'exchanging') throw new Unavailable();

        flow.sent = {
          account,
          codeHash: codeHash(id, code),
          linkHash: hash(token),
          attempts: 0,
        };

        flow.phase = 'pending';
        await tx.put('flows', id, flow);
      });
    } catch (error) {
      await this.failed(id, error);
    }
  }

  /**
   * Counts one message against the day's ceiling and the address's, and says whether both
   * had room. All or nothing, so a message refused by one spends nothing from the other.
   * Counted before the message goes, so one that fails to send is still spent: a sender
   * that is failing is not a reason to try it more often. The address is kept as a hash.
   */
  private async spend(provider: CodeProvider, account: ExternalAccount): Promise<boolean> {
    const { day, address } = this.sendLimits;

    const buckets = [
      { id: `send/${provider.id}/day`, limit: day },
      { id: `send/${provider.id}/to/${hash(account.id)}`, limit: address },
    ].filter(({ limit }) => limit !== Infinity);

    return this.transaction(async (tx) => {
      const now = this.now();
      const next: Limit[] = [];

      for (const { id, limit } of buckets) {
        const held = await tx.get('limits', id);

        const window =
          held && held.expiresAt > now ? held : { id, count: 0, expiresAt: now + dayMs };

        if (window.count >= limit) return false;

        next.push({ ...window, count: window.count + 1 });
      }

      for (const window of next) await tx.put('limits', window.id, window);

      return true;
    });
  }

  /**
   * The flow a confirmation link belongs to, while the link is still good. The link is
   * the whole credential and is used from wherever the holder reads their mail, so no
   * binding is asked for: it proves the mailbox and nothing else, and what happens to the
   * flow next is still up to the browser that started it.
   */
  private async linked(tx: Transaction, id: string, token: string): Promise<Flow> {
    const flow = await tx.get('flows', id);

    if (
      !flow ||
      flow.expiresAt <= this.now() ||
      flow.phase !== 'pending' ||
      flow.sent?.linkHash !== hash(token)
    )
      throw new Unavailable();

    return flow;
  }

  /**
   * What a confirmation link would confirm, to show its holder before they press anything.
   * The subject is named only for a new link, where the one who started the flow is the
   * one who named it. A flow on an existing record is started by anybody, and its subject
   * is nobody's to read until the matching account has been shown.
   */
  async confirming(id: string, token: string) {
    return this.transaction(async (tx) => {
      const flow = await this.linked(tx, id, token);

      return {
        kind: flow.kind,
        provider: this.providerOf(flow),
        account: flow.sent!.account,
        local: flow.kind === 'connect' ? flow.local : undefined,
      };
    });
  }

  /**
   * Takes a pressed confirmation link as the proof a typed code would have been, and
   * returns the flow as that left it. The link is spent either way.
   */
  async confirm(id: string, token: string): Promise<Flow> {
    const account = await this.transaction(async (tx) => {
      const flow = await this.linked(tx, id, token);
      const { account } = flow.sent!;

      delete flow.sent;
      flow.phase = 'exchanging';
      await tx.put('flows', id, flow);

      return account;
    });

    try {
      await this.established(id, undefined, account);
    } catch (error) {
      await this.failed(id, error);
    }

    return this.transaction(async (tx) => (await tx.get('flows', id))!);
  }

  private async bound(tx: Transaction, id: string, binding: string): Promise<Flow> {
    const flow = await tx.get('flows', id);

    if (!flow || flow.bindingHash !== hash(binding) || flow.expiresAt <= this.now())
      throw new Unavailable();

    return flow;
  }

  async flow(id: string, binding: string): Promise<Flow> {
    return this.transaction((tx) => this.bound(tx, id, binding));
  }

  async callback(state: string, binding: string, code?: string): Promise<string> {
    const id = hash(state);

    const claimed = await this.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (flow.phase !== 'pending' || !isRedirectProvider(this.providerOf(flow)))
        throw new Unavailable();

      if (code) flow.phase = 'exchanging';
      else await this.ended(tx, flow, 'cancelled');

      const verifier = flow.verifier!;

      delete flow.verifier;
      await tx.put('flows', id, flow);

      return { provider: this.providerOf(flow) as RedirectProvider, verifier };
    });

    if (!code) return id;

    try {
      const external = await claimed.provider.authenticate({
        code,
        verifier: claimed.verifier,
        redirectUri: `${this.baseUrl}/callback`,
      });

      await this.established(id, binding, external);
    } catch (error) {
      await this.failed(id, error);
    }

    return id;
  }

  /**
   * The identity is established the same way whichever method produced it, so both paths
   * land here: a provider result is never trusted for its shape, and a flow against an
   * existing connection must still be the same account on the same provider. No binding
   * means a confirmation link got here, which is held to the link and not to a browser.
   */
  private async established(
    id: string,
    binding: string | undefined,
    external: ExternalAccount,
    artifact?: string,
    dnssec = false,
  ) {
    if (
      typeof external.id !== 'string' ||
      !external.id ||
      typeof external.handle !== 'string' ||
      !external.handle ||
      typeof external.profileUrl !== 'string' ||
      // A mailbox has no page to point at, so its own address stands in for one.
      new URL(external.profileUrl).protocol !== (external.kind === 'mailbox' ? 'mailto:' : 'https:')
    )
      throw new Unavailable();

    // The flow as it stands once this account is accepted for it, or a refusal. Asked
    // twice, because what it is checked against can change while proofs are being read.
    const accepted = async (tx: Transaction) => {
      const flow =
        binding === undefined ? await tx.get('flows', id) : await this.bound(tx, id, binding);

      if (flow?.phase !== 'exchanging') throw new Unavailable();

      if (flow.kind !== 'connect') {
        const connection = await tx.get('connections', flow.connectionId!);

        if (
          !connection ||
          connection.provider !== this.providerOf(flow).id ||
          connection.revokedAt !== undefined
        )
          throw new Unavailable();

        if (!matches(flow.kind, connection.external, external))
          throw new Refused('This is a different account from the one this connection links');

        flow.local = connection.local;
      }

      flow.external = external;

      return flow;
    };

    // The account is named now, so a proof that needs nothing but its name can be read
    // without the holder choosing that method or handing anything back. Read while the
    // flow is still exchanging: approval is shown once, and must show all it will record.
    const shown = await this.transaction(accepted);
    const recorded = ['connect', 'renew'].includes(shown.kind);
    const standing = recorded ? await this.standing(shown) : [];

    // The site's own DNS is read here for the same reason: outside a transaction, and
    // before the approval that records what it said. A read a few minutes old will do.
    const site = recorded ? this.siteDomain(shown.local!) : undefined;
    const stated = site ? this.stated(await this.lookedUp(site, 300000)) : undefined;

    await this.transaction(async (tx) => {
      const flow = await accepted(tx);

      flow.artifact = artifact;
      flow.reason = undefined;
      flow.authenticatedAt = this.now();
      flow.dnssec = dnssec || undefined;
      flow.stated = stated;

      if (standing.length) flow.standing = standing;

      flow.phase = 'approval';

      // Nothing for the holder to decide, so nothing to ask them. The visibility passed is
      // never read: both of these keep the record's own.
      if (await this.settled(tx, flow)) await this.conclude(tx, flow, 'unlisted');
      else await tx.put('flows', id, flow);
    });
  }

  /**
   * The proofs already standing for the account a flow just showed, by the other methods
   * configured for its provider that can tell where to look from the account alone. One
   * that is not there, or cannot be read, is simply not found: the holder asked for none
   * of them, so none of them can fail the flow.
   */
  private async standing(flow: Flow): Promise<Attestation[]> {
    const shownBy = this.providerOf(flow);
    const found: Attestation[] = [];

    for (const provider of this.providers) {
      if (
        !isArtifactProvider(provider) ||
        provider.id !== shownBy.id ||
        provider.method === providerMethod(shownBy) ||
        provider.artifact !== 'location' ||
        !provider.expect ||
        !provider.known
      )
        continue;

      try {
        const expect = provider.expect(flow.local!);
        const known = provider.known(flow.external!);

        // A minted string is found nowhere the holder was not asked to put it.
        if (!known || expect === undefined) continue;

        const handed = provider.resolve?.(known) ?? known;

        const { account: external, dnssec } = await this.deadline(
          read(provider, { artifact: handed, expect }),
        );

        if (!sameAccount(flow.external!, external)) continue;

        found.push({
          by: 'provider',
          method: provider.method,
          confirmedAt: this.now(),
          artifactUrl: handed,
          expect,
          ...(dnssec ? { dnssec } : {}),
        });
      } catch {
        continue;
      }
    }

    return found;
  }

  /** Adds the proofs a flow found standing beneath the method the record was first shown by. */
  private recordStanding(connection: Connection, flow: Flow) {
    if (!flow.standing?.length || !connection.attestations) return;

    const [main, ...rest] = connection.attestations.external;

    for (const attestation of flow.standing) {
      // The main method is reread against the id it named, so it is only ever replaced
      // by a flow that ran it.
      if (attestation.method === main.method) continue;

      const at = rest.findIndex((a) => a.method === attestation.method);

      if (at < 0) rest.push(attestation);
      else rest[at] = attestation;
    }

    connection.attestations = { ...connection.attestations, external: [main, ...rest] };
  }

  /**
   * A sign-in or a mailed code that fails leaves the flow dead: there is nothing in it to
   * put right, and starting again costs the holder nothing. Only a `Refused` reason is
   * kept: any other error may describe this backend rather than the proof.
   */
  private async failed(id: string, error: unknown) {
    await this.transaction(async (tx) => {
      const flow = await tx.get('flows', id);

      if (flow?.phase === 'exchanging') {
        flow.reason = error instanceof Refused ? error.message : undefined;
        await this.ended(tx, flow, 'failed');
        await tx.put('flows', id, flow);
      }
    });
  }

  async approve(
    id: string,
    binding: string,
    local: LocalAccount | undefined,
    visibility: Visibility,
    cancel = false,
    /**
     * The visibilities this subject may choose, where it may not choose either. Checked at
     * the point the record's visibility is set, inside the transaction that decides whether
     * this approval makes a record or joins one, so no change in between gets past it.
     */
    allowed?: Visibility[],
  ) {
    if (!['public', 'unlisted'].includes(visibility)) throw new Unavailable();

    return this.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (
        !['revoke', 'share-revoke'].includes(flow.kind) &&
        (!local || local.id !== flow.local?.id)
      )
        throw new Unavailable();

      if (flow.phase === 'complete') return flow.resultId!;

      if (flow.phase !== 'approval') throw new Unavailable();

      if (cancel) {
        await this.ended(tx, flow, 'cancelled');
        await tx.put('flows', id, flow);

        return undefined;
      }

      return this.conclude(tx, flow, visibility, allowed);
    });
  }

  /**
   * Whether approving a flow would decide anything. A renewal, or another way of showing
   * an account the subject is already linked to, changes neither who is linked nor who
   * can read it: the holder asked for exactly this and the account has been checked
   * against the record, so it is recorded without asking them to say so again.
   */
  private async settled(tx: Transaction, flow: Flow): Promise<boolean> {
    // A flow anyone could have sent the holder's browser into is theirs only once they
    // approve it, and the approval is a form that only their own page can post.
    if (!flow.attended) return false;

    return flow.kind === 'renew' || (flow.kind === 'connect' && !!(await this.joins(tx, flow)));
  }

  /** Records what an approved flow does, and ends it. The caller has checked who approves. */
  private async conclude(
    tx: Transaction,
    flow: Flow,
    visibility: Visibility,
    allowed?: Visibility[],
  ): Promise<string> {
    const id = flow.id;

    {
      let connection: Connection;
      const provider = this.providerOf(flow);
      const joined = flow.kind === 'connect' ? await this.joins(tx, flow) : undefined;

      if (joined) {
        // Another way of showing an account this subject is already linked to. The record
        // keeps its id, its visibility and the method it was first shown by; this one is
        // added beneath it, and like a renewal it extends the record it just reproved.
        connection = joined;
        this.recordMethod(connection, flow, provider);
      } else if (flow.kind === 'connect') {
        if (allowed && !allowed.includes(visibility)) throw new Unavailable();

        // The id exists before the record does, because a hosted proof is addressed by it.
        const connectionId = secret();
        const mark = await this.accountMark(tx, flow.local!, provider.id, flow.external!);

        connection = {
          id: connectionId,
          local: flow.local!,
          external: flow.external!,
          provider: provider.id,
          visibility,
          visibilityApprovedAt: this.now(),
          authenticatedAt: flow.authenticatedAt!,
          approvedAt: this.now(),
          connectedAt: this.now(),
          expiresAt: this.now() + (this.options.validityMs ?? 30 * 86400000),
          attestations: {
            local: this.declared(flow),
            external: [this.attestation(flow, provider, connectionId)],
          },
          proof: hosted(provider) ? flow.artifact : undefined,
          // The account's other records say how the holder has it listed, and so does this.
          ...(mark ? { mark } : {}),
        };
      } else {
        const existing = await tx.get('connections', flow.connectionId!);

        if (
          !existing ||
          existing.revokedAt !== undefined ||
          !matches(flow.kind, existing.external, flow.external!)
        )
          throw new Unavailable();

        connection = existing;

        if (flow.kind !== 'renew') await this.invalidateShare(tx, connection.id);

        if (flow.kind === 'renew') {
          // Re-approval of the same pair extends the record rather than minting a new
          // id, so embeds and evidence urls published earlier keep resolving. The
          // subject snapshot refreshes because the holder just approved what it shows.
          if (flow.local!.id !== existing.local.id) throw new Unavailable();

          // Asked again here: the record may have been retired since the flow started.
          if (!revives(existing, provider)) throw new Unavailable();

          this.recordMethod(connection, flow, provider);

          if (connection.retiredAt !== undefined) {
            // Live again on the strength of the proof just made and nothing older. A record
            // made for the account while this one sat retired may have been marked since,
            // and this one would otherwise be drawn in its place and hide that choice.
            const mark = await this.accountMark(
              tx,
              connection.local,
              connection.provider,
              connection.external,
              connection.id,
            );

            delete connection.retiredAt;
            delete connection.mark;

            if (mark) connection.mark = mark;
          }
        } else if (flow.kind === 'revoke') {
          connection.revokedAt = this.now();
          connection.revocationReason = 'external';
        } else if (flow.kind === 'visibility') {
          if (allowed && !allowed.includes(visibility)) throw new Unavailable();

          if (connection.retiredAt !== undefined) throw new Unavailable();

          connection.visibility = visibility;
          connection.visibilityApprovedAt = this.now();
        }
      }

      if (['connect', 'renew'].includes(flow.kind)) this.recordStanding(connection, flow);

      await tx.put('connections', connection.id, connection);

      await this.audit(
        tx,
        connection.id,
        flow.kind,
        ['revoke', 'share-revoke'].includes(flow.kind) ? 'external' : 'local',
        id,
        connection.visibility,
      );

      flow.resultId = connection.id;
      await this.ended(tx, flow, 'complete', connection);
      await tx.put('flows', id, flow);

      return connection.id;
    }
  }

  /**
   * Ends a flow and records how, inside the transaction that ends it: the connection as it
   * stands now, since whatever later reports this result must not read a record that has
   * changed since. The caller puts the flow.
   */
  private async ended(
    tx: Transaction,
    flow: Flow,
    phase: FlowResult['phase'],
    connection?: Connection,
  ) {
    connection ??= flow.connectionId ? await tx.get('connections', flow.connectionId) : undefined;

    flow.phase = phase;

    flow.result = {
      kind: flow.kind,
      phase,
      ...(connection ? { connectionId: connection.id, visibility: connection.visibility } : {}),
      finishedAt: this.now(),
    };
  }

  /** Every read of a connection goes through here, so a record in an older shape is upgraded. */
  private transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.options.storage.transaction((tx) => work(upgraded(tx)));
  }

  /**
   * The methods a reader is shown. An additional method whose proof has gone unread no
   * longer shows anything, so it is left out until it reads again; the main one is
   * never left out, because the record's status already says what became of it.
   */
  private shown(connection: Connection): Attestations {
    if (!connection.attestations)
      // Records written before methods were stored still have a known method: the site
      // declared its subject and the provider ran the redirect flow, the only one built.
      return {
        local: { by: 'backend', method: 'declared', confirmedAt: connection.approvedAt },
        external: [{ by: 'provider', method: 'oauth', confirmedAt: connection.authenticatedAt }],
      };

    const [main, ...rest] = connection.attestations.external;
    // A retired record is as it stood when it was retired, and nothing is read after that.
    const at = connection.retiredAt ?? this.now();

    const { local } = connection.attestations;

    return {
      // A site's DNS that has gone unread no longer bears its word out, and the word stands.
      local: fresh(local, at, this.freshness)
        ? local
        : { by: local.by, method: local.method, confirmedAt: local.confirmedAt },
      external: [main, ...rest.filter((a) => fresh(a, at, this.freshness))],
    };
  }

  evidence(connection: Connection): Evidence {
    const { id: _privateId, siteName: _siteName, ...local } = connection.local;
    const standing = status(connection, this.now(), this.freshness);
    const evidenceUrl = `${this.baseUrl}/connections/${connection.id}`;

    return {
      id: connection.id,
      local,
      external: connection.external,
      provider: connection.provider,
      providerName: this.providerName(connection.provider),
      attestations: this.shown(connection),
      siteName: this.siteOf(connection.local),
      verifierName: this.options.verifierName,
      visibility: connection.visibility,
      status: standing,
      connectedAt: connected(connection),
      authenticatedAt: connection.authenticatedAt,
      approvedAt: connection.approvedAt,
      visibilityApprovedAt: connection.visibilityApprovedAt,
      expiresAt: connection.expiresAt,
      revokedAt: connection.revokedAt,
      // How an account is listed says nothing once its record is removed or retired.
      ...(connection.mark && !['revoked', 'retired'].includes(standing)
        ? { mark: connection.mark }
        : {}),
      ...(standing === 'retired' ? { retiredAt: connection.retiredAt } : {}),
      evidenceUrl,
      ...(this.options.signingKey !== undefined &&
      connection.visibility === 'public' &&
      ['verified', 'retired'].includes(standing)
        ? { signedUrl: `${evidenceUrl}?format=signed` }
        : {}),
    };
  }

  /**
   * The live record a connect flow reproves by another method, if there is one: the same
   * subject linked to the same account on the same provider, first shown some other way.
   * The same method again is a second record, as it always was; renewing is how that
   * one is extended. A retired record is never joined: it is frozen, so proving its account
   * another way makes a new record and leaves that one as history behind it.
   */
  private async joins(tx: Transaction, flow: Flow): Promise<Connection | undefined> {
    const provider = this.providerOf(flow);

    return (await tx.list('connections'))
      .filter(
        (c) =>
          c.revokedAt === undefined &&
          c.retiredAt === undefined &&
          c.local.id === flow.local!.id &&
          c.provider === provider.id &&
          (c.attestations?.external[0].method ?? 'oauth') !== providerMethod(provider) &&
          sameAccount(c.external, flow.external!) &&
          // A record first shown by a proof naming the subject's old address is a record
          // of that address. Joining it would show its proof beside the new one.
          (!c.attestations || this.names(c, c.attestations.external[0], flow.local!)),
      )
      .sort((a, b) => b.approvedAt - a.approvedAt)[0];
  }

  /**
   * The record a connect flow awaiting approval would add its method to, so the approval
   * page can say so: the holder is not creating a link but reproving one, and the
   * visibility already chosen for it stands.
   */
  async joining(flow: Flow): Promise<Connection | undefined> {
    if (flow.kind !== 'connect' || flow.phase !== 'approval') return undefined;

    return this.transaction((tx) => this.joins(tx, flow));
  }

  /**
   * Records that a flow just showed the record's account again. Shown by the method the
   * record was first shown by, it replaces that one; shown another way, it takes that
   * method's place after it, or joins the end. Either way the holder approved it and the
   * site reasserted its subject, so the record is extended and its subject refreshed.
   */
  private recordMethod(connection: Connection, flow: Flow, provider: Provider) {
    const attestation = this.attestation(flow, provider, connection.id);

    const [main, ...rest] = connection.attestations?.external ?? [
      { by: 'provider', method: 'oauth', confirmedAt: connection.authenticatedAt },
    ];

    connection.local = flow.local!;
    connection.approvedAt = this.now();
    connection.expiresAt = this.now() + (this.options.validityMs ?? 30 * 86400000);
    connection.revocationReason = undefined;

    if (attestation.method === main.method) {
      connection.authenticatedAt = flow.authenticatedAt!;

      // The account is taken as this method just named it. A recheck asks the same method
      // about the new proof and compares ids exactly, and an address read with different
      // case names the same profile under a different id.
      connection.external = flow.external!;

      connection.attestations = { local: this.declared(flow), external: [attestation, ...rest] };
    } else {
      // A proof that named the subject's old address proves nothing about its new one,
      // and rereading it would go on confirming a link to where the subject used to be.
      const others = rest.filter((a) => this.names(connection, a, flow.local!));
      const at = others.findIndex((a) => a.method === attestation.method);

      // A method already listed keeps its place: the order is the order each was first used.
      if (at < 0) others.push(attestation);
      else others[at] = attestation;

      connection.attestations = { local: this.declared(flow), external: [main, ...others] };
    }

    if (hosted(provider)) connection.proof = flow.artifact;
  }

  /**
   * Whether a proof still names the subject as it is now. A method that has the holder
   * publish something derived from the subject, as a link back publishes its address,
   * proved the subject as it was then; one whose proof is a token minted per flow names no
   * subject, and holds whatever the subject's address becomes.
   */
  private names(connection: Connection, attestation: Attestation, local: LocalAccount): boolean {
    const provider = this.providers.find(
      (p) => p.id === connection.provider && providerMethod(p) === attestation.method,
    );

    if (attestation.expect === undefined || !provider || !isArtifactProvider(provider)) return true;

    if (!provider.expect || attestation.minted) return true;

    // A subject with nothing to state gives nothing back, which no published address
    // equals: a proof of the address it used to have does not name it now.
    try {
      return provider.expect(local) === attestation.expect;
    } catch {
      return false;
    }
  }

  /**
   * The site is the only authority on its own namespace, so it declares the local subject.
   * Where the flow read the site's DNS naming this verifier, that goes with it.
   */
  private declared(flow: Flow): Attestation {
    return flow.stated ?? { by: 'backend', method: 'declared', confirmedAt: this.now() };
  }

  /** How the provider established the external account, by whatever method the flow ran. */
  private attestation(flow: Flow, provider: Provider, connectionId: string): Attestation {
    const external: Attestation = {
      by: 'provider',
      method: providerMethod(provider),
      confirmedAt: flow.authenticatedAt!,
    };

    // Only a published proof has somewhere for a reader to go, and it is kept with what
    // they should find there so the same check can be run again later. Where that is
    // depends on who holds it: an address the holder published, or this backend's own
    // copy when the proof is a document that stands up wherever it is read.
    if (flow.artifact && isArtifactProvider(provider)) {
      const hosted = provider.artifact === 'document';

      external.artifactUrl = hosted
        ? `${this.baseUrl}/connections/${connectionId}/proof`
        : flow.artifact;

      external.expect = flow.expect;

      if (flow.minted) external.minted = true;

      if (flow.dnssec) external.dnssec = true;

      if (hosted) external.hosted = true;
    }

    return external;
  }

  /**
   * The proof itself, for a method whose artifact this backend publishes. It is as public
   * as the evidence it belongs to and no more: an unlisted record's proof is the holder's
   * to hand out, exactly like the evidence page it is linked from.
   */
  async proof(id: string, local?: LocalAccount): Promise<string> {
    return this.transaction(async (tx) => {
      const connection = await tx.get('connections', id);

      if (
        !connection?.proof ||
        (connection.visibility !== 'public' && connection.local.id !== local?.id)
      )
        throw new Unavailable();

      return connection.proof;
    });
  }

  /** A record from a provider this instance no longer configures keeps its raw id. */
  private providerName(provider: string): string {
    return this.providers.find((p) => p.id === provider)?.name ?? provider;
  }

  async read(id: string, local?: LocalAccount): Promise<Evidence> {
    return this.transaction(async (tx) => {
      const connection = await tx.get('connections', id);

      if (!connection || (connection.visibility !== 'public' && connection.local.id !== local?.id))
        throw new Unavailable();

      return this.evidence(connection);
    });
  }

  /**
   * Every connection this site has published. Public evidence is already world-readable
   * one id at a time; listing it lets an embed follow the current connections instead of
   * hardcoding an id that dies whenever one is revoked and replaced. Unlisted records are
   * never included: they must not appear in any directory listing.
   */
  async published(): Promise<Evidence[]> {
    return this.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter((c) => c.visibility === 'public')
        .map((c) => this.evidence(c))
        .filter((e) => e.status === 'verified'),
    );
  }

  /**
   * Every record this instance holds, public and unlisted, for whoever runs it. No route
   * of the library serves this: a deployment that shows it must first know the reader is
   * its operator, who can read the storage it comes from anyway. Earliest connected first.
   */
  async all(): Promise<Evidence[]> {
    return this.transaction(async (tx) =>
      (await tx.list('connections'))
        .map((c) => this.evidence(c))
        .sort((a, b) => a.connectedAt - b.connectedAt),
    );
  }

  async mine(local: LocalAccount): Promise<Evidence[]> {
    return this.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter((c) => c.local.id === local.id)
        .map((c) => this.evidence(c)),
    );
  }

  private async owned(tx: Transaction, id: string, local: LocalAccount) {
    const connection = await tx.get('connections', id);

    if (!connection || connection.local.id !== local.id) throw new Unavailable();

    return connection;
  }

  async revoke(id: string, local: LocalAccount): Promise<void> {
    await this.transaction(async (tx) => {
      const connection = await this.owned(tx, id, local);

      if (connection.revokedAt !== undefined) return;

      connection.revokedAt = this.now();
      connection.revocationReason = 'local';
      await tx.put('connections', id, connection);
      await this.invalidateShare(tx, id);
      await this.audit(tx, id, 'revoke', 'local');
    });
  }

  /**
   * The holder's records of one account that are not revoked. A mark belongs to an account,
   * and an account can stand on several records: shown a second way on a record of its own,
   * or removed once and connected again. They are told apart as a badge tells them, by
   * provider and the id the provider gave.
   */
  private async account(
    tx: Transaction,
    local: LocalAccount,
    provider: string,
    external: ExternalAccount,
  ): Promise<Connection[]> {
    return (await tx.list('connections')).filter(
      (c) =>
        c.revokedAt === undefined &&
        c.local.id === local.id &&
        c.provider === provider &&
        c.external.id === external.id,
    );
  }

  /**
   * The mark an account's records carry, for a record about to stand beside them: every
   * one neither revoked nor retired, lapsed ones included, since those hold a mark that
   * must survive their own renewal.
   */
  private async accountMark(
    tx: Transaction,
    local: LocalAccount,
    provider: string,
    external: ExternalAccount,
    except?: string,
  ): Promise<Mark | undefined> {
    return (await this.account(tx, local, provider, external)).find(
      (c) => c.id !== except && c.retiredAt === undefined && c.mark !== undefined,
    )?.mark;
  }

  /**
   * Marks an account as the holder would have it listed, or retires it. Names one record
   * and acts on the account, or a mark on one record could vanish behind a sibling, and
   * retiring one could leave the account reading as verified through another.
   *
   * No fresh proof is asked for. A mark never widens who can read a record or makes one
   * read as verified, and a holder retiring an account often can no longer prove it.
   */
  async mark(
    id: string,
    local: LocalAccount,
    as: 'preferred' | 'current' | 'unused' | 'retired',
  ): Promise<void> {
    if (!['preferred', 'current', 'unused', 'retired'].includes(as)) throw new Unavailable();

    await this.transaction(async (tx) => {
      const named = await this.owned(tx, id, local);

      if (named.revokedAt !== undefined) throw new Unavailable();

      // A record already retired is left exactly as it is: its dates are what it stands on.
      const records = (await this.account(tx, local, named.provider, named.external)).filter(
        (c) => c.retiredAt === undefined,
      );

      if (as === 'retired') {
        // Whatever its status: a lapsed one left live could be read again later and bring
        // the account back. Nothing is revoked.
        for (const record of records) {
          record.retiredAt = this.now();
          delete record.mark;
          await tx.put('connections', record.id, record);
          await this.audit(tx, record.id, 'retire', 'local');
        }

        return;
      }

      // Only a retired account is left, and that is listed as retired and nothing else.
      if (!records.length) throw new Unavailable();

      const mark = as === 'current' ? undefined : as;

      for (const record of records) {
        if (record.mark === mark) continue;

        if (mark) record.mark = mark;
        else delete record.mark;

        await tx.put('connections', record.id, record);
        await this.audit(tx, record.id, `mark-${as}`, 'local');
      }

      if (as !== 'preferred') return;

      // One preferred account per holder: picking another moves the mark. Only that mark
      // is taken from the others, and what they say of being unused is left alone.
      for (const other of await tx.list('connections')) {
        if (
          other.local.id !== local.id ||
          other.revokedAt !== undefined ||
          other.mark !== 'preferred' ||
          records.some((record) => record.id === other.id)
        )
          continue;

        delete other.mark;
        await tx.put('connections', other.id, other);
        await this.audit(tx, other.id, 'mark-current', 'local');
      }
    });
  }

  async share(
    id: string,
    local: LocalAccount,
    revoke = false,
  ): Promise<{ url: string; expiresAt: number } | undefined> {
    const token = secret();

    return this.transaction(async (tx) => {
      const connection = await this.owned(tx, id, local);

      if (connection.visibility !== 'unlisted' || connection.revokedAt !== undefined)
        throw new Unavailable();

      await this.invalidateShare(tx, id);

      if (revoke) {
        await this.audit(tx, id, 'share-revoke', 'local');

        return;
      }

      const expiresAt = this.now() + (this.options.shareTtlMs ?? 7 * 86400000);

      await tx.put('shares', id, {
        connectionId: id,
        tokenHash: hash(token),
        createdAt: this.now(),
        expiresAt,
      });

      await this.audit(tx, id, 'share-issue', 'local');

      return { url: `${this.baseUrl}/s/${token}`, expiresAt };
    });
  }

  async shared(token: string) {
    return this.transaction(async (tx) => {
      const share = (await tx.list('shares')).find((s) => s.tokenHash === hash(token));

      if (!share || share.revokedAt !== undefined || share.expiresAt <= this.now())
        throw new Unavailable();

      const connection = await tx.get('connections', share.connectionId);

      if (!connection || connection.visibility !== 'unlisted' || connection.revokedAt !== undefined)
        throw new Unavailable();

      return {
        ...this.evidence(connection),
        evidenceUrl: `${this.baseUrl}/s/${token}`,
        linkExpiresAt: share.expiresAt,
      };
    });
  }

  /**
   * Asks again about proofs, because unlike a sign-in they can stop being true with nobody
   * told. What that means depends on who holds the proof:
   *
   * A proof published elsewhere is reread. The holder deletes the gist and this record
   * would otherwise go on claiming it, so continued silence ages the connection out.
   *
   * A proof this backend hosts cannot go missing, so there is nothing to reread. What can
   * still change is the identity behind it, and a method that has somewhere to say so is
   * asked. A holder who publishes a revocation for their key has withdrawn it, which is a
   * revocation of the connection rather than a proof gone stale.
   *
   * A failed read writes nothing. One refusal is not evidence the proof is gone, and a
   * provider being down must not revoke anyone; it is continued silence that ages a
   * connection out through `status`, and a single later success undoes that. Revocation
   * stays what it is, something a party chose.
   *
   * `budget` bounds the reads per run, since providers rate-limit and the alarm this runs
   * on is shared. Oldest first, so nothing starves however many connections are waiting.
   *
   * A retired record is never asked about: its proof is no longer expected to be there.
   *
   * Returns how many were confirmed. A connection revoked here is not one of them.
   */
  async recheck(budget = 5): Promise<number> {
    if (budget <= 0) return 0;

    const interval = this.options.recheckMs ?? 86400000;
    const now = this.now();

    const due = await this.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter(
          (c) =>
            c.revokedAt === undefined &&
            c.retiredAt === undefined &&
            c.expiresAt > now &&
            c.attestations,
        )
        .flatMap((connection) =>
          connection
            .attestations!.external.map((attestation) => ({
              connection,
              attestation,
              provider: this.rereads(connection, attestation),
            }))
            .filter(
              (item): item is Due =>
                item.provider !== undefined && item.attestation.confirmedAt + interval <= now,
            ),
        )
        .sort((a, b) => a.attestation.confirmedAt - b.attestation.confirmedAt)
        .slice(0, budget),
    );

    let confirmed = 0;

    // Serially and outside any transaction: storage here serializes writes, so holding one
    // open across a fetch would stall every other request behind the slowest provider.
    for (const item of due) confirmed += await this.reread(item);

    await this.restate(budget);

    return confirmed;
  }

  /**
   * Asks each site's DNS again whether it names this verifier, and writes the answer to
   * every record of that site. One lookup answers for all of a site's records, and
   * `budget` bounds the sites asked in a run, longest unread first. A site that could not
   * be read is left as it was: its records lose the proof only once it has gone unread
   * past `freshnessMs`, or once an answer comes back without the statement.
   *
   * When each site was last asked is kept in storage, as a record of its own that `prune()`
   * removes only with the site's last record. It is apart from the lookups a flow makes
   * and from anything that expires: an instance restarted or pruned between runs must not
   * start again from the same few sites, and a site whose holders connect often must
   * still have its older records rewritten.
   */
  private async restate(budget: number): Promise<void> {
    if (!this.options.dns) return;

    const interval = this.options.recheckMs ?? 86400000;
    const now = this.now();

    const live = (c: Connection | undefined): c is Connection =>
      !!c?.attestations &&
      c.revokedAt === undefined &&
      c.retiredAt === undefined &&
      c.expiresAt > this.now();

    const due = await this.transaction(async (tx) => {
      const sites = new Set(
        (await tx.list('connections'))
          .filter(live)
          .map((c) => this.siteDomain(c.local))
          .filter((site) => site !== undefined),
      );

      const reads = new Map((await tx.list('sites')).map((read) => [read.id, read]));

      // A site never asked about goes first, then the rest by how long ago they were. A
      // site that gave no answer is due again sooner, and still waits behind every site
      // asked before it, so a zone that never answers cannot hold up the others.
      const at = (site: string) => reads.get(site)?.readAt ?? -Infinity;

      const wait = (site: string) =>
        reads.get(site)?.answered === false ? Math.ceil(interval / 4) : interval;

      return [...sites]
        .filter((site) => at(site) + wait(site) <= now)
        .sort((a, b) => at(a) - at(b))
        .slice(0, budget);
    });

    for (const site of due) {
      // Always asked afresh: a read some flow made says nothing of the records before it.
      const found = await this.lookedUp(site, 0);

      await this.transaction((tx) =>
        tx.put('sites', site, { id: site, readAt: this.now(), answered: !!found }),
      );

      if (!found) continue;

      const stated = this.stated(found);

      await this.transaction(async (tx) => {
        for (const connection of await tx.list('connections')) {
          if (!live(connection) || this.siteDomain(connection.local) !== site) continue;

          const { local } = connection.attestations!;

          // Nothing was stated before and nothing is now, so there is nothing to write.
          if (!stated && !local.artifactUrl) continue;

          connection.attestations!.local = stated ?? {
            by: local.by,
            method: local.method,
            confirmedAt: local.confirmedAt,
          };

          await tx.put('connections', connection.id, connection);
        }
      });
    }
  }

  /**
   * The configured method that can ask again about one attestation, or nothing when there
   * is nothing to ask: no published proof, a method this instance no longer runs, or a
   * hosted proof whose method has nowhere to hear of a withdrawal.
   */
  private rereads(connection: Connection, attestation: Attestation): ArtifactProvider | undefined {
    if (!attestation.artifactUrl || !attestation.expect) return undefined;

    const provider = this.providers.find(
      (p) => p.id === connection.provider && providerMethod(p) === attestation.method,
    );

    if (!provider || !isArtifactProvider(provider)) return undefined;

    if (provider.artifact === 'location') return attestation.hosted ? undefined : provider;

    return provider.withdrawn && connection.proof ? provider : undefined;
  }

  /** Asks about one proof and records the answer. Returns 1 when it confirmed. */
  private async reread({ connection, attestation, provider }: Due): Promise<number> {
    const { artifactUrl, expect, method } = attestation;
    const main = attestation === connection.attestations!.external[0];
    let withdrawn = false;
    let dnssec = false;

    try {
      if (provider.artifact === 'document')
        withdrawn = await this.deadline(
          provider.withdrawn!(connection.external, connection.proof!),
        );
      else {
        const found = await this.deadline(
          read(provider, { artifact: artifactUrl!, expect: expect! }),
        );

        const external = found.account;

        dnssec = found.dnssec === true;

        // The proof must still be the same holder's. An account that changed hands has
        // not reproved anything, whatever is published at the old address.
        if (
          main
            ? external.id !== connection.external.id
            : !sameAccount(connection.external, external)
        )
          return 0;
      }
    } catch {
      return 0;
    }

    return this.transaction(async (tx) => {
      const current = await tx.get('connections', connection.id);

      // It may have been revoked or reproved while the fetch was in flight. Or retired, and
      // then an answer written now would move the proof date it was frozen with, or revoke
      // it on a withdrawal.
      if (
        !current?.attestations ||
        current.revokedAt !== undefined ||
        current.retiredAt !== undefined
      )
        return 0;

      const [first, ...rest] = current.attestations.external;
      const held = main ? first : rest.find((a) => a.method === method);

      if (held?.method !== method || held.artifactUrl !== artifactUrl) return 0;

      // The holder said this identity is no longer theirs, which is a choice, not decay.
      if (withdrawn) {
        current.revokedAt = this.now();
        current.revocationReason = 'withdrawn';
        await tx.put('connections', connection.id, current);
        await this.invalidateShare(tx, connection.id);
        await this.audit(tx, connection.id, 'revoke', 'external');

        return 0;
      }

      held.confirmedAt = this.now();

      // A zone can start or stop being signed, so the flag is as the last read found it.
      if (dnssec) held.dnssec = true;
      else delete held.dnssec;

      await tx.put('connections', connection.id, current);

      return 1;
    });
  }

  /** A provider that never answers must not hold up the maintenance run behind it. */
  private deadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;

    return Promise.race([
      work.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Unavailable()), this.options.recheckTimeoutMs ?? 10000);
      }),
    ]);
  }

  /**
   * Run periodically. Pending secrets expire immediately; historical evidence defaults to 90
   * days. A retired record is history its holder asked to keep, so it stays for as long as
   * it is not revoked, and once revoked goes like any other.
   */
  async prune(retentionMs = 90 * 86400000): Promise<void> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('Invalid retention');

    await this.transaction(async (tx) => {
      const now = this.now();

      for (const flow of await tx.list('flows'))
        if (flow.expiresAt <= now) await tx.delete('flows', flow.id);

      for (const limit of await tx.list('limits'))
        if (limit.expiresAt <= now) await tx.delete('limits', limit.id);

      const audit = await tx.list('audit');
      // The sites that still have a record here, whose place in the recheck order is kept.
      const sites = new Set<string>();

      for (const connection of await tx.list('connections')) {
        const ended =
          connection.revokedAt ??
          (connection.retiredAt === undefined ? connection.expiresAt : Infinity);

        if (ended + retentionMs <= now) {
          await tx.delete('connections', connection.id);
          await tx.delete('shares', connection.id);

          continue;
        }

        const site = this.siteDomain(connection.local);

        if (site) sites.add(site);

        if (connection.connectedAt === undefined) {
          // A record from before its first connection was kept. The audit trail still has
          // the moment, for as long as it retains it, and that is the answer. Only past
          // that is the earliest time left on the record used, which is a guess: a sign-in
          // comes before the approval that makes the record, so it must not outrank the
          // event itself. Written once, here, so it stops moving.
          const made = audit
            .filter((event) => event.connectionId === connection.id && event.action === 'connect')
            .map((event) => event.at);

          connection.connectedAt = made.length ? Math.min(...made) : connected(connection);
          await tx.put('connections', connection.id, connection);
        }
      }

      // When a site was last asked goes only with its last record, never by age: it is
      // what orders the sites `recheck()` asks, and losing it would put the site first again.
      for (const read of await tx.list('sites'))
        if (!sites.has(read.id)) await tx.delete('sites', read.id);

      for (const event of audit)
        if (event.at + retentionMs <= now) await tx.delete('audit', event.id);
    });
  }

  private async invalidateShare(tx: Transaction, id: string) {
    const share = await tx.get('shares', id);

    if (share) {
      share.revokedAt = this.now();
      await tx.put('shares', id, share);
    }
  }

  private async audit(
    tx: Transaction,
    connectionId: string,
    action: string,
    actor: 'local' | 'external',
    flowId?: string,
    visibility?: Visibility,
  ) {
    const id = secret();

    await tx.put('audit', id, {
      id,
      connectionId,
      flowId,
      action,
      actor,
      at: this.now(),
      visibility,
    });
  }
}

/**
 * When a record was first made. One written before that was kept is answered with the
 * earliest time it still carries: every one of them is at or after the first connection,
 * and each renewal moves them later, so the least of them is the closest.
 */
function connected(connection: Connection): number {
  return (
    connection.connectedAt ??
    Math.min(
      connection.approvedAt,
      connection.authenticatedAt,
      connection.visibilityApprovedAt,
      ...(connection.attestations?.external.map((a) => a.confirmedAt) ?? []),
    )
  );
}

/**
 * Whether a renewal by this method may go ahead. Any may renew a live record. A retired one
 * is revived by the method it was first shown by alone, which replaces the proof the
 * record is judged by.
 */
function revives(connection: Connection, provider: Provider): boolean {
  return (
    connection.retiredAt === undefined ||
    (connection.attestations?.external[0].method ?? 'oauth') === providerMethod(provider)
  );
}

/** One proof waiting to be read again, and the method that reads it. */
/** Whose a proof is and what else its method learned, whichever of the two it offers. */
async function read(
  provider: ArtifactProvider,
  input: { artifact: string; expect: string },
): Promise<Proved> {
  return provider.prove ? provider.prove(input) : { account: await provider.verify(input) };
}

interface Due {
  connection: Connection;
  attestation: Attestation;
  provider: ArtifactProvider;
}

/**
 * Whether two methods named the same account. Where both carry an id their provider
 * issued, that id settles it. A method that learns only an address, as a link back does,
 * names the account by its profile, so against one of those the profiles are compared:
 * the account behind the number GitHub issued is the one at that address for as long as
 * the address is theirs. Only accounts compare this way; a page or a key is named by
 * nothing but itself.
 */
function sameAccount(a: ExternalAccount, b: ExternalAccount): boolean {
  if (a.id === b.id) return true;

  if (![a.kind, b.kind].every((kind) => kind === undefined || kind === 'account')) return false;

  if (a.id !== a.profileUrl && b.id !== b.profileUrl) return false;

  return profile(a.profileUrl) === profile(b.profileUrl);
}

/**
 * Wraps a transaction so records read through it are in the current shape. They are
 * rewritten in that shape the next time they are put.
 */
function upgraded(tx: Transaction): Transaction {
  return {
    get: async (kind, id) => upgrade(kind, await tx.get(kind, id)),
    put: (kind, id, value) => tx.put(kind, id, value),
    delete: (kind, id) => tx.delete(kind, id),
    list: async (kind) => (await tx.list(kind)).map((value) => upgrade(kind, value)!),
  };
}

/** Methods stored under an earlier name. */
const renamed: Record<string, Method> = { attestation: 'gist' };

type Stored = Attestation & { method: string };

/**
 * Brings one stored record up to date. Connections written before `external` became a
 * list held the main method there alone and the rest under `further`, and connections
 * and flows may name a method by an earlier name.
 */
function upgrade<K extends keyof Records>(kind: K, value: Records[K] | undefined) {
  if (!value) return value;

  const method = (stored: Stored): Attestation => ({
    ...stored,
    method: renamed[stored.method] ?? (stored.method as Method),
  });

  if (kind === 'flows') {
    const flow = value as Flow;

    return (
      flow.method && renamed[flow.method] ? { ...flow, method: renamed[flow.method] } : flow
    ) as Records[K];
  }

  if (kind !== 'connections') return value;

  const attestations = (value as Connection).attestations as
    { local: Stored; external: Stored | Stored[]; further?: Stored[] } | undefined;

  if (!attestations) return value;

  const external = Array.isArray(attestations.external)
    ? attestations.external
    : [attestations.external, ...(attestations.further ?? [])];

  return {
    ...value,
    attestations: {
      local: method(attestations.local),
      external: external.map(method),
    },
  } as Records[K];
}

/**
 * Whether a flow of this kind showed the record's account. Removal from the external side
 * is started and approved by nobody local, so it takes the provider-issued id alone: a
 * profile address can change hands, and its next owner must not be able to remove the
 * last one's record. The weaker match is only for flows the local holder approves.
 */
function matches(kind: Flow['kind'], held: ExternalAccount, shown: ExternalAccount): boolean {
  if (kind === 'revoke' || kind === 'share-revoke') return held.id === shown.id;

  return sameAccount(held, shown);
}

/** A profile address as it compares. Handles are compared without case, as providers issue them. */
function profile(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/** The window a send limit counts over. */
const dayMs = 86400000;

/** How many wrong codes a flow takes before it is dead. */
export const codeAttempts = 5;

/** How many times a published proof may be refused before its flow is dead. */
export const artifactAttempts = 5;

/** Crockford's base 32: no I, L, O or U, so no letter is mistaken for a digit when typed. */
const codeAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A code short enough to type and long enough not to guess: forty bits, against the few
 * tries a flow allows. Written in two groups, since eight characters in a row are miscounted.
 */
function mintCode(): string {
  const text = [...randomBytes(8)].map((byte) => codeAlphabet[byte & 31]).join('');

  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

/**
 * A code as it is compared: bound to its flow, and read the way it was meant however it
 * was typed, in either case, with or without the hyphen, and with the letters the alphabet
 * leaves out taken for the digits they look like.
 */
function codeHash(flowId: string, code: string): string {
  const typed = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

  return hash(`${flowId} ${typed}`);
}

/** Whether a method hands over a proof for this backend to publish. */
function hosted(provider: Provider): boolean {
  return isArtifactProvider(provider) && provider.artifact === 'document';
}

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
  type Method,
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
  now?: () => number;
}

export class VerityService {
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

  /** The same keys as one armored text, which is what `gpg --import` takes. */
  async armoredKeys(): Promise<string> {
    return (await this.keys()).map((key) => key.publicKey.trim()).join('\n\n') + '\n';
  }

  /**
   * A public record that stands, signed as of now. Signed when asked for, not when
   * approved, so a signed record says the record stood on the day it was taken and none can be
   * made once it is removed.
   */
  async signed(id: string): Promise<SignedEvidence> {
    const current = await this.signer();

    if (!current) throw new Unavailable();

    const { status, revokedAt: _revokedAt, signedUrl: _signedUrl, ...record } = await this.read(id);

    if (status !== 'verified') throw new Unavailable();

    return current.sign({ type: 'verity-evidence', version: 1, issuedAt: this.now(), ...record });
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
    };

    // Removal from the external side answers to nobody local, so nothing local rides on it.
    if (context && !['revoke', 'share-revoke'].includes(kind)) flow.context = { ...context };

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

        subject = connection.local;
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
      if (artifact)
        flow.expect = artifact.expect
          ? artifact.expect(subject!)
          : `Verity proof for ${this.siteOf(subject!)}: ${secret()}`;

      await tx.put('flows', flow.id, flow);

      return provider;
    });

    const artifact = isArtifactProvider(provider) ? provider : undefined;

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
            }),
          }
        : { flowId: flow.id, binding };
  }

  /**
   * Which method a flow runs. A flow on an existing record stays in that record's
   * namespace, and without a choice it uses the method the record was first shown by.
   *
   * Removing a link from the external side takes a method whose proof is fresh. A standing
   * proof, such as a link back, is there for anyone to point at: handing one back shows
   * the link exists, not that whoever handed it back holds the account.
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
      const external = await provider.verify({ artifact, expect });

      await this.established(id, binding, external, artifact);
    } catch (error) {
      await this.failed(id, error);
    }

    return id;
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

    await this.transaction(async (tx) => {
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
      flow.artifact = artifact;
      flow.authenticatedAt = this.now();
      flow.phase = 'approval';
      await tx.put('flows', id, flow);
    });
  }

  /**
   * A failed check leaves the flow dead rather than retryable in place. Only a `Refused`
   * reason is kept: any other error may describe this backend rather than the proof.
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
            local: this.declared(),
            external: [this.attestation(flow, provider, connectionId)],
          },
          proof: hosted(provider) ? flow.artifact : undefined,
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

          this.recordMethod(connection, flow, provider);
        } else if (flow.kind === 'revoke') {
          connection.revokedAt = this.now();
          connection.revocationReason = 'external';
        } else if (flow.kind === 'visibility') {
          if (allowed && !allowed.includes(visibility)) throw new Unavailable();

          connection.visibility = visibility;
          connection.visibilityApprovedAt = this.now();
        }
      }

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
    });
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

    return {
      ...connection.attestations,
      external: [main, ...rest.filter((a) => fresh(a, this.now(), this.freshness))],
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
      evidenceUrl,
      ...(this.options.signingKey !== undefined &&
      connection.visibility === 'public' &&
      standing === 'verified'
        ? { signedUrl: `${evidenceUrl}?format=signed` }
        : {}),
    };
  }

  /**
   * The live record a connect flow reproves by another method, if there is one: the same
   * subject linked to the same account on the same provider, first shown some other way.
   * The same method again is a second record, as it always was; renewing is how that
   * one is extended.
   */
  private async joins(tx: Transaction, flow: Flow): Promise<Connection | undefined> {
    const provider = this.providerOf(flow);

    return (await tx.list('connections'))
      .filter(
        (c) =>
          c.revokedAt === undefined &&
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

      connection.attestations = { local: this.declared(), external: [attestation, ...rest] };
    } else {
      // A proof that named the subject's old address proves nothing about its new one,
      // and rereading it would go on confirming a link to where the subject used to be.
      const others = rest.filter((a) => this.names(connection, a, flow.local!));
      const at = others.findIndex((a) => a.method === attestation.method);

      // A method already listed keeps its place: the order is the order each was first used.
      if (at < 0) others.push(attestation);
      else others[at] = attestation;

      connection.attestations = { local: this.declared(), external: [main, ...others] };
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

    if (!provider.expect) return true;

    try {
      return provider.expect(local) === attestation.expect;
    } catch {
      return false;
    }
  }

  /** The site is the only authority on its own namespace, so it declares the local subject. */
  private declared(): Attestation {
    return { by: 'backend', method: 'declared', confirmedAt: this.now() };
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
   * Returns how many were confirmed. A connection revoked here is not one of them.
   */
  async recheck(budget = 5): Promise<number> {
    if (budget <= 0) return 0;

    const interval = this.options.recheckMs ?? 86400000;
    const now = this.now();

    const due = await this.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter((c) => c.revokedAt === undefined && c.expiresAt > now && c.attestations)
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

    return confirmed;
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

    try {
      if (provider.artifact === 'document')
        withdrawn = await this.deadline(
          provider.withdrawn!(connection.external, connection.proof!),
        );
      else {
        const external = await this.deadline(
          provider.verify({ artifact: artifactUrl!, expect: expect! }),
        );

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

      // It may have been revoked or reproved while the fetch was in flight.
      if (!current?.attestations || current.revokedAt !== undefined) return 0;

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

  /** Run periodically. Pending secrets expire immediately; historical evidence defaults to 90 days. */
  async prune(retentionMs = 90 * 86400000): Promise<void> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('Invalid retention');

    await this.transaction(async (tx) => {
      const now = this.now();

      for (const flow of await tx.list('flows'))
        if (flow.expiresAt <= now) await tx.delete('flows', flow.id);

      for (const limit of await tx.list('limits'))
        if (limit.expiresAt <= now) await tx.delete('limits', limit.id);

      const audit = await tx.list('audit');

      for (const connection of await tx.list('connections')) {
        if ((connection.revokedAt ?? connection.expiresAt) + retentionMs <= now) {
          await tx.delete('connections', connection.id);
          await tx.delete('shares', connection.id);
        } else if (connection.connectedAt === undefined) {
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

/** One proof waiting to be read again, and the method that reads it. */
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

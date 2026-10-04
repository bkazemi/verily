export type Visibility = 'public' | 'unlisted';

/**
 * `unconfirmed` is a published proof that has not been read lately. It is not disproved,
 * and turns back to `verified` the moment the proof reads again. `expired` is an approval
 * that ran out, which only the holder renewing it undoes.
 */
export type Status = 'verified' | 'unconfirmed' | 'expired' | 'revoked';

/** What a site links: one of its accounts, a single page, or the site itself. */
export type LocalKind = 'account' | 'page' | 'site';

/** id is private and must never be reassigned. reference is durable and public-safe. */
export interface LocalAccount {
  id: string;
  /** Absent means the site did not say. Renderers must not assume an account. */
  kind?: LocalKind;
  label: string;
  reference: string;
  /** Canonical URL for the linked subject: a profile, a page, or the site root. */
  profileUrl?: string;
  /**
   * The site this subject belongs to, where one instance serves several. Absent means the
   * instance's own `siteName`. Every page and record describing the subject names this.
   */
  siteName?: string;
}

export interface ExternalAccount {
  id: string;
  /**
   * What the other side is. Absent means an account, which is what a provider issues and
   * can reassign. A key is not an account: nobody issued it and nobody can hand it over.
   * A page is an address that was read and nothing more: a method that only fetches a
   * document learns what it says, never whose account the address is. A mailbox is an
   * account in all but how it is written: its domain issued it and can hand it to somebody
   * else, but its address is already its whole name and it has no profile to link to.
   */
  kind?: 'account' | 'key' | 'page' | 'mailbox';
  handle: string;
  /** Where a reader goes to see the subject. For a mailbox, its `mailto:` address. */
  profileUrl: string;
}

/**
 * How control of one side was shown. A provider is who an account belongs to; a method is
 * how control of it was demonstrated, and the two multiply rather than enumerate: one
 * provider may support several methods and one method spans providers.
 *
 * `declared` is the site asserting a subject from its own records. That is not a weaker
 * form of the others: a site is the only authority on its own namespace, so no external
 * source could improve on it. A sign-in and a mailed code happen once, between the holder
 * and this backend. The rest publish an artifact a reader can fetch.
 */
export type Method = 'declared' | 'oauth' | 'gist' | 'backlink' | 'signature' | 'code';

/** Who vouches for one side: this backend from its own records, or the account's provider. */
export type Attester = 'backend' | 'provider';

/**
 * How one side of a link was established. `artifactUrl` is present only when the method
 * leaves a public proof, which is what lets a reader check the claim without trusting
 * this backend, and lets another installation reverify it independently.
 */
export interface Attestation {
  by: Attester;
  method: Method;
  /** Public location of the proof. Never a sharing link or any other secret. */
  artifactUrl?: string;
  /**
   * True when this backend serves the proof itself rather than reading it somewhere else.
   * A hosted proof cannot go missing behind our back, so it never needs reconfirming.
   */
  hosted?: boolean;
  /** What a reader should expect to find at artifactUrl, such as a challenge token. */
  expect?: string;
  /**
   * When this side was last confirmed. For `declared` and `oauth` that is the moment it
   * was established; artifact methods drift out of date and are reconfirmed on a schedule.
   */
  confirmedAt: number;
}

/** Each side of a link is attested separately, by different parties under different methods. */
export interface Attestations {
  local: Attestation;
  /**
   * Every method the external account has been shown by, in the order each was first
   * used, at most one per method. The first is the main one for the record's life, and a
   * record is judged by it; the rest are additional and never replace it.
   */
  external: [Attestation, ...Attestation[]];
}

export interface Connection {
  id: string;
  local: LocalAccount;
  external: ExternalAccount;
  provider: string;
  visibility: Visibility;
  visibilityApprovedAt: number;
  authenticatedAt: number;
  approvedAt: number;
  /**
   * When the record was first made. A renewal moves every other time on the record forward
   * and never this one, which is what says the order a subject's accounts were connected
   * in. Absent on records written before it was kept.
   */
  connectedAt?: number;
  expiresAt: number;
  revokedAt?: number;
  /** Who removed it: the local holder, the external holder, or a withdrawal the provider read. */
  revocationReason?: 'local' | 'external' | 'withdrawn';
  /** Absent on records written before methods were recorded; evidence infers those. */
  attestations?: Attestations;
  /** The proof itself, for a method whose artifact this backend publishes rather than reads. */
  proof?: string;
}

export interface Flow {
  id: string;
  stateHash: string;
  bindingHash: string;
  verifier?: string;
  kind: 'connect' | 'renew' | 'revoke' | 'visibility' | 'share-revoke';
  local?: LocalAccount;
  connectionId?: string;
  phase: 'pending' | 'exchanging' | 'approval' | 'complete' | 'cancelled' | 'failed';
  expiresAt: number;
  external?: ExternalAccount;
  authenticatedAt?: number;
  resultId?: string;
  /** Why a failed flow failed, when a provider said so in words meant for the holder. */
  reason?: string;
  /**
   * The string an artifact must contain. Public by design: the holder publishes it. It is
   * unguessable and per-flow, so an artifact made for one flow cannot complete another.
   */
  expect?: string;
  /** What the holder handed back: an address to read, or the proof itself. */
  artifact?: string;
  /**
   * A message on its way to the address the holder named, carrying a link to press and a
   * code to type. The account is only a claim until one of them comes back, which is why
   * it is kept here and not in `external`. Never public: either one is the whole proof, so
   * only their hashes are stored and none of this is reported.
   */
  sent?: { account: ExternalAccount; codeHash: string; linkHash: string; attempts: number };
  /**
   * Which configured method the flow runs: the provider's id and its method. Absent on
   * flows written by a backend that had only one, which is the first one configured.
   */
  provider?: string;
  method?: Method;
  /**
   * What the adopting application attached when the flow was created, such as which site
   * sent the holder here. Never set on removal from the external side, which is started by
   * nobody local whatever the browser is signed into.
   */
  context?: Record<string, string>;
  /** How the flow ended, written in the transaction that ended it and never changed after. */
  result?: FlowResult;
}

/**
 * The end of a flow as it stood at that moment. The connection may change later, so anything
 * reporting the result reads it from here and never from the connection.
 */
export interface FlowResult {
  kind: Flow['kind'];
  phase: 'complete' | 'cancelled' | 'failed';
  /** The connection the flow made or acted on, where there is one. */
  connectionId?: string;
  /** That connection's visibility when the flow ended. */
  visibility?: Visibility;
  finishedAt: number;
}

export interface Share {
  connectionId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface Audit {
  id: string;
  connectionId?: string;
  flowId?: string;
  action: string;
  actor: 'local' | 'external';
  at: number;
  visibility?: Visibility;
}

/**
 * How many times something has been done in the window that ends at `expiresAt`. Past
 * that the count is spent and the next one starts a window of its own.
 */
export interface Limit {
  id: string;
  count: number;
  expiresAt: number;
}

export interface Records {
  connections: Connection;
  flows: Flow;
  shares: Share;
  audit: Audit;
  limits: Limit;
}

export interface Transaction {
  get<K extends keyof Records>(kind: K, id: string): Promise<Records[K] | undefined>;
  put<K extends keyof Records>(kind: K, id: string, value: Records[K]): Promise<void>;
  delete(kind: keyof Records, id: string): Promise<void>;
  list<K extends keyof Records>(kind: K): Promise<Records[K][]>;
}

/** Must serialize concurrent transactions and roll back all writes on rejection. */
export interface Storage {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

/**
 * Proves control by sending the holder to the provider and back in one round trip. The
 * provider is the only party that sees the holder's credentials, and nothing is published.
 */
export interface RedirectProvider {
  id: string;
  name: string;
  /** Absent means oauth, the shape this interface describes. */
  method?: 'oauth';
  authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string;
  authenticate(input: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<ExternalAccount>;
}

/**
 * Proves control by having the holder publish a given string somewhere only they can write,
 * then reading it back. It is holder-paced rather than one round trip, it needs no
 * registration with the provider, and it leaves a proof a reader can check for themselves.
 */
export interface ArtifactProvider {
  id: string;
  name: string;
  method: Exclude<Method, 'declared' | 'oauth'>;
  /**
   * What the holder must publish, for a method that does not get to choose it. A backlink
   * says the far side points at this exact subject, so the subject's own address is the
   * whole of what is proved and a per-flow token could not be part of it. Absent means the
   * backend mints an unguessable string instead, which is what a method wants when any
   * fresh artifact will do. Throw when the subject cannot be proved this way at all.
   */
  expect?(local: LocalAccount): string;
  /**
   * Where the proof lives. `location` means the holder publishes it somewhere only they
   * can write and hands back an address, so the address is half of what is proved.
   * `document` means they hand back the proof itself and this backend publishes it,
   * because a signature proves itself and where it was typed proves nothing at all.
   */
  artifact: 'location' | 'document';
  /**
   * Told to the holder verbatim. Must name what they are publishing and where. Returned in
   * pieces so a renderer can set a command as one: a command is copied character for
   * character, and prose that reflows is prose a holder cannot safely copy.
   */
  instructions(expect: string): Instruction[];
  /**
   * Reads what the holder handed back and returns whose it is. Must confirm it contains
   * `expect`. A `location` provider must also refuse any address outside itself, since
   * the holder chooses that address and an unpinned fetch is an open proxy. Throw `Refused`
   * to tell the holder why; any other error is shown only as a failure.
   */
  verify(input: { artifact: string; expect: string }): Promise<ExternalAccount>;
  /**
   * Whether the holder has since withdrawn the identity itself, wherever such a statement
   * is published. This revokes the connection, so it must be something the holder stated
   * and this provider verified, never something a third party merely asserted.
   */
  withdrawn?(account: ExternalAccount, artifact: string): Promise<boolean>;
}

/**
 * Proves control by sending a message somewhere only the holder can read and having them
 * answer it: by pressing the link it carries, or by reading its code back. It is
 * holder-paced like an artifact, but nothing is published: the proof is that the message
 * arrived, so like a sign-in it happened once and there is nothing for a reader to fetch
 * or for a recheck to read again.
 *
 * The backend mints the link and the code, counts the guesses and never hands the
 * provider anything else to say, so a provider cannot be made to carry a stranger's words
 * to an address a stranger chose.
 */
export interface CodeProvider {
  id: string;
  name: string;
  method: 'code';
  /** What the holder is asked for, such as "Your email address". */
  field: string;
  /** The kind of address, which says what a browser offers to fill in for it. */
  input: 'email' | 'tel';
  /**
   * Whose account an address names, in the one spelling this provider keeps for it.
   * Called before anything is sent. Throw `Refused` for an address it will not send to.
   */
  account(address: string): ExternalAccount;
  /** Sends the message. Rejecting fails the flow, and only a `Refused` reason is shown. */
  deliver(input: {
    account: ExternalAccount;
    /**
     * A page on this backend that confirms the address once its holder presses the button
     * there. Following the link alone confirms nothing, so a scanner that opens every link
     * in a message cannot answer for the holder. Works from any browser.
     */
    link: string;
    /** The same proof as something to type, into the page that asked. */
    code: string;
    /**
     * Who the message says is asking: the site the holder is linking this account to, or,
     * for a flow anybody may start on somebody else's record, only this installation.
     */
    siteName: string;
    /** When both stop working. */
    expiresAt: number;
  }): Promise<void>;
}

/**
 * A proof turned down for a reason the holder can act on. Its message is shown to them, so
 * it names what was wrong with what they handed over and nothing about the backend.
 */
export class Refused extends Error {}

/**
 * A piece of what the holder is told: a paragraph, a paragraph with links in it, or
 * something they run or publish as is.
 */
export type Instruction = string | { code: string } | Inline[];

/**
 * A piece of a paragraph: text, or text that links somewhere the holder goes to do what
 * the paragraph says. Renderers link only http(s) addresses and open them in a new tab.
 */
export type Inline = string | { text: string; href: string };

export type Provider = RedirectProvider | ArtifactProvider | CodeProvider;

/** Only an artifact provider is holder-paced, and only it needs a url handed back. */
export function isArtifactProvider(provider: Provider): provider is ArtifactProvider {
  return 'verify' in provider;
}

/** The one shape that sends the holder to the provider's own site and takes them back. */
export function isRedirectProvider(provider: Provider): provider is RedirectProvider {
  return 'authenticate' in provider;
}

/** Only a code provider sends the holder something to read back. */
export function isCodeProvider(provider: Provider): provider is CodeProvider {
  return 'deliver' in provider;
}

/** How a provider shows control. A redirect provider that names none is oauth. */
export function providerMethod(provider: Provider): Method {
  return provider.method ?? 'oauth';
}

export interface Evidence {
  id: string;
  /** The site's name is `siteName` below, so the subject does not carry a second copy. */
  local: Omit<LocalAccount, 'id' | 'siteName'>;
  external: ExternalAccount;
  provider: string;
  /** Display name from the provider implementation. */
  providerName: string;
  /**
   * How each side was established, so a reader can weigh them separately instead of
   * reading one undifferentiated "verified".
   */
  attestations: Attestations;
  siteName: string;
  verifierName: string;
  visibility: Visibility;
  status: Status;
  /**
   * When the record was first made, which no renewal changes. A subject's accounts are
   * shown in this order, earliest first. For a record older than this field it is the
   * earliest time the record still carries.
   */
  connectedAt: number;
  authenticatedAt: number;
  approvedAt: number;
  visibilityApprovedAt: number;
  expiresAt: number;
  revokedAt?: number;
  evidenceUrl: string;
  /**
   * Where this record can be had signed, on a verifier that signs. Only a public record
   * that stands has a signed form: once saved, a signed record cannot be taken back.
   */
  signedUrl?: string;
}

export * from './signed.js';

/**
 * How long a published proof stays good without being read again. An artifact method is
 * only true while the artifact is still there, and the holder can delete it without
 * telling anyone, so a confirmation is a heartbeat rather than a permanent fact.
 */
export const freshnessMs = 7 * 86400000;

/**
 * `freshness` bounds how stale a published proof may be before it stops counting. A
 * backend that never rechecks must leave it unbounded, since an unread proof going stale
 * is a statement about the recheck, and claiming one that never ran would be a lie.
 */
export function status(connection: Connection, now: number, freshness = freshnessMs): Status {
  if (connection.revokedAt !== undefined) return 'revoked';

  if (now >= connection.expiresAt) return 'expired';

  const main = connection.attestations?.external[0];

  if (main && !fresh(main, now, freshness)) return 'unconfirmed';

  return 'verified';
}

/**
 * Whether one method still counts. A sign-in happened once and stays happened. A proof
 * that has not been read lately is unconfirmed rather than disproved, which is why this
 * reverses the moment it reads again.
 */
export function fresh(attestation: Attestation, now: number, freshness = freshnessMs): boolean {
  return (
    !attestation.artifactUrl ||
    attestation.hosted === true ||
    freshness === Infinity ||
    now < attestation.confirmedAt + freshness
  );
}

/**
 * The word for a record's state. Evidence can be read after it was issued, so an approval
 * that has run out since reads as expired whatever status it was issued with.
 */
export function statusLabel(evidence: Pick<Evidence, 'status' | 'expiresAt'>, now: number): string {
  if (evidence.status === 'revoked') return 'Revoked';

  if (evidence.status === 'expired' || evidence.expiresAt <= now) return 'Expired';

  return evidence.status === 'unconfirmed' ? 'Unconfirmed' : 'Verified';
}

/**
 * What to call a link's local side, and what to write as its value. When the site itself is
 * what was linked there is no subject on it to name, so the site is the value rather than a
 * label above some other thing. An absent kind means the site did not say, so nothing is
 * assumed about one. A subject that names its own site is described by that name, and
 * `siteName` is only the fallback.
 */
export function localSide(
  local: Pick<LocalAccount, 'kind' | 'label' | 'siteName'>,
  fallback: string,
): { heading: string; value: string } {
  const siteName = local.siteName ?? fallback;

  if (local.kind === 'site') return { heading: 'Website', value: siteName };

  const heading: Record<string, string> = {
    account: `Account on ${siteName}`,
    page: `Page on ${siteName}`,
  };

  return { heading: heading[local.kind ?? ''] ?? siteName, value: local.label };
}

/**
 * How to write an external subject's name. The @ that marks a handle is a claim that there
 * is an account behind it, issued by somebody who could also take it away. A key has no
 * account and no handle: it is named by its own fingerprint, so it is written as it is. A
 * page is named by its address for the same reason, since fetching one says where it is
 * and never who holds it. A mailbox's address already carries its own @.
 */
export function externalName(external: ExternalAccount): string {
  return external.kind === undefined || external.kind === 'account'
    ? `@${external.handle.replace(/^@/, '')}`
    : external.handle;
}

/**
 * How to describe one side's proof in plain words. It names the attester and the method
 * together and does not rank them: whether a given proof is convincing is the reader's
 * judgement, which is the reason for publishing it rather than a verdict about it.
 *
 * An unrecognised method returns nothing, so a renderer omits the line instead of
 * describing a proof it does not understand.
 */
export function attestationLabel(
  method: string,
  names: { site: string; provider: string },
): string | undefined {
  return {
    declared: `Stated by ${names.site}`,
    oauth: `Signed in with ${names.provider}`,
    gist: `Published a proof on ${names.provider}`,
    backlink: `Linked back to ${names.site}`,
    signature: 'Proved with a signature',
    code: 'Entered a code sent to this address',
  }[method];
}

/**
 * Where a subject's name may link, or nothing where it has no page of its own. A mailbox's
 * address is `mailto:`, which opens a message to it and shows a reader nothing.
 */
export function externalLink(external: ExternalAccount): string | undefined {
  return external.kind === 'mailbox' ? undefined : external.profileUrl;
}

/**
 * The hover text on a proof link: where it leads, then when it was last read there. A
 * proof this backend serves itself is never reread, so it gives no such time.
 */
export function proofTitle(attestation: Attestation, when: (time: number) => string): string {
  const where = `View the proof at ${new URL(attestation.artifactUrl!).host}`;

  return attestation.hosted ? where : `${where} | Last checked ${when(attestation.confirmedAt)}`;
}

import { MIMEType } from 'node:util';
import {
  Refused,
  type ArtifactProvider,
  type ExternalAccount,
  type LocalAccount,
} from '../core/index.js';
import { discard, readBounded } from './body.js';
import { transport } from './public-fetch.js';

/**
 * Domain suffixes that must never be fetched. The holder names the domain, so it names the
 * host, and these are the names that can resolve to something inside the network running
 * this. Reserved suffixes that resolve nowhere are left alone: asking about them is
 * pointless rather than dangerous, and they are what tests use.
 */
const reserved = ['local', 'internal', 'localhost', 'home', 'lan', 'corp', 'intranet'];

const name = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The one resolver every lookup goes to. Fixed, because the holder chooses the name and
 * nothing else: a resolver they could choose would answer whatever they liked. It is asked
 * over HTTPS because a Worker has no resolver of its own, and at an address that answers a
 * plain GET with JSON, so the lookup that was run is also a link a reader can open.
 */
const resolver = 'https://dns.google/resolve';

/** The label the record is published under, so it sits apart from the domain's own records. */
const label = '_verily';

/** Where on a domain the file is served. */
const path = '/.well-known/verily.txt';

/** The TXT record type, as the resolver numbers it. */
const txt = 16;

/** What a signing key's record says, before the key's fingerprint. */
const keyPrefix = 'verily-key=';

/** What a site's record says, before the host of the verifier it chose. */
const verifierPrefix = 'verily-verifier=';

export interface DnsOptions {
  /** Replaces the transport, which is only ever asked for the resolver. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface DomainProviderOptions extends DnsOptions {
  /** Shown as "Verify with …". */
  name?: string;
}

/** What a domain publishes for Verily, as one lookup found it. */
export interface Published {
  /** The lookup that was run, which is also a link a reader can open. */
  lookup: string;
  /** The text of every TXT record at `_verily.<domain>` that could be read. */
  values: string[];
  /**
   * Whether the resolver validated the answer with DNSSEC. Only a domain that signs its
   * zone gets this, and without it the answer is as good as the resolver's own lookup.
   */
  dnssec: boolean;
}

export interface WellKnownProviderOptions extends DomainProviderOptions {
  /**
   * Domains this instance will read, lowercase. Omitted means any public host, which is
   * the point of the method and needs Node: see `linkProvider()`.
   */
  hosts?: string[];
  /**
   * Replaces the transport, and with it the check that keeps an instance reading any host
   * out of the network it runs in. Pass one only where it enforces that itself, such as
   * through an egress proxy, or where `hosts` already confines it.
   */
  fetch?: typeof fetch;
  /** How much of the file is read before giving up on finding the line. */
  maxBytes?: number;
}

/**
 * Proves a domain by a record in its DNS. The holder publishes the local subject's address,
 * or a string minted for them where the subject has none, in a TXT record at `_verily.<domain>` and names the domain; this looks the record up and
 * checks the address is there. It reaches a domain that serves no page of its own, or only
 * forwards somewhere else, which a link back never can.
 *
 * What it establishes is that whoever wrote the record could write that domain's DNS. That
 * is the domain's holder or somebody they delegated to, and it is the exact name proved:
 * nothing is said about a parent or a subdomain. A domain changes hands like an account,
 * and takes the record with it or drops it.
 *
 * Like a link back, the proof is a standing statement, so freshness comes from `recheck()`
 * looking it up again and a renewal asks for the record already there. A lookup that could not be made is
 * unread, never absent.
 */
export function dnsProvider(options: DomainProviderOptions = {}): ArtifactProvider {
  const prove = async ({ artifact, expect }: { artifact: string; expect: string }) => {
    const domain = looked(artifact);
    const { values, dnssec } = await published(domain, options);

    if (!values.includes(expect))
      throw new Refused(`No TXT record at ${label}.${domain} has this value`);

    return { account: account(domain), ...(dnssec ? { dnssec } : {}) };
  };

  return {
    ...shared(options),
    method: 'dns',

    instructions(expect, artifact) {
      let domain = artifact ? named(artifact) : undefined;

      if (!domain && artifact) {
        try {
          domain = looked(artifact);
        } catch {
          /* An invalid input is never a command. */
        }
      }

      const record = domain ? `${label}.${domain}` : `${label}.YOUR-DOMAIN`;

      return [
        domain
          ? 'Add a TXT record with this name and value.'
          : 'Add a TXT record with this name and value. Replace YOUR-DOMAIN with the exact domain you enter below.',
        { code: record },
        'If your DNS host adds the domain automatically, enter only _verily for the root domain. For a subdomain such as www.example.com in the example.com zone, enter _verily.www.',
        { code: expect },
        domain
          ? `Proves control of ${domain} only. Parent domains and subdomains must be verified separately.`
          : 'Proves control of the exact domain you enter. Parent domains and subdomains must be verified separately.',
        'DNS changes can take up to 72 hours to appear. Check the published record with:',
        { code: `dig TXT ${record} +short` },
        ...(domain ? [[{ text: 'Look up this TXT record', href: lookup(domain) }]] : []),
        'Keep the TXT record in place after verification so Verily can check it again.',
      ];
    },

    resolve(artifact) {
      const domain = named(artifact);

      return domain ? lookup(domain) : artifact;
    },

    verify: async (input) => (await prove(input)).account,

    // The resolver says whether it validated the answer, which is worth keeping with it.
    prove,
  };
}

/**
 * Everything a domain publishes at `_verily.<domain>`, and whether the resolver validated
 * it. One name carries every statement a domain makes here, told apart by how each begins:
 * a subject's address or a minted proof, a signing key, a verifier.
 *
 * Throws `Refused` where the lookup gave no answer. A name with no records is an answer.
 */
export async function published(domain: string, options: DnsOptions = {}): Promise<Published> {
  if (!valid(domain)) throw new Refused('Not a domain this can look up');

  // Why the resolver could not be asked is about the network this runs in.
  const response = await (options.fetch ?? fetch)(lookup(domain), {
    redirect: 'manual',
    headers: { Accept: 'application/dns-json', 'User-Agent': 'Verily-V0' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
  }).catch(() => {
    throw new Refused('DNS could not be read');
  });

  let answer: unknown;

  try {
    if (!response.ok) throw new Refused('DNS could not be read');

    const { bytes, truncated } = await readBounded(response, 64 * 1024);

    if (truncated) throw new Refused('DNS could not be read');

    answer = parsed(new TextDecoder().decode(bytes));
  } finally {
    await discard(response);
  }

  // A cut-off answer may have left out the record that would have matched.
  if (!isRecord(answer) || answer.TC === true) throw new Refused('DNS could not be read');

  // The name not existing is an answer; anything else that is not success is no answer.
  if (answer.Status !== 0 && answer.Status !== 3) throw new Refused('DNS could not be read');

  const records = Array.isArray(answer.Answer) ? answer.Answer : [];

  return {
    lookup: lookup(domain),
    values: records
      .map((record) =>
        isRecord(record) && record.type === txt && typeof record.data === 'string'
          ? text(record.data)
          : undefined,
      )
      .filter((value) => value !== undefined),
    // The resolver sets this only where every record in the answer validated.
    dnssec: answer.AD === true,
  };
}

/**
 * What a verifier publishes at `_verily.<its host>` to name a signing key: one record for
 * each key. A reader holding a signed record and nothing else can then ask the verifier's
 * domain, and not the verifier's server, whether the key that signed it is the domain's.
 */
export function keyRecord(fingerprint: string): string {
  return `${keyPrefix}${fingerprint}`;
}

/** What a site publishes at `_verily.<its host>` to name the verifier that speaks for it. */
export function verifierRecord(host: string): string {
  return `${verifierPrefix}${host.toLowerCase()}`;
}

/**
 * The fingerprints of the signing keys a domain names in its DNS. A signed record names the
 * key that signed it and the verifier's address, so a key found here is one the domain in
 * that address answers for, for as long as the domain is kept and whatever became of the
 * server. Check the signature with `verifySigned()` first: this says whose a key is, and
 * nothing about what it signed.
 */
export async function dnsKeys(
  domain: string,
  options: DnsOptions = {},
): Promise<Omit<Published, 'values'> & { ids: string[] }> {
  const { values, ...found } = await published(named(domain) ?? domain, options);

  return { ...found, ids: namedKeys(values) };
}

/**
 * The hosts of the verifiers a site's domain names in its DNS. A record's local side is
 * the verifier's word for what the site told it, so a verifier named here is one the site
 * itself chose, which a reader can find out without visiting the site.
 */
export async function dnsVerifiers(
  domain: string,
  options: DnsOptions = {},
): Promise<Omit<Published, 'values'> & { hosts: string[] }> {
  const { values, ...found } = await published(named(domain) ?? domain, options);

  return { ...found, hosts: namedVerifiers(values).map(({ host }) => host) };
}

/**
 * The fingerprints a domain's records name, in the upper case a key's id is kept in. A
 * fingerprint is hexadecimal, so however it was typed it names the same key.
 */
export function namedKeys(values: string[]): string[] {
  return stated(values, keyPrefix).map((id) => id.toUpperCase());
}

/**
 * The verifier hosts a domain's records name, lowercase as a host compares, each with the
 * record as it is published: that text is what a reader finds at the lookup.
 */
export function namedVerifiers(values: string[]): { host: string; record: string }[] {
  return values
    .filter((value) => value.startsWith(verifierPrefix))
    .map((record) => ({ host: record.slice(verifierPrefix.length).trim().toLowerCase(), record }))
    .filter(({ host }) => host);
}

/** What follows a prefix in each record that begins with it. */
function stated(values: string[], prefix: string): string[] {
  return values
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length).trim())
    .filter(Boolean);
}

/**
 * The name a URL's host is looked up under, or nothing where it is not a public domain: an
 * address literal, a single label, a name inside the network.
 */
export function domainOf(url: string): string | undefined {
  const host = URL.parse(url)?.hostname.toLowerCase().replace(/\.$/, '');

  return host !== undefined && valid(host) ? host : undefined;
}

/**
 * Proves a domain by a file it serves. The holder puts the local subject's address, or a
 * string minted for them where the subject has none, on a line of `/.well-known/verily.txt` and names the domain; this reads the file and checks
 * the line is there. It is for a holder who can add a file to a site and cannot reach its
 * DNS or its pages' markup.
 *
 * The domain names the host that is fetched, so the read is the web key directory's: HTTPS
 * on the default port, a public address, no redirect followed, a deadline and a bounded
 * read. Only `text/plain` is read, because a line in anything else may be an example of a
 * line and not one.
 */
export function wellKnownProvider(options: WellKnownProviderOptions = {}): ArtifactProvider {
  const request = transport(options);
  const hosts = options.hosts?.map((host) => host.toLowerCase());
  const maxBytes = options.maxBytes ?? 64 * 1024;

  return {
    ...shared(options),
    method: 'wellknown',

    instructions: (expect) => [
      'Serve a plain text file at this path on your domain, with this on a line of its own, then enter the domain below.',
      { code: path },
      { code: expect },
    ],

    resolve(artifact) {
      const domain = named(artifact);

      return domain ? `https://${domain}${path}` : artifact;
    },

    async verify({ artifact, expect }): Promise<ExternalAccount> {
      const domain = served(artifact);

      if (hosts && !hosts.includes(domain)) throw new Refused('Not a host this instance reads');

      const response = await request(`https://${domain}${path}`, {
        // Workers refuse 'error', so a redirect comes back as a response and is refused below.
        redirect: 'manual',
        headers: { Accept: 'text/plain', 'User-Agent': 'Verily-V0' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      }).catch(() => {
        throw new Refused('File could not be reached');
      });

      try {
        // The holder named this domain, so a redirect would take the check somewhere else.
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
          throw new Refused('File redirects, and a redirect is not followed');

        if (!response.ok) throw new Refused('File unavailable');

        if (mediaType(response.headers.get('content-type')) !== 'text/plain')
          throw new Refused('File is not plain text');

        const { bytes, truncated } = await readBounded(response, maxBytes);
        const lines = new TextDecoder().decode(bytes).split(/\r?\n/);

        // The last line of a file cut short may be the start of some longer address.
        if (truncated) lines.pop();

        if (!lines.some((line) => line.trim() === expect))
          throw new Refused(
            truncated ? 'File is too large to read' : 'File has no line with this value',
          );
      } finally {
        await discard(response);
      }

      return account(domain);
    },
  };
}

/** What both methods say of themselves: they name the same thing, and differ in how. */
function shared(options: DomainProviderOptions) {
  return {
    id: 'domain',
    name: options.name ?? 'Domain',
    artifact: 'location' as const,
    field: 'Your domain',
    input: 'text' as const,

    // The subject's own address is the entire claim, where it has one. A subject with no
    // page a reader could open has nothing to name, and is proved by a minted string.
    expect: (local: LocalAccount) => local.profileUrl,

    // DNS and a well-known path are read by anyone, unasked. A subject with no public page
    // is one its site keeps private, so the string says nothing of the site either.
    mint: (secret: string) => `verily-proof=${secret}`,

    // A domain is where it says it is, so a record of one already says where to look.
    known: (account: ExternalAccount) => (account.kind === 'domain' ? account.id : undefined),
  };
}

/**
 * A domain, named by itself. The id is the name as DNS compares it: lowercase, and in
 * punycode where it was typed in another script.
 */
function account(domain: string): ExternalAccount {
  return { id: domain, kind: 'domain', handle: domain, profileUrl: `https://${domain}/` };
}

/**
 * The domain a holder typed, or nothing where it is not one. Taken bare or as the address
 * of its front page, since both are how a domain is written, and never with a path: a path
 * is somebody's page, and this proves no page.
 */
function named(typed: string): string | undefined {
  const trimmed = typed.trim();

  if (trimmed.length > 300) return undefined;

  const url = URL.parse(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);

  if (!url || url.username || url.password || url.port || url.search || url.hash) return undefined;

  if (url.pathname !== '/') return undefined;

  const domain = url.hostname.toLowerCase().replace(/\.$/, '');

  return valid(domain) ? domain : undefined;
}

/** A dotted public-looking name, as DNS limits one, and not an address literal. */
function valid(domain: string): boolean {
  return (
    domain.length <= 253 - label.length - 1 &&
    name.test(domain) &&
    domain.split('.').every((part) => part.length <= 63) &&
    !/^[\d.]+$/.test(domain) &&
    !reserved.includes(domain.split('.').pop()!)
  );
}

/** The lookup for a domain's record: the address that is fetched, and kept as the proof's. */
function lookup(domain: string): string {
  return `${resolver}?name=${label}.${domain}&type=TXT`;
}

/**
 * The domain a lookup address asks about, once it is exactly a lookup this would make. The
 * address comes back from the holder or from a record, and anything else is somewhere this
 * has no business fetching.
 */
function looked(artifact: string): string {
  const url = artifact.length <= 600 ? URL.parse(artifact) : null;
  const asked = url?.searchParams.get('name') ?? '';
  const domain = asked.startsWith(`${label}.`) ? asked.slice(label.length + 1) : '';

  if (!url || !valid(domain) || url.href !== lookup(domain))
    throw new Refused('Not a domain this can look up');

  return domain;
}

/** The domain a file address is on, once it is exactly where this would read one. */
function served(artifact: string): string {
  const url = artifact.length <= 600 ? URL.parse(artifact) : null;
  const domain = url?.hostname.toLowerCase() ?? '';

  if (!url || !valid(domain) || url.href !== `https://${domain}${path}`)
    throw new Refused('Not a domain this can read');

  return domain;
}

/**
 * A TXT record's text. A record is one or more strings joined end to end, and a resolver
 * writes them either already joined or each in quotes with a backslash before anything
 * awkward. One this cannot read is no text at all, since a guess could read as a match.
 */
function text(data: string): string | undefined {
  if (!data.startsWith('"')) return data.trim();

  let out = '';
  let at = 0;

  while (at < data.length) {
    if (data[at] === ' ') {
      at++;
      continue;
    }

    if (data[at] !== '"') return undefined;

    at++;

    while (at < data.length && data[at] !== '"') {
      if (data[at] === '\\') {
        const code = /^\d{3}/.exec(data.slice(at + 1))?.[0];

        out += code ? String.fromCharCode(Number(code)) : (data[at + 1] ?? '');
        at += code ? 4 : 2;
      } else out += data[at++];
    }

    if (data[at] !== '"') return undefined;

    at++;
  }

  return out.trim();
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** A `Content-Type`'s essence, or nothing where it is missing or malformed. */
function mediaType(header: string | null): string | undefined {
  if (header === null) return undefined;

  try {
    return new MIMEType(header).essence;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

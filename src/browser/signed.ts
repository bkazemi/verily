import { verifySigned, type Evidence, type SignedEvidence } from '../core/index.js';

/**
 * What came of checking a record against its signed record in this browser: the same
 * record as its verifier serves it with a signature.
 *
 * `valid` is a signed record of this very record, signed by one of its verifier's
 * published keys. The record is then drawn from the signed one, so what stands beside the
 * mark is what was signed. `invalid` is a signed record that was read and no published key
 * signed, or one signed over some other record. `unchecked` is no verdict: the signed
 * record or the keys could not be read, or this browser cannot check an Ed25519 signature.
 */
export type Signature =
  { state: 'valid'; keyId: string } | { state: 'invalid' } | { state: 'unchecked' };

/** One check per record as shown while it holds, since a card is drawn again at every read. */
const checks = new Map<string, Promise<Signature>>();

/** Each verifier's keys, read once for all of its records. */
const published = new Map<string, Promise<unknown>>();

/** What each record's signed record says, once it has checked: the record is drawn from this. */
const signedAs = new Map<string, Evidence>();

/** The records, as shown, whose signed records failed. */
const failures = new Set<string>();

/** Who is told when a check changes how a record is to be drawn. */
const listeners = new Set<() => void>();

/** Whether a record may be drawn at all, as whoever draws records decides it. */
let drawable: (record: unknown) => record is Evidence = (record): record is Evidence => false;

/** Sets the test a signed record's contents must pass before a record is drawn from them. */
export function drawSignedWith(test: (record: unknown) => record is Evidence): void {
  drawable = test;
}

let supported: Promise<boolean> | undefined;

/** Whether this browser signs and checks Ed25519 at all, asked once. */
function able(): Promise<boolean> {
  supported ??= crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']).then(
    () => true,
    () => false,
  );

  return supported;
}

/** A value written the same way whatever order its fields were set in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  return `{${Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
    .join(',')}}`;
}

/** What a record claims, apart from whether it stands now: all a signed record can bear out. */
function claims(record: object): string {
  const {
    status: _status,
    revokedAt: _revokedAt,
    signedUrl: _signedUrl,
    links: _links,
    type: _type,
    version: _version,
    issuedAt: _issuedAt,
    ...rest
  } = record as Record<string, unknown>;

  return canonical(rest);
}

/**
 * What a verdict is kept under: the signed record's address and everything the record shown
 * claims.
 * Another record at the same address, or the same one once it reads differently, is checked
 * for itself and never given the first one's verdict.
 */
const shown = (evidence: Evidence) => `${evidence.signedUrl}\n${claims(evidence)}`;

function keysAt(url: string, afresh = false): Promise<unknown> {
  let reading = afresh ? undefined : published.get(url);

  if (!reading) {
    const read = fetch(url)
      .then(async (listed) =>
        listed.ok ? ((await listed.json()) as { keys?: unknown }).keys : undefined,
      )
      .catch(() => undefined);

    reading = read;
    published.set(url, read);

    // Keys that could not be read are asked for again by the next check.
    void read.then((keys) => {
      if (!Array.isArray(keys) && published.get(url) === read) published.delete(url);
    });
  }

  return reading;
}

type Checked = Signature & { record?: Evidence };

async function check(evidence: Evidence): Promise<Checked> {
  try {
    if (!(await able())) return { state: 'unchecked' };

    // Both are read from where the record itself lives, never from an address the record
    // names for the purpose: whoever handed the record over could name a signed record and
    // keys of their own. The verifier's keys sit beside its records, `<base>/keys` for
    // `<base>/connections/<id>`, and a signed record anywhere else is not this record's.
    const expected = `${evidence.evidenceUrl}?format=signed`;

    if (evidence.signedUrl !== expected) return { state: 'invalid' };

    const keysUrl = new URL('../keys', evidence.evidenceUrl).href;
    const [served, held] = await Promise.all([fetch(expected), keysAt(keysUrl)]);

    if (!served.ok || !Array.isArray(held)) return { state: 'unchecked' };

    const signed = (await served.json()) as SignedEvidence;
    let keys: unknown = held;

    // A verifier may have changed keys since its list was read. A key this list does not
    // have is looked for in the list as it is now, before the record is called unsigned.
    if (!held.some((key: { id?: unknown } | null) => key?.id === signed?.keyId)) {
      keys = await keysAt(keysUrl, true);

      if (!Array.isArray(keys)) return { state: 'unchecked' };
    }

    const document = await verifySigned(signed, keys as never[]);

    // A good signature over some other record says nothing about this one.
    if (
      !document ||
      document.id !== evidence.id ||
      document.verifierName !== evidence.verifierName ||
      document.evidenceUrl !== evidence.evidenceUrl ||
      document.siteName !== evidence.siteName ||
      document.local.reference !== evidence.local.reference ||
      document.provider !== evidence.provider ||
      document.external.id !== evidence.external.id
    )
      return { state: 'invalid' };

    // The record as it was signed. Whether it stands now is no part of a signed record, so
    // that alone is kept from the record as it was read.
    const { type: _type, version: _version, issuedAt: _issuedAt, ...said } = document;

    const record: unknown = {
      ...said,
      status: evidence.status,
      ...(evidence.revokedAt === undefined ? {} : { revokedAt: evidence.revokedAt }),
      signedUrl: evidence.signedUrl,
    };

    // Signed, but not something a page may draw: it is shown as read, with no mark.
    return drawable(record)
      ? { state: 'valid', keyId: signed.keyId, record }
      : { state: 'unchecked' };
  } catch {
    return { state: 'unchecked' };
  }
}

/** Checks a record, as shown, against its signed record and its verifier's published keys. */
export function signature(evidence: Evidence): Promise<Signature> {
  const key = shown(evidence);
  let checking = checks.get(key);

  if (!checking) {
    const checked = check(evidence);

    checking = checked.then(({ record: _record, ...result }) => result);
    checks.set(key, checking);

    void checked.then((result) => {
      // Nothing was learned, so the next card drawn asks again.
      if (result.state === 'unchecked') checks.delete(key);

      if (result.state === 'invalid') failures.add(key);

      if (result.record) {
        signedAs.set(key, result.record);

        // Drawn from the signed record, it is asked about again as that has it. That is the
        // same signed record and the same answer, so it is not read a second time.
        const drawn = shown(result.record);

        signedAs.set(drawn, result.record);
        checks.set(drawn, checking!);
      }

      // Told only where the record is now to be drawn some other way than it was read.
      if (
        result.state === 'invalid' ||
        (result.record && claims(result.record) !== claims(evidence))
      )
        for (const listener of [...listeners]) listener();
    });
  }

  return checking;
}

/**
 * The record as it may be shown. One whose signed record checked is shown as that has
 * it, with only its present state taken from the record as read, so what stands beside the
 * signature mark is what was signed. One whose signed record failed is not shown as verified: the
 * verifier's own signature does not bear it out, so it reads as unconfirmed.
 */
export function standing<T extends Evidence>(evidence: T): T {
  if (evidence.signedUrl === undefined) return evidence;

  const key = shown(evidence);
  const signed = signedAs.get(key);

  if (signed)
    return {
      ...signed,
      status: evidence.status,
      ...(evidence.revokedAt === undefined ? {} : { revokedAt: evidence.revokedAt }),
    } as T;

  return evidence.status === 'verified' && failures.has(key)
    ? { ...evidence, status: 'unconfirmed' }
    : evidence;
}

/**
 * Checks each signed record given and calls back when a check changes how one is to be
 * drawn, so whoever drew them can draw them again. A record whose check has already come
 * back is not asked about twice.
 */
export function watchSigned(records: Evidence[], changed: () => void): void {
  for (const record of records) {
    if (record.signedUrl === undefined) continue;

    const key = shown(record);

    if (failures.has(key) || signedAs.has(key)) continue;

    void signature(record).then((result) => {
      if (result.state === 'invalid' || claims(standing(record)) !== claims(record)) changed();
    });
  }
}

/** Tells a listener whenever a check changes how a record is to be drawn. Returns how to stop. */
export function onSignatureResult(listener: () => void): () => void {
  listeners.add(listener);

  return () => void listeners.delete(listener);
}

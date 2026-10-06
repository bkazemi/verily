import { signedBy, verifySigned, type Evidence, type SignedDocument } from '../core/index.js';

/**
 * What came of checking a record against its signed record in this browser: the same
 * record as its verifier serves it with a signature.
 *
 * `valid` is a signed record of this very record, signed by one of its verifier's
 * published keys. The record is then drawn from the signed one, so what stands beside the
 * mark is what was signed. `invalid` is a signed record that was read and no published key
 * signed, or one signed over some other record. `unchecked` is no verdict, and says why:
 * the check ran out of time, or the signed record or the keys could not be read. Either is
 * worth trying again.
 */
export type Signature =
  | { state: 'valid'; keyId: string }
  | { state: 'invalid' }
  | { state: 'unchecked'; why: 'timeout' | 'unreadable' };

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

/**
 * What a record claims, apart from whether it stands now: all a signed record can bear out.
 * The holder's mark is no claim of the verifier's and is in no signed record.
 */
function claims(record: object): string {
  const {
    status: _status,
    revokedAt: _revokedAt,
    signedUrl: _signedUrl,
    mark: _mark,
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

/**
 * How long a signed record or a key list is waited for. A card is veiled and out of reach
 * while its check is out, so a verifier that never answers must not hold it there: past
 * this the check is no verdict, and the record is shown as it was read.
 */
const checkLimitMs = 5000;

/** What a read gives when it ran out of time, as against one that failed. */
const late = Symbol('late');

/** Reads something, giving nothing if it fails and `late` if it takes longer than the limit. */
function limited<T>(
  read: (signal?: AbortSignal) => Promise<T>,
): Promise<T | undefined | typeof late> {
  const stop = typeof AbortController === 'undefined' ? undefined : new AbortController();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop?.abort();
      resolve(late);
    }, checkLimitMs);

    void read(stop?.signal)
      .catch(() => undefined)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
  });
}

function keysAt(url: string, afresh = false): Promise<unknown> {
  let reading = afresh ? undefined : published.get(url);

  if (!reading) {
    const read = limited<unknown>(async (signal) => {
      const listed = await fetch(url, { signal });

      return listed.ok ? ((await listed.json()) as { keys?: unknown }).keys : undefined;
    });

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
    // Both are read from where the record itself lives, never from an address the record
    // names for the purpose: whoever handed the record over could name a signed record and
    // keys of their own. The verifier's keys sit beside its records, `<base>/keys` for
    // `<base>/connections/<id>`, and a signed record anywhere else is not this record's.
    const expected = `${evidence.evidenceUrl}?format=signed`;

    if (evidence.signedUrl !== expected) return { state: 'invalid' };

    const keysUrl = new URL('../keys', evidence.evidenceUrl).href;

    const [signed, held] = await Promise.all([
      limited<string | undefined>(async (signal) => {
        const served = await fetch(expected, { signal });

        return served.ok ? await served.text() : undefined;
      }),
      keysAt(keysUrl),
    ]);

    if (signed === late || held === late) return { state: 'unchecked', why: 'timeout' };

    if (signed === undefined || !Array.isArray(held))
      return { state: 'unchecked', why: 'unreadable' };

    let keys: unknown = held;
    const by = await signedBy(signed);

    // Something else was served in a signed record's place, which is no verdict on this one.
    if (by === undefined) return { state: 'unchecked', why: 'unreadable' };

    // A verifier may have changed keys since its list was read. A key this list does not
    // have is looked for in the list as it is now, before the record is called unsigned.
    if (!held.some((key: { id?: unknown } | null) => key?.id === by)) {
      keys = await keysAt(keysUrl, true);

      if (!Array.isArray(keys))
        return { state: 'unchecked', why: keys === late ? 'timeout' : 'unreadable' };
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

    // A retired record is signed as a version of its own, and a record that stands as the
    // other. One served for the other is the record caught between the two, and no verdict.
    if ((document.version === 2) !== (evidence.status === 'retired'))
      return { state: 'unchecked', why: 'unreadable' };

    // The record as it was signed. Whether it stands now is no part of a signed record, so
    // that is kept from the record as it was read, and so is the holder's mark, which is in
    // no signed record: whatever a document says of either is left behind.
    const {
      type: _type,
      version: _version,
      issuedAt: _issuedAt,
      status: _status,
      retiredAt: _retiredAt,
      mark: _mark,
      ...said
    } = document as SignedDocument & Partial<Pick<Evidence, 'status' | 'retiredAt' | 'mark'>>;

    const record: unknown = {
      ...said,
      status: evidence.status,
      ...(evidence.revokedAt === undefined ? {} : { revokedAt: evidence.revokedAt }),
      ...(document.version === 2 ? { retiredAt: document.retiredAt } : {}),
      ...(evidence.mark === undefined ? {} : { mark: evidence.mark }),
      signedUrl: evidence.signedUrl,
    };

    // Signed, but not something a page may draw: it is shown as read, with no mark.
    return drawable(record)
      ? { state: 'valid', keyId: by, record }
      : { state: 'unchecked', why: 'unreadable' };
  } catch {
    return { state: 'unchecked', why: 'unreadable' };
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
 *
 * The holder's mark is taken from the record as read too, each time, and never from the
 * signed record kept: a mark would otherwise vanish the moment its record checked, and one
 * changed since would go on being shown as it was.
 */
export function standing<T extends Evidence>(evidence: T): T {
  if (evidence.signedUrl === undefined) return evidence;

  const key = shown(evidence);
  const signed = signedAs.get(key);

  if (signed) {
    const { mark: _mark, ...said } = signed;

    return {
      ...said,
      status: evidence.status,
      ...(evidence.revokedAt === undefined ? {} : { revokedAt: evidence.revokedAt }),
      ...(evidence.mark === undefined ? {} : { mark: evidence.mark }),
    } as T;
  }

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

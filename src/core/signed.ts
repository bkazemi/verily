import type { CleartextMessage, Signature } from 'openpgp';
import type { Evidence } from './index.js';

/**
 * A verifier's public key, as it publishes it: an OpenPGP key, named by its fingerprint.
 * `alg` says how a record under it is read, so another scheme can sit beside this one.
 */
export interface VerifierKey {
  /** The key's fingerprint, in the upper case it is read aloud in. */
  id: string;
  alg: 'OpenPGP';
  /** The armored public key, as `gpg --import` reads it. */
  publicKey: string;
}

/**
 * What either version says of a record. The holder's mark is left out: it is about how
 * their accounts are listed, and no part of what was verified.
 */
type Signable = Omit<Evidence, 'status' | 'revokedAt' | 'signedUrl' | 'mark' | 'retiredAt'> & {
  type: 'verily-evidence';
  issuedAt: number;
};

/**
 * What a signature covers: the record as it stood at `issuedAt`. Whether it still stands
 * is a live fact no signature holds, so version 1 leaves its status out, means the record
 * stood when it was signed, and gives `evidenceUrl` as where to ask.
 *
 * Version 2 is a retired record, which did not stand when it was signed and says so. It is
 * a version of its own because a reader of version 1 ignores fields it does not know, and
 * would read a retired record signed as version 1 as one that stood.
 */
export type SignedDocument =
  (Signable & { version: 1 }) | (Signable & { version: 2; status: 'retired'; retiredAt: number });

/**
 * A record that can be checked away from the verifier that served it: the document as
 * text under an OpenPGP cleartext signature, which `gpg --verify` reads as it is.
 */
export type SignedEvidence = string;

export interface Signer {
  key: VerifierKey;
  sign(document: SignedDocument): Promise<SignedEvidence>;
}

/** A signed record is a few kilobytes. Anything far past that is not one. */
const maxSignedLength = 262144;

let loaded: ReturnType<typeof load> | undefined;

async function load() {
  const pgp = await import('openpgp');
  const weak = [pgp.enums.hash.sha1, pgp.enums.hash.md5, pgp.enums.hash.ripemd];

  return {
    pgp,
    // SHA-1 and older are refused under a key's own signatures as well as under a record.
    config: {
      ...pgp.config,
      rejectHashAlgorithms: new Set([...pgp.config.rejectHashAlgorithms, ...weak]),
      rejectMessageHashAlgorithms: new Set([...pgp.config.rejectMessageHashAlgorithms, ...weak]),
    },
  };
}

/**
 * OpenPGP.js and how it is set, brought in when a record is first checked and not before.
 * On a page it will not start without WebCrypto, which an insecure page lacks, and a page
 * with no signed record on it has no use for it: neither should cost the badge anything.
 */
const library = () => (loaded ??= load());

/** The signatures under a message, which the library keeps and its types leave out. */
const marks = (message: CleartextMessage) =>
  (message as unknown as { signature: Signature }).signature.packets;

/** A signed record as OpenPGP.js reads it, where it is one message under one signature. */
async function read(signed: unknown): Promise<CleartextMessage | undefined> {
  if (typeof signed !== 'string' || signed.length > maxSignedLength) return undefined;

  const text = signed.trim();
  const lines = text.split(/\r?\n/);
  const only = (line: string) => lines.indexOf(line) === lines.lastIndexOf(line);

  // The message and nothing around it: what stands outside one is signed by nobody. Each
  // marker is a whole line, met once, with the last of them the last line there is. A line
  // of the text that begins with a dash is written with "- " before it, so none of the
  // text can be one of these.
  if (
    lines[0] !== '-----BEGIN PGP SIGNED MESSAGE-----' ||
    lines.at(-1) !== '-----END PGP SIGNATURE-----' ||
    !lines.includes('-----BEGIN PGP SIGNATURE-----') ||
    ![lines[0], lines.at(-1)!, '-----BEGIN PGP SIGNATURE-----'].every(only)
  )
    return undefined;

  try {
    const { pgp, config } = await library();
    const message = await pgp.readCleartextMessage({ cleartextMessage: text, config });

    return marks(message).length === 1 ? message : undefined;
  } catch {
    return undefined;
  }
}

const fingerprint = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('');

/**
 * The fingerprint of the key a signed record says signed it, checked or not: which key to
 * look for, and no reason by itself to believe anything.
 */
export async function signedBy(signed: unknown): Promise<string | undefined> {
  const message = await read(signed);
  const by = message && marks(message)[0]!.issuerFingerprint;

  return by ? fingerprint(by) : undefined;
}

/**
 * The document a signed record carries, if one of the keys given signed it, and nothing
 * otherwise. The keys are the caller's to choose: a record is only as good as the reason
 * to believe each key is the verifier's. It says what stood when it was signed, never
 * that it stands now.
 *
 * Whether a signature counts is OpenPGP.js's to say, by the format's own rules: a key is
 * judged as it stood when the record was signed, so one that has since run out, or been
 * retired, still answers for what it signed before, and one revoked as compromised signs
 * nothing at all. Only a record signed by the listed key itself is taken, not by a subkey
 * of it, so the fingerprint a record names is the one a list holds.
 */
export async function verifySigned(
  signed: unknown,
  keys: VerifierKey[],
): Promise<SignedDocument | undefined> {
  const message = await read(signed);
  const by = await signedBy(signed);

  if (!message || !by || !Array.isArray(keys)) return undefined;

  for (const key of keys) {
    if (
      key === null ||
      typeof key !== 'object' ||
      key.alg !== 'OpenPGP' ||
      key.id !== by ||
      typeof key.publicKey !== 'string' ||
      key.publicKey.length > maxSignedLength
    )
      continue;

    try {
      const { pgp, config } = await library();
      const published = await pgp.readKey({ armoredKey: key.publicKey, config });

      // The id is recomputed, so a key listed under another's id signs nothing in its name.
      if (published.getFingerprint().toUpperCase() !== key.id) continue;

      // Checked against the key itself with its subkeys taken off, so a subkey's signature
      // cannot pass under the key's name whatever the signature says of who made it.
      published.subkeys = [];

      const { signatures, data } = await pgp.verify({
        message,
        verificationKeys: published,
        config,
      });

      // Throws where the signature is not this key's, or the key was not fit to make it.
      await signatures[0]!.verified;

      const document = JSON.parse(data) as SignedDocument;

      return document?.type === 'verily-evidence' &&
        typeof document.issuedAt === 'number' &&
        (document.version === 1 ||
          (document.version === 2 &&
            document.status === 'retired' &&
            typeof document.retiredAt === 'number'))
        ? document
        : undefined;
    } catch {
      continue;
    }
  }

  return undefined;
}

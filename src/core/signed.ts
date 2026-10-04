import type { Evidence } from './index.js';

/**
 * A verifier's public key, as it publishes it. The id is derived from the key, so a
 * record names the key that signed it without carrying the key itself.
 */
export interface VerifierKey {
  id: string;
  alg: 'Ed25519';
  /** The raw 32-byte public key, base64url. */
  publicKey: string;
}

/**
 * What a signature covers: the record as it stood at `issuedAt`. Whether it still stands
 * is a live fact no signature holds, so its status is left out and `evidenceUrl` is where
 * to ask.
 */
export type SignedDocument = Omit<Evidence, 'status' | 'revokedAt' | 'signedUrl'> & {
  type: 'verity-evidence';
  version: 1;
  issuedAt: number;
};

/**
 * A record that can be checked away from the verifier that served it. `payload` is the
 * document's exact bytes, base64url, and the signature is over those bytes: nothing has
 * to be put back into a canonical form before it is checked.
 */
export interface SignedEvidence {
  alg: 'Ed25519';
  keyId: string;
  payload: string;
  signature: string;
}

export interface Signer {
  key: VerifierKey;
  sign(document: SignedDocument): Promise<SignedEvidence>;
}

/** Signed ahead of the payload, so a signature made here is never one over anything else. */
const context = 'verity-evidence-v1\n';

/** The fixed PKCS #8 wrapping of a 32-byte Ed25519 seed, which is how WebCrypto reads one. */
const pkcs8 = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

function encode(bytes: Uint8Array): string {
  let text = '';

  for (const byte of bytes) text += String.fromCharCode(byte);

  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;

  try {
    return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
}

function covered(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const lead = new TextEncoder().encode(context);
  const bytes = new Uint8Array(lead.length + payload.length);

  bytes.set(lead);
  bytes.set(payload, lead.length);

  return bytes;
}

async function keyId(publicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))).slice(0, 16);
}

/** A new signing key: 32 random bytes, base64url. Keep it secret and keep it backed up. */
export function generateSigningKey(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

/** Reads a signing key made by `generateSigningKey`, giving its public half and a way to sign. */
export async function signer(signingKey: string): Promise<Signer> {
  const seed = decode(signingKey);

  if (seed?.length !== 32) throw new Error('Invalid signing key');

  const secret = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from([...pkcs8, ...seed]),
    'Ed25519',
    true,
    ['sign'],
  );

  const publicKey = decode((await crypto.subtle.exportKey('jwk', secret)).x ?? '');

  if (publicKey?.length !== 32) throw new Error('Invalid signing key');

  const key: VerifierKey = {
    id: await keyId(publicKey),
    alg: 'Ed25519',
    publicKey: encode(publicKey),
  };

  return {
    key,
    async sign(document) {
      const payload = new TextEncoder().encode(JSON.stringify(document));

      return {
        alg: 'Ed25519',
        keyId: key.id,
        payload: encode(payload),
        signature: encode(
          new Uint8Array(await crypto.subtle.sign('Ed25519', secret, covered(payload))),
        ),
      };
    },
  };
}

/**
 * The document a signed record carries, if one of the keys given signed it, and nothing
 * otherwise. The keys are the caller's to choose: a record is only as good as the reason
 * to believe each key is the verifier's. It says what stood when it was signed, never
 * that it stands now.
 */
export async function verifySigned(
  signed: unknown,
  keys: VerifierKey[],
): Promise<SignedDocument | undefined> {
  if (signed === null || typeof signed !== 'object') return undefined;

  const { alg, keyId: id, payload, signature } = signed as Record<string, unknown>;

  if (
    alg !== 'Ed25519' ||
    typeof id !== 'string' ||
    typeof payload !== 'string' ||
    typeof signature !== 'string'
  )
    return undefined;

  const bytes = decode(payload);
  const mark = decode(signature);

  if (!bytes || mark?.length !== 64) return undefined;

  for (const key of keys) {
    const publicKey = key.alg === 'Ed25519' ? decode(key.publicKey) : undefined;

    // The id is recomputed, so a key listed under another's id signs nothing in its name.
    if (publicKey?.length !== 32 || key.id !== id || (await keyId(publicKey)) !== id) continue;

    try {
      const imported = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, [
        'verify',
      ]);

      if (!(await crypto.subtle.verify('Ed25519', imported, mark, covered(bytes)))) continue;

      const document = JSON.parse(new TextDecoder().decode(bytes)) as SignedDocument;

      return document?.type === 'verity-evidence' &&
        document.version === 1 &&
        typeof document.issuedAt === 'number'
        ? document
        : undefined;
    } catch {
      continue;
    }
  }

  return undefined;
}

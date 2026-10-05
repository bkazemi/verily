/**
 * Making a verifier's key and signing with it. Checking what was signed is in
 * `core/signed.ts`, which a page runs too.
 */

import {
  config as defaults,
  createCleartextMessage,
  enums,
  generateKey,
  readPrivateKey,
  sign,
} from 'openpgp';
import { verifySigned, type SignedDocument, type Signer, type VerifierKey } from '../core/index.js';

const config = { ...defaults, preferredHashAlgorithm: enums.hash.sha512 };

/**
 * A new signing key for a verifier of this name: an armored OpenPGP private key. Keep it
 * secret and keep it backed up.
 *
 * It is an Ed25519 key in the form GnuPG reads, with no subkeys, so `gpg --verify` checks
 * what it signs. The name is the key's own word for whose it is, and more can be added to
 * the same key later without changing its fingerprint.
 */
export async function generateSigningKey(name: string): Promise<string> {
  const { privateKey } = await generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ name }],
    subkeys: [],
    format: 'armored',
    config,
  });

  return privateKey;
}

/** Reads a signing key made by `generateSigningKey`, giving its public half and a way to sign. */
export async function signer(signingKey: string): Promise<Signer> {
  const secret = await readPrivateKey({ armoredKey: signingKey, config }).catch(() => undefined);

  if (!secret?.isDecrypted()) throw new Error('Invalid signing key');

  const key: VerifierKey = {
    id: secret.getFingerprint().toUpperCase(),
    alg: 'OpenPGP',
    publicKey: secret.toPublic().armor(),
  };

  const made: Signer = {
    key,
    async sign(document) {
      const signed = await sign({
        message: await createCleartextMessage({ text: JSON.stringify(document, null, 2) }),
        signingKeys: secret,
        config,
      });

      // Line endings are no part of what is signed, so the file is given one kind of them.
      return signed.replace(/\r\n/g, '\n');
    },
  };

  // A key that has run out or been revoked, or one that signs with a subkey, would sign
  // records that do not check. That is found out now and not by whoever saved one.
  const probe = { type: 'verily-evidence', version: 1, issuedAt: 0 } as SignedDocument;

  const checks = await made.sign(probe).then(
    (signed) => verifySigned(signed, [key]),
    () => undefined,
  );

  if (!checks) throw new Error('Invalid signing key');

  return made;
}

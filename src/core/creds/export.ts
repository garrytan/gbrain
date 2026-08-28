/**
 * creds/export — encrypted credential bundles for hosted-upgrade transfer.
 *
 * `gbrain creds export` produces a passphrase-encrypted JSON bundle carrying
 * selected vault entries PLUS the provider client records they depend on
 * (Google refresh tokens are bound to the client that minted them — moving
 * one without the other produces dead tokens). `gbrain creds import` is the
 * inverse; hosted gbrain.io's /api/creds/import accepts the same format.
 *
 * Crypto: scrypt (N=2^15, r=8, p=1) key derivation → AES-256-GCM. The format
 * is versioned and frozen here; the hosted receive endpoint conforms to it.
 *
 * Custody caveats enforced at export time by callers (src/commands/creds.ts):
 * per-credential confirmation, and a warning when a byo entry's consent
 * screen is not known to be published to Production (its 7-day Testing
 * expiry would travel with it).
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import type { CredentialEntry, ProviderClientRecord } from './vault.ts';

export const BUNDLE_VERSION = 1;
export const BUNDLE_KIND = 'gbrain-credential-bundle';

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export interface BundlePayload {
  version: typeof BUNDLE_VERSION;
  exported_at: string;
  credentials: CredentialEntry[];
  clients: ProviderClientRecord[];
}

export interface EncryptedBundle {
  kind: typeof BUNDLE_KIND;
  version: typeof BUNDLE_VERSION;
  kdf: 'scrypt';
  kdf_params: { N: number; r: number; p: number };
  salt: string; // base64
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
}

export function exportBundle(
  payload: Omit<BundlePayload, 'version' | 'exported_at'> & { exported_at?: string },
  passphrase: string,
): EncryptedBundle {
  if (passphrase.length < 8) {
    throw new Error('Bundle passphrase must be at least 8 characters.');
  }
  const full: BundlePayload = {
    version: BUNDLE_VERSION,
    exported_at: payload.exported_at ?? new Date().toISOString(),
    credentials: payload.credentials,
    clients: payload.clients,
  };
  const salt = randomBytes(16);
  // maxmem: 128*N*r exactly equals the 32MB default cap, which throws; give headroom.
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * 1024 * 1024,
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(full), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    kdf: 'scrypt',
    kdf_params: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function importBundle(bundle: EncryptedBundle, passphrase: string): BundlePayload {
  if (bundle.kind !== BUNDLE_KIND || bundle.version !== BUNDLE_VERSION || bundle.kdf !== 'scrypt') {
    throw new Error('Not a gbrain credential bundle (or an unsupported version).');
  }
  const salt = Buffer.from(bundle.salt, 'base64');
  const key = scryptSync(passphrase, salt, KEY_LEN, {
    N: bundle.kdf_params.N,
    r: bundle.kdf_params.r,
    p: bundle.kdf_params.p,
    // scryptSync's default maxmem (32MB) is too small for N=2^15 r=8.
    maxmem: 128 * 1024 * 1024,
  });
  // authTagLength pins the FULL 16-byte GCM tag: without it, Node accepts
  // attacker-supplied tags truncated to as little as 4 bytes, weakening the
  // bundle's forgery resistance. The explicit length check keeps the error
  // message honest (a truncated tag is tampering, not a wrong passphrase).
  const tag = Buffer.from(bundle.tag, 'base64');
  if (tag.length !== 16) {
    throw new Error('Not a gbrain credential bundle (or an unsupported version).');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'base64'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(bundle.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new Error('Wrong passphrase (or corrupted bundle).');
  }
  const parsed = JSON.parse(plaintext.toString('utf-8')) as BundlePayload;
  if (parsed.version !== BUNDLE_VERSION || !Array.isArray(parsed.credentials)) {
    throw new Error('Bundle decrypted but its payload is malformed.');
  }
  return parsed;
}

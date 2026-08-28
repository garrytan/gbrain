/**
 * creds-export — tests for the encrypted credential bundle format
 * (src/core/creds/export.ts): scrypt key derivation + AES-256-GCM.
 *
 * The format is versioned and frozen; hosted gbrain.io's import endpoint
 * conforms to it. Pinned here: exact round-trip fidelity, the single
 * wrong-passphrase/tamper error message, the passphrase length floor, and
 * that the serialized bundle leaks no plaintext secret material.
 * All fixture values are synthetic.
 */

import { describe, it, expect } from 'bun:test';

import {
  BUNDLE_KIND,
  BUNDLE_VERSION,
  exportBundle,
  importBundle,
} from '../src/core/creds/export.ts';
import type { CredentialEntry, ProviderClientRecord } from '../src/core/creds/vault.ts';

const PASSPHRASE = 'correct-horse-battery-test';
const ACCESS_TOKEN = 'ya29.bundle-access-token-test';
const REFRESH_TOKEN = '1//bundle-refresh-token-test';
const CLIENT_SECRET = 'GOCSPX-bundle-secret-test';

const ENTRY: CredentialEntry = {
  id: 'google:a@example.com',
  provider: 'google',
  kind: 'oauth2',
  client_ref: 'byo',
  secret: {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expiry: '2026-08-25T12:00:00.000Z',
  },
  meta: {
    account: 'a@example.com',
    scopes: ['openid', 'email'],
    client_id: '12345-abc.apps.googleusercontent.com',
    connected_at: '2026-08-20T00:00:00.000Z',
    last_refresh_ok_at: '2026-08-24T00:00:00.000Z',
    consent_publish_state: 'production',
  },
};

const CLIENT: ProviderClientRecord = {
  provider: 'google',
  client_id: '12345-abc.apps.googleusercontent.com',
  client_secret: CLIENT_SECRET,
  created_at: '2026-08-20T00:00:00.000Z',
};

describe('exportBundle / importBundle', () => {
  it('round-trips credentials + clients exactly', () => {
    const bundle = exportBundle(
      { credentials: [ENTRY], clients: [CLIENT], exported_at: '2026-08-25T00:00:00.000Z' },
      PASSPHRASE,
    );
    const payload = importBundle(bundle, PASSPHRASE);
    expect(payload.version).toBe(BUNDLE_VERSION);
    expect(payload.exported_at).toBe('2026-08-25T00:00:00.000Z');
    expect(payload.credentials).toEqual([ENTRY]);
    expect(payload.clients).toEqual([CLIENT]);
  });

  it('wrong passphrase → the single opaque error message', () => {
    const bundle = exportBundle({ credentials: [ENTRY], clients: [CLIENT] }, PASSPHRASE);
    expect(() => importBundle(bundle, 'not-the-passphrase')).toThrow(
      'Wrong passphrase (or corrupted bundle).',
    );
  });

  it('tampered ciphertext (one flipped byte) → the same wrong-passphrase error', () => {
    const bundle = exportBundle({ credentials: [ENTRY], clients: [CLIENT] }, PASSPHRASE);
    const bytes = Buffer.from(bundle.ciphertext, 'base64');
    bytes[0] ^= 0xff; // GCM auth tag catches any bit flip
    const tampered = { ...bundle, ciphertext: bytes.toString('base64') };
    expect(() => importBundle(tampered, PASSPHRASE)).toThrow(
      'Wrong passphrase (or corrupted bundle).',
    );
  });

  it('rejects a passphrase shorter than 8 characters at export', () => {
    expect(() => exportBundle({ credentials: [ENTRY], clients: [CLIENT] }, 'short7c')).toThrow(
      'at least 8 characters',
    );
  });

  it('the serialized bundle carries the kind marker and no plaintext secrets', () => {
    const bundle = exportBundle({ credentials: [ENTRY], clients: [CLIENT] }, PASSPHRASE);
    expect(bundle.kind).toBe('gbrain-credential-bundle');
    expect(bundle.kind).toBe(BUNDLE_KIND);
    expect(bundle.version).toBe(BUNDLE_VERSION);
    expect(bundle.kdf).toBe('scrypt');

    const s = JSON.stringify(bundle);
    expect(s).not.toContain(REFRESH_TOKEN);
    expect(s).not.toContain(ACCESS_TOKEN);
    expect(s).not.toContain(CLIENT_SECRET);
    expect(s).not.toContain('a@example.com');
  });

  it('a non-bundle object is refused before any key derivation', () => {
    const bundle = exportBundle({ credentials: [ENTRY], clients: [CLIENT] }, PASSPHRASE);
    expect(() => importBundle({ ...bundle, kind: 'something-else' as never }, PASSPHRASE)).toThrow(
      'Not a gbrain credential bundle',
    );
  });

  it('a truncated GCM auth tag is refused as tampering, never verified', () => {
    // Without authTagLength pinned at 16, Node would accept tags truncated to
    // as little as 4 bytes — an attacker-crafted bundle with a short tag gets
    // a drastically easier forgery target. Refused with the bundle-shape
    // error (tampering), not the wrong-passphrase one.
    const bundle = exportBundle({ credentials: [ENTRY], clients: [CLIENT] }, PASSPHRASE);
    const shortTag = Buffer.from(bundle.tag, 'base64').subarray(0, 12).toString('base64');
    expect(() => importBundle({ ...bundle, tag: shortTag }, PASSPHRASE)).toThrow(
      'Not a gbrain credential bundle',
    );
  });
});

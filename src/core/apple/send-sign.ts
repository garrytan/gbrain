/**
 * Signs requests to GBrain Helper's send route, \`POST /v1/imessage/send\`, the way the helper checks them (\`GBrain-Sign\`,
 * Ed25519). The caller's computer keeps the private key; the Mac stores only the public half. Pure functions with no brain,
 * repository or database, so the same code serves a repo-less brain. Test vectors shared with the helper's Swift tests live in
 * apple/helper/Tests/HelperCoreTests/Fixtures/send-sign-vectors.json.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export const SEND_ROUTE = '/v1/imessage/send';
export const SEND_SCHEME = 'GBrain-Sign';
export const SEND_SIGN_VERSION = 'GBRAIN-SIGN-V1';
export const SEND_TEXT_MAX_UTF16 = 4000;
export const SEND_TEXT_MAX_GRAPHEMES = 2000;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;

export interface SendKeyPair {
  privateKey: KeyObject;
  /** The raw 32-byte public key in base64url, the form \`gbrain-apple-helper send-key add\` takes. */
  publicKey: string;
}

export function sendKeyPairFromSeed(seed: Uint8Array): SendKeyPair {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

export function generateSendKeyPair(): SendKeyPair {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

function publicKeyOf(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('not an Ed25519 key');
  return jwk.x;
}

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY.test(key);
}

export function canonicalSendString(input: { timestamp: number; nonce: string; idempotencyKey: string; body: string | Uint8Array; route?: string }): string {
  const digest = createHash('sha256').update(input.body).digest('hex');
  return [SEND_SIGN_VERSION, 'POST', input.route ?? SEND_ROUTE, String(input.timestamp), input.nonce, input.idempotencyKey, digest].join('\n');
}

/** Returns the Authorization header value for one send (or, with `route`, one Contacts batch). Sign the exact bytes you put on the wire. */
export function signSendRequest(input: {
  privateKey: KeyObject;
  keyName: string;
  idempotencyKey: string;
  body: string | Uint8Array;
  timestamp?: number;
  nonce?: string;
  route?: string;
}): string {
  if (!isValidIdempotencyKey(input.idempotencyKey)) throw new Error('Idempotency-Key must be 8 to 128 characters of A-Z, a-z, 0-9, dot, underscore and hyphen');
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('nonce must be 32 lowercase hex characters');
  const canonical = canonicalSendString({ timestamp, nonce, idempotencyKey: input.idempotencyKey, body: input.body, route: input.route });
  const sig = sign(null, Buffer.from(canonical, 'utf8'), input.privateKey).toString('base64url');
  return SEND_SCHEME + ' key=' + input.keyName + ', ts=' + timestamp + ', nonce=' + nonce + ', sig=' + sig;
}

/** The helper's text rule: 1 to 4,000 UTF-16 code units, at most 2,000 characters, not blank. Returns null when it passes. */
export function checkSendText(text: string): string | null {
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;
  if (text.length < 1 || text.length > SEND_TEXT_MAX_UTF16 || graphemes > SEND_TEXT_MAX_GRAPHEMES || text.trim() === '') {
    return 'text must be 1 to ' + SEND_TEXT_MAX_UTF16 + ' UTF-16 code units and at most ' + SEND_TEXT_MAX_GRAPHEMES + ' characters, not blank';
  }
  return null;
}

/** The helper's recipient form: an E.164 phone number or a lower-cased email address; null when neither. */
export function normalizeRecipient(raw: string): string | null {
  const value = raw.replace(/^[ \t]+|[ \t]+$/g, '');
  if (value.includes('@')) {
    const lower = value.toLowerCase();
    const parts = lower.split('@');
    if (parts.length !== 2 || parts[0] === '' || !parts[1].includes('.') || parts[1].startsWith('.') || parts[1].endsWith('.')) return null;
    if (lower.length > 254 || !/^[\x21-\x7e]+$/.test(lower) || /[<>()[\],;:\\"]/.test(lower)) return null;
    return lower;
  }
  if (!value.startsWith('+')) return null;
  const rest = value.slice(1).replace(/[ \-().]/g, '');
  if (!/^[1-9][0-9]{6,14}$/.test(rest)) return null;
  return '+' + rest;
}

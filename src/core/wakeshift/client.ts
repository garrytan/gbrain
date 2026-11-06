/**
 * Wakeshift HTTP API client (plan D1): the five endpoints gbrain uses, with no
 * SDK. A key is an Ed25519 seed (`wst_` + 50 base58 characters whose last 4
 * bytes are the seed's CRC32); each request carries a fresh compact JWS signed
 * with it (EdDSA, typ app+jwt, 2 minutes, unique jti), so the key itself never
 * leaves the brain host. One `fetch` per call with a 10 s timeout and no
 * internal retry: the drainer (drain.ts) owns the retry schedule.
 * Docs: docs/guides/wakeshift.md; the API: https://wakeshift.ai/docs/http-api.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';

export const WAKESHIFT_DEFAULT_URL = 'https://app.wakeshift.ai';
export const WAKESHIFT_FETCH_TIMEOUT_MS = 10_000;
const API_PATH = '/api/apps/v1';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface WakeshiftKey {
  privateKey: KeyObject;
  /** First 16 bytes of SHA-256 of the 32-byte public key, base64url: names the key (and its app) without revealing it. */
  kid: string;
}

export class WakeshiftKeyError extends Error {
  constructor(readonly reason: 'format' | 'checksum' | 'legacy', message: string) { super(message); }
}

/** Non-2xx answers carry Wakeshift's code; status 0 is a network failure or the timeout. */
export class WakeshiftError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterS?: number) { super(message); }
}

let crcTable: Uint32Array | null = null;
export function crc32(buf: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const b64u = (buf: Uint8Array | string) => Buffer.from(buf).toString('base64url');

/** Parse a current-format key (`wst_` + 50 base58). Older `test_`/`live_` keys are refused: make a new key in the console. */
export function parseWakeshiftKey(raw: string): WakeshiftKey {
  const body = raw.trim().replace(/^wst_/, '');
  if (/^(test|live)_/.test(body)) {
    throw new WakeshiftKeyError('legacy', 'This is an older Wakeshift key format (test_ or live_), which gbrain does not accept. Create a new key in the Wakeshift console; current keys start with wst_.');
  }
  if (body.length !== 50 || body.includes('_')) throw new WakeshiftKeyError('format', 'A Wakeshift key is wst_ followed by 50 base58 characters.');
  let n = 0n;
  for (const ch of body) {
    const d = B58.indexOf(ch);
    if (d < 0) throw new WakeshiftKeyError('format', 'A Wakeshift key holds only base58 characters after wst_.');
    n = n * 58n + BigInt(d);
  }
  if (n >= 1n << 288n) throw new WakeshiftKeyError('format', 'A Wakeshift key decodes to more than 36 bytes.');
  const bytes = Buffer.from(n.toString(16).padStart(72, '0'), 'hex');
  const seed = bytes.subarray(0, 32);
  if (crc32(seed) !== bytes.readUInt32BE(32)) throw new WakeshiftKeyError('checksum', 'The Wakeshift key fails its checksum: it was mistyped or cut short. Copy it again.');
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { privateKey, kid: b64u(createHash('sha256').update(spki.subarray(spki.length - 32)).digest().subarray(0, 16)) };
}

/** Encode a 32-byte seed as a current-format key (tests and fixtures; gbrain never mints keys for anyone). */
export function encodeWakeshiftKey(seed: Uint8Array): string {
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(seed));
  let n = BigInt('0x' + Buffer.concat([Buffer.from(seed), crc]).toString('hex'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return 'wst_' + out.padStart(50, B58[0]);
}

/** A fresh assertion: header {alg, typ, kid}, claims iss=sub=kid, aud <url>/api/apps, 120 s life, 16-byte jti. */
export function wakeshiftAssertion(key: WakeshiftKey, url: string, nowS = Math.floor(Date.now() / 1000)): string {
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'app+jwt', kid: key.kid }));
  const claims = b64u(JSON.stringify({ iss: key.kid, sub: key.kid, aud: `${url}/api/apps`, iat: nowS, exp: nowS + 120, jti: b64u(randomBytes(16)) }));
  return `${header}.${claims}.${b64u(sign(null, Buffer.from(`${header}.${claims}`), key.privateKey))}`;
}

/** The console address: https, or http only on a loopback host (a local fake for tests). No trailing slash. */
export function normalizeWakeshiftUrl(raw: string | undefined): string {
  const url = new URL(raw?.trim() || WAKESHIFT_DEFAULT_URL);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`wakeshift.url must be https (got ${url.protocol}//${url.host}).`);
  return url.origin;
}

/** The caller of a conversation-bound call (Wakeshift "The caller"); every field is optional and passed on unchanged. */
export interface WakeshiftCall {
  user: string;
  tool: string;
  client?: string;
  meta?: Record<string, unknown>;
  user_agent?: string;
  session?: string;
  harness?: string;
  conversation?: string;
}

export interface WakeshiftAddition { text?: string; meta?: Record<string, unknown> }
export interface SubscribeResult {
  event_subscription: { id: string; user: string; event: string; created: boolean; expires_at?: string };
  session?: string;
  addition?: WakeshiftAddition;
  agent?: { harness: string | null; via: string | null; claimed: string | null };
}
export interface EmitResult { matched: number; duplicate: boolean; unmatched: unknown[]; ended: unknown[] }

export interface WakeshiftApi {
  getApp(): Promise<{ id: string; name: string; key: { key_id: string; name: string } }>;
  mergeManifest(body: Record<string, unknown>): Promise<unknown>;
  subscribe(body: { call: WakeshiftCall; name: string; arguments: Record<string, unknown>; ttl?: string; once?: boolean; reason?: string }): Promise<SubscribeResult>;
  unsubscribe(body: { call: WakeshiftCall; name: string; arguments: Record<string, unknown>; reason?: string }): Promise<{ ended: boolean }>;
  end(body: { user: string; id: string }): Promise<{ ended: boolean }>;
  emit(body: { name: string; arguments: Record<string, unknown>; payload: Record<string, unknown>; text: string; id: string; to: unknown[] }): Promise<EmitResult>;
}

export function wakeshiftClient(key: WakeshiftKey, opts: { url?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): WakeshiftApi {
  const url = normalizeWakeshiftUrl(opts.url);
  const doFetch = opts.fetch ?? fetch;
  const request = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${url}${API_PATH}${path}`, {
        method,
        headers: { authorization: `Bearer ${wakeshiftAssertion(key, url)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? WAKESHIFT_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      throw new WakeshiftError(0, timeout ? 'timeout' : 'network', timeout ? 'Wakeshift did not answer within 10 s.' : 'Wakeshift could not be reached.');
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const retryHeader = res.headers.get('retry-after')?.trim();
      const retryAfter = retryHeader ? Number(retryHeader) : NaN;
      throw new WakeshiftError(res.status, typeof err?.code === 'string' ? err.code.slice(0, 64) : `http_${res.status}`,
        typeof err?.message === 'string' ? err.message.slice(0, 300) : `Wakeshift answered HTTP ${res.status}.`,
        Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined);
    }
    return json as T;
  };
  return {
    getApp: () => request('GET', '/app'),
    mergeManifest: body => request('POST', '/manifest/merge', body),
    subscribe: body => request('POST', '/event-subscriptions', body),
    unsubscribe: body => request('POST', '/event-subscriptions/unsubscribe', body),
    end: body => request('POST', '/event-subscriptions/end', body),
    emit: body => request('POST', '/events/emit', body),
  };
}

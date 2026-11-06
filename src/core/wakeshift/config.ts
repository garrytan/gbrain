/**
 * Wakeshift host configuration (plan D4, D6). Everything here is host-side
 * state no MCP or HTTP operation writes:
 *
 *   - `wakeshift.enabled` / `wakeshift.url` in the file plane (~/.gbrain/config.json), written only by the
 *     trusted local `gbrain wakeshift enable|disable`, so a remote caller can never turn reporting back on;
 *   - the key: WAKESHIFT_API_KEY (moved out of this process's environment whenever config loads, wakeshift-env-key.ts, so
 *     child processes do not inherit it), else ~/.gbrain/wakeshift.key, which must be 0600 (a looser file is ignored and doctor says so);
 *   - the HMAC secret ~/.gbrain/wakeshift.secret (0600, random): the Wakeshift `user` is the first 32 hex of
 *     HMAC-SHA256 over (brain, principal), never an email, name or token.
 *
 * Off, or no usable key, means inert: no tools listed, no rows, no network.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { gbrainPath, loadConfig, type GBrainConfig } from '../config.ts';
import { normalizeWakeshiftUrl, parseWakeshiftKey, wakeshiftClient, type WakeshiftApi, type WakeshiftKey } from './client.ts';
import { WAKESHIFT_KEY_ENV, takeWakeshiftEnvKey } from '../wakeshift-env-key.ts';

export { WAKESHIFT_KEY_ENV, resetWakeshiftEnvKeyForTests } from '../wakeshift-env-key.ts';

export const wakeshiftKeyFile = () => gbrainPath('wakeshift.key');
export const wakeshiftSecretFile = () => gbrainPath('wakeshift.secret');

export type KeyRead =
  | { source: 'env' | 'file'; raw: string }
  | { source: 'none' }
  | { source: 'file_too_open'; mode: string };

/** Where the key comes from, without parsing it. The process's env value moves out of process.env when first seen (wakeshift-env-key.ts). */
export function readWakeshiftKey(env: NodeJS.ProcessEnv = process.env): KeyRead {
  if (env === process.env) {
    const taken = takeWakeshiftEnvKey();
    if (taken) return { source: 'env', raw: taken };
  } else {
    const fromEnv = env[WAKESHIFT_KEY_ENV]?.trim();
    if (fromEnv) return { source: 'env', raw: fromEnv };
  }
  const file = wakeshiftKeyFile();
  let mode: number;
  try { mode = statSync(file).mode; } catch { return { source: 'none' }; }
  if (mode & 0o077) return { source: 'file_too_open', mode: (mode & 0o777).toString(8).padStart(4, '0') };
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return raw ? { source: 'file', raw } : { source: 'none' };
  } catch {
    return { source: 'none' };
  }
}


export interface WakeshiftFileConfig { enabled?: boolean; url?: string }

export function wakeshiftFileConfig(config: GBrainConfig | null | undefined): WakeshiftFileConfig {
  const raw = (config as { wakeshift?: unknown } | null | undefined)?.wakeshift;
  return raw && typeof raw === 'object' ? raw as WakeshiftFileConfig : {};
}

export interface WakeshiftRuntime { key: WakeshiftKey; url: string; api: WakeshiftApi }

/**
 * The live runtime when reporting back is on and the key parses, else null. Reads the file plane fresh (never a
 * DB-merged snapshot), so `gbrain wakeshift disable` takes effect on the next call or tools/list.
 */
export function wakeshiftRuntime(opts: { config?: GBrainConfig | null; fetch?: typeof fetch } = {}): WakeshiftRuntime | null {
  const file = wakeshiftFileConfig(opts.config === undefined ? loadConfig() : opts.config);
  if (file.enabled !== true) return null;
  const read = readWakeshiftKey();
  if (read.source !== 'env' && read.source !== 'file') return null;
  try {
    const key = parseWakeshiftKey(read.raw);
    const url = normalizeWakeshiftUrl(file.url);
    return { key, url, api: wakeshiftClient(key, { url, ...(opts.fetch ? { fetch: opts.fetch } : {}) }) };
  } catch {
    return null;
  }
}

/** The publish gate `mcp.publish_wakeshift`: the file plane says on and a usable key is present. No DB read. */
export function wakeshiftPublished(): boolean {
  try { return wakeshiftRuntime() !== null; } catch { return false; }
}

/** The local HMAC secret, created (0600, exclusive) on first use. */
export function wakeshiftSecret(): Buffer {
  const file = wakeshiftSecretFile();
  const read = () => Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  try {
    const s = read();
    if (s.length >= 32) return s;
  } catch { /* created below */ }
  try {
    writeFileSync(file, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const s = read();
  if (s.length < 32) throw new Error(`${file} is not a gbrain Wakeshift secret; remove it and retry.`);
  return s;
}

/** Which brain: a hash of its database location (never the location), so two brains in one home map apart. */
export function wakeshiftBrainKey(config: GBrainConfig | null | undefined): string {
  return createHash('sha256').update(config?.database_url ?? config?.database_path ?? '').digest('hex').slice(0, 16);
}

/** The opaque Wakeshift `user` for a principal: first 32 hex of HMAC-SHA256(secret, brain \n principal). */
export function wakeshiftUserId(secret: Buffer, brainKey: string, principal: string): string {
  return createHmac('sha256', secret).update(`${brainKey}\n${principal}`).digest('hex').slice(0, 32);
}

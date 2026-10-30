/**
 * #7360: the thin client's OAuth access token, shared across CLI processes.
 *
 * Every `gbrain` command is its own process, so an in-memory cache alone
 * minted one client_credentials token per command, and a per-prompt caller
 * spent the host's /token budget. This file keeps the bearer the host issued
 * until shortly before it expires.
 *
 * Trust: an entry is keyed by a hash of the issuer, MCP URL, client id and
 * client secret, so another client or a rotated secret never reuses it. Each
 * key has its own file under `remote-tokens/` in the gbrain home, holding the
 * bearer and its expiry only (no secret, no client id). A file is written
 * 0600 by an atomic rename, which replaces a planted symlink instead of
 * writing through it, and read through a descriptor opened without following
 * symlinks, so the ownership and mode it checks belong to the bytes it reads.
 * A file another user owns or could read is deleted and not used. The host
 * authorizes every request against the client's current grant, so a cached
 * token never acts with more scope than the client holds.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gbrainPath } from './config.ts';

export interface CachedToken {
  access_token: string;
  /** Wall-clock ms after which the token is re-minted (already inside the server's expiry). */
  expires_at_ms: number;
}

const cacheDir = () => gbrainPath('remote-tokens');
const entryPath = (key: string) => join(cacheDir(), `${key}.json`);

export function tokenCacheKey(remote: { issuer_url: string; mcp_url: string; oauth_client_id: string }, secret: string): string {
  return createHash('sha256').update(JSON.stringify([remote.issuer_url, remote.mcp_url, remote.oauth_client_id, secret])).digest('hex');
}

export function readCachedToken(key: string): CachedToken | undefined {
  const path = entryPath(key);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') dropCachedToken(key);
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      dropCachedToken(key);
      return undefined;
    }
    const entry = JSON.parse(readFileSync(fd, 'utf8')) as Partial<CachedToken>;
    if (typeof entry?.access_token !== 'string' || typeof entry.expires_at_ms !== 'number' || !(entry.expires_at_ms > Date.now())) return undefined;
    return { access_token: entry.access_token, expires_at_ms: entry.expires_at_ms };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function writeCachedToken(key: string, token: CachedToken): void {
  const path = entryPath(key);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(token), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
  }
}

export function dropCachedToken(key: string): void {
  try { rmSync(entryPath(key), { force: true }); } catch { /* best-effort */ }
}

export function clearTokenCacheFile(): void {
  try { rmSync(cacheDir(), { recursive: true, force: true }); } catch { /* best-effort */ }
}

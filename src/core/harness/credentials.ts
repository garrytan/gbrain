import { openSync, closeSync, fstatSync, readFileSync, constants, mkdirSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { atomicWriteTextFile as atomicWrite } from '../bootstrap/atomic-write.ts';
import { normalizeMcpUrl, validateToken } from '../mcp-registration.ts';
import { assertNoSymlinks } from '../agent-install/state.ts';

/** Private handoff, never serialized into a public receipt. */
export interface HarnessCredentials {
  version: 1;
  mcp_url: string;
  issuer_url: string;
  client_id: string;
  client_secret?: string;
  access_token?: string;
  expires_at?: number;
  profile?: string;
  harness?: string;
  source_id?: string;
}

export function validateCredentials(value: unknown): HarnessCredentials {
  if (!value || typeof value !== 'object') throw new Error('Invalid credential handoff');
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.client_id !== 'string' || !v.client_id || typeof v.mcp_url !== 'string') {
    throw new Error('Unsupported or incomplete credential handoff');
  }
  const url = normalizeMcpUrl(v.mcp_url);
  if (!url.ok) throw new Error('Invalid endpoint in credential handoff');
  assertSecureEndpoint(url.url);
  const issuer = typeof v.issuer_url === 'string' ? v.issuer_url.replace(/\/+$/, '') : url.url.replace(/\/mcp$/, '');
  assertSecureEndpoint(issuer);
  if (new URL(issuer).search) throw new Error('Credential issuer must not contain a query');
  if (new URL(issuer).origin !== new URL(url.url).origin) throw new Error('Credential issuer and MCP endpoint must have the same origin');
  if (typeof v.client_secret !== 'string' && typeof v.access_token !== 'string') throw new Error('Credential handoff has no access credential');
  for (const key of ['client_secret', 'access_token'] as const) {
    if (v[key] !== undefined && (typeof v[key] !== 'string' || !validateToken(v[key] as string).ok)) throw new Error('Invalid private credential');
  }
  if (v.expires_at !== undefined && (typeof v.expires_at !== 'number' || !Number.isFinite(v.expires_at))) throw new Error('Invalid credential expiration');
  return { version: 1, mcp_url: url.url, issuer_url: issuer, client_id: v.client_id,
    ...(typeof v.client_secret === 'string' ? { client_secret: v.client_secret } : {}),
    ...(typeof v.access_token === 'string' ? { access_token: v.access_token } : {}),
    ...(typeof v.expires_at === 'number' ? { expires_at: v.expires_at } : {}),
    ...(typeof v.profile === 'string' ? { profile: v.profile } : {}),
    ...(typeof v.harness === 'string' ? { harness: v.harness } : {}),
    ...(typeof v.source_id === 'string' ? { source_id: v.source_id } : {}),
  };
}

export function assertSecureEndpoint(endpoint: string): void {
  const u = new URL(endpoint);
  if (u.username || u.password || u.hash) throw new Error('Endpoint URLs must not contain credentials or fragments');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) {
    throw new Error('Use HTTPS for credential delivery; HTTP is supported only on loopback');
  }
}

export function readPrivateText(path: string, maximumBytes = 8192): string {
  assertNoSymlinks(resolve(path));
  const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximumBytes || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Use a small private regular credential file (0600)');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export function readCredentials(path: string): HarnessCredentials {
  assertNoSymlinks(resolve(path));
  const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536) throw new Error('Credential handoff must be a small regular file');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Credential handoff must be private: chmod 600 the file');
    try { return validateCredentials(JSON.parse(readFileSync(fd, 'utf8'))); }
    catch { throw new Error('Invalid credential handoff; re-export it from the brain host'); }
  } finally { closeSync(fd); }
}

export function writeCredentials(path: string, credentials: HarnessCredentials): void {
  const target = resolve(path);
  assertNoSymlinks(target);
  const validated = validateCredentials(credentials);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Credential destination must be a regular file');
    const existing = readCredentials(target);
    if (existing.client_id !== validated.client_id || existing.mcp_url !== validated.mcp_url) throw new Error('Credential destination belongs to another connection');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  atomicWrite(target, `${JSON.stringify(validated, null, 2)}\n`, { forceMode: 0o600 });
}

export function credentialReceipt(c: HarnessCredentials) {
  return { client_id: c.client_id, mcp_url: c.mcp_url, profile: c.profile ?? null, harness: c.harness ?? null,
    source_id: c.source_id ?? null, expires_at: c.expires_at ?? null,
    renewable: Boolean(c.client_secret), credentials: 'private-file' };
}

export async function credentialAccessToken(c: HarnessCredentials, signal?: AbortSignal): Promise<string> {
  if (c.access_token && (!c.expires_at || c.expires_at > Date.now() / 1000 + 30)) return c.access_token;
  if (!c.client_secret) throw new Error('authentication_failed: credential expired; issue a new access token without rotating the client secret');
  const response = await fetch(`${c.issuer_url}/token`, {
    method: 'POST', redirect: 'error', signal: signal ?? AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret }),
  });
  if (!response.ok) throw new Error(`authentication_failed: token exchange returned HTTP ${response.status}`);
  const body = await response.json() as { access_token?: unknown };
  if (typeof body.access_token !== 'string' || !validateToken(body.access_token).ok) throw new Error('authentication_failed: invalid token response');
  return body.access_token;
}

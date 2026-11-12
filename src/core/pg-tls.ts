/**
 * TLS for every postgres() pool gbrain opens (one resolver, every call site).
 *
 * The vendored postgres.js defaults to `ssl: false`, so a URL without an
 * sslmode connected in plaintext even to a database across the internet. Each
 * call site now builds its options through `withPgTls(url, opts)`:
 *
 *   1. An explicit setting wins and is never changed: an `ssl` option the call
 *      site passes, `sslmode` / `ssl` / `sslrootcert=system` in the URL, or
 *      the driver's own PGSSL environment variable (which it reads itself).
 *   2. Otherwise a host on this machine keeps the driver default (no TLS):
 *      localhost, 127.0.0.0/8, ::1 (and ::ffff:127.x) or a Unix socket path.
 *   3. Otherwise TLS is required (`ssl: 'require'`). That includes private
 *      addresses and Docker service names: gbrain cannot tell a trusted network
 *      from an untrusted one by name, so they opt out like any other host.
 *
 * The one opt-out is `sslmode=disable` in the URL. `require` encrypts the
 * connection but does not verify the server certificate (postgres.js sets
 * rejectUnauthorized=false for it); `sslmode=verify-full` with the server's CA
 * also verifies it. PGLite opens no network connection, so none of this
 * applies to it.
 *
 * When a default-required connection fails, `tlsRequiredDefaultError` asks
 * the server directly (the protocol's 8-byte SSLRequest) whether it speaks
 * TLS; a plain "no" becomes the coded `postgres_tls_required` error instead
 * of the driver's unreadable TLS handshake failure.
 */

import { connect as netConnect, isIP } from 'node:net';
import type { OperationError } from './ops/contract.ts';

export type PgTlsSource = 'option' | 'url' | 'env' | 'loopback' | 'default';

export interface PgTlsResolution {
  source: PgTlsSource;
  /** The mode in effect as text: the URL's sslmode, 'require' for the default, 'driver-default' on loopback. */
  mode: string;
}

type Env = Record<string, string | undefined>;

/** PGHOST, PGPORT and PGSSL, read the way the driver reads them, so the default matches the host it dials. */
const processEnv = (): Env => process.env;

export function isLoopbackPgHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!h) return false;
  if (h.startsWith('/')) return true;
  if (h === 'localhost') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) {
    if (h === '::1' || /^(0{1,4}:){7}0{0,3}1$/.test(h)) return true;
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return !!mapped && mapped[1].startsWith('127.');
  }
  return false;
}

function stripPort(entry: string): string {
  const e = entry.trim();
  if (e.startsWith('[')) return e.slice(1, e.indexOf(']') > 0 ? e.indexOf(']') : undefined);
  return (e.match(/:/g) ?? []).length === 1 ? e.slice(0, e.indexOf(':')) : e;
}

/** The hosts the driver will dial, read the way postgres.js reads them (options, URL host list, PGHOST, localhost). */
export function pgConnectHosts(url: string, opts: Record<string, unknown> = {}, env: Env = processEnv()): string[] {
  if (typeof opts.path === 'string' && opts.path) return [opts.path];
  const optHost = typeof opts.hostname === 'string' ? opts.hostname : typeof opts.host === 'string' ? opts.host : '';
  let urlHost = '';
  const afterScheme = url.indexOf('://') >= 0 ? url.slice(url.indexOf('://') + 3) : '';
  const authority = afterScheme.split(/[?/]/)[0] ?? '';
  try { urlHost = decodeURIComponent(authority.slice(authority.lastIndexOf('@') + 1)); } catch { urlHost = authority.slice(authority.lastIndexOf('@') + 1); }
  const raw = optHost || urlHost || env.PGHOST || 'localhost';
  if (raw.startsWith('/')) return [raw];
  return raw.split(',').map(stripPort).filter(Boolean);
}

/** The URL query as the driver reads it: the fragment dropped, and a repeated key's last value wins. */
function urlQuery(url: string): Record<string, string> {
  const withoutFragment = url.split('#')[0] ?? '';
  const q = withoutFragment.indexOf('?');
  return Object.fromEntries(new URLSearchParams(q >= 0 ? withoutFragment.slice(q + 1) : ''));
}

export function resolvePgTls(url: string, opts: Record<string, unknown> = {}, env: Env = processEnv()): PgTlsResolution {
  if ('ssl' in opts && opts.ssl !== undefined) return { source: 'option', mode: typeof opts.ssl === 'string' ? opts.ssl : String(opts.ssl === false ? 'disable' : 'custom') };
  const query = urlQuery(url);
  const explicit = query.sslrootcert === 'system' ? 'verify-full' : query.sslmode || query.ssl;
  if (explicit) return { source: 'url', mode: explicit === 'false' ? 'disable' : explicit };
  if (!('ssl' in query) && env.PGSSL) return { source: 'env', mode: env.PGSSL };
  const hosts = pgConnectHosts(url, opts, env);
  if (hosts.length > 0 && hosts.every(isLoopbackPgHost)) return { source: 'loopback', mode: 'driver-default' };
  return { source: 'default', mode: 'require' };
}

/** The options to hand postgres(): unchanged unless the TLS default applies, then with `ssl: 'require'`. */
export function withPgTls<T extends Record<string, unknown>>(url: string, opts: T, env: Env = processEnv()): T {
  return resolvePgTls(url, opts, env).source === 'default' ? { ...opts, ssl: 'require' } : opts;
}

/** Ask a Postgres server whether it accepts TLS: 'S' yes, 'N' no, null when it could not be asked. */
export function probeServerTls(host: string, port: number, timeoutMs = 3000): Promise<'S' | 'N' | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v: 'S' | 'N' | null) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(v); };
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('connect', () => socket.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
    socket.once('data', d => finish(d[0] === 0x53 ? 'S' : d[0] === 0x4e ? 'N' : null));
    socket.once('error', () => finish(null));
    socket.once('close', () => finish(null));
  });
}

/** Failures that happen before or after the TLS handshake (DNS, refused, timeout, a server SQLSTATE): no probe. */
const NOT_A_TLS_REFUSAL: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

/** The first host and port the driver dials, or null for a Unix socket. */
export function pgFirstHostPort(url: string, opts: Record<string, unknown> = {}, env: Env = processEnv()): { host: string; port: number } | null {
  const host = pgConnectHosts(url, opts, env)[0];
  if (!host || host.startsWith('/')) return null;
  if (typeof opts.port === 'number') return { host, port: opts.port };
  const authority = (url.slice(url.indexOf('://') + 3).split(/[?/]/)[0] ?? '').split('@').pop() ?? '';
  const first = authority.split(',')[0] ?? '';
  const port = first.startsWith('[') ? first.slice(first.indexOf(']') + 2) : first.includes(':') ? first.slice(first.lastIndexOf(':') + 1) : '';
  return { host, port: Number(port) || Number(env.PGPORT) || 5432 };
}

/** The coded refusal; its text, why and fix live once, in the error registry entry. */
export async function postgresTlsRequiredError(): Promise<OperationError> {
  const [{ opError }, { CODES }] = await Promise.all([import('./ops/contract.ts'), import('./error-registry.ts')]);
  const entry = CODES.postgres_tls_required;
  return opError('postgres_tls_required', entry.summary, entry.suggestion, { why: entry.why, fix: { ...entry.fix, docs: 'docs/guides/error-codes.md#postgres_tls_required' } });
}

/**
 * After a connect failure: the coded error when the TLS default applied and the
 * server answers the SSLRequest with "no"; null otherwise (the original error stands).
 */
export async function tlsRequiredDefaultError(
  url: string,
  error: unknown,
  opts: Record<string, unknown> = {},
  probe: (host: string, port: number) => Promise<'S' | 'N' | null> = probeServerTls,
  env: Env = processEnv(),
): Promise<OperationError | null> {
  if (resolvePgTls(url, opts, env).source !== 'default') return null;
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  if (NOT_A_TLS_REFUSAL.has(code) || /^[0-9A-Z]{5}$/.test(code)) return null;
  const target = pgFirstHostPort(url, opts, env);
  if (!target) return null;
  return (await probe(target.host, target.port)) === 'N' ? await postgresTlsRequiredError() : null;
}

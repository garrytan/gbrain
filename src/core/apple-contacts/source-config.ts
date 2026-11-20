/** Parse an apple-contacts source's `sources.config`. Dependency-light so the connector identity can import it. */
import { syncIntervalMinutes } from '../meetings/source-config.ts';
import { parseContactsDir } from '../google/source-config.ts';
import { APPLE_CONTACTS_DEFAULT_DIR, APPLE_CONTACTS_DEFAULT_PORT, APPLE_CONTACTS_DEFAULT_SYNC_INTERVAL_MIN, type AppleContactsSourceConfig } from './types.ts';

const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:.]+)$/;

/** A helper host as written: a host name or an IP literal, with no scheme, port, path or credentials; null otherwise. */
export function parseHelperHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const host = raw.trim();
  return host.length > 0 && host.length <= 253 && HOST.test(host) ? host : null;
}

export function parseHelperPort(raw: unknown): number | null {
  const port = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** `socks5h://host:port` normalized, or null. Credentials in the URL are refused: nothing secret rides in a URL. */
export function parseSocksProxy(raw: unknown): { url: string; host: string; port: number } | null {
  if (typeof raw !== 'string') return null;
  const m = /^socks5h:\/\/([^/@:\s[\]]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\/?$/.exec(raw.trim());
  if (!m) return null;
  const host = parseHelperHost(m[1]);
  const port = parseHelperPort(m[2]);
  return host && port ? { url: `socks5h://${host}:${port}`, host: host.replace(/^\[|\]$/g, ''), port } : null;
}

/** A contacts directory parseContactsDir accepts that is not people/ or under it: contact pages carry phones and emails. */
export function parseAppleContactsDir(raw: unknown): string | null {
  const dir = parseContactsDir(raw);
  return dir !== null && dir.split('/')[0] !== 'people' ? dir : null;
}

export function parseAppleContactsSourceConfig(config: Record<string, unknown>): AppleContactsSourceConfig {
  const proxy = parseSocksProxy(config.ac_proxy);
  return {
    helperHost: parseHelperHost(config.ac_helper_host) ?? '',
    helperPort: parseHelperPort(config.ac_helper_port) ?? APPLE_CONTACTS_DEFAULT_PORT,
    // A stored proxy that does not parse is kept as written, so the client refuses it instead of going direct.
    ...(config.ac_proxy !== undefined && config.ac_proxy !== null && config.ac_proxy !== '' ? { proxy: proxy?.url ?? String(config.ac_proxy) } : {}),
    tokenFile: typeof config.ac_token_file === 'string' ? config.ac_token_file : '',
    contactsDir: parseAppleContactsDir(config.ac_contacts_dir) ?? APPLE_CONTACTS_DEFAULT_DIR,
    record: config.ac_record === 'git' ? 'git' : 'database',
    dir: config.ac_record === 'git' && typeof config.ac_dir === 'string' && config.ac_dir ? config.ac_dir : null,
    syncIntervalMin: syncIntervalMinutes(config, APPLE_CONTACTS_DEFAULT_SYNC_INTERVAL_MIN)!,
  };
}

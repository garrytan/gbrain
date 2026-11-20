/**
 * GBrain Helper's read-only Contacts route, as the apple-contacts source consumes it (plan GST-3256, route contract):
 * `GET /v1/contacts/changes?cursor=<opaque>&limit=1..500` on the helper's address (host and port from the source
 * config), directly or through a `socks5h://` proxy (net/socks5-http.ts), with `Authorization: Bearer <token>`.
 *
 * The token is read only from the 0600 JSON file the source config names (`{"accessToken": "..."}`, the shape of
 * ~/.gbrain/connectors/imessage.json): never from the environment, a flag or a URL, and it never appears in an error, a
 * log line or any output. A token file that is a symlink, not a regular file, or readable or writable by group or
 * others is refused before it is read.
 *
 * Responses (the helper's Contacts route, gbrain#9850): 200 a page `{data: [...], meta: {next_cursor, more, full}}`, every
 * scalar a string (possibly empty, never null); errors are Problem bodies whose `code` names them. 410 `cursor_expired`,
 * and 400 `bad_param` on a request that carried a cursor (the helper did not issue it), start a full snapshot; 403
 * `contacts_not_allowed` (the owner has not granted Contacts) and `source_disabled` (the helper's Contacts source is off);
 * 401 and 403 `insufficient_scope` (a token problem); 503, a timeout or no connection retries with bounded backoff,
 * then stops; anything else stops and is reported. Presenting a page's `next_cursor` commits that page on the helper, so
 * the caller sends it back only after the page is applied.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { socks5HttpGet } from '../net/socks5-http.ts';
import { parseSocksProxy } from '../apple-contacts/source-config.ts';
import { readBounded } from './helper-client.ts';
import type { AppleContact, AppleContactChange, AppleContactsPage, AppleContactsSourceConfig, AppleLabeledValue } from '../apple-contacts/types.ts';

export const APPLE_CONTACTS_PAGE_LIMIT = 200;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/** Waits before each retry of a 503, a timeout or a refused connection; then the run stops. */
export const APPLE_CONTACTS_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000];
const DOCS = 'docs/guides/apple-contacts.md';

export function appleContactsError(code: string, message: string, suggestion: string): OperationError {
  return new OperationError(code, message, suggestion, `${DOCS}#${code}`);
}

/** The helper answered 410 cursor_expired: the saved change-history cursor is too old, so a full snapshot follows. */
export class AppleContactsCursorExpiredError extends Error {
  constructor() { super('apple-contacts: the helper no longer knows the saved cursor (410 cursor_expired)'); this.name = 'AppleContactsCursorExpiredError'; }
}

/** A helper response missing a field it must carry: the run stops and writes nothing more. */
export class AppleContactsShapeDriftError extends Error {
  readonly code = 'connector_shape_drift';
  constructor(what: string) {
    super(`apple-contacts: the helper response is missing ${what}; the helper and gbrain may be out of step`);
    this.name = 'AppleContactsShapeDriftError';
  }
}

/** The bearer token from the source's token file. Refuses an unsafe file; never puts the token in an error. */
export function readAppleContactsToken(sourceId: string, tokenFile: string): string {
  const fix = `Write the helper's read:contacts token as {"accessToken":"..."} to the file the source names, owned by the user that runs gbrain, with chmod 600, then run: gbrain sync --source ${sourceId}`;
  const refuse = (why: string) => appleContactsError('apple_contacts_token_file', `Apple Contacts source ${sourceId}: ${why} Nothing was imported.`, fix);
  if (!tokenFile || !isAbsolute(tokenFile)) throw refuse('its config names no absolute token file path (ac_token_file).');
  let stat;
  try { stat = lstatSync(tokenFile); } catch { throw refuse(`the token file ${tokenFile} does not exist or cannot be read.`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw refuse(`the token file ${tokenFile} is not a regular file.`);
  if ((stat.mode & 0o077) !== 0) {
    throw refuse(`the token file ${tokenFile} has mode ${(stat.mode & 0o777).toString(8).padStart(3, '0')}; it must not be readable or writable by group or others (chmod 600).`);
  }
  let token: unknown;
  try { token = (JSON.parse(readFileSync(tokenFile, 'utf8')) as { accessToken?: unknown })?.accessToken; } catch { token = undefined; }
  if (typeof token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(token)) throw refuse(`the token file ${tokenFile} does not hold a JSON object with an accessToken string.`);
  return token;
}

export interface AppleContactsHelperOpts {
  sourceId: string;
  cfg: Pick<AppleContactsSourceConfig, 'helperHost' | 'helperPort' | 'proxy'>;
  token: string;
  /** Test seam for the retry waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export interface AppleContactsHelper {
  /** One page of changes after `cursor`, or of the full snapshot when it is null. */
  changes(cursor: string | null, signal?: AbortSignal): Promise<AppleContactsPage>;
}

interface HelperResponse { status: number; text: string }

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export function appleContactsHelper(opts: AppleContactsHelperOpts): AppleContactsHelper {
  const { sourceId, cfg } = opts;
  if (!cfg.helperHost) throw appleContactsError('apple_contacts_config', `Apple Contacts source ${sourceId} has no helper host (ac_helper_host). Nothing was imported.`,
    `Re-add the source with --helper-host <the helper's address>: gbrain sources add <id> --kind apple-contacts --helper-host <host> --token-file <path>`);
  const proxy = cfg.proxy ? parseSocksProxy(cfg.proxy) : null;
  if (cfg.proxy && !proxy) throw appleContactsError('apple_contacts_config', `Apple Contacts source ${sourceId} has a proxy that is not socks5h://host:port. Nothing was imported.`,
    'Re-add the source with --proxy socks5h://<host>:<port> (no credentials in the URL).');
  const hostPart = cfg.helperHost.includes(':') && !cfg.helperHost.startsWith('[') ? `[${cfg.helperHost}]` : cfg.helperHost;
  const where = `${hostPart}:${cfg.helperPort}`;
  const sleep = opts.sleep ?? defaultSleep;
  const delays = opts.retryDelaysMs ?? APPLE_CONTACTS_RETRY_DELAYS_MS;
  const headers = { authorization: `Bearer ${opts.token}`, accept: 'application/json' };

  async function once(path: string, signal?: AbortSignal): Promise<HelperResponse> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (proxy) {
      const res = await socks5HttpGet({ proxyHost: proxy.host, proxyPort: proxy.port, host: cfg.helperHost.replace(/^\[|\]$/g, ''), port: cfg.helperPort,
        path, headers, signal: combined, maxBytes: MAX_RESPONSE_BYTES });
      return { status: res.status, text: res.body.toString('utf8') };
    }
    const res = await fetch(`http://${where}${path}`, { method: 'GET', headers, redirect: 'manual', signal: combined });
    return { status: res.status, text: await readBounded(res, path) };
  }

  async function get(path: string, signal?: AbortSignal): Promise<HelperResponse> {
    let last = '';
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await once(path, signal);
        if (res.status !== 503) return res;
        last = 'the helper answered 503';
      } catch (error) {
        if (signal?.aborted) throw error;
        last = (error as { name?: string })?.name === 'TimeoutError' ? 'the request timed out' : 'no connection could be made';
      }
      if (attempt >= delays.length) break;
      await sleep(delays[attempt]!, signal);
    }
    throw appleContactsError('apple_contacts_unreachable',
      `GBrain Helper at ${where}${proxy ? ' (through the configured proxy)' : ''} did not answer for Apple Contacts source ${sourceId}: ${last}, after ${delays.length + 1} tries. Nothing more was imported; the saved cursor is unchanged.`,
      `Check that the Mac is awake and GBrain Helper is running${proxy ? ' and the proxy is up' : ''}, then run: gbrain sync --source ${sourceId}`);
  }

  return {
    async changes(cursor, signal) {
      const query = new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(APPLE_CONTACTS_PAGE_LIMIT) });
      const res = await get(`/v1/contacts/changes?${query.toString()}`, signal);
      let body: Record<string, unknown> = {};
      try { body = res.text ? JSON.parse(res.text) as Record<string, unknown> : {}; } catch { body = {}; }
      if (res.status === 200) return parsePage(body);
      const code = errorCode(body);
      if (res.status === 410 || (res.status === 400 && code === 'bad_param' && cursor)) throw new AppleContactsCursorExpiredError();
      if (res.status === 403 && code === 'contacts_not_allowed') {
        throw appleContactsError('apple_contacts_not_allowed', `GBrain Helper cannot read Contacts for Apple Contacts source ${sourceId}: the owner has not allowed it yet. Nothing was imported.`,
          `Ask the user to click OK on the Mac's "GBrain Helper would like to access your contacts" prompt, or switch GBrain Helper on in System Settings > Privacy & Security > Contacts, then run: gbrain sync --source ${sourceId}`);
      }
      if (res.status === 403 && code === 'source_disabled') {
        throw appleContactsError('apple_contacts_disabled', `GBrain Helper has its Contacts source turned off, so Apple Contacts source ${sourceId} imported nothing.`,
          `On the Mac, set sources.contacts.enabled to true in GBrain Helper's config.json (the running helper sees it on its next request), then run: gbrain sync --source ${sourceId}`);
      }
      if (res.status === 401 || (res.status === 403 && code === 'insufficient_scope')) {
        throw appleContactsError('apple_contacts_unauthorized', `GBrain Helper refused the token of Apple Contacts source ${sourceId} (${res.status === 401 ? '401' : '403 insufficient_scope'}). Nothing was imported.`,
          `Put a token the helper issued with the read:contacts scope in the source's token file (chmod 600), then run: gbrain sync --source ${sourceId}`);
      }
      throw appleContactsError('apple_contacts_helper_error', `GBrain Helper answered ${res.status}${code ? ` (${code})` : ''} for Apple Contacts source ${sourceId}. The run stopped; the saved cursor is unchanged.`,
        `Report this with gbrain doctor --json; check that GBrain Helper and the GBrain CLI are both up to date, then run: gbrain sync --source ${sourceId}`);
    },
  };
}

/** The Problem body's `code` (Problem.swift), or null. */
function errorCode(body: Record<string, unknown>): string | null {
  return typeof body.code === 'string' && /^[a-z0-9_]{1,64}$/.test(body.code) ? body.code : null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

function labeled(raw: unknown, what: string): AppleLabeledValue[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AppleContactsShapeDriftError(`contact.${what}[]`);
  return raw.flatMap((entry: unknown) => {
    const e = entry as Record<string, unknown> | null;
    const value = text(e?.value);
    return value ? [{ label: text(e?.label), value }] : [];
  });
}

function parseContact(id: string, raw: unknown): AppleContact {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppleContactsShapeDriftError('data[].contact');
  const c = raw as Record<string, unknown>;
  const groups = c.groups === undefined || c.groups === null ? [] : Array.isArray(c.groups) ? c.groups : null;
  if (!groups) throw new AppleContactsShapeDriftError('contact.groups[]');
  return {
    id, givenName: text(c.given_name), familyName: text(c.family_name), nickname: text(c.nickname),
    organization: text(c.organization), jobTitle: text(c.job_title),
    emails: labeled(c.emails, 'emails'), phones: labeled(c.phones, 'phones'),
    groups: [...new Set(groups.map(text).filter((g): g is string => !!g))],
  };
}

export function parsePage(body: Record<string, unknown>): AppleContactsPage {
  const items = body.data;
  if (!Array.isArray(items)) throw new AppleContactsShapeDriftError('data');
  const meta = body.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object' || typeof meta.more !== 'boolean') throw new AppleContactsShapeDriftError('meta.more');
  const nextCursor = meta.next_cursor ?? null;
  if (nextCursor !== null && typeof nextCursor !== 'string') throw new AppleContactsShapeDriftError('meta.next_cursor');
  if (meta.more && !nextCursor) throw new AppleContactsShapeDriftError('meta.next_cursor on a page with more');
  const changes = items.map((raw: unknown): AppleContactChange => {
    const item = raw as Record<string, unknown> | null;
    const id = text(item?.id);
    if (!id) throw new AppleContactsShapeDriftError('data[].id');
    if (item!.op === 'delete') return { op: 'delete', id };
    if (item!.op === 'upsert') return { op: 'upsert', id, contact: parseContact(id, item!.contact) };
    throw new AppleContactsShapeDriftError('data[].op upsert or delete');
  });
  return { items: changes, meta: { nextCursor, more: meta.more, full: meta.full === true } };
}

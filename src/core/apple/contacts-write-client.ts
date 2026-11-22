/**
 * GBrain Helper's Contacts write route, \`POST /v1/contacts/batch\` (plan GST-3278, PR 1), as gbrain calls it: the same
 * helper address and socks5h proxy as the read route (contacts-client.ts), with one of two credentials, never the read token:
 *
 * - owner changes (\`requested_by: "owner"\`, every verb, the owner's own asks through their agent) are signed with the Ed25519
 *   key in the 0600 JSON file \`apple_contacts.owner_key_file\` names (\`{"key_name": "...", "seed": "<32 bytes base64url>"}\`),
 *   the send route's GBrain-Sign scheme with this route in the signed string; the Mac stores only the public half;
 * - enrichment fills (\`requested_by: "enrich"\`, additive verbs only) carry the bearer token in
 *   \`apple_contacts.write_token_file\`, which the helper limits to the write:contacts:enrich scope.
 *
 * A retry re-sends the same batch id and change keys, so the helper answers finished changes from its journal instead of
 * applying them twice; an owner retry is signed again with a fresh nonce. Neither credential appears in an error or output.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { socks5HttpGet } from '../net/socks5-http.ts';
import { parseSocksProxy } from '../apple-contacts/source-config.ts';
import { readBounded } from './helper-client.ts';
import { appleContactsError, APPLE_CONTACTS_RETRY_DELAYS_MS } from './contacts-client.ts';
import { sendKeyPairFromSeed, signSendRequest } from './send-sign.ts';
import type { AppleContactsSourceConfig } from '../apple-contacts/types.ts';

export const CONTACTS_WRITE_ROUTE = '/v1/contacts/batch';
export const WRITE_CONFIG_KEY = 'apple_contacts.write';
export const DESTRUCTIVE_CONFIG_KEY = 'apple_contacts.destructive_writes';
export const OWNER_KEY_FILE_CONFIG_KEY = 'apple_contacts.owner_key_file';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

export interface ContactsWriteChange {
  key: string;
  op: 'create' | 'fill' | 'add_value' | 'group_add' | 'set' | 'remove_value' | 'group_remove' | 'delete' | 'merge';
  id?: string;
  from?: string;
  field?: string;
  value?: string;
  label?: string;
  group?: string;
  fields?: Record<string, unknown>;
  expect?: Record<string, unknown>;
}

export interface ContactsWriteResult { key: string; op: string; status: string; id: string | null; reason: string | null }

export interface ContactsWriteReply {
  batch: string;
  journal: string;
  results: ContactsWriteResult[];
  stopped: string | null;
  sideEffects: 'none' | 'partial' | 'all';
  next: string | null;
}

export type ContactsWriteAuth =
  | { kind: 'owner'; keyName: string; privateKey: KeyObject; instruction: string }
  | { kind: 'enrich'; token: string };

function safeFile(path: string, what: string, refuse: (why: string) => Error): string {
  if (!path || !isAbsolute(path)) throw refuse('no absolute ' + what + ' path is configured.');
  let stat;
  try { stat = lstatSync(path); } catch { throw refuse('the ' + what + ' ' + path + ' does not exist or cannot be read.'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw refuse('the ' + what + ' ' + path + ' is not a regular file.');
  if ((stat.mode & 0o077) !== 0) throw refuse('the ' + what + ' ' + path + ' must not be readable or writable by group or others (chmod 600).');
  return readFileSync(path, 'utf8');
}

/** The owner signing key from its 0600 file. Never puts the seed in an error. */
export function readOwnerKey(path: string): { keyName: string; privateKey: KeyObject } {
  const refuse = (why: string) => appleContactsError('apple_contacts_owner_key_file', 'Apple Contacts owner writes: ' + why + ' Nothing was changed.',
    'On the Mac, register the public half: gbrain-apple-helper contacts-write key add --name <name> --public-key-file <its public key>. Then put {"key_name":"<that name>","seed":"<32-byte Ed25519 seed, base64url>"} in a chmod 600 file and run gbrain config set apple_contacts.owner_key_file <path>');
  let parsed: { key_name?: unknown; seed?: unknown } = {};
  try { parsed = JSON.parse(safeFile(path, 'owner key file', refuse)); } catch (error) { if ((error as { code?: string }).code) throw error; throw refuse('the owner key file is not JSON.'); }
  const seed = typeof parsed.seed === 'string' ? Buffer.from(parsed.seed, 'base64url') : Buffer.alloc(0);
  if (typeof parsed.key_name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(parsed.key_name) || seed.length !== 32) {
    throw refuse('the owner key file needs key_name and a 32-byte seed.');
  }
  return { keyName: parsed.key_name, privateKey: sendKeyPairFromSeed(seed).privateKey };
}

/** The enrichment bearer token from its 0600 file (\`{"accessToken": "..."}\`). */
export function readWriteToken(path: string): string {
  const refuse = (why: string) => appleContactsError('apple_contacts_write_token_file', 'Apple Contacts fills: ' + why + ' Nothing was changed.',
    'Write the helper\'s write:contacts:enrich token as {"accessToken":"..."} to a chmod 600 file and run: gbrain config set apple_contacts.write_token_file <path>');
  let token: unknown;
  try { token = (JSON.parse(safeFile(path, 'write token file', refuse)) as { accessToken?: unknown }).accessToken; } catch (error) { if ((error as { code?: string }).code) throw error; }
  if (typeof token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(token)) throw refuse('the write token file does not hold an accessToken string.');
  return token;
}

export interface ContactsWriteOpts {
  sourceId: string;
  cfg: Pick<AppleContactsSourceConfig, 'helperHost' | 'helperPort' | 'proxy'>;
  auth: ContactsWriteAuth;
  batch: string;
  countryCode: string;
  changes: ContactsWriteChange[];
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export async function sendContactsBatch(opts: ContactsWriteOpts): Promise<ContactsWriteReply> {
  const { sourceId, cfg, auth } = opts;
  if (!cfg.helperHost) throw appleContactsError('apple_contacts_config', 'Apple Contacts source ' + sourceId + ' has no helper host (ac_helper_host). Nothing was changed.',
    'Re-add the source with --helper-host <the helper\'s address>.');
  const proxy = cfg.proxy ? parseSocksProxy(cfg.proxy) : null;
  if (cfg.proxy && !proxy) throw appleContactsError('apple_contacts_config', 'Apple Contacts source ' + sourceId + ' has a proxy that is not socks5h://host:port. Nothing was changed.',
    'Re-add the source with --proxy socks5h://<host>:<port>.');
  const body = Buffer.from(JSON.stringify({
    batch: opts.batch, requested_by: auth.kind, country_code: opts.countryCode, changes: opts.changes,
    ...(auth.kind === 'owner' ? { owner_instruction: auth.instruction } : {}),
  }), 'utf8');
  const host = cfg.helperHost.replace(/^\[|\]$/g, '');
  const where = (cfg.helperHost.includes(':') && !cfg.helperHost.startsWith('[') ? '[' + cfg.helperHost + ']' : cfg.helperHost) + ':' + cfg.helperPort;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const delays = opts.retryDelaysMs ?? APPLE_CONTACTS_RETRY_DELAYS_MS;

  async function once(): Promise<{ status: number; text: string }> {
    const authorization = auth.kind === 'owner'
      ? signSendRequest({ privateKey: auth.privateKey, keyName: auth.keyName, idempotencyKey: opts.batch, body, route: CONTACTS_WRITE_ROUTE })
      : 'Bearer ' + auth.token;
    const headers = { authorization, 'content-type': 'application/json', accept: 'application/json' };
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (proxy) {
      const res = await socks5HttpGet({ proxyHost: proxy.host, proxyPort: proxy.port, host, port: cfg.helperPort, path: CONTACTS_WRITE_ROUTE, headers, signal,
        maxBytes: MAX_RESPONSE_BYTES, body });
      return { status: res.status, text: res.body.toString('utf8') };
    }
    const res = await fetch('http://' + where + CONTACTS_WRITE_ROUTE, { method: 'POST', headers, body, redirect: 'manual', signal });
    return { status: res.status, text: await readBounded(res, CONTACTS_WRITE_ROUTE) };
  }

  let res: { status: number; text: string } | null = null;
  let last = '';
  for (let attempt = 0; ; attempt++) {
    try {
      res = await once();
      if (res.status !== 503 || !/"retryable":true/.test(res.text)) break;
      last = 'the helper answered 503';
    } catch (error) {
      last = (error as { name?: string })?.name === 'TimeoutError' ? 'the request timed out' : 'no connection could be made';
      res = null;
    }
    if (attempt >= delays.length) break;
    await sleep(delays[attempt]!);
  }
  if (!res) {
    throw appleContactsError('apple_contacts_unreachable', 'GBrain Helper at ' + where + ' did not answer the Contacts batch ' + opts.batch + ': ' + last + '. Some changes may have been applied.',
      'Send the same command again: the helper answers finished changes from its journal and applies the rest once.');
  }
  let parsed: Record<string, unknown> = {};
  try { parsed = res.text ? JSON.parse(res.text) as Record<string, unknown> : {}; } catch { parsed = {}; }
  if (res.status === 200 && parsed.data && typeof parsed.data === 'object') {
    const d = parsed.data as Record<string, unknown>;
    return {
      batch: String(d.batch ?? opts.batch), journal: String(d.journal ?? ''), stopped: typeof d.stopped === 'string' ? d.stopped : null,
      sideEffects: d.side_effects === 'all' || d.side_effects === 'partial' ? d.side_effects : 'none', next: typeof d.next === 'string' ? d.next : null,
      results: (Array.isArray(d.results) ? d.results : []).map((r: Record<string, unknown>) => ({
        key: String(r.key ?? ''), op: String(r.op ?? ''), status: String(r.status ?? ''), id: typeof r.id === 'string' ? r.id : null, reason: typeof r.reason === 'string' ? r.reason : null,
      })),
    };
  }
  const code = typeof parsed.code === 'string' && /^[a-z0-9_]{1,64}$/.test(parsed.code) ? parsed.code : null;
  const fix = typeof parsed.fix === 'string' ? parsed.fix : null;
  const map: Record<string, [string, string]> = {
    contacts_write_off: ['apple_contacts_write_off', 'Contacts writes are switched off on the Mac, so nothing was changed.'],
    contacts_not_allowed: ['apple_contacts_not_allowed', 'macOS has not given GBrain Helper access to Contacts, so nothing was changed.'],
    backup_failed: ['apple_contacts_backup_failed', 'The helper could not save its daily copy of the contacts, so nothing was changed.'],
    insufficient_scope: ['apple_contacts_unauthorized', 'The helper refused the write credential for this kind of change. Nothing was changed.'],
    unauthorized: ['apple_contacts_unauthorized', 'The helper refused the write credential (wrong key, clock skew over 60 s, or a reused nonce). Nothing was changed.'],
    bad_param: ['apple_contacts_bad_request', 'The helper refused the batch as malformed. Nothing was changed.'],
  };
  const [mapped, message] = (code && map[code]) || ['apple_contacts_helper_error', 'GBrain Helper answered ' + res.status + (code ? ' (' + code + ')' : '') + ' to the Contacts batch. Nothing was confirmed changed.'];
  throw appleContactsError(mapped, message + (typeof parsed.detail === 'string' && code === 'bad_param' ? ' ' + parsed.detail : ''),
    fix ?? 'Run gbrain doctor --json, check that GBrain Helper and the GBrain CLI are both up to date, then send the same command again.');
}

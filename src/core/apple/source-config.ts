/**
 * Parse an Apple connector source's `sources.config` (issue #6855).
 * Dependency-light so the connector identity and `sources add` can import it.
 *
 * Keys (all prefixed `a_`): a_account, a_services, a_history_days,
 * a_future_days, a_calendar_ids, a_contacts_dir, a_mail_mailboxes,
 * a_mail_days, a_mail_max (config only: per-run message cap, default 500), a_mail_owner_addresses (the
 * mailbox owner's addresses; open-loop tracking), a_loops_extract_consent (default false), a_dir.
 *
 * Deliberate difference from the Google parser: an `a_services` value that is
 * present but names no known service parses to an EMPTY list (nothing is
 * swept), never to "all services". This connector reads private local data
 * (Mail, Contacts), so a typo like `--services calender` must not silently
 * widen scope to everything.
 */
import {
  ALL_APPLE_SERVICES,
  DEFAULT_CONTACTS_DIR,
  type AppleService,
  type AppleSourceConfig,
} from './types.ts';

export const APPLE_DEFAULT_ACCOUNT = 'local';
export const APPLE_DEFAULT_HISTORY_DAYS = 90;
export const APPLE_HISTORY_DAYS_MAX = 3650;
export const APPLE_DEFAULT_FUTURE_DAYS = 60;
export const APPLE_FUTURE_DAYS_MAX = 3650;
export const APPLE_DEFAULT_MAIL_MAILBOXES: readonly string[] = ['INBOX', 'Sent'];
export const APPLE_DEFAULT_MAIL_DAYS = 30;
export const APPLE_MAIL_DAYS_MAX = 365;
export const APPLE_DEFAULT_MAIL_MAX = 500;
export const APPLE_MAIL_MAX_MAX = 5000;
export const APPLE_MAIL_OWNER_ADDRESSES_MAX = 20;

const OWNER_ADDRESS_RE = /^[^\s@<>,;()"'\\]+@[^\s@<>,;()"'\\]+\.[^\s@<>,;()"'\\]+$/;

/** A mailbox-owner address as the owner wrote it, lower-cased, or null when it is not a bare email address. */
export function normalizeOwnerAddress(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  return t.length <= 254 && OWNER_ADDRESS_RE.test(t) ? t : null;
}

/** The valid owner addresses of a csv or array, de-duplicated, sorted. Invalid entries are dropped (fail closed: fewer owners, never invented ones). */
export function parseOwnerAddresses(raw: unknown): string[] {
  const tokens = csv(raw) ?? [];
  const out = new Set<string>();
  for (const t of tokens) { const a = normalizeOwnerAddress(t); if (a) out.add(a); }
  return [...out].sort().slice(0, APPLE_MAIL_OWNER_ADDRESSES_MAX);
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
export function parseBoolFlag(raw: unknown): boolean {
  return raw === true || (typeof raw === 'string' && TRUE_VALUES.has(raw.trim().toLowerCase())) || raw === 1;
}

/** A csv string (or a string array) split into trimmed, non-empty, de-duplicated tokens. */
function csv(raw: unknown): string[] | null {
  let parts: string[];
  if (typeof raw === 'string') parts = raw.split(',');
  else if (Array.isArray(raw)) parts = raw.filter((v): v is string => typeof v === 'string');
  else return null;
  const out: string[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (t.length > 0 && !out.includes(t)) out.push(t);
  }
  return out;
}

/** A positive finite integer from a number or numeric string, else null. */
function positiveInt(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/**
 * A contacts directory as the user wrote it, normalized (`/people/` →
 * `people`), or null when it is not a safe relative path: one or more
 * lower-case segments of `[a-z0-9_-]`, no dot segments, nothing hidden.
 * (Same rules as the Google connector's parseContactsDir.)
 */
export function parseContactsDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const dir = raw.trim().replace(/^\/+|\/+$/g, '');
  return /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/.test(dir) ? dir : null;
}

/** The services a csv names, in canonical order, unknown tokens ignored. */
export function parseAppleServices(raw: unknown): AppleService[] {
  const tokens = csv(raw);
  if (tokens === null) return [...ALL_APPLE_SERVICES];
  const wanted = new Set(tokens.map((t) => t.toLowerCase()));
  return ALL_APPLE_SERVICES.filter((s) => wanted.has(s));
}

export function parseAppleSourceConfig(
  config: Record<string, unknown>,
  fallbackDir: string,
): AppleSourceConfig {
  const accountRaw = typeof config.a_account === 'string' ? config.a_account.trim().replace(/\s+/g, ' ').slice(0, 64) : '';
  const history = positiveInt(config.a_history_days);
  const future = positiveInt(config.a_future_days);
  const mailDays = positiveInt(config.a_mail_days);
  const mailboxes = csv(config.a_mail_mailboxes);
  const mailMax = positiveInt(config.a_mail_max);
  return {
    account: accountRaw || APPLE_DEFAULT_ACCOUNT,
    services: parseAppleServices(config.a_services),
    historyDays: history !== null ? Math.min(APPLE_HISTORY_DAYS_MAX, history) : APPLE_DEFAULT_HISTORY_DAYS,
    futureDays: future !== null && future <= APPLE_FUTURE_DAYS_MAX ? future : APPLE_DEFAULT_FUTURE_DAYS,
    calendarIds: csv(config.a_calendar_ids) ?? [],
    contactsDir: parseContactsDir(config.a_contacts_dir) ?? DEFAULT_CONTACTS_DIR,
    mailMailboxes: mailboxes && mailboxes.length > 0 ? mailboxes : [...APPLE_DEFAULT_MAIL_MAILBOXES],
    mailDays: mailDays !== null ? Math.min(APPLE_MAIL_DAYS_MAX, mailDays) : APPLE_DEFAULT_MAIL_DAYS,
    mailMax: mailMax !== null ? Math.min(APPLE_MAIL_MAX_MAX, mailMax) : APPLE_DEFAULT_MAIL_MAX,
    mailOwnerAddresses: parseOwnerAddresses(config.a_mail_owner_addresses),
    loopsExtractConsent: parseBoolFlag(config.a_loops_extract_consent),
    dir: typeof config.a_dir === 'string' && config.a_dir.length > 0 ? config.a_dir : fallbackDir,
  };
}

/**
 * The per-source tuning keys `sources add` writes, each only when it differs
 * from the parse-time default so an existing source's config keeps its exact
 * shape.
 */
export function appleTuningConfig(apple: Partial<AppleSourceConfig>): Record<string, unknown> {
  const sameServices = apple.services
    && apple.services.length === ALL_APPLE_SERVICES.length
    && ALL_APPLE_SERVICES.every((s) => apple.services!.includes(s));
  const sameMailboxes = apple.mailMailboxes
    && apple.mailMailboxes.join(',') === APPLE_DEFAULT_MAIL_MAILBOXES.join(',');
  return {
    ...(apple.account && apple.account !== APPLE_DEFAULT_ACCOUNT ? { a_account: apple.account } : {}),
    ...(apple.services && !sameServices ? { a_services: apple.services.join(',') } : {}),
    ...(apple.historyDays !== undefined && apple.historyDays !== APPLE_DEFAULT_HISTORY_DAYS ? { a_history_days: apple.historyDays } : {}),
    ...(apple.futureDays !== undefined && apple.futureDays !== APPLE_DEFAULT_FUTURE_DAYS ? { a_future_days: apple.futureDays } : {}),
    ...(apple.calendarIds && apple.calendarIds.length > 0 ? { a_calendar_ids: apple.calendarIds.join(',') } : {}),
    ...(apple.contactsDir && apple.contactsDir !== DEFAULT_CONTACTS_DIR ? { a_contacts_dir: apple.contactsDir } : {}),
    ...(apple.mailMailboxes && !sameMailboxes ? { a_mail_mailboxes: apple.mailMailboxes.join(',') } : {}),
    ...(apple.mailDays !== undefined && apple.mailDays !== APPLE_DEFAULT_MAIL_DAYS ? { a_mail_days: apple.mailDays } : {}),
    ...(apple.mailOwnerAddresses && apple.mailOwnerAddresses.length > 0 ? { a_mail_owner_addresses: apple.mailOwnerAddresses.join(',') } : {}),
    ...(apple.loopsExtractConsent === true ? { a_loops_extract_consent: true } : {}),
  };
}

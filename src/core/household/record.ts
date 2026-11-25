/**
 * Household records (agent platform plan, lane 2, H1): typed pages with `type: household` and a `kind`. This module
 * holds the schema (version 1), the calendar-strict date helpers and the read-time validator. Validation never holds a
 * file and never refuses a read: an invalid record comes back in `invalid[]` with the field, the reason and the exact fix.
 * Values shaped like full account or card numbers are named by field only, never echoed (`account_number_key`).
 */
import { AGENT_VERBS, type AgentVerb } from '../agent-verbs.ts';

export const HOUSEHOLD_TYPE = 'household';
export const HOUSEHOLD_SCHEMA = 1;
export const HOUSEHOLD_KINDS = ['supply', 'birthday', 'bill', 'deadline', 'appointment', 'return', 'credit'] as const;
export type HouseholdKind = typeof HOUSEHOLD_KINDS[number];
export const HOUSEHOLD_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
export type HouseholdStatus = typeof HOUSEHOLD_STATUSES[number];
/** The status moves any write may make (household_mark's events are a subset); archived is final. */
export const HOUSEHOLD_TRANSITIONS: Readonly<Record<HouseholdStatus, readonly HouseholdStatus[]>> = {
  active: ['paused', 'done', 'archived'], paused: ['active', 'archived'], done: ['archived'], archived: [],
};
export const RECURS = ['none', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type Recurs = typeof RECURS[number];
export const GIFT_STATES = ['none', 'ideas', 'bought', 'given'] as const;
export type GiftState = typeof GIFT_STATES[number];
/** Kinds whose next date comes from `due` (with `recurs`); supply and appointment use cadence, birthday uses `on`. */
export const DUE_KINDS: readonly HouseholdKind[] = ['bill', 'deadline', 'return', 'credit'];
/** The roles a subject page may carry in `household_role`; anything else (or none) leaves the subject unclassified. */
export const HOUSEHOLD_ROLES = ['adult', 'child', 'helper', 'pet', 'home', 'other'] as const;
export type HouseholdRole = typeof HOUSEHOLD_ROLES[number];
const TEXT_MAX = 200;

export interface HouseholdRecord {
  slug: string;
  source_id: string;
  kind: HouseholdKind;
  title: string;
  status: HouseholdStatus;
  about: string[];
  handled_by: string | null;
  tags: string[];
  cadence_days: number | null;
  last_done: string | null;
  due: string | null;
  recurs: Recurs;
  done_through: string | null;
  on: string | null;
  gift: GiftState;
  gift_for: number | null;
  lead_days: number | null;
  amount: { value: number; currency: string } | null;
  proposed_action: { verb: AgentVerb; note: string | null } | null;
}

export interface HouseholdIssue {
  slug: string;
  source_id: string;
  field: string;
  reason: string;
  fix: string;
}

/** A YYYY-MM-DD string that names a real calendar day, or null. */
export function strictDate(value: unknown): string | null {
  const text = value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : typeof value === 'string' ? value.trim() : null;
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? text : null;
}

/** An MM-DD birthday (02-29 included), or null. */
export function strictMonthDay(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : null;
  if (!text || !/^\d{2}-\d{2}$/.test(text)) return null;
  return strictDate(`2024-${text}`) ? text : null;
}

/** Days since 1970-01-01 for a strict date. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

export function dateOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** `anchor` moved by `months`, clamped to the month's last day (01-31 + 1 month = 02-28, 02-29 + 12 = 02-28). */
export function addMonths(anchor: string, months: number): string {
  const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return dateOfDay(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last)) / 86_400_000);
}

/** The n-th occurrence of a recurring date (n = 0 is the anchor itself). */
export function occurrence(anchor: string, recurs: Recurs, n: number): string {
  if (recurs === 'weekly') return dateOfDay(dayNumber(anchor) + 7 * n);
  const months = recurs === 'monthly' ? 1 : recurs === 'quarterly' ? 3 : recurs === 'yearly' ? 12 : 0;
  return months === 0 ? anchor : addMonths(anchor, months * n);
}

/** A cadence of `<n>d|w|m|y` (or a bare number of days) as a number of days. */
export function cadenceDays(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 && value <= 3660 ? value : null;
  const m = typeof value === 'string' ? /^\s*(\d{1,4})\s*([dwmy]?)\s*$/i.exec(value) : null;
  if (!m) return null;
  const n = Number(m[1]) * ({ '': 1, d: 1, w: 7, m: 30, y: 365 } as Record<string, number>)[m[2]!.toLowerCase()]!;
  return n > 0 && n <= 3660 ? n : null;
}

/** Frontmatter keys named like an account or card number. */
const ACCOUNT_KEY_RE = /^(?:(?:account|acct|iban|routing)(?:[_ -]?(?:number|no|num|id))?|(?:card|bank)[_ -]?(?:number|no|num|id))$/i;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** True when a string holds a run shaped like a full card number (13 to 19 digits passing Luhn) or a long account number (10+ digits); a calendar date standing alone is not a run. */
export function looksLikeAccountNumber(value: string): boolean {
  for (const [run] of value.replace(/(?<![\d-])\d{4}-\d{2}-\d{2}(?![\d-])/g, ' ').matchAll(/\d[\d -]{8,24}\d/g)) {
    const digits = run.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
    if (digits.length >= 10 && /^\d+$/.test(run)) return true;
  }
  return false;
}

/** Every field (dotted path) of `value` whose key or text is shaped like an account or card number. Neither the values nor a number-shaped key is returned. */
export function accountNumberFields(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return looksLikeAccountNumber(value) ? [path || 'value'] : [];
  if (typeof value === 'number') return looksLikeAccountNumber(String(value)) ? [path || 'value'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => accountNumberFields(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object' || value instanceof Date) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    if (looksLikeAccountNumber(k)) return [path ? `${path}.<number-shaped key>` : '<number-shaped key>'];
    const at = path ? `${path}.${k}` : k;
    return ACCOUNT_KEY_RE.test(k) ? [at] : accountNumberFields(v, at);
  });
}

/** Caps a free-text field and drops control characters; returned text is data, never instructions. */
export function capText(value: unknown, max = TEXT_MAX): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function slugList(value: unknown): string[] | null {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : value === undefined || value === null ? [] : null;
  if (!list || !list.every(v => typeof v === 'string' && /^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(v.trim()))) return null;
  return [...new Set(list.map(v => (v as string).trim().toLowerCase()))];
}

/**
 * Reads one household page into a typed record, or the issues that keep it from being assessed. A record with an
 * account-number-shaped field is invalid whatever else it holds.
 */
export function readHouseholdRecord(page: { slug: string; source_id: string; title?: string | null; frontmatter: Record<string, unknown> | null | undefined; tags?: string[] }):
  { record: HouseholdRecord; issues: [] } | { record: null; issues: HouseholdIssue[] } {
  const fm = page.frontmatter ?? {};
  const issues: HouseholdIssue[] = [];
  const at = { slug: page.slug, source_id: page.source_id };
  const issue = (field: string, reason: string, fix: string) => issues.push({ ...at, field, reason, fix });
  for (const field of accountNumberFields(fm)) {
    issue(field, 'account_number_key', `Remove ${field} from the page: household records never hold full account or card numbers (keep the last four digits in the title if you need them).`);
  }
  const kind = fm.kind as HouseholdKind;
  if (!HOUSEHOLD_KINDS.includes(kind)) issue('kind', 'unknown_kind', `Set kind to one of ${HOUSEHOLD_KINDS.join(', ')}.`);
  const title = capText(fm.title ?? page.title);
  if (!title) issue('title', 'missing', 'Give the record a title.');
  const status = (fm.status ?? 'active') as HouseholdStatus;
  if (!HOUSEHOLD_STATUSES.includes(status)) issue('status', 'unknown_status', `Set status to one of ${HOUSEHOLD_STATUSES.join(', ')}.`);
  const about = slugList(fm.about);
  if (!about) issue('about', 'not_slugs', 'Set about to a list of subject page slugs, e.g. [people/alice-example].');
  const optionalDate = (field: string): string | null => {
    if (fm[field] === undefined || fm[field] === null) return null;
    const d = strictDate(fm[field]);
    if (!d) issue(field, 'not_a_date', `Set ${field} to a calendar date written YYYY-MM-DD.`);
    return d;
  };
  const due = optionalDate('due');
  const lastDone = optionalDate('last_done');
  const doneThrough = optionalDate('done_through');
  const recurs = (fm.recurs ?? 'none') as Recurs;
  if (!RECURS.includes(recurs)) issue('recurs', 'unknown_recurs', `Set recurs to one of ${RECURS.join(', ')}.`);
  let cadence: number | null = null;
  if (fm.cadence !== undefined && fm.cadence !== null) {
    cadence = cadenceDays(fm.cadence);
    if (cadence === null) issue('cadence', 'not_a_cadence', 'Set cadence to a number of days, weeks, months or years, e.g. 30d, 2w, 6m, 1y.');
  }
  const on = fm.on === undefined || fm.on === null ? null : strictMonthDay(fm.on);
  if (fm.on !== undefined && fm.on !== null && on === null) issue('on', 'not_a_month_day', 'Set on to the birthday as MM-DD, e.g. 03-14.');
  const gift = (fm.gift ?? 'none') as GiftState;
  if (!GIFT_STATES.includes(gift)) issue('gift', 'unknown_gift', `Set gift to one of ${GIFT_STATES.join(', ')}.`);
  const giftFor = fm.gift_for === undefined || fm.gift_for === null ? null : Number(fm.gift_for);
  if (giftFor !== null && !(Number.isInteger(giftFor) && giftFor >= 1900 && giftFor <= 9999)) issue('gift_for', 'not_a_year', 'Set gift_for to the year the gift is for.');
  let lead: number | null = null;
  if (fm.lead_days !== undefined && fm.lead_days !== null) {
    lead = Number(fm.lead_days);
    if (!(Number.isInteger(lead) && lead >= 0 && lead <= 365)) { issue('lead_days', 'not_days', 'Set lead_days to a whole number of days from 0 to 365.'); lead = null; }
  }
  let amount: HouseholdRecord['amount'] = null;
  if (fm.amount !== undefined && fm.amount !== null) {
    const value = Number(fm.amount);
    const currency = typeof fm.currency === 'string' ? fm.currency.trim().toUpperCase() : '';
    if (!Number.isFinite(value) || value < 0 || !/^[A-Z]{3}$/.test(currency)) issue('amount', 'not_money', 'Set amount to a number and currency to a three-letter code, e.g. amount: 60, currency: USD.');
    else amount = { value, currency };
  }
  let proposed: HouseholdRecord['proposed_action'] = null;
  if (fm.proposed_action !== undefined && fm.proposed_action !== null) {
    const pa = fm.proposed_action as Record<string, unknown>;
    const verb = typeof pa === 'object' ? pa.verb as AgentVerb : undefined;
    if (!verb || !AGENT_VERBS.includes(verb)) issue('proposed_action.verb', 'unknown_verb', `Set proposed_action.verb to one of ${AGENT_VERBS.join(', ')}.`);
    else proposed = { verb, note: capText(pa.note) };
  }
  if (DUE_KINDS.includes(kind) && !due) issue('due', 'missing', `A ${kind} needs due: YYYY-MM-DD.`);
  if (kind === 'birthday' && !on) issue('on', 'missing', 'A birthday needs on: MM-DD.');
  if ((kind === 'supply' || kind === 'appointment') && cadence === null && !due) issue('cadence', 'missing', `A ${kind} needs a cadence (e.g. 30d)${kind === 'appointment' ? ' or a booked due date' : ''}.`);
  if (issues.length) return { record: null, issues };
  return { issues: [], record: {
    ...at, kind, title: title!, status, about: about!, handled_by: capText(fm.handled_by, 100), tags: (page.tags ?? []).map(t => t.toLowerCase()),
    cadence_days: cadence, last_done: lastDone, due, recurs, done_through: doneThrough, on, gift, gift_for: giftFor, lead_days: lead, amount, proposed_action: proposed,
  } };
}

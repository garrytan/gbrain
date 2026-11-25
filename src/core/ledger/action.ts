/**
 * The agent_action page (L2): one private page per outside action an agent took or proposes, at
 * actions/YYYY/MM/<id>. Its frontmatter is a fixed shape, validated strictly: an unknown key, a bad
 * status or an impossible transition is refused, never stored. Money is per action and never
 * annualized; minutes_saved is an estimate that is recorded but never totalled. claim_basis is
 * server-owned (store.ts computes it), so no writer sets "evidenced" or "user_confirmed" itself.
 */
import { createHash } from 'node:crypto';
import { AGENT_VERBS, SPEND_PURPOSES, isAgentVerb, type AgentVerb, type SpendPurpose } from '../agent-verbs.ts';

export const AGENT_ACTION_TYPE = 'agent_action';
export const ACTION_SOURCE = 'default';
export const ACTION_SLUG_RE = /^actions\/\d{4}\/\d{2}\/[0-9a-hjkmnp-tv-z]{26}$/;
export const DIGEST_PREFIX = 'actions/weekly/';

export const ACTION_STATUSES = ['proposed', 'approved', 'done', 'failed', 'cancelled', 'reversed'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
const TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  proposed: ['approved', 'done', 'failed', 'cancelled'],
  approved: ['done', 'failed', 'cancelled'],
  done: ['reversed'],
  failed: [],
  cancelled: [],
  reversed: [],
};
export const SAVED_PERIODS = ['one_time', 'monthly', 'yearly'] as const;
export type SavedPeriod = (typeof SAVED_PERIODS)[number];
export const CLAIM_BASES = ['evidenced', 'user_confirmed', 'estimated'] as const;
export type ClaimBasis = (typeof CLAIM_BASES)[number];
export const APPROVERS = ['owner', 'policy', 'none'] as const;
export type Approver = (typeof APPROVERS)[number];

export interface ActionMoney { currency: string; spent?: number; saved?: number; saved_period?: SavedPeriod; estimated?: boolean }
export interface ActionEvidence { ref: string; note?: string }
export interface ActionHold { amount: number; currency: string; expires_at: string }
export interface ActionRecord {
  action: { verb: AgentVerb; purpose?: SpendPurpose; status: ActionStatus; at: string; summary: string; counterparty?: string; harness?: string; actor: string };
  money?: ActionMoney;
  minutes_saved?: number;
  evidence: ActionEvidence[];
  approval: { by: Approver; rule?: string; policy_revision?: string };
  cost?: { measured_usd?: number; reported?: number };
  supersedes?: string;
  claim_basis: ClaimBasis;
  hold?: ActionHold;
  request_id?: string;
  request_hash?: string;
  last_request?: { id: string; hash: string };
}

/** Keys the write path stamps on every page (trust tier and provenance); never part of the action. */
export const SERVER_STAMPED_KEYS = ['trust_tier', 'source_kind', 'ingested_via', 'ingested_at'];
const TOP_KEYS = ['type', 'title', 'visibility', 'readable_by', 'action', 'money', 'minutes_saved', 'evidence', 'approval', 'cost', 'supersedes', 'claim_basis', 'hold', 'request_id', 'request_hash', 'last_request', ...SERVER_STAMPED_KEYS];
const NESTED: Record<string, readonly string[]> = {
  action: ['verb', 'purpose', 'status', 'at', 'summary', 'counterparty', 'harness', 'actor'],
  money: ['currency', 'spent', 'saved', 'saved_period', 'estimated'],
  approval: ['by', 'rule', 'policy_revision'],
  cost: ['measured_usd', 'reported'],
  hold: ['amount', 'currency', 'expires_at'],
  last_request: ['id', 'hash'],
};
export const MAX_SUMMARY = 200;
const MAX_TEXT = 200;
const MAX_EVIDENCE = 20;
const MAX_MONEY = 1e9;

export type ActionValidation = { ok: true; record: ActionRecord } | { ok: false; field: string; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const amount = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MONEY;
const isoTime = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

/**
 * Validate a stored or proposed agent_action frontmatter. A write refuses every key outside the shape. A read
 * (`{ read: true }`) ignores keys it does not know, so an action a newer gbrain wrote still counts here.
 */
export function validateActionFrontmatter(fm: Record<string, unknown>, opts: { read?: boolean } = {}): ActionValidation {
  const fail = (field: string, message: string): ActionValidation => ({ ok: false, field, message });
  if (!opts.read) for (const key of Object.keys(fm)) if (!TOP_KEYS.includes(key)) return fail(key, `${key} is not an agent_action field`);
  for (const [key, allowed] of Object.entries(NESTED)) {
    const value = fm[key];
    if (value === undefined) continue;
    if (!isObject(value)) return fail(key, `${key} must be a mapping`);
    if (!opts.read) for (const inner of Object.keys(value)) if (!allowed.includes(inner)) return fail(`${key}.${inner}`, `${key}.${inner} is not an agent_action field`);
  }
  const a = fm.action as Record<string, unknown> | undefined;
  if (!a) return fail('action', 'action is required');
  if (!isAgentVerb(a.verb)) return fail('action.verb', `action.verb must be one of ${AGENT_VERBS.join(', ')}`);
  if (a.purpose !== undefined && (a.verb !== 'spend' || !(SPEND_PURPOSES as readonly unknown[]).includes(a.purpose))) return fail('action.purpose', 'action.purpose is buy or pay, on spend only');
  if (!(ACTION_STATUSES as readonly unknown[]).includes(a.status)) return fail('action.status', `action.status must be one of ${ACTION_STATUSES.join(', ')}`);
  if (!isoTime(a.at)) return fail('action.at', 'action.at must be an ISO timestamp');
  if (!text(a.summary, MAX_SUMMARY)) return fail('action.summary', `action.summary is required, at most ${MAX_SUMMARY} characters`);
  for (const k of ['counterparty', 'harness'] as const) if (a[k] !== undefined && !text(a[k])) return fail(`action.${k}`, `action.${k} must be text of at most ${MAX_TEXT} characters`);
  if (!text(a.actor)) return fail('action.actor', 'action.actor is required (gbrain stamps it)');
  const m = fm.money as Record<string, unknown> | undefined;
  if (m) {
    if (typeof m.currency !== 'string' || !/^[A-Z]{3}$/.test(m.currency)) return fail('money.currency', 'money.currency must be a three-letter code like USD');
    for (const k of ['spent', 'saved'] as const) if (m[k] !== undefined && !amount(m[k])) return fail(`money.${k}`, `money.${k} must be a number from 0 to ${MAX_MONEY}`);
    if (m.spent === undefined && m.saved === undefined) return fail('money', 'money needs spent or saved');
    if (m.saved !== undefined && !(SAVED_PERIODS as readonly unknown[]).includes(m.saved_period)) return fail('money.saved_period', 'money.saved_period must be one_time, monthly or yearly');
    if (m.saved === undefined && m.saved_period !== undefined) return fail('money.saved_period', 'money.saved_period goes with money.saved');
    if (m.estimated !== undefined && typeof m.estimated !== 'boolean') return fail('money.estimated', 'money.estimated must be true or false');
  }
  if (fm.minutes_saved !== undefined && !(typeof fm.minutes_saved === 'number' && Number.isFinite(fm.minutes_saved) && fm.minutes_saved >= 0 && fm.minutes_saved <= 100_000)) return fail('minutes_saved', 'minutes_saved must be a number of minutes');
  const evidence = fm.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) return fail('evidence', `evidence must be a list of at most ${MAX_EVIDENCE} refs`);
  for (const [i, e] of evidence.entries()) {
    if (!isObject(e) || !text(e.ref, 500) || Object.keys(e).some(k => k !== 'ref' && k !== 'note') || (e.note !== undefined && !text(e.note))) return fail(`evidence[${i}]`, 'each evidence entry is {ref, note?}: a page slug or a URL');
  }
  const ap = fm.approval as Record<string, unknown> | undefined;
  if (!ap || !(APPROVERS as readonly unknown[]).includes(ap.by)) return fail('approval.by', 'approval.by must be owner, policy or none');
  for (const k of ['rule', 'policy_revision'] as const) if (ap[k] !== undefined && !text(ap[k])) return fail(`approval.${k}`, `approval.${k} must be text`);
  const c = fm.cost as Record<string, unknown> | undefined;
  if (c) for (const k of ['measured_usd', 'reported'] as const) if (c[k] !== undefined && !amount(c[k])) return fail(`cost.${k}`, `cost.${k} must be a non-negative number of USD`);
  if (fm.supersedes !== undefined && !(typeof fm.supersedes === 'string' && ACTION_SLUG_RE.test(fm.supersedes))) return fail('supersedes', 'supersedes must name another action page (actions/YYYY/MM/<id>)');
  if (!(CLAIM_BASES as readonly unknown[]).includes(fm.claim_basis)) return fail('claim_basis', 'claim_basis must be evidenced, user_confirmed or estimated');
  const h = fm.hold as Record<string, unknown> | undefined;
  if (h) {
    if (a.status !== 'proposed' && a.status !== 'approved') return fail('hold', 'a hold belongs to a proposed or approved action');
    if (!amount(h.amount) || typeof h.currency !== 'string' || !/^[A-Z]{3}$/.test(h.currency) || !isoTime(h.expires_at)) return fail('hold', 'hold is {amount, currency, expires_at}');
  }
  if (fm.request_id !== undefined && !text(fm.request_id, 128)) return fail('request_id', 'request_id must be text of at most 128 characters');
  if (fm.request_hash !== undefined && !(typeof fm.request_hash === 'string' && /^[0-9a-f]{64}$/.test(fm.request_hash))) return fail('request_hash', 'request_hash is a sha256 hex digest (gbrain stamps it)');
  const lr = fm.last_request as Record<string, unknown> | undefined;
  if (lr && (!text(lr.id, 128) || typeof lr.hash !== 'string' || !/^[0-9a-f]{64}$/.test(lr.hash))) return fail('last_request', 'last_request is {id, hash} (gbrain stamps it)');
  return { ok: true, record: fm as unknown as ActionRecord };
}

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** The first 10 characters of an action id: its time, so action slugs in one month sort by when they were made. */
export function actionTimeKey(at: Date): string {
  let t = Math.max(0, at.getTime());
  let time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  return time;
}

/** A ULID-shaped id: 10 characters of the action's time, 16 from a hash of who logged it and its request_id, so a replay names the same page. */
export function actionId(at: Date, actor: string, requestId: string): string {
  const time = actionTimeKey(at);
  const digest = createHash('sha256').update(`${actor}\n${requestId}`).digest();
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[digest[i]! % 32];
  return time + rand;
}

export function actionSlug(at: Date, actor: string, requestId: string): string {
  return `actions/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${actionId(at, actor, requestId)}`;
}

export function isActionSlug(slug: unknown): boolean {
  return typeof slug === 'string' && ACTION_SLUG_RE.test(slug.replace(/\.md$/, '').toLowerCase());
}

/**
 * assessHouseholdRecord (agent platform plan, lane 2, H1): a pure function of a record, a calendar day and options.
 * No model, no stored state. It returns the record's next date, the days left, a state (overdue, at_risk, upcoming,
 * ok, unknown), a template reason built from fields, and a proposed action as typed fields.
 *
 * Every outside household proposal needs the user's yes at launch (d2): `requires_approval` is always true, whatever
 * the policy says. Policy advice, once L1's policy_check exists, rides in its own `policy_advice` field.
 */
import type { AgentVerb, SpendPurpose } from '../agent-verbs.ts';
import { capText, dateOfDay, dayNumber, occurrence, strictDate, type GiftState, type HouseholdKind, type HouseholdRecord } from './record.ts';

export type HouseholdState = 'overdue' | 'at_risk' | 'upcoming' | 'ok' | 'unknown';

/** Per-kind lead defaults in days: how early a record turns at_risk. */
export const LEAD_DEFAULTS: Readonly<Record<HouseholdKind, number>> = { supply: 5, appointment: 21, bill: 5, deadline: 7, return: 3, credit: 14, birthday: 14 };
const KIND_WEIGHT: Readonly<Record<HouseholdKind, number>> = { bill: 6, deadline: 5, return: 5, credit: 4, appointment: 3, supply: 2, birthday: 2 };
const STATE_SCORE: Readonly<Record<HouseholdState, number>> = { overdue: 50, at_risk: 30, upcoming: 10, ok: 0, unknown: 0 };
const DEFAULT_ACTION: Readonly<Record<HouseholdKind, { verb: AgentVerb; purpose?: SpendPurpose; what: string }>> = {
  supply: { verb: 'spend', purpose: 'buy', what: 'Buy' }, bill: { verb: 'spend', purpose: 'pay', what: 'Pay' },
  deadline: { verb: 'submit', what: 'Submit' }, appointment: { verb: 'book', what: 'Book' }, return: { verb: 'return', what: 'Return' },
  credit: { verb: 'use', what: 'Use' }, birthday: { verb: 'spend', purpose: 'buy', what: 'Buy a gift for' },
};

/** What a policy says about a proposed action (L1's policy_check), shown beside the approval flag and never replacing it. */
export interface PolicyAdvice { decision: 'allow' | 'ask' | 'deny' | 'none'; rule_id: string | null; enforcement: 'advisory' }
export type PolicyAdvisor = (action: { verb: AgentVerb; purpose: SpendPurpose | null; amount: HouseholdRecord['amount'] }) => PolicyAdvice | null;

export interface ProposedAction {
  verb: AgentVerb;
  purpose: SpendPurpose | null;
  item_slug: string;
  summary: string;
  /** Always true at launch: GBrain never acts, and every outside household action needs the user's yes in the harness. */
  requires_approval: true;
  policy_advice: PolicyAdvice | null;
  /** The day from which acting makes sense (next date minus lead days, never before as_of). */
  after: string;
}

export interface HouseholdAssessment {
  slug: string;
  source_id: string;
  kind: HouseholdKind;
  title: string;
  status: HouseholdRecord['status'];
  next_due: string | null;
  days_left: number | null;
  lead_days: number;
  state: HouseholdState;
  reason: string;
  score: number;
  amount: HouseholdRecord['amount'];
  handled_by: string | null;
  proposed_action: ProposedAction | null;
}

/** The calendar day of `ms` in `timeZone` (YYYY-MM-DD). Throws RangeError on an unknown zone. */
export function calendarDay(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function nextBirthday(on: string, asOf: string): string {
  const year = Number(asOf.slice(0, 4));
  for (const y of [year, year + 1]) {
    const date = strictDate(`${y}-${on}`) ?? `${y}-02-28`;
    if (date >= asOf) return date;
  }
  return `${year + 1}-${on}`;
}

function nextDue(r: HouseholdRecord, asOf: string): { next: string | null; done?: true; gift?: GiftState } {
  if (r.kind === 'birthday') {
    const next = nextBirthday(r.on!, asOf);
    return { next, gift: r.gift_for === Number(next.slice(0, 4)) ? r.gift : 'none' };
  }
  if (r.kind === 'supply' || r.kind === 'appointment') {
    if (r.due && (!r.last_done || r.due > r.last_done)) return { next: r.due };
    if (r.last_done && r.cadence_days) return { next: dateOfDay(dayNumber(r.last_done) + r.cadence_days) };
    return { next: null };
  }
  const anchor = r.due!;
  if (r.recurs === 'none') return r.done_through && r.done_through >= anchor ? { next: null, done: true } : { next: anchor };
  let n = 0;
  while (r.done_through && occurrence(anchor, r.recurs, n) <= r.done_through && n < 10_000) n++;
  return { next: occurrence(anchor, r.recurs, n) };
}

function reasonFor(r: HouseholdRecord, state: HouseholdState, next: string | null, days: number | null, gift?: GiftState): string {
  const t = r.title;
  if (r.status !== 'active') return `${t} is ${r.status}.`;
  if (state === 'unknown') return r.kind === 'supply' ? `${t} has never been marked bought, so its next date is unknown.` : `${t} has no date to count from.`;
  if (next === null || days === null) return `${t} is done.`;
  const when = days < 0 ? `was due ${next} (${-days} day${days === -1 ? '' : 's'} ago)` : days === 0 ? `is due today (${next})` : `is due ${next}, in ${days} day${days === 1 ? '' : 's'}`;
  if (r.kind === 'birthday') {
    const on = days === 0 ? `is today (${next})` : `is on ${next}, in ${days} day${days === 1 ? '' : 's'}`;
    return `${t} ${on}${gift === 'none' ? ', and no gift is planned yet' : gift === 'ideas' ? ', and the gift is still only ideas' : `; the gift is ${gift}`}.`;
  }
  if (r.kind === 'supply' && r.last_done) return `${t} ${when}; last bought ${r.last_done}.`;
  return `${t} ${when}.`;
}

/**
 * The assessment of one record on `asOf` (a YYYY-MM-DD day in the brain's timezone). `windowDays` bounds
 * `upcoming`; `advice` (L1's policy_check, when present) fills policy_advice and never the approval flag.
 */
export function assessHouseholdRecord(r: HouseholdRecord, asOf: string, opts: { windowDays?: number; advice?: PolicyAdvisor } = {}): HouseholdAssessment {
  const lead = r.lead_days ?? LEAD_DEFAULTS[r.kind];
  const windowDays = opts.windowDays ?? 7;
  const active = r.status === 'active';
  const { next, gift } = active ? nextDue(r, asOf) : { next: null, gift: undefined };
  const days = next === null ? null : dayNumber(next) - dayNumber(asOf);
  let state: HouseholdState;
  if (!active) state = 'ok';
  else if (days === null) state = next === null && (r.kind === 'supply' || r.kind === 'appointment') ? 'unknown' : 'ok';
  else if (days < 0) state = 'overdue';
  else if (days <= lead) state = r.kind === 'birthday' && gift !== 'none' && gift !== 'ideas' ? 'upcoming' : 'at_risk';
  else if (days <= windowDays) state = 'upcoming';
  else state = 'ok';
  const score = state === 'ok' || state === 'unknown' || days === null ? 0 : STATE_SCORE[state] - Math.min(days, 14) + KIND_WEIGHT[r.kind];
  let proposed: ProposedAction | null = null;
  if ((state === 'overdue' || state === 'at_risk') && next) {
    const fallback = DEFAULT_ACTION[r.kind];
    const verb = r.proposed_action?.verb ?? fallback.verb;
    const purpose: SpendPurpose | null = verb === 'spend' ? (r.kind === 'bill' ? 'pay' : 'buy') : null;
    const note = r.proposed_action?.note;
    proposed = {
      verb, purpose, item_slug: r.slug,
      summary: capText(note ? note : `${verb === fallback.verb ? fallback.what : verb} ${r.title}${r.amount ? ` (${r.amount.value} ${r.amount.currency})` : ''}`)!,
      requires_approval: true,
      policy_advice: opts.advice?.({ verb, purpose, amount: r.amount }) ?? null,
      after: dateOfDay(Math.max(dayNumber(asOf), dayNumber(next) - lead)),
    };
  }
  return {
    slug: r.slug, source_id: r.source_id, kind: r.kind, title: r.title, status: r.status, next_due: next, days_left: days, lead_days: lead,
    state, reason: reasonFor(r, state, next, days, gift), score, amount: r.amount, handled_by: r.handled_by, proposed_action: proposed,
  };
}

/** Highest score first; ties by next date (undated last), then slug. Reproducible for a pinned as_of. */
export function rankAssessments(items: HouseholdAssessment[]): HouseholdAssessment[] {
  return [...items].sort((a, b) => b.score - a.score
    || (a.next_due ?? '9999-12-31').localeCompare(b.next_due ?? '9999-12-31') || a.slug.localeCompare(b.slug) || a.source_id.localeCompare(b.source_id));
}

/**
 * Ledger arithmetic (L2), computed by core and never by a model: totals over a window split by
 * claim basis, verb and counterparty, the spend a budget window has used, and the weekly digest.
 * Money is summed per currency (no exchange rates) and saved money per period (never annualized).
 * minutes_saved is never totalled. A superseded action, or one that failed, was cancelled or was
 * reversed, counts nothing; a live hold counts toward budgets, an expired one counts nothing. Sums run in millionths
 * of a unit (policy/evaluate.ts toMicros), so decimal amounts add exactly.
 */
import type { AgentVerb } from '../agent-verbs.ts';
import { MICROS, toMicros, type WindowUsage } from '../policy/evaluate.ts';
import type { ActionRecord, ClaimBasis, SavedPeriod } from './action.ts';

export interface StoredAction { slug: string; record: ActionRecord }
export type BudgetWindow = 'day' | 'week' | 'month';

type ByCurrency = Record<string, number>;
type ByBasis = Record<ClaimBasis, ByCurrency>;
const emptyBasis = (): ByBasis => ({ evidenced: {}, user_confirmed: {}, estimated: {} });
const add = (bucket: ByCurrency, currency: string, amount: number) => { bucket[currency] = (toMicros(bucket[currency] ?? 0) + toMicros(amount)) / MICROS; };

export function windowStart(window: BudgetWindow, now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (window === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (window === 'month') d.setUTCDate(1);
  return d;
}

export function holdLive(a: ActionRecord, now: Date): boolean {
  return !!a.hold && (a.action.status === 'proposed' || a.action.status === 'approved') && Date.parse(a.hold.expires_at) > now.getTime();
}

export function holdExpired(a: ActionRecord, now: Date): boolean {
  return !!a.hold && (a.action.status === 'proposed' || a.action.status === 'approved') && Date.parse(a.hold.expires_at) <= now.getTime();
}

/** The actions that still count: done, and not superseded by a correction that was applied (done, or done and then reversed). */
export function countedActions(rows: readonly StoredAction[]): StoredAction[] {
  const superseded = new Set(rows.filter(r => r.record.action.status === 'done' || r.record.action.status === 'reversed').map(r => r.record.supersedes).filter((s): s is string => !!s));
  return rows.filter(r => r.record.action.status === 'done' && !superseded.has(r.slug));
}

export interface LedgerTotals {
  actions: number;
  spent: ByBasis;
  saved: Record<SavedPeriod, ByBasis>;
  by_verb: Record<string, { actions: number; spent: ByCurrency }>;
  by_counterparty: Array<{ counterparty: string; actions: number; spent: ByCurrency; saved: ByCurrency }>;
  holds: { live: number; held: ByCurrency; expired_unconfirmed: number };
}

const MAX_COUNTERPARTIES = 20;

/** Totals over rows; `keep` filters after corrections are resolved, so a filter never brings back a corrected action. */
export function ledgerTotals(rows: readonly StoredAction[], now: Date, keep: (row: StoredAction) => boolean = () => true): LedgerTotals {
  const counted = countedActions(rows).filter(keep);
  const out: LedgerTotals = { actions: counted.length, spent: emptyBasis(), saved: { one_time: emptyBasis(), monthly: emptyBasis(), yearly: emptyBasis() }, by_verb: {}, by_counterparty: [], holds: { live: 0, held: {}, expired_unconfirmed: 0 } };
  const parties = new Map<string, { counterparty: string; actions: number; spent: ByCurrency; saved: ByCurrency }>();
  for (const { record: a } of counted) {
    const verb = (out.by_verb[a.action.verb] ??= { actions: 0, spent: {} });
    verb.actions++;
    const key = a.action.counterparty?.trim().toLowerCase();
    const party = key ? (parties.get(key) ?? parties.set(key, { counterparty: a.action.counterparty!.trim(), actions: 0, spent: {}, saved: {} }).get(key)!) : null;
    if (party) party.actions++;
    const m = a.money;
    if (!m) continue;
    if (m.spent !== undefined) { add(out.spent[a.claim_basis], m.currency, m.spent); add(verb.spent, m.currency, m.spent); if (party) add(party.spent, m.currency, m.spent); }
    if (m.saved !== undefined && m.saved_period) { add(out.saved[m.saved_period][a.claim_basis], m.currency, m.saved); if (party) add(party.saved, `${m.currency} ${m.saved_period}`, m.saved); }
  }
  for (const { record: a } of rows.filter(keep)) {
    if (holdLive(a, now)) { out.holds.live++; add(out.holds.held, a.hold!.currency, a.hold!.amount); }
    else if (holdExpired(a, now)) out.holds.expired_unconfirmed++;
  }
  out.by_counterparty = [...parties.values()].sort((x, y) => y.actions - x.actions || x.counterparty.localeCompare(y.counterparty)).slice(0, MAX_COUNTERPARTIES);
  return out;
}


/**
 * What a budget window has used for one verb (and merchant, when the rule names one) in one currency: done spend
 * since the window started, and every hold still live now, whenever it was made, since it is money not yet spent.
 */
export function windowUsage(rows: readonly StoredAction[], q: { verb: AgentVerb; merchant?: string; currency: string; since: Date }, now: Date): WindowUsage {
  const merchant = q.merchant?.trim().toLowerCase();
  const matches = (a: ActionRecord) => a.action.verb === q.verb && (merchant === undefined || a.action.counterparty?.trim().toLowerCase() === merchant);
  let spent = 0;
  for (const { record: a } of countedActions(rows)) {
    if (matches(a) && Date.parse(a.action.at) >= q.since.getTime() && a.money?.currency === q.currency && a.money.spent !== undefined) spent += toMicros(a.money.spent);
  }
  let held = 0;
  for (const { record: a } of rows) if (matches(a) && holdLive(a, now) && a.hold!.currency === q.currency) held += toMicros(a.hold!.amount);
  return { spent: spent / MICROS, held: held / MICROS };
}

const money = (bucket: ByCurrency) => Object.entries(bucket).map(([c, n]) => `${n.toFixed(2)} ${c}`).join(', ') || 'none';

/** The weekly digest: deterministic text from the same totals, no model call. */
export function renderDigest(rows: readonly StoredAction[], since: Date, until: Date, now: Date): string {
  const t = ledgerTotals(rows, now);
  const sum = (b: ByBasis) => ({ evidenced: money(b.evidenced), user_confirmed: money(b.user_confirmed), estimated: money(b.estimated) });
  const spent = sum(t.spent);
  const lines = [
    `# What your agents did: ${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`,
    '',
    `${t.actions} outside actions done.`,
    '',
    `Spent with evidence: ${spent.evidenced}. Confirmed by you: ${spent.user_confirmed}. Estimated: ${spent.estimated}.`,
  ];
  for (const period of ['one_time', 'monthly', 'yearly'] as const) {
    const s = sum(t.saved[period]);
    if (s.evidenced === 'none' && s.user_confirmed === 'none' && s.estimated === 'none') continue;
    lines.push(`Saved (${period.replace('_', ' ')}): with evidence ${s.evidenced}; confirmed by you ${s.user_confirmed}; estimated ${s.estimated}.`);
  }
  lines.push('', '## By verb', '');
  for (const [verb, v] of Object.entries(t.by_verb).sort(([a], [b]) => a.localeCompare(b))) lines.push(`- ${verb}: ${v.actions} (spent ${money(v.spent)})`);
  if (t.by_counterparty.length) {
    lines.push('', '## By counterparty', '');
    for (const p of t.by_counterparty) lines.push(`- ${p.counterparty}: ${p.actions} (spent ${money(p.spent)})`);
  }
  const unconfirmed = rows.filter(r => holdExpired(r.record, now));
  if (unconfirmed.length) {
    lines.push('', '## Unconfirmed holds', '', 'These budget holds expired without a logged result, so they count toward nothing:', '');
    for (const r of unconfirmed) lines.push(`- ${r.slug}: ${r.record.action.verb}, ${r.record.hold!.amount.toFixed(2)} ${r.record.hold!.currency}, ${r.record.action.summary}`);
  }
  return lines.join('\n') + '\n';
}

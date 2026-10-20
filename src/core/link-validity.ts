/**
 * Temporal typed edges: relation semantics, relationship state and the one
 * liveness predicate every semantic graph reader uses.
 *
 * Model (docs/guides/temporal-edges.md):
 * - A relationship is (from_page_id, to_page_id, link_type). Its evidence is
 *   every `links` row for it (assertions, each with a tense) plus every
 *   `link_transitions` row (dated start/end statements).
 * - `buildRelationshipState` turns that evidence into stints. It reads only the
 *   evidence, never arrival order, so any ingestion order yields the same state.
 * - `link_relationships` stores the state per read scope; readers filter with
 *   `relationshipFilterSql`, a primary-key probe. A relationship with no state
 *   row reads as live, so a lagging projection never hides an edge.
 * - `closeContradiction` is the date arithmetic applied after something (an LLM
 *   verdict, a declared single-value relation) says two relationships cannot
 *   both hold. It never invents dates.
 *
 * Pure module except the SQL fragment builders; no engine imports.
 */
import type { PageReadScope } from './types.ts';

export type RelationSemantics = 'state' | 'event' | 'reference';
export type TransitionKind = 'start' | 'end';
export type TransitionProducer = 'timeline' | 'explicit' | 'frontmatter' | 'manual' | 'inline' | 'dream';
export type DatePrecision = 'day' | 'month' | 'year';
export type AssertionTense = 'present' | 'past';
export type RelationshipStatus = 'live' | 'ended' | 'ended_unknown_date' | 'not_started' | 'disputed' | 'event';
export type EdgeStatusFilter = 'live' | 'ended' | 'all';
export type RelationshipScope = 'all' | 'world';

/**
 * State relations can end; event relations happened on a date and stay true
 * afterwards; everything else is a plain reference with no temporal state.
 * Open-loop edges (owes_to, awaiting_reply_from) keep their own lifecycle in
 * open_loops, so they are references here.
 */
export const RELATION_SEMANTICS: Readonly<Record<string, RelationSemantics>> = {
  works_at: 'state',
  advises: 'state',
  yc_partner: 'state',
  founded: 'event',
  invested_in: 'event',
  led_round: 'event',
  attended: 'event',
  discussed_in: 'event',
  cited: 'event',
};

/**
 * Pack-declared semantics (`link_types[].temporal`) layered over the built-in
 * table; a pack declaration wins for its type. Set by
 * `primeRelationSemantics` (link-semantics-pack.ts) at write entry points.
 */
let packSemantics: ReadonlyMap<string, 'state' | 'event'> = new Map();

export function setPackRelationSemantics(semantics: ReadonlyMap<string, 'state' | 'event'>): void {
  packSemantics = semantics;
}

/**
 * Relation types that record when something takes effect rather than a
 * relationship that starts and ends: their edges are never hidden for not
 * having started (or for falling outside a `during` window). Status reads
 * still report `not_started` and the stints; only filtering treats them like
 * reference edges (never part of an `ended` read). docs/guides/temporal-edges.md.
 */
export const LIVENESS_EXEMPT_LINK_TYPES: readonly string[] = Object.freeze(['amends']);

const livenessExemptSql = `lr.link_type <> ALL(ARRAY[${LIVENESS_EXEMPT_LINK_TYPES.map(t => `'${t}'`).join(', ')}]::text[])`;

export function relationSemantics(linkType: string | null | undefined): RelationSemantics {
  if (!linkType) return 'reference';
  return packSemantics.get(linkType) ?? RELATION_SEMANTICS[linkType] ?? 'reference';
}

export function isTemporalLinkType(linkType: string | null | undefined): boolean {
  return relationSemantics(linkType) !== 'reference';
}

/** Every relation type with temporal state: the built-in table plus pack declarations. */
export function temporalLinkTypes(): string[] {
  return [...new Set([...Object.keys(RELATION_SEMANTICS), ...packSemantics.keys()])].filter(isTemporalLinkType).sort();
}

// ─── Dates ───────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * Normalize a full or partial calendar date. `2021` → 2021-01-01 (year),
 * `2021-04` → 2021-04-01 (month), `2021-04-09` → itself (day). Rejects
 * impossible dates (2021-02-30) and anything else.
 */
export function normalizePartialDate(raw: string | null | undefined): { date: string; precision: DatePrecision } | null {
  if (typeof raw !== 'string') return null;
  const m = DATE_RE.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] === undefined ? 1 : Number(m[2]);
  const day = m[3] === undefined ? 1 : Number(m[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  const date = `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { date, precision: m[3] !== undefined ? 'day' : m[2] !== undefined ? 'month' : 'year' };
}

/** Strict YYYY-MM-DD (op params). */
export function isCalendarDate(raw: unknown): raw is string {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && normalizePartialDate(raw)?.date === raw;
}

/** Today's date in UTC, the reference "now" for liveness. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Date column values arrive as Date (PGLite) or string (postgres.js); normalize to YYYY-MM-DD. */
export function dateKey(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

// ─── Relationship state ──────────────────────────────────────────────────

/** A half-open stint [from, until). NULL bound = unbounded. */
export interface Stint { from: string | null; until: string | null }

export interface AssertionEvidence {
  tense: AssertionTense;
  /** Page that asserts it (origin_page_id, else from_page_id). */
  originPageId: number | null;
}

export interface TransitionEvidence {
  kind: TransitionKind;
  occurredOn: string;
  producer: TransitionProducer;
  originPageId: number | null;
}

export interface RelationshipState {
  semantics: Exclude<RelationSemantics, 'reference'>;
  stints: Stint[];
  firstStart: string | null;
  lastStart: string | null;
  lastEnd: string | null;
  undatedPresent: number;
  undatedPast: number;
  disputed: boolean;
  /** Present-tense assertions that a later dated end overrides. */
  staleAssertions: number;
  /**
   * The last end is an upper bound: only an inferred closure (producer `dream`, the nightly check's date arithmetic)
   * dates it, so the relationship ended on or before `lastEnd`, not on it.
   */
  lastEndUpperBound: boolean;
}

/**
 * Turn a relationship's evidence into stints.
 *
 * State relations:
 * 1. Dated transitions collapse to one event per (kind, date), sorted by date
 *    with an end before a start on the same day.
 * 2. A start opens a stint when none is open (a second start, e.g. a promotion,
 *    is absorbed). An end closes the open stint; an end with no open stint
 *    closes an implicit stint (-inf, end) only when no stint exists yet, so
 *    repeated unmatched ends collapse to the first.
 * 3. Undated present assertions: with no dated events they form (-inf, inf);
 *    if the last event is a start its stint stays open; if the last event is an
 *    end they do not reopen it (dated evidence beats undated) and count as
 *    stale assertions.
 * 4. Undated past assertions with no dated events: no undated present →
 *    ended at an unknown date (no stints); undated present from another origin
 *    → disputed (kept live, flagged). With a dated start and no dated end, past
 *    assertions never close the stint: only a dated end does.
 * 5. An inferred end (producer `dream`: the nightly check closed the stint on the date a conflicting
 *    relationship started) is an upper bound. An explicit end of the same stint replaces it, earlier or later.
 * Event relations: [earliest dated occurrence, inf), or (-inf, inf) undated.
 */
export function buildRelationshipState(
  semantics: Exclude<RelationSemantics, 'reference'>,
  assertions: readonly AssertionEvidence[],
  transitions: readonly TransitionEvidence[],
): RelationshipState {
  const undatedPresent = assertions.filter(a => a.tense === 'present').length;
  const undatedPast = assertions.filter(a => a.tense === 'past').length;
  const events = semantics === 'state' ? withoutOverriddenInferredEnds(dedupeEvents(transitions)) : dedupeEvents(transitions);
  const starts = events.filter(e => e.kind === 'start').map(e => e.date);
  const ends = events.filter(e => e.kind === 'end');
  const lastEnd = ends.at(-1) ?? null;
  const base = {
    semantics,
    firstStart: starts[0] ?? null,
    lastStart: starts.length ? starts[starts.length - 1] : null,
    lastEnd: lastEnd?.date ?? null,
    lastEndUpperBound: lastEnd?.inferred === true,
    undatedPresent,
    undatedPast,
  };

  if (semantics === 'event') {
    const first = events.length ? events[0].date : null;
    return { ...base, lastEndUpperBound: false, stints: [{ from: first, until: null }], disputed: false, staleAssertions: 0 };
  }

  if (events.length === 0) {
    if (undatedPresent > 0) {
      return { ...base, stints: [{ from: null, until: null }], disputed: pastFromOtherOrigin(assertions), staleAssertions: 0 };
    }
    // Only past-tense assertions (or no evidence at all): ended, date unknown.
    return { ...base, stints: [], disputed: false, staleAssertions: 0 };
  }

  const stints: Stint[] = [];
  let open: Stint | null = null;
  for (const e of events) {
    if (e.kind === 'start') {
      if (!open) { open = { from: e.date, until: null }; stints.push(open); }
    } else if (open) {
      open.until = e.date;
      open = null;
    } else if (stints.length === 0) {
      stints.push({ from: null, until: e.date });
    }
  }
  const lastEvent = events[events.length - 1];
  const staleAssertions = lastEvent.kind === 'end' ? undatedPresent : 0;
  let disputed = false;
  // A dated start stays open until a dated end: past-tense prose alone never
  // closes it (a promotion or "has worked at" reads as past). Present and past
  // assertions from different pages flag the relationship as disputed.
  if (open && undatedPast > 0 && undatedPresent > 0) disputed = pastFromOtherOrigin(assertions);
  return { ...base, stints: mergeStints(stints), disputed, staleAssertions };
}

function pastFromOtherOrigin(assertions: readonly AssertionEvidence[]): boolean {
  const presentOrigins = new Set(assertions.filter(a => a.tense === 'present').map(a => a.originPageId));
  return assertions.some(a => a.tense === 'past' && !presentOrigins.has(a.originPageId));
}

interface StateEvent { kind: TransitionKind; date: string; inferred: boolean }

/** One event per (kind, date); an end is inferred only when every transition behind it is a `dream` closure. */
function dedupeEvents(transitions: readonly TransitionEvidence[]): StateEvent[] {
  const byKey = new Map<string, StateEvent>();
  for (const t of transitions) {
    const date = dateKey(t.occurredOn);
    if (!date) continue;
    const key = `${t.kind}:${date}`;
    const inferred = t.kind === 'end' && t.producer === 'dream';
    const seen = byKey.get(key);
    if (seen) seen.inferred &&= inferred;
    else byKey.set(key, { kind: t.kind, date, inferred });
  }
  return [...byKey.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === 'end' ? -1 : 1);
}

/**
 * Drops an inferred end when an explicit end closes the same stint: the explicit date is when it ended, the inferred
 * one only bounds it. Stints are assigned in replay order (an end sorts before a start on the same day, so a same-day
 * end and rejoin end the old stint): an end belongs to the stint the last start before it opened, or to the implicit
 * stint before the first start.
 */
function withoutOverriddenInferredEnds(events: StateEvent[]): StateEvent[] {
  const stintOf = new Map<StateEvent, number>();
  let stint = 0;
  for (const e of events) {
    if (e.kind === 'start') stint++;
    else stintOf.set(e, stint);
  }
  const explicit = new Set([...stintOf].filter(([e]) => !e.inferred).map(([, s]) => s));
  return events.filter(e => !(e.kind === 'end' && e.inferred && explicit.has(stintOf.get(e)!)));
}

/** Merge touching/overlapping stints and drop empty ones (until <= from). */
function mergeStints(stints: Stint[]): Stint[] {
  const valid = stints.filter(s => !(s.from && s.until && s.until <= s.from));
  const sorted = [...valid].sort((a, b) => (a.from ?? '') < (b.from ?? '') ? -1 : (a.from ?? '') > (b.from ?? '') ? 1 : 0);
  const out: Stint[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && (prev.until === null || (s.from !== null && prev.until >= s.from))) {
      if (prev.until !== null && (s.until === null || s.until > prev.until)) prev.until = s.until;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

export function stintCovers(s: Stint, date: string): boolean {
  return (s.from === null || s.from <= date) && (s.until === null || date < s.until);
}

/** Status of a relationship at `date` (default today, UTC). */
export function statusAt(state: Pick<RelationshipState, 'semantics' | 'stints' | 'disputed' | 'undatedPast'>, date: string = utcToday()): RelationshipStatus {
  if (state.stints.some(s => stintCovers(s, date))) {
    if (state.semantics === 'event') return 'event';
    return state.disputed ? 'disputed' : 'live';
  }
  if (state.stints.length === 0) return state.semantics === 'event' ? 'not_started' : 'ended_unknown_date';
  if (state.stints.every(s => s.from !== null && s.from > date)) return 'not_started';
  return 'ended';
}

// ─── Multirange text form ────────────────────────────────────────────────

/** Postgres datemultirange literal: '{[2021-04-01,2025-03-01),[2026-01-01,)}', '{}' when empty. */
export function stintsToMultirange(stints: readonly Stint[]): string {
  return `{${stints.map(s => `${s.from === null ? '(' : '['}${s.from ?? ''},${s.until ?? ''})`).join(',')}}`;
}

/** Parse a datemultirange text value back into stints (both engines return the canonical text form). */
export function parseMultirange(text: unknown): Stint[] {
  if (typeof text !== 'string') return [];
  const out: Stint[] = [];
  for (const m of text.matchAll(/([[(])([^,\])]*),([^,\])]*)([\])])/g)) {
    let from: string | null = m[2] ? m[2].replace(/"/g, '') : null;
    let until: string | null = m[3] ? m[3].replace(/"/g, '') : null;
    if (from === '-infinity') from = null;
    if (until === 'infinity') until = null;
    out.push({ from, until });
  }
  return out;
}

// ─── Contradiction closing (pure date arithmetic) ────────────────────────

export interface ContradictionSide {
  /** Relationship-specific dated start (latest), or null when unknown. */
  lastStart: string | null;
  stints: readonly Stint[];
  /** When the brain first recorded this relationship. */
  recordedAt: string | Date | null;
}

export type ContradictionOutcome =
  | { action: 'close'; side: 'a' | 'b'; closeDate: string; bornClosed: boolean }
  | { action: 'none'; reason: 'undated_unresolved' | 'ambiguous_same_date' | 'already_disjoint' };

/**
 * Given two state relationships that cannot both hold, end the one that
 * started earlier at the date the other started. Dates come only from each
 * relationship's own dated start; page dates and ingestion time never count.
 * The arithmetic is symmetric in valid time, so arrival order cannot change
 * the result; `bornClosed` labels the case where the relationship being ended
 * is the one recorded later (out-of-order arrival).
 */
export function closeContradiction(a: ContradictionSide, b: ContradictionSide): ContradictionOutcome {
  const da = dateKey(a.lastStart);
  const db = dateKey(b.lastStart);
  if (!da || !db) return { action: 'none', reason: 'undated_unresolved' };
  if (da === db) return { action: 'none', reason: 'ambiguous_same_date' };
  const [older, newer, olderSide] = da < db ? [a, db, 'a' as const] : [b, da, 'b' as const];
  const olderCurrent = older.stints[older.stints.length - 1];
  if (!olderCurrent || (olderCurrent.until !== null && olderCurrent.until <= newer)) {
    return { action: 'none', reason: 'already_disjoint' };
  }
  const recordedOlder = recordedMs(older.recordedAt);
  const recordedNewer = recordedMs((olderSide === 'a' ? b : a).recordedAt);
  return { action: 'close', side: olderSide, closeDate: newer, bornClosed: recordedOlder > recordedNewer };
}

function recordedMs(v: string | Date | null): number {
  if (v == null) return 0;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

// ─── SQL ─────────────────────────────────────────────────────────────────

/** Link reads that may apply a temporal edge policy. `temporal` absent = every edge, unannotated (reference consumers). */
export interface LinkReadScope extends PageReadScope {
  temporal?: EdgeTemporalOpts;
  /** Opt-in keyset page (get_links / get_backlinks ops); unset reads every row, as internal callers need. */
  page?: LinkReadPage;
}

/**
 * A keyset page of `getLinks` / `getBacklinks` rows in `links.id` order. Each
 * row then carries `link_id` (the keyset). Every filter runs in SQL so a LIMIT
 * counts only rows the caller can be shown.
 */
export interface LinkReadPage {
  /** Only rows with links.id above this. */
  afterId?: number;
  /** Only rows with links.id at or below this. */
  throughId?: number;
  limit?: number;
  linkType?: string;
  /** Only rows whose from page has `type` (stored, `untyped` for none, or a stored alias `aliases[i]` that source `aliasSources[i]` maps to it). */
  fromType?: { type: string; aliasSources: string[]; aliases: string[] };
  /** Keep the rows that match the temporal policy, or only the rows it hides. */
  relationship?: { policy: EdgeTemporalOpts; keep: 'match' | 'hidden' };
  /** Context longer than this is cut, ending in an ellipsis. */
  contextChars?: number;
}

export interface EdgeTemporalOpts {
  /** live (default), ended, or all. */
  status?: EdgeStatusFilter;
  /** Valid-time reference day, YYYY-MM-DD; default today (UTC). */
  asOf?: string;
  /** Overlap window [from, until) — "during 2022" is ['2022-01-01','2023-01-01']. */
  during?: { from: string; until: string };
  /** Exclude evidence from private origins (remote callers). */
  excludePrivate?: boolean;
  /** Read policy off (graph.edge_validity=off): no filtering. */
  disabled?: boolean;
}

/** SQL literal for a validated YYYY-MM-DD date (never user free text). */
function dateLiteral(date: string): string {
  if (!isCalendarDate(date)) throw new TypeError(`temporal edge filter: invalid date ${JSON.stringify(date)}`);
  return `DATE '${date}'`;
}

/**
 * WHERE-clause fragment for a `links` row alias. Returns `TRUE` when no
 * filtering applies. Dates are validated and inlined as literals so the
 * fragment composes into statements with any parameter numbering.
 *
 * A row passes when its relationship has no state row (reference type, or not
 * yet refreshed), its type is liveness-exempt (outside `ended` reads), or its
 * state row matches the requested status.
 */
export function relationshipFilterSql(linkAlias: string, opts: EdgeTemporalOpts = {}): string {
  const status = opts.status ?? 'live';
  if (opts.disabled || (status === 'all' && !opts.during)) return 'TRUE';
  const scope = opts.excludePrivate ? 'world' : 'all';
  const day = opts.asOf ? dateLiteral(opts.asOf) : `(now() AT TIME ZONE 'UTC')::date`;
  const probe = `lr.from_page_id = ${linkAlias}.from_page_id AND lr.to_page_id = ${linkAlias}.to_page_id
      AND lr.link_type = ${linkAlias}.link_type AND lr.scope = '${scope}'`;
  if (opts.during) {
    const range = `daterange(${dateLiteral(opts.during.from)}, ${dateLiteral(opts.during.until)})`;
    return `NOT EXISTS (SELECT 1 FROM link_relationships lr WHERE ${probe} AND ${livenessExemptSql} AND NOT (lr.valid_ranges && ${range}))`;
  }
  if (status === 'ended') {
    return `EXISTS (SELECT 1 FROM link_relationships lr WHERE ${probe} AND lr.semantics = 'state'
      AND NOT (lr.valid_ranges @> ${day}) AND (lr.first_start IS NULL OR lr.first_start <= ${day}))`;
  }
  const disputedClause = opts.asOf ? ' OR lr.disputed' : '';
  return `NOT EXISTS (SELECT 1 FROM link_relationships lr WHERE ${probe} AND ${livenessExemptSql} AND (NOT (lr.valid_ranges @> ${day})${disputedClause}))`;
}

/** Validate op-level temporal params; returns normalized opts or an error message. */
export function parseTemporalParams(p: { status?: unknown; as_of?: unknown; during?: unknown }):
  { ok: true; opts: EdgeTemporalOpts } | { ok: false; param: string; message: string } {
  const opts: EdgeTemporalOpts = {};
  if (p.status !== undefined) {
    if (p.status !== 'live' && p.status !== 'ended' && p.status !== 'all') {
      return { ok: false, param: 'status', message: `status must be one of live, ended, all (got ${JSON.stringify(p.status)})` };
    }
    opts.status = p.status;
  }
  if (p.as_of !== undefined) {
    if (!isCalendarDate(p.as_of)) return { ok: false, param: 'as_of', message: `as_of must be a calendar date YYYY-MM-DD (got ${JSON.stringify(p.as_of)})` };
    opts.asOf = p.as_of;
  }
  if (p.during !== undefined) {
    const during = parseDuring(p.during);
    if (!during) return { ok: false, param: 'during', message: `during must be YYYY, YYYY-MM, YYYY-MM-DD or FROM..UNTIL of those (got ${JSON.stringify(p.during)})` };
    opts.during = during;
  }
  return { ok: true, opts };
}

/**
 * "2022" → [2022-01-01, 2023-01-01); "2022-03" → that month; "2022-03-04" →
 * that day; "2021..2023-06" → [2021-01-01, 2023-07-01) (the end is inclusive
 * of its own period).
 */
export function parseDuring(raw: unknown): { from: string; until: string } | null {
  if (typeof raw !== 'string') return null;
  const [a, b] = raw.split('..');
  const start = normalizePartialDate(a);
  const endBase = normalizePartialDate(b ?? a);
  if (!start || !endBase) return null;
  const until = periodEnd(endBase.date, endBase.precision);
  return until > start.date ? { from: start.date, until } : null;
}

function periodEnd(date: string, precision: DatePrecision): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = precision === 'year' ? new Date(Date.UTC(y + 1, 0, 1))
    : precision === 'month' ? new Date(Date.UTC(y, m, 1))
      : new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

// ─── Row annotation (bounded per-page reads: get_links / get_backlinks / entity cards) ──

export type EdgeRowStatus = RelationshipStatus | 'reference';

/** Annotation fields added to link rows when a temporal read is requested. */
export interface TemporalAnnotation {
  status: EdgeRowStatus;
  /** Stints [from, until) when the relationship has temporal state. */
  stints?: Stint[];
  /** When the brain first recorded evidence for the relationship. */
  recorded_at?: string | null;
  /** When the brain recorded that the relationship ended. */
  retired_at?: string | null;
}

/** LEFT JOIN of a links alias onto its relationship state row for the read scope. */
export function temporalLinkJoinSql(linkAlias: string, excludePrivate?: boolean): string {
  return `LEFT JOIN link_relationships lr_t ON lr_t.from_page_id = ${linkAlias}.from_page_id
      AND lr_t.to_page_id = ${linkAlias}.to_page_id AND lr_t.link_type = ${linkAlias}.link_type
      AND lr_t.scope = '${excludePrivate ? 'world' : 'all'}'`;
}

export const TEMPORAL_LINK_SELECT_SQL = `, lr_t.valid_ranges::text AS temporal_ranges, lr_t.semantics AS temporal_semantics,
      lr_t.disputed AS temporal_disputed, lr_t.undated_past AS temporal_undated_past, lr_t.first_start::text AS temporal_first_start,
      lr_t.recorded_at AS temporal_recorded_at, lr_t.retired_at AS temporal_retired_at`;

const TEMPORAL_COLUMNS = ['temporal_ranges', 'temporal_semantics', 'temporal_disputed', 'temporal_undated_past',
  'temporal_first_start', 'temporal_recorded_at', 'temporal_retired_at'] as const;

const iso = (v: unknown): string | null => v == null ? null : v instanceof Date ? v.toISOString() : String(v);

/** Replace the temporal_* columns of a row with its annotation (status at `asOf`, default today UTC). */
export function annotateTemporalRow<T extends { link_type: string }>(row: T, asOf?: string): T & TemporalAnnotation & { first_start?: string | null } {
  const r = row as unknown as Record<string, unknown>;
  const ranges = r.temporal_ranges;
  const semantics = r.temporal_semantics as 'state' | 'event' | null | undefined;
  const out = { ...row } as T & TemporalAnnotation & { first_start?: string | null };
  for (const c of TEMPORAL_COLUMNS) delete (out as unknown as Record<string, unknown>)[c];
  if (ranges == null || !semantics) {
    return Object.assign(out, { status: relationSemantics(row.link_type) === 'reference' ? 'reference' as const : 'live' as const });
  }
  const stints = parseMultirange(ranges);
  const status = statusAt({ semantics, stints, disputed: r.temporal_disputed === true, undatedPast: Number(r.temporal_undated_past ?? 0) }, asOf);
  return Object.assign(out, {
    status, stints,
    recorded_at: iso(r.temporal_recorded_at), retired_at: iso(r.temporal_retired_at),
    first_start: r.temporal_first_start == null ? null : String(r.temporal_first_start).slice(0, 10),
  });
}

/**
 * Same semantics as `relationshipFilterSql`, applied to an annotated row.
 * Used where the read is bounded (one page's edges) so callers can also count
 * what they hid.
 */
export function edgeMatchesTemporal(row: TemporalAnnotation & { first_start?: string | null; link_type?: string }, opts: EdgeTemporalOpts = {}): boolean {
  const status = opts.status ?? 'live';
  if (opts.disabled) return true;
  if (row.status === 'reference') return status !== 'ended';
  if (row.link_type && LIVENESS_EXEMPT_LINK_TYPES.includes(row.link_type) && status !== 'ended') return true;
  if (opts.during) {
    if (!row.stints) return true;
    return row.stints.some(s => (s.from === null || s.from < opts.during!.until) && (s.until === null || s.until > opts.during!.from));
  }
  if (status === 'all') return true;
  if (status === 'ended') {
    const day = opts.asOf ?? utcToday();
    return (row.status === 'ended' || row.status === 'ended_unknown_date') && (row.first_start == null || row.first_start <= day);
  }
  if (row.status === 'disputed') return !opts.asOf;
  return row.status === 'live' || row.status === 'event';
}

const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled']);

/** `graph.edge_validity` read policy: on unless explicitly turned off; fail-open to on. */
export async function edgeValidityEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const value = await engine.getConfig('graph.edge_validity');
    return !(typeof value === 'string' && OFF_VALUES.has(value.trim().toLowerCase()));
  } catch {
    return true;
  }
}

/**
 * Status a relational question asks about: "former employees of X" → ended;
 * "who worked at X" / "used to" → all (history); present tense → live.
 */
export function relationQueryStatus(query: string): EdgeStatusFilter {
  if (/\b(?:former|ex-|previous(?:ly)?|past|old)\b/i.test(query) && !/\b(?:current(?:ly)?|now)\b/i.test(query)) return 'ended';
  if (/\b(?:worked|used\s+to|did\s+\S+\s+work|was\s+(?:an?\s+)?(?:employee|advisor|partner)|have\s+(?:ever\s+)?worked|ever)\b/i.test(query)) return 'all';
  return 'live';
}

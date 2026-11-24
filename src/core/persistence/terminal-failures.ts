/**
 * #6650 (L3): the reader behind the writer's terminal-state visibility. Two reads over `persistence_requests`, both
 * bounded (a statement deadline and a connection-acquisition deadline; a read that hits either reports `unknown`, never
 * an empty pile):
 *
 * - `readTerminalFailureSummary`: ONE set-based aggregate over the terminal receipts that did not commit (failed,
 *   conflict, cancelled) in the window, plus every receipt that still holds a publication recovery record, grouped on
 *   the columns `classifyTerminal` reads. It reports active blockers (recovery records, which hold their root as the
 *   head blocker's `request_recovery`, plus PR A's `checkpoint_blockers` when the caller passes them), distinct
 *   unresolved slugs and intents, the oldest unresolved age, historical non-blocking rows, the attempts of the last
 *   24 h and the zero-filled daily counts of the 7 days before them (the spike check). "Resolved" means
 *   `supersessionSql` found a later request that made the row moot; "historical" means resolved, or written by a build
 *   older than the release that fixed its class (`TERMINAL_FIXED_IN`). Archived sources are skipped.
 * - `readTerminalFailures`: the drill-down for one source, rows newest first by `sequence` with a `before` cursor, or
 *   groups on code + origin + category with each group's exact filter, its drill-down command and inspect actions
 *   for a few samples. A page that fills (or a scan that reaches its bound) returns `truncated: true` with the next
 *   command instead of refusing.
 *
 * Neither read uses `persistence_requests_compactable`: that partial index excludes recovery-holding and compacted
 * receipts, both of which this reader must see. The window is clamped to `persistence.receipt_retention_days`: past
 * it a receipt's message is gone and the message-routed codes would read as `diagnosis_required`.
 *
 * The statements run through the engine's typed members (`src/core/engine-sql/doctor-terminal.ts` on PGLite and
 * Postgres, the request-journal port in the store on Rust); this file keeps the classifier fragments they splice
 * (`TERMINAL_SQL_PARTS`, pinned by `test/doctor-terminal-sql.test.ts`), the bounds and the shaping.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { isStatementTimeout } from './bounded-reads.ts';
import { readSchemaBehind } from './schema-admission.ts';
import { readReceiptRetentionDays, DEFAULT_RECEIPT_RETENTION_DAYS } from './limits.ts';
import { MANAGED_SYNC_PASS_OP } from './sync-pass-row.ts';
import { SYNC_PASS_SUPERSEDED } from './sync-checkpoint-replaced.ts';
import type { PublicCategory } from './public-category.ts';
import { GRANDFATHER_RETIRED } from './publication-failure.ts';
import { classifyTerminal, dispositionOf, driftSinceAction, faultOperation, TERMINAL_FIXED_IN, supersessionOrderSql, supersessionSql, terminalInspectArgv, terminalKnockOnSql, type TerminalCategory,
  type TerminalDisposition, type TerminalVerdict, CONNECTION_MESSAGE_PATTERN, LEGACY_PUBLICATION_PREFIX } from './terminal-classify.ts';
import { readConfigRows, type ConfigReader } from '../config-values.ts';
import type { TerminalReadOpts } from '../engine-sql/doctor-terminal.ts';

export const TERMINAL_WINDOW_KEY = 'persistence.terminal_failures.window_days';
export const TERMINAL_SPIKE_FACTOR_KEY = 'persistence.terminal_failures.spike_factor';
export const TERMINAL_SPIKE_MIN_KEY = 'persistence.terminal_failures.spike_min';
export const TERMINAL_CONFIG_KEYS = [TERMINAL_WINDOW_KEY, TERMINAL_SPIKE_FACTOR_KEY, TERMINAL_SPIKE_MIN_KEY] as const;
export const TERMINAL_DEFAULTS = { windowDays: 7, spikeFactor: 3, spikeMin: 25 } as const;
/** Server-side bound of each read, and how long it may wait for a pooled connection on top. */
export const TERMINAL_STATEMENT_MS = 5_000;
export const TERMINAL_ACQUIRE_MS = 2_000;

export interface TerminalThresholds { windowDays: number; spikeFactor: number; spikeMin: number; retentionDays: number; clamped: boolean }

/** `gbrain config set` validation for the three keys: a positive number (whole days for the window). */
export function validateTerminalConfigValue(key: string, value: string): string | null {
  if (!(TERMINAL_CONFIG_KEYS as readonly string[]).includes(key)) return null;
  const n = Number(value);
  const ok = key === TERMINAL_WINDOW_KEY ? Number.isInteger(n) && n >= 1 && n <= 3650 : Number.isFinite(n) && n > 0 && n <= 1_000_000;
  return ok ? null : `${key} must be ${key === TERMINAL_WINDOW_KEY ? 'a whole number of days from 1 to 3650' : 'a positive number'}; got ${JSON.stringify(value)}.`;
}

export async function readTerminalThresholds(engine: ConfigReader, requestedDays?: number): Promise<TerminalThresholds> {
  const rows = await readConfigRows(engine, TERMINAL_CONFIG_KEYS);
  const read = (key: string, fallback: number) => {
    const raw = rows.find(row => row.key === key)?.value;
    return raw !== undefined && validateTerminalConfigValue(key, raw) === null ? Number(raw) : fallback;
  };
  const retentionDays = Math.max(1, Math.floor(await readReceiptRetentionDays(engine as BrainEngine).catch(() => DEFAULT_RECEIPT_RETENTION_DAYS)));
  const wanted = requestedDays ?? read(TERMINAL_WINDOW_KEY, TERMINAL_DEFAULTS.windowDays);
  return { windowDays: Math.min(wanted, retentionDays), spikeFactor: read(TERMINAL_SPIKE_FACTOR_KEY, TERMINAL_DEFAULTS.spikeFactor),
    spikeMin: read(TERMINAL_SPIKE_MIN_KEY, TERMINAL_DEFAULTS.spikeMin), retentionDays, clamped: wanted > retentionDays };
}

/** The receipt columns every read selects, with the knock-on, routed-message and build columns computed once in SQL. */
const ROUTED_MESSAGE = (r: string) => `CASE
    WHEN ${r}.error_code='source_changed' AND ${r}.error_detail->>'reason' IS NULL THEN left(${r}.error_message, 500)
    WHEN ${r}.error_code IN ('storage_error','writer_coordinator_required') AND ${r}.error_detail IS NULL AND ${r}.error_message LIKE '${LEGACY_PUBLICATION_PREFIX}%' THEN '${LEGACY_PUBLICATION_PREFIX}'
    WHEN ${r}.error_code='storage_error' AND ${r}.error_message ~* '${CONNECTION_MESSAGE_PATTERN}' THEN 'connection closed' END`;
/** A version column older than `fixed` (both MAJOR.MINOR.PATCH[.MICRO]); NULL-safe (an unknown build is not older). */
const OLDER_THAN = (column: string, fixed: string) => `COALESCE(${column} ~ '^\\d+\\.\\d+\\.\\d+(\\.\\d+)?$' AND string_to_array(${column} || CASE WHEN ${column} ~ '^\\d+\\.\\d+\\.\\d+$' THEN '.0' ELSE '' END, '.')::int[] < '{${fixed.split('.').concat(fixed.split('.').length === 3 ? ['0'] : []).join(',')}}'::int[], false)`;
/**
 * The SQL twin of `TerminalVerdict.historical` for the categories `TERMINAL_FIXED_IN` names, over the base CTE's columns,
 * so distinct counts leave history out. The classifier stays the authority for every per-group count; a test pins the twin.
 */
export const TERMINAL_HISTORICAL_SQL: Readonly<Record<keyof typeof TERMINAL_FIXED_IN, (b: string) => string>> = {
  knock_on: b => `(${b}.knock_on AND NOT ${b}.has_recovery AND ${OLDER_THAN(`${b}.build`, TERMINAL_FIXED_IN.knock_on)})`,
  legacy_publication_refusal: b => `(NOT ${b}.has_recovery AND NOT ${b}.knock_on AND ${b}.routed_message = '${LEGACY_PUBLICATION_PREFIX}' AND ${b}.origin IS NULL AND ${b}.error_code IN ('storage_error','writer_coordinator_required'))`,
  fence_unrenderable: b => `(NOT ${b}.has_recovery AND NOT ${b}.knock_on AND ${b}.origin IS NULL AND ${b}.error_code = 'fence_unrenderable' AND ${OLDER_THAN(`${b}.build`, TERMINAL_FIXED_IN.fence_unrenderable)})`,
  retired_operation: b => `(NOT ${b}.has_recovery AND NOT ${b}.knock_on AND ${b}.error_code = 'revision_conflict' AND (${b}.origin IS NOT DISTINCT FROM '${GRANDFATHER_RETIRED}' OR ${b}.intent_kind IS NOT DISTINCT FROM 'managed_grandfather'))`,
};
const HISTORICAL_BY_BUILD = (b: string) => `COALESCE(${Object.values(TERMINAL_HISTORICAL_SQL).map(sql => sql(b)).join(' OR ')}, false)`;
const BUILD = (r: string) => `COALESCE(${r}.error_detail->'attempt'->>'consumer_version', ${r}.admitter_version)`;
const ENDED = (r: string) => `COALESCE(${r}.completed_at, ${r}.updated_at)`;
const TERMINAL = (r: string) => `${r}.state IN ('failed','conflict','cancelled')`;
/** A request holding a publication recovery record outside an in-flight claim: it blocks its root. `recovering` is the durable parked state (a blocked restore). */
/** #6904: the grouped `reason`, with an older build's owner exception on a missing relation or column (its errno) read as `schema_missing`, as `classifyTerminal` reads the full detail. */
const SCHEMA_AWARE_REASON = (r: string) => `COALESCE(${r}.error_detail->>'reason', CASE WHEN ${r}.error_detail->>'origin'='owner_exception' AND ${r}.error_detail->>'errno' IN ('42P01','42703') THEN 'schema_missing' END)`;
const RECOVERY = (r: string) => `(${r}.recovery IS NOT NULL AND ${r}.state IN ('committed','recovering','failed','conflict','cancelled'))`;
/** The SQL builders the two terminal statements (engine-sql/doctor-terminal.ts) were composed from; test/doctor-terminal-sql.test.ts composes them again to pin the statements' text. */
export const TERMINAL_SQL_PARTS = { ROUTED_MESSAGE, BUILD, ENDED, TERMINAL, RECOVERY, SCHEMA_AWARE_REASON, HISTORICAL_BY_BUILD, terminalKnockOnSql, supersessionSql, supersessionOrderSql } as const;

interface KeyColumns { source_id: string; state: string; error_code: string | null; origin: string | null; reason: string | null; cause: string | null; operation: string; intent_kind?: string | null;
  has_recovery: boolean; blocked_reason: string | null; compacted: boolean; knock_on: boolean; routed_message: string | null; build: string | null }

function verdictOf(row: KeyColumns & { request_id?: string; slug?: string; error_detail?: Record<string, unknown> | null }, schemaBehind: boolean | null = null): TerminalVerdict {
  const detail = row.error_detail ?? (row.origin || row.reason || row.cause ? { ...(row.origin ? { origin: row.origin } : {}), ...(row.reason ? { reason: row.reason } : {}),
    ...(row.cause ? { cause: row.cause } : {}) } : null);
  return classifyTerminal({ request_id: row.request_id, source_id: row.source_id, slug: row.slug ?? '<slug>', operation: row.operation, state: row.state, error_code: row.error_code,
    error_detail: detail, recovery: row.has_recovery || null, blocked_reason: row.blocked_reason, compacted: row.compacted, knock_on: row.knock_on,
    error_message: row.routed_message, build: row.build, intent_kind: row.intent_kind ?? null, schema_behind: schemaBehind })!;
}

async function bounded<T>(read: (opts: TerminalReadOpts) => Promise<T>): Promise<T | 'unknown'> {
  try {
    return await read({ timeoutMs: TERMINAL_STATEMENT_MS, signal: AbortSignal.timeout(TERMINAL_STATEMENT_MS + TERMINAL_ACQUIRE_MS) });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (isStatementTimeout(error) || name === 'AbortError' || name === 'TimeoutError' || (error as { code?: string })?.code === 'pool_capacity') return 'unknown';
    throw error;
  }
}

export interface TerminalBlocker { kind: 'recovery' | 'checkpoint'; source_id: string; request_id: string; slug?: string; category: TerminalCategory | 'checkpoint_blocker'; action: Action; human_reason?: string; needs_human: boolean }
export interface TerminalSourceSummary {
  source_id: string;
  active_blockers: TerminalBlocker[];
  unresolved: { rows: number; distinct_slugs: number; distinct_intents: number; oldest_at: string | null; oldest_age_seconds: number | null };
  historical_rows: number;
  new_last_24h: number;
  /** Of `new_last_24h`, the receipts a build older than its class's fixing release wrote (`TERMINAL_FIXED_IN`), by build. */
  new_last_24h_older_builds: { rows: number; builds: string[] };
  daily_7d: number[];
  defects: Array<{ category: TerminalCategory; code: string; origin: string | null; rows: number; human_reason?: string; action: Action }>;
  categories: Array<{ category: TerminalCategory; public_category: PublicCategory; code: string; origin: string | null; rows: number; unresolved: number; historical: number; class: string; needs_human: boolean }>;
}
export type TerminalSummary = { status: 'ok'; window_days: number; window_clamped: boolean; retention_days: number; sources: TerminalSourceSummary[] } | { status: 'unknown'; window_days: number; reason: string };

/**
 * The one aggregate. `sourceIds` narrows it (a remote scope or one source); otherwise every non-archived source.
 * `checkpointBlockers` are PR A's `checkpoint_blockers` per source (the caller read them; this module never recomputes them).
 */
export async function readTerminalFailureSummary(engine: BrainEngine, opts: { sourceIds?: string[]; thresholds?: TerminalThresholds;
  checkpointBlockers?: Map<string, Array<{ request_id: string; slug: string; knock_on: boolean; recovery: boolean }>> } = {}): Promise<TerminalSummary> {
  const t = opts.thresholds ?? await readTerminalThresholds(engine);
  const schemaBehind = await readSchemaBehind(engine);
  const span = Math.max(t.windowDays, 8);
  const sourceFilter = opts.sourceIds ?? null;
  // The order is not output: the sources are sorted in JS below, and rows of one source tie, so the SQL order never reaches the result.
  const rows = await bounded(opts => engine.readTerminalFailureGroups({ spanDays: span, windowDays: t.windowDays, sourceIds: sourceFilter }, opts));
  if (rows === 'unknown') return { status: 'unknown', window_days: t.windowDays, reason: `the aggregate did not finish within ${TERMINAL_STATEMENT_MS} ms (or no connection within ${TERMINAL_ACQUIRE_MS} ms)` };
  const bySource = new Map<string, TerminalSourceSummary>();
  const summaryOf = (sourceId: string) => {
    let s = bySource.get(sourceId);
    if (!s) bySource.set(sourceId, s = { source_id: sourceId, active_blockers: [], unresolved: { rows: 0, distinct_slugs: 0, distinct_intents: 0, oldest_at: null, oldest_age_seconds: null },
      historical_rows: 0, new_last_24h: 0, new_last_24h_older_builds: { rows: 0, builds: [] }, daily_7d: [0, 0, 0, 0, 0, 0, 0], defects: [], categories: [] });
    return s;
  };
  // Per-group oldest unresolved: the GROUPING SETS total row's oldest covers every row, so the unresolved one is taken from groups.
  for (const row of rows) {
    const s = summaryOf(row.source_id);
    if (Number(row.set) === 1) {
      s.unresolved.distinct_slugs = Number(row.distinct_slugs); s.unresolved.distinct_intents = Number(row.distinct_intents);
      s.new_last_24h = Number(row.n_24h);
      s.daily_7d = [row.d2, row.d3, row.d4, row.d5, row.d6, row.d7, row.d8].map(n => Number(n ?? 0));
      continue;
    }
    const verdict = verdictOf(row, schemaBehind);
    const n = Number(row.rows);
    if (verdict.historical && Number(row.n_24h) > 0) {
      s.new_last_24h_older_builds.rows += Number(row.n_24h);
      if (row.build && !s.new_last_24h_older_builds.builds.includes(row.build)) s.new_last_24h_older_builds.builds.push(row.build);
    }
    if (row.has_recovery) {
      (row.recovery_ids ?? []).forEach((id, i) => {
        const v = verdictOf({ ...row, request_id: id, slug: row.recovery_slugs?.[i] }, schemaBehind);
        s.active_blockers.push({ kind: 'recovery', source_id: row.source_id, request_id: id, slug: row.recovery_slugs?.[i], category: v.category, action: v.action,
          needs_human: v.needs_human, ...(v.human_reason ? { human_reason: v.human_reason } : {}) });
      });
    }
    if (!n) continue;
    const historical = !row.has_recovery && (row.resolved === true || verdict.historical);
    const unresolved = !row.has_recovery && !historical;
    if (historical) s.historical_rows += n;
    if (unresolved) {
      s.unresolved.rows += n;
      const age = row.oldest_age === null ? null : Number(row.oldest_age);
      if (age !== null && (s.unresolved.oldest_age_seconds === null || age > s.unresolved.oldest_age_seconds)) { s.unresolved.oldest_age_seconds = age; s.unresolved.oldest_at = row.oldest; }
      if (verdict.defect) {
        const existing = s.defects.find(d => d.category === verdict.category && d.code === verdict.code && d.origin === verdict.origin);
        if (existing) existing.rows += n;
        else s.defects.push({ category: verdict.category, code: verdict.code, origin: verdict.origin, rows: n, ...(verdict.human_reason ? { human_reason: verdict.human_reason } : {}), action: verdict.action });
      }
    }
    const cat = s.categories.find(c => c.category === verdict.category && c.code === verdict.code && c.origin === verdict.origin);
    if (cat) { cat.rows += n; cat.unresolved += unresolved ? n : 0; cat.historical += historical ? n : 0; }
    else s.categories.push({ category: verdict.category, public_category: verdict.public_category, code: verdict.code, origin: verdict.origin, rows: n, unresolved: unresolved ? n : 0, historical: historical ? n : 0,
      class: verdict.class, needs_human: verdict.needs_human });
  }
  for (const [sourceId, blockers] of opts.checkpointBlockers ?? []) {
    const live = blockers.filter(b => !b.knock_on && !b.recovery);
    if (!live.length) continue;
    const s = summaryOf(sourceId);
    for (const b of live) s.active_blockers.push({ kind: 'checkpoint', source_id: sourceId, request_id: b.request_id, slug: b.slug, category: 'checkpoint_blocker', needs_human: false,
      action: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: `Receipt ${b.request_id} (${b.slug}) blocks the sync checkpoint of source ${sourceId}; sync status names the next step, read-only.`, verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] } } });
  }
  for (const s of bySource.values()) s.categories.sort((a, b) => b.rows - a.rows || a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
  return { status: 'ok', window_days: t.windowDays, window_clamped: t.clamped, retention_days: t.retentionDays,
    sources: [...bySource.values()].sort((a, b) => a.source_id.localeCompare(b.source_id)) };
}

/**
 * PR A's checkpoint blockers for every non-archived source whose managed-sync cursor waits at its checkpoint step
 * (the others have none), keyed by source, for `readTerminalFailureSummary`.
 * #6712 PR 4b (design v3.2 §3.7): also every source whose open pass (pass row `telemetry.outcome = 'open'`) has its
 * `managed_sync_checkpoint` admitted and not yet committed (`intent.passId` equal to the row's `pass_id`). Its blockers
 * are what the pass checkpoint's validation refuses on (design v3 §3.3 clauses 1-2): a recovery row on the worktree, and
 * a queued, running or recovering sync page or checkpoint request of the worktree other than the checkpoint itself.
 * Both reads go through the partial indexes `persistence_requests_recovery` and `persistence_requests_pending`.
 */
export async function readCheckpointBlockerMap(engine: BrainEngine, sourceIds?: string[]): Promise<NonNullable<Parameters<typeof readTerminalFailureSummary>[1]>['checkpointBlockers'] & {}> {
  const { readCheckpointBlockers } = await import('./sync-status.ts');
  const atCheckpoint = (await engine.listCheckpointBlockedSources(sourceIds)).map(source_id => ({ source_id }));
  const blockers = new Map<string, Awaited<ReturnType<typeof readCheckpointBlockers>>>();
  for (const row of atCheckpoint) blockers.set(row.source_id, await readCheckpointBlockers(engine, row.source_id));
  const passes = await engine.listOpenPassCheckpointBlockers(MANAGED_SYNC_PASS_OP, sourceIds ?? null);
  for (const pass of passes) {
    if (blockers.has(pass.source_id)) continue;
    const rows = await engine.listWorktreeBlockerRequests(pass.worktree_id, pass.checkpoint);
    blockers.set(pass.source_id, rows.slice(0, 20).map(row => ({ request_id: row.request_id, slug: row.slug, state: row.state, code: row.code, index: null, recovery: row.recovery === true, knock_on: false })));
  }
  return blockers;
}

/** The zero-filled median of the 7 days before the last 24 h. */
export function sevenDayMedian(daily: number[]): number {
  const sorted = [...daily, ...Array(Math.max(0, 7 - daily.length)).fill(0)].slice(0, 7).sort((a, b) => a - b);
  return sorted[3]!;
}
export function isSpike(last24h: number, daily: number[], t: Pick<TerminalThresholds, 'spikeFactor' | 'spikeMin'>): boolean {
  return last24h >= t.spikeMin && last24h > t.spikeFactor * sevenDayMedian(daily);
}

export interface TerminalFailureQuery {
  sourceId: string;
  /** `unresolved` (default): rows that neither block, nor are resolved or historical. `all`: every terminal row in the window. */
  state?: 'unresolved' | 'all';
  groupBy?: 'category' | null;
  sinceDays?: number;
  limit?: number;
  /** The previous page's `next_cursor` (a request sequence). */
  before?: string;
  code?: string;
  origin?: string;
  category?: string;
  /** #7630: the receipt's operation, or a reconcile or managed put_page's intent kind (`faultOperation`); `--operation` narrows by it. */
  operation?: string;
}
export interface TerminalFailureRow {
  request_id: string; slug: string; operation: string; state: string; code: string; origin: string | null; category: TerminalCategory; public_category: PublicCategory;
  class: string; safe_actions: string[]; needs_human: boolean; human_reason?: string; disposition: TerminalDisposition; blocking: boolean; historical: boolean;
  compacted: boolean; ended_at: string; cursor: string; inspect: Action; fix: Action; root_request_id?: string;
}
export interface TerminalFailureGroup {
  code: string; origin: string | null; category: TerminalCategory; public_category: PublicCategory; rows: number; class: string; needs_human: boolean; human_reason?: string;
  /** #7630: a sync fault's fix depends on its operation (a sync retries submit_job; a caller resubmits its own write), so those groups split by it and drill down by it. */
  operation?: string;
  filter: { code: string; origin: string | null; category: TerminalCategory; operation?: string }; drill_down: string[]; fix: Action; samples: Array<Pick<TerminalFailureRow, 'request_id' | 'slug' | 'state' | 'ended_at' | 'inspect'>>;
}
export type TerminalFailureListing = {
  status: 'ok'; source_id: string; window_days: number; window_clamped: boolean; state: 'unresolved' | 'all'; group_by: 'category' | null;
  rows?: TerminalFailureRow[]; groups?: TerminalFailureGroup[]; truncated: boolean; next_cursor: string | null; next?: string[]; scanned: number;
} | { status: 'unknown'; source_id: string; reason: string };

const MAX_SCAN = 2_000;
const BATCH = 200;
/** How a null origin is written in a drill-down filter (`--origin none`). */
export const NO_ORIGIN = 'none';

export function terminalFailuresArgv(q: TerminalFailureQuery, extra: Record<string, string | null | undefined> = {}): string[] {
  const argv = ['gbrain', 'sources', 'writer', 'failures', q.sourceId];
  const flags: Record<string, string | null | undefined> = { state: q.state === 'all' ? 'all' : null, 'group-by': q.groupBy ?? null, since: q.sinceDays ? `${q.sinceDays}d` : null,
    category: q.category, code: q.code, origin: q.origin, operation: q.operation, limit: q.limit && q.limit !== 20 ? String(q.limit) : null, ...extra };
  for (const [flag, value] of Object.entries(flags)) if (value) argv.push(`--${flag}`, value);
  return [...argv, '--json'];
}

/**
 * The drill-down for one source. Rows are classified here, so the `code` / `origin` / `category` filters (the verdict's,
 * exactly as a group names them) are applied after the read, and one call scans at most `MAX_SCAN` receipts.
 */
export async function readTerminalFailures(engine: BrainEngine, q: TerminalFailureQuery): Promise<TerminalFailureListing> {
  const t = await readTerminalThresholds(engine, q.sinceDays);
  const schemaBehind = await readSchemaBehind(engine);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  const state = q.state ?? 'unresolved';
  const out: TerminalFailureRow[] = [];
  // #6712 PR 2: the oldest admission per drift group, so the group's file-drift fix selects every page in it with one concrete --since.
  const driftSince = new Map<string, string>();
  let cursor = q.before ?? null, scanned = 0, exhausted = false;
  const want = q.groupBy ? MAX_SCAN : limit + 1;
  while (out.length < want && scanned < MAX_SCAN && !exhausted) {
    const batch = await bounded(opts => engine.listTerminalFailureBatch({ sourceId: q.sourceId, windowDays: t.windowDays, before: cursor, limit: BATCH }, opts));
    if (batch === 'unknown') return { status: 'unknown', source_id: q.sourceId, reason: `the read did not finish within ${TERMINAL_STATEMENT_MS} ms (or no connection within ${TERMINAL_ACQUIRE_MS} ms)` };
    if (batch.length < BATCH) exhausted = true;
    for (const row of batch) {
      scanned++;
      cursor = row.sequence;
      const v = verdictOf(row, schemaBehind);
      // GBRA-133 PR 3a: a pass checkpoint whose pass ended is superseded by construction (the next pass stamps its own).
      const disposition = row.error_code === SYNC_PASS_SUPERSEDED ? 'superseded' : dispositionOf(row.later_state ? { state: row.later_state, same_intent: row.same_intent === true } : null);
      const historical = !row.has_recovery && (disposition !== 'unknown' || v.historical);
      const matches = (!q.category || v.category === q.category) && (!q.code || v.code === q.code)
        && (q.origin === undefined || (v.origin ?? NO_ORIGIN) === q.origin) && (!q.operation || faultOperation(row.operation, row.intent_kind) === q.operation) && (state === 'all' || !historical);
      if (matches) out.push({ request_id: row.request_id, slug: row.slug, operation: faultOperation(row.operation, row.intent_kind), state: row.state, code: v.code, origin: v.origin, category: v.category, public_category: v.public_category, class: v.class,
        safe_actions: v.safe_actions, needs_human: v.needs_human, ...(v.human_reason ? { human_reason: v.human_reason } : {}), disposition, blocking: row.has_recovery, historical,
        compacted: row.compacted, ended_at: row.ended_at, cursor: row.sequence, ...(v.root_request_id ? { root_request_id: v.root_request_id } : {}),
        inspect: { argv: terminalInspectArgv(row.request_id), consent: [], actor: 'agent', requires_exclusive: false, why: 'The receipt with its diagnosis and structured fix, read-only.' },
        fix: v.action });
      const driftKey = `${v.code}\0${v.origin ?? ''}\0${v.category}`;
      const seen = driftSince.get(driftKey);
      if (matches && v.category === 'file_conflict' && (!seen || row.admitted_at < seen)) driftSince.set(driftKey, row.admitted_at);
      if (out.length >= want || scanned >= MAX_SCAN) { exhausted = exhausted && row === batch.at(-1); break; }
    }
  }
  const window = { window_days: t.windowDays, window_clamped: t.clamped };
  if (!q.groupBy) {
    const page = out.slice(0, limit);
    // A page past `limit`, or a scan that stopped at its bound with receipts left, continues from the last row it covered.
    const resume = out.length > limit ? page.at(-1)!.cursor : !exhausted ? cursor : null;
    return { status: 'ok', source_id: q.sourceId, ...window, state, group_by: null, rows: page, scanned,
      truncated: resume !== null, next_cursor: resume, ...(resume !== null ? { next: terminalFailuresArgv(q, { before: resume }) } : {}) };
  }
  const groups = new Map<string, TerminalFailureGroup>();
  for (const row of out) {
    const operation = row.category === 'sync_fault' ? row.operation : undefined;
    const key = `${row.code}\0${row.origin ?? ''}\0${row.category}${operation === undefined ? '' : `\0${operation}`}`;
    let g = groups.get(key);
    if (!g) {
      const filter = { code: row.code, origin: row.origin, category: row.category, ...(operation ?? q.operation ? { operation: operation ?? q.operation } : {}) };
      groups.set(key, g = { code: row.code, origin: row.origin, category: row.category, ...(operation === undefined ? {} : { operation }), public_category: row.public_category, rows: 0, class: row.class, needs_human: row.needs_human,
        ...(row.human_reason ? { human_reason: row.human_reason } : {}), filter, fix: row.fix, samples: [],
        drill_down: terminalFailuresArgv({ sourceId: q.sourceId, state: q.state, sinceDays: q.sinceDays, category: row.category, code: row.code, origin: row.origin ?? NO_ORIGIN, operation: operation ?? q.operation }) });
    }
    g.rows++;
    if (g.samples.length < 3) g.samples.push({ request_id: row.request_id, slug: row.slug, state: row.state, ended_at: row.ended_at, inspect: row.inspect });
  }
  for (const [key, since] of driftSince) {
    const g = groups.get(key);
    if (g && new Set(out.filter(row => row.category === 'file_conflict' && `${row.code}\0${row.origin ?? ''}\0${row.category}` === key).map(row => row.slug)).size > 1) g.fix = driftSinceAction(q.sourceId, since);
  }
  const sorted = [...groups.values()].sort((a, b) => b.rows - a.rows || a.category.localeCompare(b.category) || a.code.localeCompare(b.code) || (a.origin ?? '').localeCompare(b.origin ?? ''));
  // Groups count the receipts this call scanned; a scan that stopped at its bound continues from where it stopped.
  const resume = !exhausted ? cursor : null;
  const more = resume !== null || sorted.length > limit;
  return { status: 'ok', source_id: q.sourceId, ...window, state, group_by: 'category', groups: sorted.slice(0, limit), scanned, truncated: more, next_cursor: resume,
    ...(resume !== null ? { next: terminalFailuresArgv(q, { before: resume }) } : sorted.length > limit ? { next: terminalFailuresArgv({ ...q, limit: 100 }) } : {}) };
}

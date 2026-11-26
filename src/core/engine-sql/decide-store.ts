/**
 * The decide store (src/core/ai/decide/store.ts): `decide_state` (internal key/value state), `decide_spend` (the
 * third-party spend ledger), `decision_receipts` (one row per decision, aggregate-only reads) and `decide_calibrations`
 * (the qualification runs). SQL once for both engines, so a store that is not SQL serves the same members
 * (rust/docs/store/decide-store.md).
 *
 * Every function takes the engine (or transaction) it runs on. Rows come back typed: counts and sums as numbers,
 * timestamps as `Date`s. The 60 s daily-spend cache, the buffered writers and the salt cache stay in store.ts.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

// ---------------------------------------------------------------- state

/** The value kept under `key`, or null when there is none. */
export async function readDecideState(tx: Raw, key: string): Promise<string | null> {
  const rows = await tx.executeRaw<{ value: string }>('SELECT value FROM decide_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

/** Keep `value` under `key`, replacing an earlier value and stamping the write. */
export async function upsertDecideState(tx: Raw, key: string, value: string): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO decide_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

/** Forget `key` (nothing happens when it is absent). */
export async function deleteDecideState(tx: Raw, key: string): Promise<void> {
  await tx.executeRaw('DELETE FROM decide_state WHERE key = $1', [key]);
}

/**
 * Keep `value` under `key` only when nothing is there yet, then answer what is stored (so concurrent callers agree on
 * one value). Null only when the stored value cannot be read back.
 */
export async function ensureDecideState(tx: Raw, key: string, value: string): Promise<string | null> {
  await tx.executeRaw('INSERT INTO decide_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
  return readDecideState(tx, key);
}

// ---------------------------------------------------------------- spend

/**
 * One `decide_spend` row to insert. Loose on purpose: store.ts's `SpendRow` is assignable to it, and a caller that
 * leaves a column out gets the same refusal an explicit null gets (every column but the two booleans is bound as given).
 */
export interface DecideSpendInsert {
  request_id: string;
  source_id?: string | null;
  slot: string;
  provider: string;
  model_resolved?: string | null;
  lane: string;
  remote?: boolean;
  input_tokens?: number | null;
  cost_usd?: number | null;
  outcome: string;
}

type Cell = string | number | boolean | null;
type ColumnKind = 'text' | 'int' | 'real' | 'float8' | 'boolean';

const SPEND_COLUMNS: ReadonlyArray<readonly [string, ColumnKind]> = [
  ['request_id', 'text'], ['source_id', 'text'], ['slot', 'text'], ['provider', 'text'], ['model_resolved', 'text'],
  ['lane', 'text'], ['remote', 'boolean'], ['input_tokens', 'int'], ['cost_usd', 'float8'], ['outcome', 'text'],
];

/**
 * Each row as one value per column: a column the caller left out is null (a NOT NULL column then refuses the row),
 * except the booleans, which default to false. Text columns are text, numbers and booleans keep their type.
 * The SQL insert and the Rust store both start from this, so the two engines read a row the same way.
 */
function columnValues(columns: ReadonlyArray<readonly [string, ColumnKind]>, rows: readonly object[]): Array<Record<string, Cell>> {
  return rows.map((row) => {
    const out: Record<string, Cell> = {};
    for (const [name, kind] of columns) {
      const v = (row as Record<string, unknown>)[name];
      if (v === undefined) out[name] = kind === 'boolean' ? false : null;
      else if (v === null) out[name] = null;
      else out[name] = kind === 'text' ? String(v) : (v as Cell);
    }
    return out;
  });
}

export function spendRowValues(rows: readonly DecideSpendInsert[]): Array<Record<string, Cell>> {
  return columnValues(SPEND_COLUMNS, rows);
}

/** The statements are spelled out: engine-sql splices only constant text. Each column binds as one array parameter. */
const INSERT_SPEND_SQL = `INSERT INTO decide_spend (request_id, source_id, slot, provider, model_resolved, lane, remote, input_tokens, cost_usd, outcome)
  SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]::boolean[],
                       $8::text[]::int[], $9::text[]::float8[], $10::text[])
  ON CONFLICT (request_id) DO NOTHING`;

/**
 * Multi-row insert via unnest of one array per column (fixed parameter count). Every column binds as text[] and casts
 * server-side: postgres.js cannot serialize boolean/number arrays for a typed array cast, PGLite can; text arrays behave
 * the same on both engines.
 */
async function unnestInsert(tx: Raw, sql: string, columns: ReadonlyArray<readonly [string, ColumnKind]>, values: Array<Record<string, Cell>>): Promise<void> {
  if (values.length === 0) return;
  await tx.executeRaw(sql, columns.map(([name]) => values.map((r) => (r[name] === null ? null : String(r[name])))));
}

/** Record spend rows. A request id that is already recorded keeps its first row. All rows go in, or none do. */
export async function insertDecideSpend(tx: Raw, rows: readonly DecideSpendInsert[]): Promise<void> {
  await unnestInsert(tx, INSERT_SPEND_SQL, SPEND_COLUMNS, spendRowValues(rows));
}

/** Third-party spend recorded at or after `since`: everything, and the part that went to a remote caller. */
export async function dailyDecideSpend(tx: Raw, since: Date): Promise<{ total: number; remote: number }> {
  const rows = await tx.executeRaw<{ total: number | string | null; remote: number | string | null }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total, COALESCE(SUM(CASE WHEN remote THEN cost_usd ELSE 0 END), 0) AS remote
       FROM decide_spend WHERE created_at >= $1::timestamptz AND provider LIKE 'typesafe:%'`,
    [since.toISOString()],
  );
  return { total: Number(rows[0]?.total ?? 0), remote: Number(rows[0]?.remote ?? 0) };
}

export interface DecideSpendSlotTotals { slot: string; input_tokens: number; cost_usd: number; requests: number }

/** Spend totals per slot over the whole ledger, one row per slot, in the database's own order, as master read them. */
export async function listDecideSpendBySlot(tx: Raw): Promise<DecideSpendSlotTotals[]> {
  const rows = await tx.executeRaw<{ slot: string; tokens: number | string; cost: number | string; n: number | string }>(
    `SELECT slot, COALESCE(SUM(input_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS n
       FROM decide_spend GROUP BY slot`,
  );
  return rows.map((r) => ({ slot: String(r.slot), input_tokens: Number(r.tokens), cost_usd: Number(r.cost), requests: Number(r.n) }));
}

// ---------------------------------------------------------------- receipts

/**
 * One `decision_receipts` row to insert. Loose on purpose (see `DecideSpendInsert`): store.ts's `ReceiptRow` is assignable
 * to it, a column left out is null, and a NOT NULL column that gets null refuses the whole batch.
 */
export interface DecideReceiptInsert {
  decision_id: string;
  source_id?: string | null;
  slot: string;
  mode: string;
  provider: string;
  model_alias?: string | null;
  model_resolved?: string | null;
  question_kind?: string | null;
  state_hash?: string | null;
  question_hash?: string | null;
  answer_value?: number | null;
  answer_choice?: string | null;
  confidence?: number | null;
  threshold?: number | null;
  outcome: string;
  subject_ref?: string | null;
  call_site: string;
  lane: string;
  policy_fingerprint?: string | null;
  calibration_ref?: string | null;
  latency_ms?: number | null;
  input_tokens?: number | null;
  error_reason?: string | null;
  protected?: boolean;
  min_keep?: number | null;
  rank?: number | null;
  k_used?: number | null;
  remote?: boolean;
  run_meta?: string | null;
}

const RECEIPT_COLUMNS: ReadonlyArray<readonly [string, ColumnKind]> = [
  ['decision_id', 'text'], ['source_id', 'text'], ['slot', 'text'], ['mode', 'text'], ['provider', 'text'],
  ['model_alias', 'text'], ['model_resolved', 'text'], ['question_kind', 'text'], ['state_hash', 'text'],
  ['question_hash', 'text'], ['answer_value', 'real'], ['answer_choice', 'text'], ['confidence', 'real'],
  ['threshold', 'real'], ['outcome', 'text'], ['subject_ref', 'text'], ['call_site', 'text'], ['lane', 'text'],
  ['policy_fingerprint', 'text'], ['calibration_ref', 'text'], ['latency_ms', 'int'], ['input_tokens', 'int'],
  ['error_reason', 'text'], ['protected', 'boolean'], ['min_keep', 'int'], ['rank', 'int'], ['k_used', 'int'],
  ['remote', 'boolean'], ['run_meta', 'text'],
];

export function receiptRowValues(rows: readonly DecideReceiptInsert[]): Array<Record<string, Cell>> {
  return columnValues(RECEIPT_COLUMNS, rows);
}

/** Statement spelled out, as `INSERT_SPEND_SQL` is. */
const INSERT_RECEIPTS_SQL = `INSERT INTO decision_receipts (
  decision_id, source_id, slot, mode, provider, model_alias,
  model_resolved, question_kind, state_hash, question_hash, answer_value, answer_choice,
  confidence, threshold, outcome, subject_ref, call_site, lane,
  policy_fingerprint, calibration_ref, latency_ms, input_tokens, error_reason, protected,
  min_keep, rank, k_used, remote, run_meta)
  SELECT * FROM unnest(
    $1::text[], $2::text[], $3::text[], $4::text[],
    $5::text[], $6::text[], $7::text[], $8::text[],
    $9::text[], $10::text[], $11::text[]::real[], $12::text[],
    $13::text[]::real[], $14::text[]::real[], $15::text[], $16::text[],
    $17::text[], $18::text[], $19::text[], $20::text[],
    $21::text[]::int[], $22::text[]::int[], $23::text[], $24::text[]::boolean[],
    $25::text[]::int[], $26::text[]::int[], $27::text[]::int[], $28::text[]::boolean[],
    $29::text[])`;

/** Record receipt rows, in order. All rows go in, or none do. */
export async function insertDecideReceipts(tx: Raw, rows: readonly DecideReceiptInsert[]): Promise<void> {
  await unnestInsert(tx, INSERT_RECEIPTS_SQL, RECEIPT_COLUMNS, receiptRowValues(rows));
}

/**
 * Delete the receipts older than `retentionDays` and the spend rows older than `max(retentionDays, 31)` days (the ledger
 * outlives the receipts), and answer how many receipts went. A day is 24 hours.
 */
export async function pruneDecideReceipts(tx: Raw, retentionDays: number): Promise<number> {
  const rows = await tx.executeRaw<{ n: number | string }>(
    `WITH gone AS (DELETE FROM decision_receipts WHERE created_at < now() - ($1::int * interval '1 day') RETURNING 1)
     SELECT COUNT(*)::int AS n FROM gone`,
    [retentionDays],
  );
  await tx.executeRaw(`DELETE FROM decide_spend WHERE created_at < now() - ($1::int * interval '1 day')`, [Math.max(retentionDays, 31)]);
  return Number(rows[0]?.n ?? 0);
}

export interface DecideReceiptStat {
  slot: string;
  mode: string;
  outcome: string;
  error_reason: string | null;
  n: number;
  avg_value: number | null;
  p50_latency: number | null;
  p95_latency: number | null;
  input_tokens: number;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Whether a receipt window holds nothing without asking the database: a whole number of hours, zero or fewer, in the
 * `int4` range, with no NUL byte in any text argument. "The last 0 hours" names no time at all, so it answers nothing
 * on every engine, decided before any query: `created_at >= now() - 0` counts a receipt stamped with the read's own
 * now() (written in the same transaction, or in the same clock tick on PGLite), and a strict `>` would still count a
 * receipt stamped after the read's now() (a transaction that started later and committed first). Any other value runs
 * the query, so a fraction, a window outside `int4` or a NUL byte is still refused as before.
 */
function windowHoldsNothing(sinceHours: number, ...text: Array<string | null | undefined>): boolean {
  return Number.isInteger(sinceHours) && sinceHours <= 0 && sinceHours >= -2147483648 && !text.some((t) => t?.includes('\u0000'));
}

/**
 * Receipt counts over the last `sinceHours` hours (none for zero or fewer: windowHoldsNothing), per slot, mode, outcome and error reason (aggregates only, never text),
 * in that order, by byte (`COLLATE "C"`, as PGLite sorts).
 */
export async function listDecideReceiptStats(tx: Raw, opts: { slot?: string; sinceHours: number }): Promise<DecideReceiptStat[]> {
  if (windowHoldsNothing(opts.sinceHours, opts.slot)) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT slot, mode, outcome, error_reason, COUNT(*)::int AS n, AVG(answer_value)::float8 AS avg_value,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p50_latency,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p95_latency,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens
       FROM decision_receipts
      WHERE created_at >= now() - ($1::int * interval '1 hour') AND ($2::text IS NULL OR slot = $2)
      GROUP BY slot, mode, outcome, error_reason
      ORDER BY slot COLLATE "C", mode COLLATE "C", outcome COLLATE "C", error_reason COLLATE "C"`,
    [opts.sinceHours, opts.slot ?? null],
  );
  return rows.map((r) => ({
    slot: String(r.slot), mode: String(r.mode), outcome: String(r.outcome), error_reason: r.error_reason === null ? null : String(r.error_reason),
    n: Number(r.n), avg_value: numOrNull(r.avg_value), p50_latency: numOrNull(r.p50_latency), p95_latency: numOrNull(r.p95_latency), input_tokens: Number(r.input_tokens),
  }));
}

export interface DecideSlotUsageRow { slot: string; decisions: number; rows: number; input_tokens: number; errors: number; skipped: number; egress: number }

/** Per-slot decision counts, tokens, errors and egress refusals over the last `sinceHours` hours. */
export async function decideSlotUsage(tx: Raw, sinceHours: number): Promise<DecideSlotUsageRow[]> {
  if (windowHoldsNothing(sinceHours)) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT slot, COUNT(DISTINCT decision_id)::int AS decisions, COUNT(*)::int AS rows,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
            SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END)::int AS errors,
            SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END)::int AS skipped,
            SUM(CASE WHEN error_reason LIKE 'egress%' OR error_reason IN ('denied_source','missing_provenance') THEN 1 ELSE 0 END)::int AS egress
       FROM decision_receipts WHERE created_at >= now() - ($1::int * interval '1 hour')
      GROUP BY slot ORDER BY slot COLLATE "C"`,
    [sinceHours],
  );
  return rows.map((r) => ({ slot: String(r.slot), decisions: Number(r.decisions), rows: Number(r.rows), input_tokens: Number(r.input_tokens), errors: Number(r.errors), skipped: Number(r.skipped), egress: Number(r.egress) }));
}

/** The conflict receipts of the last `sinceHours` hours, and how many were fact-level `no_entity` skips. */
export async function decideConflictNoEntityCounts(tx: Raw, sinceHours: number): Promise<{ receipts: number; skipped: number }> {
  if (windowHoldsNothing(sinceHours)) return { receipts: 0, skipped: 0 };
  const [row] = await tx.executeRaw<{ receipts: number | string; skipped: number | string }>(
    `SELECT COUNT(*)::int AS receipts,
            COUNT(*) FILTER (WHERE outcome = 'skipped' AND error_reason = 'no_entity')::int AS skipped
       FROM decision_receipts WHERE slot = 'conflict' AND created_at >= now() - ($1::int * interval '1 hour')`,
    [sinceHours],
  );
  return { receipts: Number(row?.receipts ?? 0), skipped: Number(row?.skipped ?? 0) };
}

export interface DecideReplayReceipt {
  decision_id: string;
  answer_value: number | null;
  protected: boolean;
  rank: number | null;
  min_keep: number | null;
  outcome: string;
}

/** The decision rows of `slot` over the last `sinceHours` hours that a replay reads, by decision id (byte order), then rank (null last), then insertion order. */
export async function listDecideReplayReceipts(tx: Raw, slot: string, sinceHours: number): Promise<DecideReplayReceipt[]> {
  if (windowHoldsNothing(sinceHours, slot)) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT decision_id, answer_value, protected, rank, min_keep, outcome FROM decision_receipts
      WHERE slot = $1 AND created_at >= now() - ($2::int * interval '1 hour') AND outcome IN ('kept','pruned','margin_hold','pass','reject','quarantine','insufficient_context')
      ORDER BY decision_id COLLATE "C", rank, id`,
    [slot, sinceHours],
  );
  return rows.map((r) => ({
    decision_id: String(r.decision_id), answer_value: numOrNull(r.answer_value), protected: r.protected === true || r.protected === 't',
    rank: numOrNull(r.rank), min_keep: numOrNull(r.min_keep), outcome: String(r.outcome),
  }));
}

export interface DecideResolvedModel { slot: string; provider: string; model_resolved: string; n: number; last_at: Date }

/** Each (slot, provider, resolved model) seen over the last `sinceHours` hours, with its count and latest time, latest first; groups with one latest time in byte order of slot, provider and model. */
export async function listDecideResolvedModels(tx: Raw, sinceHours: number): Promise<DecideResolvedModel[]> {
  if (windowHoldsNothing(sinceHours)) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT slot, provider, model_resolved, COUNT(*)::int AS n, MAX(created_at) AS last_at FROM decision_receipts
      WHERE model_resolved IS NOT NULL AND created_at >= now() - ($1::int * interval '1 hour')
      GROUP BY slot, provider, model_resolved
      ORDER BY MAX(created_at) DESC, slot COLLATE "C", provider COLLATE "C", model_resolved COLLATE "C"`,
    [sinceHours],
  );
  return rows.map((r) => ({
    slot: String(r.slot), provider: String(r.provider), model_resolved: String(r.model_resolved), n: Number(r.n),
    last_at: r.last_at instanceof Date ? r.last_at : new Date(String(r.last_at)),
  }));
}

/** Per slot, the receipts of the last `sinceHours` hours marked `mixed_model` (a decision whose rows carried more than one resolved model). */
export async function listDecideMixedModelDecisions(tx: Raw, sinceHours: number): Promise<Array<{ slot: string; n: number }>> {
  if (windowHoldsNothing(sinceHours)) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT slot, COUNT(*)::int AS n FROM decision_receipts
      WHERE created_at >= now() - ($1::int * interval '1 hour') AND error_reason = 'mixed_model'
      GROUP BY slot`,
    [sinceHours],
  );
  return rows.map((r) => ({ slot: String(r.slot), n: Number(r.n) }));
}

// ---------------------------------------------------------------- calibrations

/**
 * One `decide_calibrations` row to insert (store.ts's `NewCalibration` is assignable to it). Every column is bound as
 * given, so a null in a NOT NULL column refuses the row (`calibrate_only` has a default but is always bound).
 */
export interface DecideCalibrationInsert {
  slot: string;
  call_site: string;
  provider: string;
  model_resolved: string;
  threshold: number;
  min_keep?: number | null;
  metric: string;
  metric_value?: number | null;
  ece?: number | null;
  retest_sd?: number | null;
  repack_sd?: number | null;
  n: number;
  dataset_hash?: string | null;
  split_hash?: string | null;
  calibrate_ids_hash?: string | null;
  calibrate_only: boolean;
  pack_shape: string;
  notes?: string | null;
}

/** One `decide_calibrations` row as the store hands it back: numbers as numbers, timestamps as `Date`s. */
export interface DecideCalibration {
  id: number;
  slot: string;
  call_site: string;
  provider: string;
  model_resolved: string;
  threshold: number;
  min_keep: number | null;
  metric: string;
  metric_value: number | null;
  ece: number | null;
  retest_sd: number | null;
  repack_sd: number | null;
  action_precision_lb: number | null;
  qualification: string | null;
  qualified_at: Date | null;
  policy_fingerprint: string | null;
  n: number;
  dataset_hash: string | null;
  split_hash: string | null;
  calibrate_ids_hash: string | null;
  calibrate_only: boolean;
  pack_shape: string;
  created_at: Date;
  retired_at: Date | null;
  notes: string | null;
}

export interface DecideQualification {
  action_precision_lb: number | null;
  qualification: string | null;
  policy_fingerprint: string | null;
}

const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const textOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toDecideCalibration(r: Record<string, unknown>): DecideCalibration {
  return {
    id: Number(r.id), slot: String(r.slot), call_site: String(r.call_site), provider: String(r.provider),
    model_resolved: String(r.model_resolved), threshold: Number(r.threshold), min_keep: numOrNull(r.min_keep),
    metric: String(r.metric), metric_value: numOrNull(r.metric_value), ece: numOrNull(r.ece),
    retest_sd: numOrNull(r.retest_sd), repack_sd: numOrNull(r.repack_sd),
    action_precision_lb: numOrNull(r.action_precision_lb), qualification: textOrNull(r.qualification),
    qualified_at: dateOrNull(r.qualified_at), policy_fingerprint: textOrNull(r.policy_fingerprint), n: Number(r.n),
    dataset_hash: textOrNull(r.dataset_hash), split_hash: textOrNull(r.split_hash),
    calibrate_ids_hash: textOrNull(r.calibrate_ids_hash), calibrate_only: r.calibrate_only === true || r.calibrate_only === 't',
    pack_shape: String(r.pack_shape), created_at: dateOrNull(r.created_at)!, retired_at: dateOrNull(r.retired_at),
    notes: textOrNull(r.notes),
  };
}

/** Record one calibration, stamped now, and answer its id (ids count up from 1). */
export async function insertDecideCalibration(tx: Raw, c: DecideCalibrationInsert): Promise<number> {
  const rows = await tx.executeRaw<{ id: number | string }>(
    `INSERT INTO decide_calibrations (slot, call_site, provider, model_resolved, threshold, min_keep, metric, metric_value, ece,
       retest_sd, repack_sd, n, dataset_hash, split_hash, calibrate_ids_hash, calibrate_only, pack_shape, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [c.slot, c.call_site, c.provider, c.model_resolved, c.threshold, c.min_keep ?? null, c.metric, c.metric_value ?? null, c.ece ?? null,
      c.retest_sd ?? null, c.repack_sd ?? null, c.n, c.dataset_hash ?? null, c.split_hash ?? null, c.calibrate_ids_hash ?? null,
      c.calibrate_only, c.pack_shape, c.notes ?? null],
  );
  return Number(rows[0]!.id);
}

/** Replace the three qualification columns of calibration `id` (null included) and stamp `qualified_at`. An id with no row changes nothing. */
export async function storeDecideQualification(tx: Raw, id: number, q: DecideQualification): Promise<void> {
  await tx.executeRaw(
    'UPDATE decide_calibrations SET action_precision_lb = $2, qualification = $3, policy_fingerprint = $4, qualified_at = now() WHERE id = $1',
    [id, q.action_precision_lb ?? null, q.qualification ?? null, q.policy_fingerprint ?? null],
  );
}

/** The calibrations (retired ones only when asked for), by slot, then newest first, then highest id first. */
export async function listDecideCalibrations(tx: Raw, opts: { slot?: string; includeRetired?: boolean } = {}): Promise<DecideCalibration[]> {
  const rows = await tx.executeRaw<Record<string, unknown>>(
    `SELECT * FROM decide_calibrations
      WHERE ($1::text IS NULL OR slot = $1) AND ($2::boolean OR retired_at IS NULL)
      ORDER BY slot COLLATE "C", created_at DESC, id DESC`,
    [opts.slot ?? null, opts.includeRetired ?? false],
  );
  return rows.map(toDecideCalibration);
}

/** Calibration `id`, or null when there is none. */
export async function getDecideCalibration(tx: Raw, id: number): Promise<DecideCalibration | null> {
  const rows = await tx.executeRaw<Record<string, unknown>>('SELECT * FROM decide_calibrations WHERE id = $1', [id]);
  return rows[0] ? toDecideCalibration(rows[0]) : null;
}

/** Retire calibration `id` (stamp `retired_at` now) or bring it back (clear it). Answers whether the row exists. */
export async function setDecideCalibrationRetired(tx: Raw, id: number, retired: boolean): Promise<boolean> {
  const rows = await tx.executeRaw<{ id: number | string }>(
    'UPDATE decide_calibrations SET retired_at = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE id = $1 RETURNING id',
    [id, retired],
  );
  return rows.length > 0;
}

/**
 * decide storage: receipts, the spend ledger, calibrations and internal state,
 * read and written through `engine.executeRaw` (the search/telemetry.ts and
 * query-cache.ts pattern), so no BrainEngine method and no engine facade grows.
 *
 * Receipts and spend rows are buffered per process and flushed
 * fire-and-forget off the hot path (threshold or 5 s unref'd timer). The
 * buffers register with the background-work registry: the CLI's bounded
 * teardown drain ('exit') flushes residual rows with a 500 ms bound, and
 * engine disconnect ('disconnect') awaits only the in-flight flush. A hard
 * kill loses buffered rows; the daily cap is soft in both directions.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { registerBackgroundWorkDrainer, type BackgroundWorkDrainMode } from '../../background-work.ts';
import { isValidOutcome } from './outcomes.ts';
import type { DecideLane, DecideSlot, QuestionKind } from './types.ts';

export interface ReceiptRow {
  decision_id: string;
  source_id?: string | null;
  slot: DecideSlot;
  mode: 'on' | 'shadow';
  provider: string;
  model_alias?: string | null;
  model_resolved?: string | null;
  question_kind?: QuestionKind | null;
  state_hash?: string | null;
  question_hash?: string | null;
  answer_value?: number | null;
  answer_choice?: string | null;
  confidence?: number | null;
  threshold?: number | null;
  outcome: string;
  subject_ref?: string | null;
  call_site: string;
  lane: DecideLane;
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

export interface SpendRow {
  request_id: string;
  source_id?: string | null;
  slot: DecideSlot;
  provider: string;
  model_resolved?: string | null;
  lane: DecideLane;
  remote: boolean;
  input_tokens: number;
  cost_usd: number;
  outcome: 'ok' | 'failed' | 'timeout' | 'malformed';
}

const FLUSH_THRESHOLD_ROWS = 200;
const FLUSH_INTERVAL_MS = 5_000;
const EXIT_FLUSH_BOUND_MS = 500;

const RECEIPT_COLUMNS = [
  ['decision_id', 'text'], ['source_id', 'text'], ['slot', 'text'], ['mode', 'text'], ['provider', 'text'],
  ['model_alias', 'text'], ['model_resolved', 'text'], ['question_kind', 'text'], ['state_hash', 'text'],
  ['question_hash', 'text'], ['answer_value', 'real'], ['answer_choice', 'text'], ['confidence', 'real'],
  ['threshold', 'real'], ['outcome', 'text'], ['subject_ref', 'text'], ['call_site', 'text'], ['lane', 'text'],
  ['policy_fingerprint', 'text'], ['calibration_ref', 'text'], ['latency_ms', 'int'], ['input_tokens', 'int'],
  ['error_reason', 'text'], ['protected', 'boolean'], ['min_keep', 'int'], ['rank', 'int'], ['k_used', 'int'],
  ['remote', 'boolean'], ['run_meta', 'text'],
] as const;

const SPEND_COLUMNS = [
  ['request_id', 'text'], ['source_id', 'text'], ['slot', 'text'], ['provider', 'text'], ['model_resolved', 'text'],
  ['lane', 'text'], ['remote', 'boolean'], ['input_tokens', 'int'], ['cost_usd', 'float8'], ['outcome', 'text'],
] as const;

/**
 * Multi-row insert via unnest of one array per column (fixed param count).
 * Every column binds as text[] and casts server-side: postgres.js cannot
 * serialize boolean/number arrays for a typed array cast, PGLite can; text
 * arrays behave the same on both engines.
 */
async function insertRows(engine: BrainEngine, table: string, columns: readonly (readonly [string, string])[], rows: readonly object[], conflict = ''): Promise<void> {
  if (rows.length === 0) return;
  const defaults: Record<string, unknown> = { protected: false, remote: false };
  const params = columns.map(([name]) => rows.map((r) => {
    const v = (r as Record<string, unknown>)[name];
    const value = v === undefined ? (defaults[name] ?? null) : v;
    return value === null ? null : String(value);
  }));
  const names = columns.map(([name]) => name).join(', ');
  const casts = columns.map(([, type], i) => (type === 'text' ? `$${i + 1}::text[]` : `$${i + 1}::text[]::${type}[]`)).join(', ');
  await engine.executeRaw(`INSERT INTO ${table} (${names}) SELECT * FROM unnest(${casts}) ${conflict}`, params);
}

class BufferedWriter<T extends object> {
  private rows: T[] = [];
  private engine: BrainEngine | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  constructor(private readonly write: (engine: BrainEngine, rows: T[]) => Promise<void>) {}

  push(engine: BrainEngine, rows: readonly T[]): void {
    if (rows.length === 0) return;
    if (this.engine !== engine) {
      if (this.engine && this.rows.length > 0) void this.flush().catch(() => {});
      this.engine = engine;
    }
    this.rows.push(...rows);
    if (!this.timer) {
      this.timer = setInterval(() => { void this.flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
    if (this.rows.length >= FLUSH_THRESHOLD_ROWS) void this.flush().catch(() => {});
  }

  async flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.engine || this.rows.length === 0) return;
    const batch = this.rows;
    this.rows = [];
    const engine = this.engine;
    this.inFlight = (async () => {
      try { await this.write(engine, batch); } catch { /* receipts never break the caller */ } finally { this.inFlight = null; }
    })();
    return this.inFlight;
  }

  pending(): Promise<void> | null { return this.inFlight; }
  hasBuffered(): boolean { return this.rows.length > 0; }
  reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.rows = [];
    this.engine = null;
    this.inFlight = null;
  }
}

const receipts = new BufferedWriter<ReceiptRow>((engine, rows) => insertRows(engine, 'decision_receipts', RECEIPT_COLUMNS, rows));
const spend = new BufferedWriter<SpendRow>((engine, rows) => insertRows(engine, 'decide_spend', SPEND_COLUMNS, rows, 'ON CONFLICT (request_id) DO NOTHING'));

/** Buffer receipts. Throws on an outcome outside the canonical vocabulary (a code bug, caught by tests). */
export function recordReceipts(engine: BrainEngine, rows: readonly ReceiptRow[]): void {
  for (const r of rows) {
    if (!isValidOutcome(r.slot, r.outcome)) throw new Error(`decide: outcome '${r.outcome}' is not in the canonical vocabulary for ${r.slot}`);
  }
  receipts.push(engine, rows);
}

export function recordSpend(engine: BrainEngine, row: SpendRow): void {
  spend.push(engine, [row]);
  bumpSpendCache(engine, row);
}

/** Flush both buffers now (CLI commands that read what they just wrote, tests). */
export async function flushDecideWrites(): Promise<void> {
  await Promise.all([receipts.flush(), spend.flush()]);
}

export async function drainDecideWrites(timeoutMs: number, mode: BackgroundWorkDrainMode): Promise<{ unfinished: number }> {
  const bound = Math.min(timeoutMs, EXIT_FLUSH_BOUND_MS);
  const work = (async () => {
    await Promise.all([receipts.pending(), spend.pending()].map((p) => p?.catch(() => {})));
    if (mode === 'exit') await flushDecideWrites();
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), bound); timer.unref?.(); });
  try {
    return (await Promise.race([work.then(() => 'done' as const), timedOut])) === 'timeout' ? { unfinished: 1 } : { unfinished: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

registerBackgroundWorkDrainer({ name: 'decide-receipts', order: 6, drain: drainDecideWrites });

export function __resetDecideStoreForTests(): void {
  receipts.reset();
  spend.reset();
  spendCache.clear();
  saltCache = new WeakMap();
}

// ---------------------------------------------------------------------------
// Internal state (decide_state): never a config key, so no config surface
// (get/list/snapshot/MCP/export) can print it.
// ---------------------------------------------------------------------------

export async function getDecideState(engine: BrainEngine, key: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ value: string }>('SELECT value FROM decide_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setDecideState(engine: BrainEngine, key: string, value: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO decide_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

export async function deleteDecideState(engine: BrainEngine, key: string): Promise<void> {
  await engine.executeRaw('DELETE FROM decide_state WHERE key = $1', [key]);
}

const SALT_KEY = 'receipt_hmac_salt';
let saltCache = new WeakMap<BrainEngine, Promise<string>>();

/** Per-brain receipt salt: 32 random bytes, insert-if-absent then re-read so concurrent processes agree. */
export function receiptSalt(engine: BrainEngine): Promise<string> {
  let cached = saltCache.get(engine);
  if (!cached) {
    cached = (async () => {
      await engine.executeRaw('INSERT INTO decide_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [SALT_KEY, randomBytes(32).toString('hex')]);
      const value = await getDecideState(engine, SALT_KEY);
      if (!value) throw new Error('decide: receipt salt unavailable');
      return value;
    })();
    cached.catch(() => saltCache.delete(engine));
    saltCache.set(engine, cached);
  }
  return cached;
}

/** HMAC-SHA256 (hex, 32 chars): joinable for calibration, not dictionary-reversible. */
export function hmacRef(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value, 'utf8').digest('hex').slice(0, 32);
}

export function pageSubject(sourceId: string | undefined, slug: string): string {
  return `page:${sourceId ?? 'default'}:${slug}`;
}

// ---------------------------------------------------------------------------
// Spend: the daily figure sums decide_spend for the current UTC day (third-party
// providers only), cached per process for at most 60 s and bumped locally.
// ---------------------------------------------------------------------------

interface SpendCacheEntry { day: string; at: number; total: number; remote: number }
const SPEND_CACHE_MS = 60_000;
const spendCache = new Map<BrainEngine, SpendCacheEntry>();
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function bumpSpendCache(engine: BrainEngine, row: SpendRow): void {
  const entry = spendCache.get(engine);
  if (!entry || entry.day !== utcDay()) return;
  entry.total += row.cost_usd;
  if (row.remote) entry.remote += row.cost_usd;
}

export async function dailySpend(engine: BrainEngine, now = Date.now()): Promise<{ total: number; remote: number }> {
  const day = utcDay(now);
  const cached = spendCache.get(engine);
  if (cached && cached.day === day && now - cached.at < SPEND_CACHE_MS) return { total: cached.total, remote: cached.remote };
  const rows = await engine.executeRaw<{ total: number | string | null; remote: number | string | null }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total, COALESCE(SUM(CASE WHEN remote THEN cost_usd ELSE 0 END), 0) AS remote
       FROM decide_spend WHERE created_at >= $1::timestamptz AND provider LIKE 'typesafe:%'`,
    [`${day}T00:00:00Z`],
  );
  const entry = { day, at: now, total: Number(rows[0]?.total ?? 0), remote: Number(rows[0]?.remote ?? 0) };
  spendCache.set(engine, entry);
  return { total: entry.total, remote: entry.remote };
}

// ---------------------------------------------------------------------------
// Calibrations
// ---------------------------------------------------------------------------

export interface CalibrationRow {
  id: number;
  slot: DecideSlot;
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
  qualified_at: string | null;
  policy_fingerprint: string | null;
  n: number;
  dataset_hash: string | null;
  split_hash: string | null;
  calibrate_ids_hash: string | null;
  calibrate_only: boolean;
  pack_shape: string;
  created_at: string;
  retired_at: string | null;
  notes: string | null;
}

export type NewCalibration = Omit<CalibrationRow, 'id' | 'created_at' | 'retired_at' | 'qualified_at' | 'qualification' | 'action_precision_lb' | 'policy_fingerprint'>;

const toNum = (v: unknown): number | null => v === null || v === undefined ? null : Number(v);
const toTime = (v: unknown): string | null => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

function normalizeCalibration(r: Record<string, unknown>): CalibrationRow {
  return {
    ...(r as unknown as CalibrationRow),
    id: Number(r.id),
    threshold: Number(r.threshold),
    min_keep: toNum(r.min_keep),
    metric_value: toNum(r.metric_value),
    ece: toNum(r.ece),
    retest_sd: toNum(r.retest_sd),
    repack_sd: toNum(r.repack_sd),
    action_precision_lb: toNum(r.action_precision_lb),
    n: Number(r.n),
    calibrate_only: r.calibrate_only === true || r.calibrate_only === 't',
    created_at: toTime(r.created_at)!,
    retired_at: toTime(r.retired_at),
    qualified_at: toTime(r.qualified_at),
  };
}

export async function insertCalibration(engine: BrainEngine, c: NewCalibration): Promise<number> {
  const rows = await engine.executeRaw<{ id: number | string }>(
    `INSERT INTO decide_calibrations (slot, call_site, provider, model_resolved, threshold, min_keep, metric, metric_value, ece,
       retest_sd, repack_sd, n, dataset_hash, split_hash, calibrate_ids_hash, calibrate_only, pack_shape, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [c.slot, c.call_site, c.provider, c.model_resolved, c.threshold, c.min_keep, c.metric, c.metric_value, c.ece,
      c.retest_sd, c.repack_sd, c.n, c.dataset_hash, c.split_hash, c.calibrate_ids_hash, c.calibrate_only, c.pack_shape, c.notes],
  );
  return Number(rows[0]!.id);
}

export async function storeQualification(engine: BrainEngine, id: number, q: { action_precision_lb: number | null; qualification: string; policy_fingerprint: string }): Promise<void> {
  await engine.executeRaw(
    'UPDATE decide_calibrations SET action_precision_lb = $2, qualification = $3, policy_fingerprint = $4, qualified_at = now() WHERE id = $1',
    [id, q.action_precision_lb, q.qualification, q.policy_fingerprint],
  );
}

export async function listCalibrations(engine: BrainEngine, filter: { slot?: DecideSlot; includeRetired?: boolean } = {}): Promise<CalibrationRow[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM decide_calibrations
      WHERE ($1::text IS NULL OR slot = $1) AND ($2::boolean OR retired_at IS NULL)
      ORDER BY slot, created_at DESC, id DESC`,
    [filter.slot ?? null, filter.includeRetired ?? false],
  );
  return rows.map(normalizeCalibration);
}

export async function getCalibration(engine: BrainEngine, id: number): Promise<CalibrationRow | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM decide_calibrations WHERE id = $1', [id]);
  return rows[0] ? normalizeCalibration(rows[0]) : null;
}

export async function setCalibrationRetired(engine: BrainEngine, id: number, retired: boolean): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE decide_calibrations SET retired_at = ${retired ? 'now()' : 'NULL'} WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Receipt reads (aggregate stats only; never text)
// ---------------------------------------------------------------------------

export interface ReceiptStats {
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

export async function receiptStats(engine: BrainEngine, opts: { slot?: DecideSlot; sinceHours: number }): Promise<ReceiptStats[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT slot, mode, outcome, error_reason, COUNT(*)::int AS n, AVG(answer_value)::float8 AS avg_value,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p50_latency,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p95_latency,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens
       FROM decision_receipts
      WHERE created_at >= now() - ($1::int * interval '1 hour') AND ($2::text IS NULL OR slot = $2)
      GROUP BY slot, mode, outcome, error_reason ORDER BY slot, mode, outcome, error_reason`,
    [opts.sinceHours, opts.slot ?? null],
  );
  return rows.map((r) => ({
    slot: String(r.slot), mode: String(r.mode), outcome: String(r.outcome), error_reason: r.error_reason === null ? null : String(r.error_reason),
    n: Number(r.n), avg_value: toNum(r.avg_value), p50_latency: toNum(r.p50_latency), p95_latency: toNum(r.p95_latency), input_tokens: Number(r.input_tokens),
  }));
}

export interface SlotUsage { slot: string; decisions: number; rows: number; input_tokens: number; errors: number; skipped: number; egress: number }

/** Per-slot decision counts, tokens, errors and egress refusals over the window (status, doctor, cost estimates). */
export async function slotUsage(engine: BrainEngine, sinceHours = 24): Promise<SlotUsage[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT slot, COUNT(DISTINCT decision_id)::int AS decisions, COUNT(*)::int AS rows,
            COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
            SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END)::int AS errors,
            SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END)::int AS skipped,
            SUM(CASE WHEN error_reason LIKE 'egress%' OR error_reason IN ('denied_source','missing_provenance') THEN 1 ELSE 0 END)::int AS egress
       FROM decision_receipts WHERE created_at >= now() - ($1::int * interval '1 hour')
      GROUP BY slot ORDER BY slot`,
    [sinceHours],
  );
  return rows.map((r) => ({ slot: String(r.slot), decisions: Number(r.decisions), rows: Number(r.rows), input_tokens: Number(r.input_tokens), errors: Number(r.errors), skipped: Number(r.skipped), egress: Number(r.egress) }));
}

export interface ReplayReceipt {
  decision_id: string;
  answer_value: number | null;
  protected: boolean;
  rank: number | null;
  min_keep: number | null;
  outcome: string;
}

export async function replayReceipts(engine: BrainEngine, slot: DecideSlot, sinceHours: number): Promise<ReplayReceipt[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT decision_id, answer_value, protected, rank, min_keep, outcome FROM decision_receipts
      WHERE slot = $1 AND created_at >= now() - ($2::int * interval '1 hour') AND outcome IN ('kept','pruned','margin_hold','pass','reject','quarantine','insufficient_context')
      ORDER BY decision_id, rank`,
    [slot, sinceHours],
  );
  return rows.map((r) => ({
    decision_id: String(r.decision_id), answer_value: toNum(r.answer_value), protected: r.protected === true || r.protected === 't',
    rank: toNum(r.rank), min_keep: toNum(r.min_keep), outcome: String(r.outcome),
  }));
}

/** Most recent resolved model per (slot) over the window, for alias calibration lookup and drift. */
export async function recentResolvedModels(engine: BrainEngine, sinceHours = 24): Promise<Array<{ slot: string; provider: string; model_resolved: string; n: number; last_at: string }>> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT slot, provider, model_resolved, COUNT(*)::int AS n, MAX(created_at) AS last_at FROM decision_receipts
      WHERE model_resolved IS NOT NULL AND created_at >= now() - ($1::int * interval '1 hour')
      GROUP BY slot, provider, model_resolved ORDER BY MAX(created_at) DESC`,
    [sinceHours],
  );
  return rows.map((r) => ({ slot: String(r.slot), provider: String(r.provider), model_resolved: String(r.model_resolved), n: Number(r.n), last_at: toTime(r.last_at)! }));
}

/** Decisions whose rows carried more than one resolved model (alias rollout), per slot. */
export async function mixedModelDecisions(engine: BrainEngine, sinceHours = 24): Promise<Array<{ slot: string; n: number }>> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT slot, COUNT(*)::int AS n FROM decision_receipts
      WHERE created_at >= now() - ($1::int * interval '1 hour') AND error_reason = 'mixed_model'
      GROUP BY slot`,
    [sinceHours],
  );
  return rows.map((r) => ({ slot: String(r.slot), n: Number(r.n) }));
}

/** Delete receipts older than the retention window (proposals are never pruned). */
export async function pruneReceipts(engine: BrainEngine, retentionDays: number): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `WITH gone AS (DELETE FROM decision_receipts WHERE created_at < now() - ($1::int * interval '1 day') RETURNING 1)
     SELECT COUNT(*)::int AS n FROM gone`,
    [retentionDays],
  );
  await engine.executeRaw(`DELETE FROM decide_spend WHERE created_at < now() - ($1::int * interval '1 day')`, [Math.max(retentionDays, 31)]);
  return Number(rows[0]?.n ?? 0);
}

/** Cycle purge hook: prune receipts past decide.receipts.retention_days (default 7). */
export async function pruneReceiptsForCycle(engine: BrainEngine): Promise<number> {
  const raw = await engine.getConfig('decide.receipts.retention_days');
  const days = raw && /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : 7;
  return pruneReceipts(engine, days);
}

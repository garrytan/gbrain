/**
 * decide storage: receipts, the spend ledger, calibrations and internal state,
 * read and written through the BrainEngine decide-store members (SQL once in
 * engine-sql/decide-store.ts, a record store on the Rust engine), so a brain that
 * is not SQL serves them too. This file keeps the buffering, the caches and the
 * share maths; it holds no SQL.
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
import type { DecideCalibration } from '../../engine-sql/decide-store.ts';
import { engineKey } from '../../engine-key.ts';
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

class BufferedWriter<T extends object> {
  private rows: T[] = [];
  private engine: BrainEngine | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  /** Rows written to the engine they were buffered for when the next push names another brain. */
  private readonly handoffs = new Set<Promise<void>>();
  constructor(private readonly write: (engine: BrainEngine, rows: T[]) => Promise<void>) {}

  push(engine: BrainEngine, rows: readonly T[]): void {
    if (rows.length === 0) return;
    if (this.engine !== engine) {
      if (this.engine && this.rows.length > 0 && engineKey(this.engine) !== engineKey(engine)) {
        const handoff: Promise<void> = this.write(this.engine, this.rows).catch(() => {}).finally(() => { this.handoffs.delete(handoff); });
        this.handoffs.add(handoff);
        this.rows = [];
      }
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

  pending(): Promise<void> | null {
    const work = [...this.handoffs, ...(this.inFlight ? [this.inFlight] : [])];
    return work.length > 0 ? Promise.all(work).then(() => {}) : null;
  }
  hasBuffered(): boolean { return this.rows.length > 0; }
  reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.rows = [];
    this.engine = null;
    this.inFlight = null;
    this.handoffs.clear();
  }
}

const receipts = new BufferedWriter<ReceiptRow>((engine, rows) => engine.insertDecideReceipts(rows));
const spend = new BufferedWriter<SpendRow>((engine, rows) => engine.insertDecideSpend(rows));

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
  await Promise.all([receipts.flush(), spend.flush(), receipts.pending(), spend.pending()]);
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
  spendCache = new WeakMap();
  saltCache = new WeakMap();
}

// ---------------------------------------------------------------------------
// Internal state (decide_state): never a config key, so no config surface
// (get/list/snapshot/MCP/export) can print it.
// ---------------------------------------------------------------------------

export function getDecideState(engine: BrainEngine, key: string): Promise<string | null> {
  return engine.readDecideState(key);
}

export function setDecideState(engine: BrainEngine, key: string, value: string): Promise<void> {
  return engine.upsertDecideState(key, value);
}

export function deleteDecideState(engine: BrainEngine, key: string): Promise<void> {
  return engine.deleteDecideState(key);
}

const SALT_KEY = 'receipt_hmac_salt';
let saltCache = new WeakMap<BrainEngine, Promise<string>>();

/** Per-brain receipt salt: 32 random bytes, insert-if-absent then re-read so concurrent processes agree. */
export function receiptSalt(engine: BrainEngine): Promise<string> {
  let cached = saltCache.get(engine);
  if (!cached) {
    cached = (async () => {
      const value = await engine.ensureDecideState(SALT_KEY, randomBytes(32).toString('hex'));
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
/** Keyed by engineKey: a transaction or view shares its engine's entry, and an engine dropped by its host takes its entry with it. */
let spendCache = new WeakMap<object, SpendCacheEntry>();
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function bumpSpendCache(engine: BrainEngine, row: SpendRow): void {
  const entry = spendCache.get(engineKey(engine));
  if (!entry || entry.day !== utcDay()) return;
  entry.total += row.cost_usd;
  if (row.remote) entry.remote += row.cost_usd;
}

export async function dailySpend(engine: BrainEngine, now = Date.now()): Promise<{ total: number; remote: number }> {
  const day = utcDay(now);
  const cached = spendCache.get(engineKey(engine));
  if (cached && cached.day === day && now - cached.at < SPEND_CACHE_MS) return { total: cached.total, remote: cached.remote };
  const sums = await engine.dailyDecideSpend(new Date(`${day}T00:00:00Z`));
  const entry = { day, at: now, total: sums.total, remote: sums.remote };
  spendCache.set(engineKey(engine), entry);
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

const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function normalizeCalibration(r: DecideCalibration): CalibrationRow {
  return {
    ...r,
    slot: r.slot as DecideSlot,
    created_at: r.created_at.toISOString(),
    retired_at: isoOrNull(r.retired_at),
    qualified_at: isoOrNull(r.qualified_at),
  };
}

export function insertCalibration(engine: BrainEngine, c: NewCalibration): Promise<number> {
  return engine.insertDecideCalibration(c);
}

export function storeQualification(engine: BrainEngine, id: number, q: { action_precision_lb: number | null; qualification: string; policy_fingerprint: string }): Promise<void> {
  return engine.storeDecideQualification(id, q);
}

export async function listCalibrations(engine: BrainEngine, filter: { slot?: DecideSlot; includeRetired?: boolean } = {}): Promise<CalibrationRow[]> {
  return (await engine.listDecideCalibrations(filter)).map(normalizeCalibration);
}

export async function getCalibration(engine: BrainEngine, id: number): Promise<CalibrationRow | null> {
  const row = await engine.getDecideCalibration(id);
  return row ? normalizeCalibration(row) : null;
}

export function setCalibrationRetired(engine: BrainEngine, id: number, retired: boolean): Promise<boolean> {
  return engine.setDecideCalibrationRetired(id, retired);
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

export function receiptStats(engine: BrainEngine, opts: { slot?: DecideSlot; sinceHours: number }): Promise<ReceiptStats[]> {
  return engine.listDecideReceiptStats(opts);
}

export interface SlotUsage { slot: string; decisions: number; rows: number; input_tokens: number; errors: number; skipped: number; egress: number }

/** Per-slot decision counts, tokens, errors and egress refusals over the window (status, doctor, cost estimates). */
export function slotUsage(engine: BrainEngine, sinceHours = 24): Promise<SlotUsage[]> {
  return engine.decideSlotUsage(sinceHours);
}

/** Conflict receipts in the window and how many were fact-level `no_entity` skips (facts the sweep cannot judge). */
export async function conflictNoEntityShare(engine: BrainEngine, sinceHours = 24 * 7): Promise<{ skipped: number; receipts: number; share: number }> {
  const { receipts, skipped } = await engine.decideConflictNoEntityCounts(sinceHours);
  return { skipped, receipts, share: receipts > 0 ? Number((skipped / receipts).toFixed(4)) : 0 };
}

export interface ReplayReceipt {
  decision_id: string;
  answer_value: number | null;
  protected: boolean;
  rank: number | null;
  min_keep: number | null;
  outcome: string;
}

export function replayReceipts(engine: BrainEngine, slot: DecideSlot, sinceHours: number): Promise<ReplayReceipt[]> {
  return engine.listDecideReplayReceipts(slot, sinceHours);
}

/** Most recent resolved model per (slot) over the window, for alias calibration lookup and drift. */
export async function recentResolvedModels(engine: BrainEngine, sinceHours = 24): Promise<Array<{ slot: string; provider: string; model_resolved: string; n: number; last_at: string }>> {
  const rows = await engine.listDecideResolvedModels(sinceHours);
  return rows.map((r) => ({ ...r, last_at: r.last_at.toISOString() }));
}

/** Decisions whose rows carried more than one resolved model (alias rollout), per slot. */
export function mixedModelDecisions(engine: BrainEngine, sinceHours = 24): Promise<Array<{ slot: string; n: number }>> {
  return engine.listDecideMixedModelDecisions(sinceHours);
}

/** Delete receipts older than the retention window (proposals are never pruned). */
export function pruneReceipts(engine: BrainEngine, retentionDays: number): Promise<number> {
  return engine.pruneDecideReceipts(retentionDays);
}

/** Cycle purge hook: prune receipts past decide.receipts.retention_days (default 7). */
export async function pruneReceiptsForCycle(engine: BrainEngine): Promise<number> {
  const raw = await engine.getConfig('decide.receipts.retention_days');
  const days = raw && /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : 7;
  return pruneReceipts(engine, days);
}

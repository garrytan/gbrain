/**
 * #7117: the content-drift sweep (#4246) as a resumable, budgeted pass.
 *
 * A chunk whose stored `embedded_text_hash` no longer matches md5(chunk_text)
 * carries a vector computed from an earlier text. Writers clear the hash and
 * the vector when they change chunk_text, so this sweep is a safety net, not
 * the main path. As one UPDATE it scanned all of content_chunks on every embed
 * job; on a large brain the pool's statement_timeout cancelled it every time,
 * nothing was kept, and the error was swallowed.
 *
 * Each step examines at most `batchRows` chunk rows in id order
 * (`invalidateContentDriftBatch`) and commits its invalidations together with
 * the cursor, in a config row keyed by the active embedding column and the
 * scope (`all` or `source:<id>`). One run stops at its time budget, the job
 * deadline or an abort, so a pass spans as many runs as it needs. Each step
 * locks the cursor row, so concurrent runs share one pass instead of
 * repeating it. A completed pass starts over only after
 * `embed.content_drift.pass_interval_hours` (default 24); a pass that fit in
 * one batch costs one bounded statement and repeats on every run.
 */
import type { BrainEngine } from './engine.ts';
import { CONTENT_DRIFT_BATCH_ROWS, invalidateContentDriftBatch, type ContentDriftBatch } from './engine-sql/chunks.ts';
import { resolveActiveEmbeddingColumnFromEngine } from './search/embedding-column.ts';
import { isMissingSchemaObject } from './utils.ts';

export const CONTENT_DRIFT_SWEEP_KEY_PREFIX = 'embed.content_drift_sweep.';
export const CONTENT_DRIFT_PASS_INTERVAL_KEY = 'embed.content_drift.pass_interval_hours';
export const DEFAULT_CONTENT_DRIFT_PASS_INTERVAL_HOURS = 24;
/** Wall time one run may spend sweeping; one batch is far shorter than any statement_timeout. */
export const DEFAULT_CONTENT_DRIFT_TIME_BUDGET_MS = 60_000;

/** The saved cursor and pass record for one (column, scope). */
export interface ContentDriftSweepState {
  /** Last chunk id the current pass examined; 0 before a pass starts. */
  cursor: number;
  pass_started_at: string | null;
  pass_checked: number;
  pass_drifted: number;
  last_completed_at: string | null;
  last_pass_checked: number | null;
  last_pass_drifted: number | null;
  last_error: { at: string; message: string } | null;
}

export interface ContentDriftSweepStatus {
  scope: string;
  column: string | null;
  /**
   * complete: this run finished a pass. partial: it reached its time budget
   * with the cursor saved. waiting: the last pass completed less than the
   * interval ago, so nothing ran. stopped: an abort or the deadline stopped it.
   * failed: a batch failed (error says why; the cursor stays before it).
   * unsupported: the schema predates the drift columns (v133).
   */
  state: 'complete' | 'partial' | 'waiting' | 'stopped' | 'failed' | 'unsupported';
  checked: number;
  drifted: number;
  batches: number;
  cursor: number;
  last_completed_at: string | null;
  next_pass_at?: string;
  error?: string;
}

export interface ContentDriftSweepOpts {
  sourceId?: string;
  signal?: AbortSignal;
  /** Epoch ms the caller must stop by (a job deadline). */
  deadline?: number;
  /** Extra stop condition checked between batches. */
  stopped?: () => boolean;
  /** Runs inside every batch transaction, before and after its write; a throw ends the sweep and propagates. */
  assertOwned?: (tx: BrainEngine) => Promise<void>;
  timeBudgetMs?: number;
  batchRows?: number;
}

const EMPTY_STATE: ContentDriftSweepState = {
  cursor: 0, pass_started_at: null, pass_checked: 0, pass_drifted: 0,
  last_completed_at: null, last_pass_checked: null, last_pass_drifted: null, last_error: null,
};

export function contentDriftSweepKey(column: string, sourceId?: string): string {
  return `${CONTENT_DRIFT_SWEEP_KEY_PREFIX}${column}.${sourceId === undefined ? 'all' : `source:${sourceId}`}`;
}

export function parseContentDriftSweepState(raw: string | null | undefined): ContentDriftSweepState {
  if (!raw) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(raw) as Partial<ContentDriftSweepState>;
    const cursor = Number(parsed.cursor);
    return { ...EMPTY_STATE, ...parsed, cursor: Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0 };
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function passIntervalMs(engine: BrainEngine): Promise<number> {
  const raw = await engine.getConfig(CONTENT_DRIFT_PASS_INTERVAL_KEY);
  const hours = raw === null ? NaN : Number(raw);
  return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_CONTENT_DRIFT_PASS_INTERVAL_HOURS) * 3_600_000;
}

/** Lock the cursor row for this step (creating it first), so concurrent runs advance one shared pass. */
async function lockState(tx: BrainEngine, key: string): Promise<ContentDriftSweepState> {
  return parseContentDriftSweepState(await tx.lockContentDriftState(key, JSON.stringify(EMPTY_STATE)));
}

export async function runContentDriftSweep(engine: BrainEngine, opts: ContentDriftSweepOpts = {}): Promise<ContentDriftSweepStatus> {
  const stopAt = Math.min(Date.now() + (opts.timeBudgetMs ?? DEFAULT_CONTENT_DRIFT_TIME_BUDGET_MS), opts.deadline ?? Infinity);
  const stopped = () => !!opts.signal?.aborted || opts.stopped?.() === true || Date.now() >= (opts.deadline ?? Infinity);
  const batchRows = opts.batchRows ?? CONTENT_DRIFT_BATCH_ROWS;
  const status: ContentDriftSweepStatus = {
    scope: opts.sourceId === undefined ? 'all' : `source:${opts.sourceId}`,
    column: null, state: 'partial', checked: 0, drifted: 0, batches: 0, cursor: 0, last_completed_at: null,
  };
  const ownership: { lost: boolean; error?: unknown } = { lost: false };
  const own = async (tx: BrainEngine) => {
    try {
      await opts.assertOwned?.(tx);
    } catch (error) {
      ownership.lost = true;
      ownership.error = error;
      throw error;
    }
  };
  let key: string | null = null;
  try {
    const column = (await resolveActiveEmbeddingColumnFromEngine(engine)).name;
    status.column = column;
    const stateKey = contentDriftSweepKey(column, opts.sourceId);
    key = stateKey;
    const intervalMs = await passIntervalMs(engine);
    for (;;) {
      if (stopped()) { status.state = 'stopped'; return status; }
      if (Date.now() >= stopAt) { status.state = 'partial'; return status; }
      const step = await engine.transaction(async (tx): Promise<{ state: ContentDriftSweepState; nextAt: number } | { state: ContentDriftSweepState; batch: ContentDriftBatch }> => {
        await own(tx);
        const state = await lockState(tx, stateKey);
        if (state.cursor === 0 && state.last_completed_at && (state.last_pass_checked ?? 0) > batchRows) {
          const nextAt = Date.parse(state.last_completed_at) + intervalMs;
          if (Date.now() < nextAt) return { state, nextAt };
        }
        const batch = await invalidateContentDriftBatch(run => run(tx), column, {
          afterChunkId: state.cursor, limit: batchRows, ...(opts.sourceId !== undefined && { sourceId: opts.sourceId }),
        });
        const now = new Date().toISOString();
        const pass = state.cursor === 0
          ? { pass_started_at: now, pass_checked: batch.checked, pass_drifted: batch.drifted }
          : { pass_started_at: state.pass_started_at, pass_checked: state.pass_checked + batch.checked, pass_drifted: state.pass_drifted + batch.drifted };
        const next: ContentDriftSweepState = batch.lastChunkId === null
          ? { ...EMPTY_STATE, last_completed_at: now, last_pass_checked: pass.pass_checked, last_pass_drifted: pass.pass_drifted }
          : { ...state, ...pass, cursor: batch.lastChunkId, last_error: null };
        await own(tx);
        await tx.setConfig(stateKey, JSON.stringify(next));
        return { state: next, batch };
      });
      status.cursor = step.state.cursor;
      status.last_completed_at = step.state.last_completed_at;
      if ('nextAt' in step) {
        status.state = 'waiting';
        status.next_pass_at = new Date(step.nextAt).toISOString();
        return status;
      }
      status.batches += 1;
      status.checked += step.batch.checked;
      status.drifted += step.batch.drifted;
      if (step.batch.lastChunkId === null) { status.state = 'complete'; return status; }
    }
  } catch (error) {
    if (ownership.lost) throw ownership.error;
    if (stopped()) { status.state = 'stopped'; return status; }
    status.error = error instanceof Error ? error.message : String(error);
    if (isMissingSchemaObject(error, 'column', ['embedded_text_hash', 'embedding_pending_since'])) {
      status.state = 'unsupported';
      return status;
    }
    status.state = 'failed';
    if (key) {
      const failedKey = key;
      const last_error = { at: new Date().toISOString(), message: status.error.slice(0, 500) };
      await engine.transaction(async tx => {
        const state = await lockState(tx, failedKey);
        status.cursor = state.cursor;
        await tx.setConfig(failedKey, JSON.stringify({ ...state, last_error }));
      }).catch(() => {});
    }
    return status;
  }
}

/** One line for stderr, naming what the sweep did and where it stands. */
export function describeContentDriftSweep(s: ContentDriftSweepStatus): string {
  const counts = `${s.checked} chunk(s) checked in ${s.batches} batch(es), ${s.drifted} invalidated`;
  switch (s.state) {
    case 'complete': return `content-drift sweep (${s.scope}) completed a pass: ${counts}`;
    case 'partial': return `content-drift sweep (${s.scope}) reached its time budget at chunk id ${s.cursor}: ${counts}; the next run resumes there`;
    case 'stopped': return `content-drift sweep (${s.scope}) stopped at chunk id ${s.cursor}: ${counts}; the next run resumes there`;
    case 'waiting': return `content-drift sweep (${s.scope}) is idle until ${s.next_pass_at} (last pass completed ${s.last_completed_at})`;
    case 'unsupported': return `content-drift sweep (${s.scope}) skipped: this schema predates embedded_text_hash; run gbrain apply-migrations --yes`;
    case 'failed': return `content-drift sweep (${s.scope}) FAILED at chunk id ${s.cursor} after ${counts}: ${s.error}; the cursor stays before the failed batch`;
  }
}

/** The stderr line for a run: a failure always, otherwise the status unless quiet or idle. */
export function contentDriftSweepLine(s: ContentDriftSweepStatus, quiet: boolean): string | null {
  if (s.state === 'failed') return `WARNING: ${describeContentDriftSweep(s)}`;
  return quiet || s.state === 'waiting' ? null : describeContentDriftSweep(s);
}

/** Every saved sweep state, for doctor. */
export async function readContentDriftSweepStates(engine: BrainEngine): Promise<Array<{ key: string; state: ContentDriftSweepState }>> {
  const config = await engine.getAllConfig();
  return Object.keys(config).filter(key => key.startsWith(CONTENT_DRIFT_SWEEP_KEY_PREFIX)).sort()
    .map(key => ({ key, state: parseContentDriftSweepState(config[key]) }));
}

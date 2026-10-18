/**
 * C-9 (#6948 sweep, #6761): the retry set for dead page-write facts-absorb jobs.
 *
 * A put_page's facts-backstop effect submits one facts-absorb job (idempotency key facts-absorb:write:<request id>,
 * 5 attempts) and completes as 'queued' in the same transaction, so nothing dispatches it again. When the job dies
 * on a provider or configuration failure (an outage, a revoked key, #6113), that revision's facts would never land.
 *
 * Each maintenance pass (the facts_drain cycle phase, any engine) reads the dead page-write jobs. A job whose error
 * is a provider or configuration failure is recorded in a durable set keyed by its idempotency key (config row
 * facts.absorb_retry.state). Once the cause has cleared (extraction enabled and its model servable), the pass
 * re-submits it in place (gbrain jobs retry semantics: same row, same key, fresh attempts), at most
 * facts.absorb_retry.max_resubmits times per key (default 3; 0 disables) and at most once an hour per key, and at
 * most MAX_RESUBMITS_PER_PASS keys per pass. A key at its limit is exhausted: it stays dead and visible until an
 * operator resets it (gbrain facts retry-dead --reset <key>) or clears it (--clear <key>: never re-submitted again).
 * A job that died on anything else (a deterministic write refusal, an unclassified error) is not retryable: it stays
 * dead and is counted. Entries settle when their job completes or its row is gone.
 */
import type { BrainEngine } from '../engine.ts';
import { classifyJobError } from '../minions/error-classify.ts';

export const FACTS_ABSORB_RETRY_STATE_KEY = 'facts.absorb_retry.state';
export const FACTS_ABSORB_RETRY_MAX_KEY = 'facts.absorb_retry.max_resubmits';
export const DEFAULT_MAX_RESUBMITS = 3;
export const MAX_RESUBMITS_PER_PASS = 20;
export const RESUBMIT_SPACING_MS = 60 * 60_000;
const WRITE_KEY_PREFIX = 'facts-absorb:write:';

export type DeadAbsorbClass = 'provider' | 'config' | 'not_retryable';

/**
 * Provider and configuration failures clear on their own or with an operator fix; everything else stays dead.
 * Extraction failures carry `[facts-extract] <reason> (model=..) (cause=<class> <global llm class>)` (extract.ts):
 * provider_error and chat_unavailable are retryable; refusal, content filter, malformed or truncated output fail the
 * same way on the same page text.
 */
export function classifyDeadFactsAbsorb(errorText: string | null | undefined): DeadAbsorbClass {
  const text = errorText ?? '';
  if (/facts_absorb_write_refused/.test(text)) return 'not_retryable';
  const extract = /^\[facts-extract\] ([a-z_]+)/.exec(text);
  if (extract) {
    if (extract[1] === 'chat_unavailable') return 'config';
    if (extract[1] !== 'provider_error') return 'not_retryable';
    return /\(cause=[^)]*\b(auth|billing|model_not_found)\b/.test(text) ? 'config' : 'provider';
  }
  if (/chat_unavailable|no usable provider key|not servable|model[_ ]not[_ ]found|billing|insufficient[_ ]quota|credit/i.test(text)) return 'config';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|fetch failed|socket hang up|network error/i.test(text)) return 'provider';
  const cluster = classifyJobError(text);
  if (cluster === 'auth') return 'config';
  if (cluster === 'rate_limit' || cluster === 'rate_lease_full' || cluster === 'http_5xx' || cluster === 'timeout') return 'provider';
  return 'not_retryable';
}

export interface RetryEntry {
  /** not_retryable only when an operator reset that key by name. */
  job_id: number; slug: string | null; source_id: string; class: DeadAbsorbClass;
  first_dead_at: string; resubmits: number; last_resubmit_at: string | null; cleared_at: string | null;
}
interface RetryState { version: 1; keys: Record<string, RetryEntry> }

export interface DeadAbsorbRetryResult {
  max_resubmits: number;
  /** Retryable dead jobs in the set that the next pass may re-submit (under the limit, not cleared). */
  pending: number;
  resubmitted: number;
  /** Keys at the limit: dead until reset. */
  exhausted: Array<{ key: string; job_id: number; slug: string | null; resubmits: number }>;
  cleared: number;
  not_retryable: Array<{ job_id: number; slug: string | null }>;
  /** Why nothing was re-submitted this pass although keys were pending. */
  waiting_on?: 'extraction_disabled' | 'extraction_unavailable' | 'spacing' | 'disabled' | 'dry_run';
}

export function factsRetryDeadCommand(flag: '--list' | '--reset' | '--clear', key?: string): string {
  return ['gbrain facts retry-dead', flag, ...(key ? [`'${key.replaceAll("'", "'\\''")}'`] : [])].join(' ');
}

export async function loadMaxResubmits(engine: BrainEngine): Promise<number> {
  const raw = await engine.getConfig(FACTS_ABSORB_RETRY_MAX_KEY).catch(() => null);
  if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_MAX_RESUBMITS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_RESUBMITS;
}

async function readState(engine: BrainEngine): Promise<RetryState> {
  try {
    const raw = await engine.getConfig(FACTS_ABSORB_RETRY_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<RetryState> : null;
    if (parsed && parsed.keys && typeof parsed.keys === 'object' && !Array.isArray(parsed.keys)) return { version: 1, keys: parsed.keys };
  } catch { /* an unreadable set is rebuilt from the dead rows */ }
  return { version: 1, keys: {} };
}

const writeState = (engine: BrainEngine, state: RetryState) => engine.setConfig(FACTS_ABSORB_RETRY_STATE_KEY, JSON.stringify(state));

const JOB_COLUMNS = "id, idempotency_key, status, error_text, data->>'slug' AS slug, COALESCE(data->>'sourceId', 'default') AS source_id, finished_at";
const newEntry = (row: JobRow, cls: DeadAbsorbClass, now: number): RetryEntry => ({ job_id: Number(row.id), slug: row.slug, source_id: row.source_id, class: cls,
  first_dead_at: new Date(row.finished_at ?? now).toISOString(), resubmits: 0, last_resubmit_at: null, cleared_at: null });

interface JobRow { id: number | string; idempotency_key: string; status: string; error_text: string | null; slug: string | null; source_id: string; finished_at: string | Date | null }

/** Reconcile the set with the dead rows; with apply, re-submit the eligible keys and persist. */
async function reconcile(engine: BrainEngine, opts: { apply: boolean; record?: boolean; now: number }): Promise<DeadAbsorbRetryResult> {
  const state = await readState(engine);
  const max = await loadMaxResubmits(engine);
  const rows = await engine.executeRaw<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM minion_jobs
      WHERE name = 'facts-absorb' AND idempotency_key LIKE $1 AND (status = 'dead' OR idempotency_key = ANY($2::text[]))`,
    [`${WRITE_KEY_PREFIX}%`, Object.keys(state.keys)]);
  const byKey = new Map(rows.map(r => [r.idempotency_key, r]));
  for (const key of Object.keys(state.keys)) {
    const row = byKey.get(key);
    if (!row || row.status === 'completed' || row.status === 'cancelled') delete state.keys[key];
  }
  const result: DeadAbsorbRetryResult = { max_resubmits: max, pending: 0, resubmitted: 0, exhausted: [], cleared: 0, not_retryable: [] };
  for (const row of rows) {
    if (row.status !== 'dead') continue;
    const cls = classifyDeadFactsAbsorb(row.error_text);
    const known = state.keys[row.idempotency_key];
    if (cls === 'not_retryable' && !known) { result.not_retryable.push({ job_id: Number(row.id), slug: row.slug }); continue; }
    state.keys[row.idempotency_key] = known ?? newEntry(row, cls, opts.now);
  }
  const due: string[] = [];
  let spaced = false;
  for (const [key, entry] of Object.entries(state.keys)) {
    if (byKey.get(key)?.status !== 'dead') continue;
    if (entry.cleared_at) { result.cleared++; continue; }
    if (entry.resubmits >= max) { result.exhausted.push({ key, job_id: entry.job_id, slug: entry.slug, resubmits: entry.resubmits }); continue; }
    result.pending++;
    if (entry.last_resubmit_at && opts.now - Date.parse(entry.last_resubmit_at) < RESUBMIT_SPACING_MS) { spaced = true; continue; }
    due.push(key);
  }
  if (max === 0 && Object.keys(state.keys).length) result.waiting_on = 'disabled';
  else if (due.length === 0 && result.pending > 0 && spaced) result.waiting_on = 'spacing';
  if (due.length && !opts.apply) result.waiting_on = 'dry_run';
  if (due.length && opts.apply) {
    const { isFactsExtractionEnabled } = await import('./extract.ts');
    const { resolveExtractionAvailability } = await import('./extraction-availability.ts');
    // As the drain does: a key or model fixed since the process started counts as the cause clearing.
    const { refreshGatewayEnvFromFilePlane, reconfigureGatewayWithEngine } = await import('../ai/gateway.ts');
    refreshGatewayEnvFromFilePlane();
    await reconfigureGatewayWithEngine(engine).catch(() => undefined);
    if (!await isFactsExtractionEnabled(engine)) result.waiting_on = 'extraction_disabled';
    else if (!(await resolveExtractionAvailability(engine)).available) result.waiting_on = 'extraction_unavailable';
    else {
      const { MinionQueue } = await import('../minions/queue.ts');
      const queue = new MinionQueue(engine);
      for (const key of due.slice(0, MAX_RESUBMITS_PER_PASS)) {
        const entry = state.keys[key]!;
        if (!await queue.retryJob(entry.job_id)) continue;
        entry.resubmits++;
        entry.last_resubmit_at = new Date(opts.now).toISOString();
        result.resubmitted++;
        result.pending--;
      }
    }
  }
  if (opts.apply || opts.record) await writeState(engine, state);
  return result;
}

/** One maintenance pass: record, settle and re-submit. dryRun reports what would happen and writes nothing. */
export function retryDeadFactsAbsorb(engine: BrainEngine, opts: { dryRun?: boolean; now?: number } = {}): Promise<DeadAbsorbRetryResult> {
  return reconcile(engine, { apply: !opts.dryRun, now: opts.now ?? Date.now() });
}

/** Read-only status for doctor and gbrain facts retry-dead --list (nothing is written or re-submitted). */
export async function readDeadFactsAbsorbRetry(engine: BrainEngine, now = Date.now()): Promise<DeadAbsorbRetryResult> {
  const r = await reconcile(engine, { apply: false, now });
  if (r.waiting_on === 'dry_run') delete r.waiting_on;
  return r;
}

/**
 * Operator controls. reset: the key's resubmits count from zero and it is no longer cleared, so the next pass may
 * re-submit it; naming a dead page-write job the set does not hold (one that died not retryable, after its cause was
 * fixed) adds it. clear: the key is never re-submitted again and stays listed as cleared. Returns the keys changed.
 */
export async function updateDeadFactsAbsorbKeys(engine: BrainEngine, action: 'reset' | 'clear', keys: string[] | 'all', now = Date.now()): Promise<string[]> {
  await reconcile(engine, { apply: false, record: true, now });
  const state = await readState(engine);
  if (keys !== 'all') {
    const rows = await engine.executeRaw<JobRow>(`SELECT ${JOB_COLUMNS} FROM minion_jobs WHERE name = 'facts-absorb' AND status = 'dead' AND idempotency_key = ANY($1::text[])`, [keys]);
    for (const row of rows) state.keys[row.idempotency_key] ??= newEntry(row, classifyDeadFactsAbsorb(row.error_text), now);
  }
  const targets = (keys === 'all' ? Object.keys(state.keys) : keys).filter(k => state.keys[k]);
  for (const key of targets) {
    const entry = state.keys[key]!;
    if (action === 'reset') { entry.resubmits = 0; entry.last_resubmit_at = null; entry.cleared_at = null; }
    else entry.cleared_at = new Date(now).toISOString();
  }
  await writeState(engine, state);
  return targets;
}

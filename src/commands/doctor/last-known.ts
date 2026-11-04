/**
 * #7142: last known doctor results.
 *
 * On a large brain a standard run cannot finish every check inside the
 * non-interactive default budget, and the quick tier does not run the slow
 * checks at all. Every completed standard or deep entry records the checks it
 * emitted in `op_checkpoints` (op `doctor-last-known`, one row per entry, so
 * the jobs worker and the CLI share it whatever GBRAIN_HOME each has). A later
 * run that did not finish an entry, or a quick-tier run that did not run it,
 * reports that entry's last known checks with their age instead of nothing or
 * an unknown. A result older than LAST_KNOWN_MAX_AGE_MS is not served: those
 * checks are named as unknown in one `doctor_last_known` check (status warn,
 * so the report is never healthy on them), and a `doctor-refresh` job is
 * queued to measure them in the background with a long per-check budget.
 *
 * Only a brain-wide local CLI run (no --only, no --source, not remote) reads or
 * writes these rows; writing is best-effort and never fails the run.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { Check } from '../doctor.ts';
import type { DoctorContext, DoctorEntry } from './context.ts';

export const LAST_KNOWN_OP = 'doctor-last-known';
/** A last known result older than this is not served; its checks are unknown. */
export const LAST_KNOWN_MAX_AGE_MS = 24 * 60 * 60_000;
/** An entry whose last known result is older than this is measured again by the background refresh. */
export const REFRESH_AFTER_MS = 60 * 60_000;
/** The background refresh job and its per-check budget (the time a slow check needs on a large brain, not 15 s). */
export const REFRESH_JOB = 'doctor-refresh';
export const REFRESH_ENTRY_BUDGET_MS = 600_000;
/**
 * #7263: the whole refresh's budget, well under its hourly slot. Past it no further check starts (the one running is cut
 * at it), what finished is recorded and the rest stays unknown for the next slot; the job still completes.
 */
export const REFRESH_BUDGET_MS = 10 * 60_000;
const REFRESH_TIMEOUT_MS = 15 * 60_000;
/** #7263: behind sync (-10, 0, continuations 5), the autopilot cycles and global maintenance (0), embed backfill and loops extract (5). */
const REFRESH_PRIORITY = 10;
/** #7263: `false` turns the background refresh off (DB plane; default on). */
export const BACKGROUND_REFRESH_KEY = 'doctor.background_refresh';
/** Bound of the cache read and write (they run outside every entry's deadline). */
const IO_BOUND_MS = 3_000;

/**
 * `emits`: the checks the entry emitted when it was recorded. A check the entry emits now and did not then (added by a later
 * release, or a result recorded before `emits` was stored and not among its checks) has no last known result.
 */
export interface LastKnownEntry { checks: Check[]; measured_at: string; elapsed_ms: number; emits?: string[] }

/** What a run asks of the last known results: `serve` reports them for entries it did not finish; `record` stores the ones it did. */
export interface LastKnownMode { serve: boolean; record: boolean; refresh: boolean }

/** One entry's outcome in this run. */
export interface EntryOutcome { entry: DoctorEntry; state: 'done' | 'expired' | 'not_run'; checks: Check[]; elapsed_ms: number }

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('doctor last-known I/O timed out')), IO_BOUND_MS); });
  try { return await Promise.race([work, expiry]); } finally { if (timer) clearTimeout(timer); }
}

/** Every entry's last known result; an unreadable store reads as empty (nothing is served, so nothing reads as healthy). */
export async function readLastKnown(engine: BrainEngine): Promise<Map<string, LastKnownEntry>> {
  try {
    const rows = await bounded(engine.executeRaw<{ fingerprint: string; entry: unknown }>(
      'SELECT fingerprint, completed_keys->0 AS entry FROM op_checkpoints WHERE op = $1', [LAST_KNOWN_OP]));
    const out = new Map<string, LastKnownEntry>();
    for (const row of rows) {
      const value = (typeof row.entry === 'string' ? JSON.parse(row.entry) : row.entry) as LastKnownEntry | null;
      if (value && Array.isArray(value.checks) && typeof value.measured_at === 'string') out.set(row.fingerprint, value);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Store the entries this run finished (best-effort: a read-only role or an old schema just keeps the previous results). */
export async function writeLastKnown(engine: BrainEngine, outcomes: readonly EntryOutcome[], now = Date.now()): Promise<void> {
  const rows = outcomes.filter(o => o.state === 'done').map(o => ({ entry: o.entry.name,
    value: { checks: o.checks.filter(c => c.details?.last_known === undefined), measured_at: new Date(now).toISOString(), elapsed_ms: o.elapsed_ms,
      emits: [...o.entry.emits] } satisfies LastKnownEntry }));
  if (!rows.length) return;
  try {
    await bounded(engine.executeRaw(
      `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
       SELECT $1, e->>'entry', jsonb_build_array(e->'value'), now() FROM jsonb_array_elements($2::text::jsonb) AS e
       ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = EXCLUDED.updated_at`,
      [LAST_KNOWN_OP, JSON.stringify(rows)]));
  } catch { /* the previous results stay; the next run that can write records them */ }
}

function ageText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 120) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

/** One check from a last known result, with its age; its status is the one it had then. */
export function lastKnownCheck(check: Check, measuredAt: string, reason: 'not_in_tier' | 'budget', now = Date.now()): Check {
  const age = Math.max(0, now - Date.parse(measuredAt));
  const why = reason === 'budget' ? 'not finished within this run\'s budget' : 'not run by the quick tier';
  return { ...check, message: `Last known, ${ageText(age)} ago (${why}): ${check.message}`,
    details: { ...check.details, last_known: { measured_at: measuredAt, age_ms: age, reason } } };
}

/**
 * Apply the last known results to a finished run: an entry that expired or was not run at this tier reports its
 * last known checks when they are fresh; otherwise its checks are listed in one `doctor_last_known` warning (and an
 * expired entry keeps its unknown checks). Returns the checks to report and the entries a refresh should measure.
 */
export function applyLastKnown(checks: Check[], outcomes: readonly EntryOutcome[], cache: ReadonlyMap<string, LastKnownEntry>, now = Date.now()): { checks: Check[]; stale: EntryOutcome[]; refresh: string[] } {
  const replaced = new Set<string>();
  const served: Check[] = [];
  const stale: EntryOutcome[] = [];
  const refresh: string[] = [];
  for (const outcome of outcomes) {
    const last = cache.get(outcome.entry.name);
    const age = last ? now - Date.parse(last.measured_at) : Infinity;
    if (outcome.state === 'done') continue;
    if (!last || !(age <= REFRESH_AFTER_MS)) refresh.push(outcome.entry.name);
    if (last && age <= LAST_KNOWN_MAX_AGE_MS) {
      // GST-1209 follow-up: a check the recorded result never covered keeps this run's unknown (expired) or is named unmeasured (not run).
      const covered = new Set(last.emits ?? last.checks.map(c => c.name));
      const uncovered = outcome.entry.emits.filter(name => !covered.has(name));
      if (outcome.state === 'expired') for (const name of outcome.entry.emits) if (covered.has(name)) replaced.add(name);
      if (outcome.state === 'not_run' && uncovered.length) stale.push({ ...outcome, entry: { ...outcome.entry, emits: uncovered } });
      served.push(...last.checks.filter(c => outcome.entry.emits.includes(c.name)).map(c => lastKnownCheck(c, last.measured_at, outcome.state === 'expired' ? 'budget' : 'not_in_tier', now)));
    } else if (outcome.state === 'not_run') {
      stale.push(outcome);
    }
  }
  return { checks: [...checks.filter(c => !replaced.has(c.name)), ...served], stale, refresh };
}

/** The one warning that names the checks with no result inside LAST_KNOWN_MAX_AGE_MS (never measured, or too old). */
export function unmeasuredCheck(stale: readonly EntryOutcome[], cache: ReadonlyMap<string, LastKnownEntry>, refreshJob: { id: number } | null, engineKind: string | undefined): Check | null {
  if (!stale.length) return null;
  const names = [...new Set(stale.flatMap(o => o.entry.emits))].sort();
  const old = stale.filter(o => cache.has(o.entry.name)).length;
  const argv = ['gbrain', 'doctor', '--tier', 'standard', '--budget-ms', '0', '--json'];
  const queued = refreshJob ? ` A background refresh is queued (job #${refreshJob.id}); it needs a running jobs worker${engineKind === 'pglite' ? ' (gbrain jobs work)' : ''}.` : '';
  return {
    name: 'doctor_last_known', status: 'warn',
    message: `${names.length} check(s) have no result from the last ${LAST_KNOWN_MAX_AGE_MS / 3_600_000} h (${old === stale.length ? 'their last results are too old' : old ? `${old} of ${stale.length} entries have only an older result, the rest were never measured` : 'never measured'}); their health is unknown, not clear.${queued} Measure them now with: ${argv.join(' ')}`,
    details: { health: 'unknown', reason: 'not_measured', exact: false, unknown_checks: names, ...(refreshJob ? { refresh_job: refreshJob.id } : {}) },
    fix: { argv, consent: [], actor: 'user', requires_exclusive: false, why: 'Runs every standard check with no overall budget and records each result, so later quick runs report them; read-only, and it can take minutes on a large brain.' },
  };
}

/** Queue one background refresh (deduplicated per hour); null when it cannot be queued or `doctor.background_refresh` is false. */
export async function queueRefresh(engine: BrainEngine, now = Date.now()): Promise<{ id: number } | null> {
  try {
    if ((await bounded(engine.getConfig(BACKGROUND_REFRESH_KEY)))?.trim().toLowerCase() === 'false') return null;
    const { MinionQueue } = await import('../../core/minions/queue.ts');
    const slot = new Date(now).toISOString().slice(0, 13);
    const job = await bounded(new MinionQueue(engine).add(REFRESH_JOB, {}, { queue: 'default', idempotency_key: `${REFRESH_JOB}:${slot}`, max_attempts: 1, timeout_ms: REFRESH_TIMEOUT_MS, priority: REFRESH_PRIORITY, maxWaiting: 1 }));
    return { id: Number(job.id) };
  } catch {
    return null;
  }
}

/** Whether this run reads or writes the last known results (only a brain-wide local run, never `--only`). */
export function lastKnownMode(ctx: Pick<DoctorContext, 'only' | 'sourceIds' | 'orphanRatioSourceId' | 'doFix' | 'tier' | 'lastKnown'>): LastKnownMode | null {
  if (!ctx.lastKnown || ctx.only || ctx.sourceIds || ctx.orphanRatioSourceId || ctx.doFix || ctx.tier === 'ops') return null;
  return { serve: true, record: ctx.tier === 'standard' || ctx.tier === 'deep', refresh: ctx.lastKnown === 'cli' };
}

/**
 * The `doctor-refresh` job: every standard-tier database check, each with REFRESH_ENTRY_BUDGET_MS and all of them within
 * `budgetMs`, recorded as last known results. Read-only apart from that record; it never queues another refresh.
 */
export async function runDoctorRefresh(engine: BrainEngine, budgetMs = REFRESH_BUDGET_MS): Promise<{ recorded: number; unfinished: string[]; elapsed_ms: number }> {
  const started = Date.now();
  const { buildChecks } = await import('../doctor.ts');
  const checks = await buildChecks(engine, ['--json', '--tier', 'standard', '--scope=brain', '--budget-ms', String(budgetMs)], undefined, undefined, undefined, { lastKnown: 'refresh', entryBudgetOverrideMs: REFRESH_ENTRY_BUDGET_MS, refreshOnly: true });
  const unfinished = [...new Set(checks.filter(c => c.details?.health === 'unknown' && c.details.reason === 'budget').map(c => c.name))];
  return { recorded: checks.length - unfinished.length, unfinished, elapsed_ms: Date.now() - started };
}


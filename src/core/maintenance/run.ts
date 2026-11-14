/**
 * Unattended upkeep (GBRA-438): the free, never-purging maintenance a brain
 * runs with nobody watching, and the runner core `gbrain maintain --safe`
 * shares its step list with.
 *
 * One run is a list of work items: one global item (the brain-wide free
 * phases, once per window, under the shared `gbrain-cycle` lease) and one
 * item per source (its source-scoped free phases, under that source's lease),
 * then the embedding catch-up step on a brain with an embedding key, under a
 * daily dollar cap (`maintenance.embed_daily_usd`, default $1, 0 turns it
 * off). Nothing here purges a page or calls a chat model; the page purge
 * stays preview-first (`gbrain maintain --purge`), and every other paid phase
 * stays with `gbrain dream` or an installed autopilot.
 *
 * Cycles run with `stamp: 'none'`, so upkeep never writes
 * `last_full_cycle_at` or `last_source_cycle_at`. Its own record is
 * `maintenance.last_run` in the database config, which is also the record on
 * a repo-less brain. The runner never throws to its caller: every skip and
 * failure comes back as an outcome with a code and a fix.
 */
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { ALL_PHASES, LAST_GLOBAL_AT_KEY, PHASE_SCOPE, anyAbortSignal, resolveCyclePhases, runCycle, type CycleOpts, type CyclePhase, type CycleReport } from '../cycle.ts';
import { MANAGED_PHASE_TABLE } from '../cycle/phase-table.ts';
import { isAvailable } from '../ai/gateway.ts';
import { fenceRepairLlmEnabled } from '../fence-repair/config.ts';
import { resolveFenceRepairModel } from '../fence-repair/model.ts';
import { resolveContentRepairModel } from '../content-repair/llm.ts';
import { loadConfigSnapshot } from '../config-snapshot.ts';
import { readDecideConfig } from '../ai/decide/config.ts';
import { hasTypesafeKey } from '../ai/decide/index.ts';
import { isEngineDegraded } from '../degraded-marker.ts';
import { hasPendingMigrations } from '../migrate-pending.ts';
import { tryAcquireDbLock } from '../db-lock.ts';

export const MAINTENANCE_LAST_RUN_KEY = 'maintenance.last_run';
export const MAINTENANCE_AUTO_KEY = 'maintenance.auto';
export const MAINTENANCE_EMBED_DAILY_USD_KEY = 'maintenance.embed_daily_usd';
/** Unattended embedding spend per UTC day: `{ day, usd }`. */
export const MAINTENANCE_EMBED_SPEND_KEY = 'maintenance.embed_spend';
export const DEFAULT_EMBED_DAILY_USD = 1;
/** A finished round is due again after this long. */
export const UPKEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A step failing with the same code this many runs in a row backs off to once a week. */
export const UPKEEP_BACKOFF_FAILURES = 3;
export const UPKEEP_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A budgeted (serve) run parks an item that its budget stopped this many times in one round: the round settles without
 * it and budgeted runs skip it until the next round, an unbudgeted run (`gbrain maintain --unattended`, the schedule) or
 * a serve's first idle run (`retryParked`) runs it again. A foreground request's abort never counts as a slice.
 */
export const UPKEEP_PARK_AFTER_SLICES = 30;
/** One runner embeds at a time, so two serves finishing a round together never both spend the day's cap. */
export const MAINTENANCE_EMBED_LOCK_ID = 'gbrain-maintenance-embed';
/** An autopilot whose global pass is younger than this owns upkeep. */
export const AUTOPILOT_OWNS_WITHIN_MS = 48 * 60 * 60 * 1000;

/**
 * The cycle phases `--safe` may run: free, and never hard-deleting. The page
 * purge and every phase that calls a model stay with `gbrain dream` and
 * `gbrain pages purge-deleted`.
 */
export const MAINTAIN_SAFE_PHASES: readonly CyclePhase[] = [
  'lint', 'backlinks', 'sync', 'fence_repair', 'content_repair', 'unindexed_files',
  'extract', 'extract_facts', 'resolve_symbol_edges', 'recompute_emotional_weight',
  'consolidate', 'orphans', 'schema-suggest',
];

/** Which providers a safe phase would call on this brain; those phases are held back. */
export interface SafePhaseProviders {
  embedding: boolean;
  decideConflict: boolean;
  fenceRepairModel: boolean;
  contentRepairModel: boolean;
}

export function maintainSafePhases(sourceId: string, providers: SafePhaseProviders): { phases: CyclePhase[]; held: CyclePhase[] } {
  const held: CyclePhase[] = [];
  if (providers.embedding || providers.decideConflict) held.push('extract_facts');
  if (providers.fenceRepairModel || providers.embedding) held.push('fence_repair');
  if (providers.contentRepairModel || providers.embedding) held.push('content_repair');
  const phases = resolveCyclePhases(undefined, sourceId)
    .filter((phase) => MAINTAIN_SAFE_PHASES.includes(phase) && !held.includes(phase));
  return { phases, held };
}

export async function readSafePhaseProviders(engine: BrainEngine): Promise<SafePhaseProviders> {
  const repairLlm = await fenceRepairLlmEnabled(engine);
  return {
    embedding: isAvailable('embedding'),
    decideConflict: readDecideConfig(await loadConfigSnapshot(engine), { typesafeKey: hasTypesafeKey() }).slots.conflict.mode !== 'off',
    fenceRepairModel: repairLlm && (await resolveFenceRepairModel(engine)) !== null,
    contentRepairModel: repairLlm && (await resolveContentRepairModel(engine)) !== null,
  };
}

export interface UpkeepPlan {
  /** Brain-wide phases, one item per run. */
  global: CyclePhase[];
  /** Source-scoped phases, one item per source. */
  source: CyclePhase[];
  /** Phases left out because they would call a provider on this brain. */
  held: CyclePhase[];
  /** An embedding key exists: extract_facts writes new rows without vectors and the capped embedding step adds them. */
  embedding: boolean;
}

/**
 * The unattended step list for this brain: the `--safe` phases plus the
 * bookkeeping GC (decision C1). extract_facts stays in on a keyed brain with
 * its embedding deferred; it is held only when the System One conflict slot
 * would call its provider. The repair lanes stay held whenever their LLM step
 * is on or an embedding key exists, because their publications embed.
 */
export function unattendedPlan(providers: SafePhaseProviders): UpkeepPlan {
  const held: CyclePhase[] = [];
  if (providers.decideConflict) held.push('extract_facts');
  if (providers.fenceRepairModel || providers.embedding) held.push('fence_repair');
  if (providers.contentRepairModel || providers.embedding) held.push('content_repair');
  const steps = ALL_PHASES.filter((phase) => (MAINTAIN_SAFE_PHASES.includes(phase) || phase === 'bookkeeping_gc') && !held.includes(phase));
  return {
    global: steps.filter((phase) => PHASE_SCOPE[phase] !== 'source'),
    source: steps.filter((phase) => PHASE_SCOPE[phase] === 'source'),
    held,
    embedding: providers.embedding,
  };
}

/** Paid-tier phases: what upkeep leaves for the person (`gbrain dream`, autopilot). */
export const PAID_PHASES: readonly CyclePhase[] = ALL_PHASES.filter((phase) => MANAGED_PHASE_TABLE[phase].tier === 'paid');

export type UpkeepStepStatus = 'ok' | 'warn' | 'fail' | 'skipped';
export interface UpkeepStep { name: string; scope: string; status: UpkeepStepStatus; code?: string; reason?: string }
export interface UpkeepFailure { step: string; scope: string; code: string; count: number; last_at: string }
export interface UpkeepRecord {
  at: string;
  runner: string;
  status: 'ok' | 'partial' | 'failed';
  steps: UpkeepStep[];
  held: CyclePhase[];
  /**
   * Items already settled in an unfinished round; null once the round finished. `attempts` counts a budgeted run's
   * unfinished slices per item, `retry` names parked items this round runs again, and `due_at` is the due time a
   * round that only reruns parked items keeps.
   */
  cursor: { round_started_at: string; done: string[]; attempts?: Record<string, number>; retry?: string[]; due_at?: string } | null;
  /** Items budgeted runs gave up on (UPKEEP_PARK_AFTER_SLICES), with their total unfinished slices. */
  parked?: Array<{ key: string; since: string; slices: number }>;
  next_due_at: string;
  consecutive_failures: UpkeepFailure[];
  embed?: { spent_today_usd: number; cap_usd: number };
  last_skip?: { at: string; code: string };
}

export interface UpkeepOutcome {
  status: 'ran' | 'skipped' | 'not_due';
  /** 0 for every skip; 1 when a step failed (`maintain` only; the serve never exits). */
  exit: 0 | 1;
  code?: string;
  message: string;
  fix?: Action;
  record?: UpkeepRecord;
}

export interface UpkeepOpts {
  runner: string;
  now?: () => Date;
  /** Wall-clock budget for the whole run; an unfinished round resumes on the next run. */
  budgetMs?: number;
  signal?: AbortSignal;
  /** A serve's first idle run: parked items get one more set of UPKEEP_PARK_AFTER_SLICES slices. */
  retryParked?: boolean;
  /** Test seams. */
  providers?: SafePhaseProviders;
  capacityPaused?: (engine: BrainEngine) => Promise<{ command: string; config_key: string } | null>;
  cycle?: typeof runCycle;
}

const RUNNER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const isValidRunnerName = (name: string): boolean => RUNNER_NAME.test(name);

export async function readUpkeepRecord(engine: BrainEngine): Promise<UpkeepRecord | null> {
  const raw = await engine.getConfig(MAINTENANCE_LAST_RUN_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UpkeepRecord;
    return parsed && typeof parsed.at === 'string' && Array.isArray(parsed.steps) ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether a run would do work now: no record yet, a round left unfinished, or past next_due_at. */
export function upkeepDue(record: UpkeepRecord | null, now: Date): boolean {
  return !record || !!record.cursor || !(Date.parse(record.next_due_at) > now.getTime());
}

export async function upkeepEnabled(engine: BrainEngine): Promise<boolean> {
  const raw = (await engine.getConfig(MAINTENANCE_AUTO_KEY).catch(() => null))?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

export async function readEmbedDailyCapUsd(engine: BrainEngine): Promise<number> {
  const raw = (await engine.getConfig(MAINTENANCE_EMBED_DAILY_USD_KEY).catch(() => null))?.trim();
  if (!raw) return DEFAULT_EMBED_DAILY_USD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_EMBED_DAILY_USD;
}

const utcDay = (at: Date) => at.toISOString().slice(0, 10);

export async function readEmbedSpentToday(engine: BrainEngine, now: Date): Promise<number> {
  const raw = await engine.getConfig(MAINTENANCE_EMBED_SPEND_KEY).catch(() => null);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { day?: string; usd?: number };
    return parsed.day === utcDay(now) && typeof parsed.usd === 'number' && Number.isFinite(parsed.usd) ? parsed.usd : 0;
  } catch {
    return 0;
  }
}

/** Whether an autopilot keeps this brain maintained: its brain-wide pass stamped recently (any host). */
export async function autopilotOwnsUpkeep(engine: BrainEngine, now: Date): Promise<string | null> {
  const raw = await engine.getConfig(LAST_GLOBAL_AT_KEY).catch(() => null);
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) && now.getTime() - at < AUTOPILOT_OWNS_WITHIN_MS ? raw : null;
}

async function defaultCapacityPaused(engine: BrainEngine): Promise<{ command: string; config_key: string } | null> {
  const { cachedCapacitySnapshot } = await import('../persistence/capacity-snapshot.ts');
  const snapshot = await cachedCapacitySnapshot(engine as never).catch(() => null);
  const row = snapshot?.paused[0];
  return row ? { command: row.command, config_key: row.config_key } : null;
}

const STATUS_VERIFY = { argv: ['gbrain', 'maintain', '--status', '--json'] };

function skip(code: string, message: string, fix?: Action): UpkeepOutcome {
  return { status: 'skipped', exit: 0, code, message, ...(fix ? { fix } : {}) };
}

/** Why upkeep cannot run right now, or null. Checked in this order before any work. */
async function preflight(engine: BrainEngine, opts: UpkeepOpts, now: Date): Promise<UpkeepOutcome | null> {
  if (!await upkeepEnabled(engine)) {
    return skip('maintenance_disabled', 'Unattended upkeep is off (maintenance.auto is false); nothing ran.');
  }
  if (isEngineDegraded(engine)) {
    return skip('engine_degraded', 'The brain database is unreachable right now (degraded engine), so upkeep skipped this run.',
      { consent: [], actor: 'agent', requires_exclusive: false, why: 'Upkeep waits for the database to come back; doctor names the connection problem.', verify: { argv: ['gbrain', 'doctor', '--json'] } });
  }
  if (await hasPendingMigrations(engine)) {
    return skip('migrations_pending', 'Schema migrations are pending on this brain, so upkeep skipped this run.',
      { argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: 'agent', requires_exclusive: true,
        why: 'Applies the pending schema migrations (the same ones every command applies on connect); upkeep runs on its next turn.', verify: STATUS_VERIFY });
  }
  const owner = await autopilotOwnsUpkeep(engine, now);
  if (owner) {
    return skip('maintenance_owned_by_autopilot', `An autopilot keeps this brain maintained (its last brain-wide pass ran at ${owner}), so free upkeep left it alone.`);
  }
  const paused = await (opts.capacityPaused ?? defaultCapacityPaused)(engine).catch(() => null);
  if (paused) {
    return skip('write_capacity_backpressure', `A cumulative write cap (${paused.config_key}) passed the background pause line, so upkeep skipped this run.`,
      { argv: paused.command.split(' '), consent: [], actor: 'host_admin', requires_exclusive: false,
        why: 'Raises the write cap on the brain host; background producers, upkeep included, resume below the pause line.', verify: { argv: ['gbrain', 'doctor', '--only', 'persistence_capacity', '--json'] } });
  }
  return null;
}

interface WorkItem { key: string; sourceId?: string; phases: CyclePhase[] }

function phaseCode(phase: CycleReport['phases'][number]): string | undefined {
  return phase.code ?? phase.error?.code;
}

function stepsFrom(report: CycleReport, scope: string): UpkeepStep[] {
  return report.phases.map((phase) => {
    const code = phase.status === 'fail' ? phaseCode(phase) ?? 'phase_failed' : phase.status === 'skipped' ? undefined : phaseCode(phase);
    const reason = phase.status === 'skipped' ? String(phase.details?.reason ?? '') || undefined : undefined;
    return { name: phase.phase, scope, status: phase.status, ...(code ? { code } : {}), ...(reason ? { reason } : {}) };
  });
}

async function brainDirFor(engine: BrainEngine, sourceId: string, localPath: string | null | undefined): Promise<string | null> {
  if (!localPath || !isAbsolute(localPath) || !existsSync(localPath)) return null;
  const { syncContentDirectory } = await import('../sync-applicability.ts');
  return (await syncContentDirectory(engine, { sourceId }).catch(() => null)) ? null : localPath;
}

function backedOff(failures: UpkeepFailure[], step: string, scope: string, now: Date): boolean {
  const entry = failures.find((f) => f.step === step && f.scope === scope);
  return !!entry && entry.count >= UPKEEP_BACKOFF_FAILURES && now.getTime() - Date.parse(entry.last_at) < UPKEEP_BACKOFF_MS;
}

/** One embed step at a time per brain, so overlapping runs cannot each spend the remaining daily cap. */
async function runEmbedStep(engine: BrainEngine, now: Date, signal: AbortSignal | undefined): Promise<{ step: UpkeepStep; embed: { spent_today_usd: number; cap_usd: number } }> {
  const lock = await tryAcquireDbLock(engine, MAINTENANCE_EMBED_LOCK_ID, 60);
  if (!lock) {
    return { step: { name: 'embed', scope: 'global', status: 'skipped', reason: 'embed_running' },
      embed: { spent_today_usd: await readEmbedSpentToday(engine, now), cap_usd: await readEmbedDailyCapUsd(engine) } };
  }
  try {
    return await embedWithinDailyCap(engine, now, signal);
  } finally {
    await lock.release();
  }
}

/** Reserves the rest of the day's cap in the ledger before any spend and settles it to the actual spend afterwards, so a run killed mid-step cannot spend the cap again. */
async function embedWithinDailyCap(engine: BrainEngine, now: Date, signal: AbortSignal | undefined): Promise<{ step: UpkeepStep; embed: { spent_today_usd: number; cap_usd: number } }> {
  const cap = await readEmbedDailyCapUsd(engine);
  const spentBefore = await readEmbedSpentToday(engine, now);
  const embed = (spent: number) => ({ spent_today_usd: Math.round(spent * 1e6) / 1e6, cap_usd: cap });
  if (cap <= 0) return { step: { name: 'embed', scope: 'global', status: 'skipped', reason: 'embed_cap_off' }, embed: embed(spentBefore) };
  if (await engine.getConfig('embedding_disabled').catch(() => null) === 'true') {
    return { step: { name: 'embed', scope: 'global', status: 'skipped', reason: 'embedding_disabled' }, embed: embed(spentBefore) };
  }
  const remaining = cap - spentBefore;
  if (remaining <= 0) return { step: { name: 'embed', scope: 'global', status: 'skipped', reason: 'daily_cap_reached' }, embed: embed(spentBefore) };
  const [{ embedCostCap }, { loadPricingOverrides }, { runEmbedCore }, { embedStaleFacts }] = await Promise.all([
    import('../embed-cost-cap.ts'), import('../budget/budget-tracker.ts'), import('../../commands/embed.ts'), import('../embed-facts.ts')]);
  const costCap = embedCostCap(remaining, 'user', await loadPricingOverrides(engine).catch(() => undefined))!;
  await engine.setConfig(MAINTENANCE_EMBED_SPEND_KEY, JSON.stringify({ day: utcDay(now), usd: cap }));
  const combined = anyAbortSignal(signal ? [costCap.signal, signal] : [costCap.signal]);
  let spent = 0;
  let status: UpkeepStepStatus = 'ok';
  let code: string | undefined;
  try {
    const result = await costCap.metered(() => runEmbedCore(engine, { stale: true, quiet: true, signal: combined.signal }));
    if (result.failures > 0 && !result.lock_skipped) status = 'warn';
    spent = costCap.spent();
    if (!costCap.hit() && !combined.signal.aborted) {
      for (const source of await engine.listAllSources()) {
        const left = remaining - spent;
        if (left <= 0 || combined.signal.aborted) break;
        try {
          const facts = await embedStaleFacts(engine, { sourceId: source.id, yes: true, maxCostUsd: left, signal: combined.signal });
          spent += facts.cost_usd;
          if (facts.failures > 0) status = 'warn';
        } catch (error) {
          status = 'warn';
          code ??= (error as { code?: string } | null)?.code ?? 'facts_embed_refused';
        }
      }
    }
  } catch (error) {
    spent = Math.max(spent, costCap.spent());
    if (!costCap.hit() && !combined.signal.aborted) {
      status = 'fail';
      code = (error as { code?: string } | null)?.code ?? 'embed_failed';
    }
  } finally {
    combined.dispose();
  }
  const total = spentBefore + spent;
  await engine.setConfig(MAINTENANCE_EMBED_SPEND_KEY, JSON.stringify({ day: utcDay(now), usd: total }));
  const reason = costCap.hit() ? 'daily_cap_reached' : undefined;
  return { step: { name: 'embed', scope: 'global', status, ...(code ? { code } : {}), ...(reason ? { reason } : {}) }, embed: embed(total) };
}

/**
 * PGLite only: a top-level CHECKPOINT once a round finishes, outside every
 * transaction, so the WAL the round wrote is folded into the data files
 * while the brain is quiet instead of at the next open.
 */
async function checkpointStep(engine: BrainEngine): Promise<UpkeepStep> {
  try {
    await engine.executeRaw('CHECKPOINT');
    return { name: 'checkpoint', scope: 'global', status: 'ok' };
  } catch (error) {
    return { name: 'checkpoint', scope: 'global', status: 'fail', code: (error as { code?: string } | null)?.code ?? 'checkpoint_failed' };
  }
}

/**
 * One unattended upkeep run. Never throws: a run that cannot start returns a
 * skip with its code and fix, a failed step is recorded with its own code and
 * the run moves on to the next item.
 */
export async function runUnattendedMaintenance(engine: BrainEngine, opts: UpkeepOpts): Promise<UpkeepOutcome> {
  const now = (opts.now ?? (() => new Date()))();
  try {
    const refused = await preflight(engine, opts, now);
    const prior = await readUpkeepRecord(engine);
    if (refused) {
      if (prior && refused.code) await engine.setConfig(MAINTENANCE_LAST_RUN_KEY, JSON.stringify({ ...prior, last_skip: { at: now.toISOString(), code: refused.code } }));
      return refused;
    }
    const budgeted = opts.budgetMs !== undefined;
    const sources = (await engine.listAllSources()).sort((a, b) => a.id.localeCompare(b.id));
    const keys = ['global', ...sources.map((source) => `source:${source.id}`)];
    const parked = (prior?.parked ?? []).filter((p) => keys.includes(p.key)).map((p) => ({ ...p }));
    const retryOnly = !upkeepDue(prior, now);
    const retrying = !budgeted || opts.retryParked || (!retryOnly && !prior?.cursor) ? parked.map((p) => p.key) : [];
    if (retryOnly && retrying.length === 0) {
      return { status: 'not_due', exit: 0, message: `Upkeep already ran at ${prior!.at}; next due at ${prior!.next_due_at}.`, record: prior! };
    }
    const plan = unattendedPlan(opts.providers ?? await readSafePhaseProviders(engine));
    const round = prior?.cursor ?? (retryOnly
      ? { round_started_at: now.toISOString(), done: keys.filter((key) => !retrying.includes(key)), due_at: prior!.next_due_at }
      : { round_started_at: now.toISOString(), done: [] as string[] });
    const attempts: Record<string, number> = { ...round.attempts };
    const retry = new Set([...(round.retry ?? []), ...retrying]);
    for (const key of retrying) delete attempts[key];
    const done = round.done.filter((key) => !retrying.includes(key));
    const failures = prior?.consecutive_failures ?? [];
    const items: WorkItem[] = [
      { key: 'global', phases: plan.global },
      ...sources.map((source) => ({ key: `source:${source.id}`, sourceId: source.id, phases: plan.source })),
    ].filter((item) => !done.includes(item.key));
    const deadline = budgeted ? Date.now() + opts.budgetMs! : Infinity;
    const steps: UpkeepStep[] = [];
    const cycled = new Set<string>();
    let lockBusy = false;
    for (const item of items) {
      if (Date.now() >= deadline || opts.signal?.aborted) break;
      const scope = item.sourceId ?? 'global';
      if (budgeted && !retry.has(item.key) && parked.some((p) => p.key === item.key)) {
        steps.push({ name: 'cycle', scope, status: 'skipped', reason: 'parked' });
        done.push(item.key);
        continue;
      }
      const settle = (): void => {
        done.push(item.key);
        delete attempts[item.key];
        retry.delete(item.key);
      };
      const unfinished = (): void => {
        if (!budgeted || opts.signal?.aborted) return;
        const slices = (attempts[item.key] ?? 0) + 1;
        if (slices < UPKEEP_PARK_AFTER_SLICES) { attempts[item.key] = slices; return; }
        const entry = parked.find((p) => p.key === item.key);
        if (entry) entry.slices += slices;
        else parked.push({ key: item.key, since: now.toISOString(), slices });
        steps.push({ name: 'cycle', scope, status: 'skipped', reason: 'parked' });
        settle();
      };
      const phases = item.phases.filter((phase) => !backedOff(failures, phase, scope, now));
      for (const phase of item.phases) if (!phases.includes(phase)) steps.push({ name: phase, scope, status: 'skipped', reason: 'backed_off' });
      const source = item.sourceId ? sources.find((s) => s.id === item.sourceId) : undefined;
      const brainDir = source ? await brainDirFor(engine, source.id, source.local_path) : null;
      const budget = Number.isFinite(deadline) ? AbortSignal.timeout(Math.max(1, deadline - Date.now())) : undefined;
      const signals = [opts.signal, budget].filter((s): s is AbortSignal => s !== undefined);
      const combined = signals.length ? anyAbortSignal(signals) : null;
      const cycleOpts: CycleOpts = {
        brainDir, pull: false, phases, stamp: 'none', deferFactEmbedding: plan.embedding,
        ...(item.sourceId ? { sourceId: item.sourceId } : { forceGlobalOrphans: true }),
        ...(combined ? { signal: combined.signal } : {}),
      };
      try {
        if (phases.length > 0) {
          const report = await (opts.cycle ?? runCycle)(engine, cycleOpts);
          if (report.status === 'skipped' && report.reason === 'cycle_already_running') { lockBusy = true; break; }
          cycled.add(scope);
          steps.push(...stepsFrom(report, scope));
          if (report.reason === 'aborted') { unfinished(); break; }
          if (report.reason === 'lock_stolen') break;
        }
        settle();
        const at = parked.findIndex((p) => p.key === item.key);
        if (at >= 0) parked.splice(at, 1);
      } catch (error) {
        if (combined?.signal.aborted) { unfinished(); break; }
        steps.push({ name: 'cycle', scope, status: 'fail', code: (error as { code?: string } | null)?.code ?? 'cycle_failed' });
        settle();
      } finally {
        combined?.dispose();
      }
    }
    if (lockBusy && steps.length === 0) {
      const out = skip('cycle_already_running', 'Another maintenance cycle holds the brain\'s cycle lock, so upkeep skipped this run.',
        { argv: STATUS_VERIFY.argv, consent: [], actor: 'provider', requires_exclusive: false, why: 'The other cycle releases the lock when it finishes; upkeep runs again on its next turn.', verify: STATUS_VERIFY });
      if (prior) await engine.setConfig(MAINTENANCE_LAST_RUN_KEY, JSON.stringify({ ...prior, last_skip: { at: now.toISOString(), code: 'cycle_already_running' } }));
      return out;
    }
    const finished = items.every((item) => done.includes(item.key));
    let embed: UpkeepRecord['embed'];
    if (finished && plan.embedding && !opts.signal?.aborted) {
      if (Date.now() >= deadline) {
        steps.push({ name: 'embed', scope: 'global', status: 'skipped', reason: 'budget_exhausted' });
      } else {
        const budget = Number.isFinite(deadline)
          ? anyAbortSignal([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) : null;
        try {
          const result = await runEmbedStep(engine, now, budget?.signal ?? opts.signal);
          steps.push(result.step);
          embed = result.embed;
        } finally {
          budget?.dispose();
        }
      }
    }
    if (finished && engine.kind === 'pglite' && !opts.signal?.aborted) steps.push(await checkpointStep(engine));
    const failed = steps.filter((step) => step.status === 'fail');
    const planned = new Map<string, string[]>([
      ...sources.map((source): [string, string[]] => [source.id, [...plan.source, 'cycle']]),
      ['global', [...plan.global, 'cycle', ...(plan.embedding ? ['embed'] : []), ...(engine.kind === 'pglite' ? ['checkpoint'] : [])]],
    ]);
    const nextFailures: UpkeepFailure[] = failures
      .filter((f) => planned.get(f.scope)?.includes(f.step) && !(f.step === 'cycle' && cycled.has(f.scope)))
      .filter((f) => !steps.some((s) => s.name === f.step && s.scope === f.scope && s.status !== 'fail' && s.reason !== 'backed_off' && s.reason !== 'parked'));
    for (const step of failed) {
      const entry = nextFailures.find((f) => f.step === step.name && f.scope === step.scope);
      if (entry && entry.code === step.code) { entry.count += 1; entry.last_at = now.toISOString(); }
      else if (entry) { entry.code = step.code!; entry.count = 1; entry.last_at = now.toISOString(); }
      else nextFailures.push({ step: step.name, scope: step.scope, code: step.code!, count: 1, last_at: now.toISOString() });
    }
    const record: UpkeepRecord = {
      at: now.toISOString(),
      runner: opts.runner,
      status: failed.length === 0 ? 'ok' : failed.length === steps.filter((s) => s.status !== 'skipped').length ? 'failed' : 'partial',
      steps,
      held: plan.held,
      cursor: finished ? null : {
        round_started_at: round.round_started_at, done,
        ...(Object.keys(attempts).length ? { attempts } : {}), ...(retry.size ? { retry: [...retry] } : {}), ...(round.due_at ? { due_at: round.due_at } : {}),
      },
      next_due_at: finished ? round.due_at ?? new Date(now.getTime() + UPKEEP_INTERVAL_MS).toISOString() : now.toISOString(),
      consecutive_failures: nextFailures,
      ...(parked.length ? { parked } : {}),
      ...(embed ? { embed } : {}),
    };
    await engine.setConfig(MAINTENANCE_LAST_RUN_KEY, JSON.stringify(record));
    const first = failed[0];
    return {
      status: 'ran',
      exit: first ? 1 : 0,
      ...(first?.code ? { code: first.code } : {}),
      message: first
        ? `Upkeep ran ${steps.length} step(s); ${failed.length} failed, first ${first.name} (${first.scope}) with ${first.code}.`
        : `Upkeep ran ${steps.length} step(s)${finished ? '' : '; the round continues on the next run'}.`,
      record,
    };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'maintenance_failed';
    return { status: 'ran', exit: 1, code, message: `Upkeep stopped: ${error instanceof Error ? error.message : String(error)}` };
  }
}

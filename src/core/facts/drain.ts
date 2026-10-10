/**
 * Automatic facts drain (Foundations 2, Lane D). PGLite has no background job
 * worker, so `facts-absorb` jobs (one per eligible page write) wait until
 * something runs them. This module runs them inside the processes that
 * already own a PGLite brain: stdio `gbrain serve`, `gbrain serve --http` and
 * the dream/autopilot cycle (`facts_drain` phase). One shared implementation:
 *
 *   - one job at a time, with a yield between jobs, a wall-clock budget per
 *     run and an AbortSignal (shutdown) forwarded into the job handler;
 *   - spend bounded per run (`facts.drain_budget_usd`, default $1.00), per
 *     rolling 24 hours (`facts.drain_daily_budget_usd`, default $5.00) and by
 *     job count (`facts.drain_max_jobs`, default 50); unpriced models warn and
 *     run under the default caps, and refuse with the register-the-rate fix
 *     under a cap the user set;
 *   - every stop that is not "queue empty" is a deferral that keeps the jobs
 *     queued without counting an attempt (budget used up, no provider key,
 *     shutdown, provider halt);
 *   - status (last run, backlog, last error with its fix) lives in the config
 *     row `facts.drain_state`, read by doctor `facts_drain` and the MCP
 *     readiness entry `facts_drain`.
 *
 * Opt out with `gbrain config set facts.extraction_enabled false`. Logging goes
 * to stderr only (stdio serve speaks JSON-RPC on stdout).
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { Action, Notice } from '../agent-output.ts';
import type { MinionJob } from '../minions/types.ts';
import { FACTS_DRAIN_KEYS, parseFactsDrainKey, type FactsDrainKey } from './drain-config.ts';
export { FACTS_DRAIN_KEYS, validateFactsDrainConfigValue, type FactsDrainKey } from './drain-config.ts';


export const FACTS_DRAIN_JOB = 'facts-absorb';
export const FACTS_DRAIN_QUEUE = 'default';
export const FACTS_DRAIN_STATE_KEY = 'facts.drain_state';
export const FACTS_DRAIN_OPT_OUT_ARGV = ['gbrain', 'config', 'set', 'facts.extraction_enabled', 'false'] as const;
export const FACTS_DRAIN_DOCS = 'docs/guides/facts-drain.md';
/** One run's default wall-clock budget. */
export const FACTS_DRAIN_WALL_MS = 5 * 60_000;
/** Tokens the extractor adds around the page text (system prompt + framing). */
const PROMPT_OVERHEAD_TOKENS = 1_500;
const RUN_HISTORY = 20;

export interface FactsDrainSettings {
  enabled: boolean;
  budgetUsd: number;
  dailyBudgetUsd: number;
  maxJobs: number;
  /** A spend cap was set by the user: an unpriced model then refuses instead of warn-and-run. */
  explicitCap: boolean;
}

export async function factsDrainSettings(engine: BrainEngine): Promise<FactsDrainSettings> {
  const { isFactsExtractionEnabled } = await import('./extract.ts');
  const values = {} as Record<FactsDrainKey, number>;
  let explicitCap = false;
  for (const key of Object.keys(FACTS_DRAIN_KEYS) as FactsDrainKey[]) {
    const raw = await engine.getConfig(key).catch(() => null);
    const parsed = raw == null || raw.trim() === '' ? null : parseFactsDrainKey(key, raw);
    values[key] = parsed ?? FACTS_DRAIN_KEYS[key].fallback;
    if (parsed !== null && key !== 'facts.drain_max_jobs') explicitCap = true;
  }
  return {
    enabled: await isFactsExtractionEnabled(engine),
    budgetUsd: values['facts.drain_budget_usd'],
    dailyBudgetUsd: values['facts.drain_daily_budget_usd'],
    maxJobs: values['facts.drain_max_jobs'],
    explicitCap,
  };
}

export type FactsDrainOwner = 'serve' | 'serve_http' | 'cycle';
export type FactsDrainOutcome =
  | 'drained' | 'idle' | 'disabled' | 'not_applicable' | 'max_jobs' | 'deadline' | 'aborted'
  | 'no_key' | 'extraction_unavailable' | 'budget_exhausted' | 'daily_budget_exhausted' | 'job_over_budget'
  | 'no_pricing' | 'provider_halted' | 'error';
/** Outcomes that leave work queued for a reason the agent can act on. */
export const FACTS_DRAIN_DEFERRALS: ReadonlySet<FactsDrainOutcome> = new Set([
  'no_key', 'extraction_unavailable', 'budget_exhausted', 'daily_budget_exhausted', 'job_over_budget', 'no_pricing', 'provider_halted', 'error',
]);

export interface FactsDrainRunRecord {
  owner: FactsDrainOwner;
  started_at: string;
  finished_at: string | null;
  outcome: FactsDrainOutcome | 'running';
  completed: number;
  failed: number;
  deferred: number;
  facts_inserted: number;
  spent_usd: number;
  unpriced_calls: number;
  backlog_before: number;
  backlog_after: number | null;
  waiting_after?: number;
  delayed_after?: number;
  active_after?: number;
  waiting_children_after?: number;
  paused_after?: number;
  remaining_after?: number;
  model: string | null;
  error?: { code: string; reason: string; message: string; fix?: Action };
}

interface FactsDrainState { version: 1; runs: FactsDrainRunRecord[]; first_run_reported_at?: string }

export async function readFactsDrainState(engine: BrainEngine): Promise<FactsDrainState> {
  try {
    const raw = await engine.getConfig(FACTS_DRAIN_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<FactsDrainState> : null;
    if (parsed && Array.isArray(parsed.runs)) return { version: 1, runs: parsed.runs, first_run_reported_at: parsed.first_run_reported_at };
  } catch { /* unreadable state starts fresh */ }
  return { version: 1, runs: [] };
}

async function writeFactsDrainState(engine: BrainEngine, state: FactsDrainState): Promise<void> {
  const cutoff = Date.now() - 48 * 3600_000;
  const runs = state.runs.filter((r, i) => i === state.runs.length - 1 || Date.parse(r.started_at) >= cutoff).slice(-RUN_HISTORY);
  await engine.setConfig(FACTS_DRAIN_STATE_KEY, JSON.stringify({ ...state, runs }));
}

/** Priced spend of drain runs that started in the last 24 hours. */
export function dailySpentUsd(state: FactsDrainState, now = Date.now()): number {
  return state.runs.filter(r => now - Date.parse(r.started_at) < 24 * 3600_000).reduce((sum, r) => sum + (r.spent_usd || 0), 0);
}

export interface FactsDrainBacklog { waiting: number; delayed: number; active: number; waiting_children: number; paused: number }

export async function factsDrainBacklog(engine: BrainEngine): Promise<FactsDrainBacklog> {
  const rows = await engine.executeRaw<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM minion_jobs
      WHERE name = $1 AND queue = $2 AND status IN ('waiting', 'delayed', 'active', 'waiting-children', 'paused') GROUP BY status`,
    [FACTS_DRAIN_JOB, FACTS_DRAIN_QUEUE]);
  const out: FactsDrainBacklog = { waiting: 0, delayed: 0, active: 0, waiting_children: 0, paused: 0 };
  for (const r of rows) {
    const key = r.status === 'waiting-children' ? 'waiting_children' : r.status as keyof FactsDrainBacklog;
    out[key] = Number(r.n);
  }
  return out;
}

const fmtUsd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
const command = (argv: readonly string[]) => argv.join(' ');

function keySetupFix(): Action {
  return {
    argv: ['gbrain', 'providers', 'list'], consent: ['credentials', 'paid'], actor: 'user', requires_exclusive: false,
    why: 'Automatic fact extraction needs one chat provider key (for example ANTHROPIC_API_KEY or OPENAI_API_KEY, stored with `gbrain config set anthropic_api_key <key>`); `gbrain providers list` shows what each provider needs. Queued pages run on the next drain once a key exists.',
    user_message: 'Pages are waiting for automatic fact extraction, which needs a chat model API key (Anthropic or OpenAI, for example). Want to add one? It costs a little per page processed.',
    verify: { argv: ['gbrain', 'doctor', '--only', 'facts_drain', '--json'] },
  };
}

function budgetFix(key: 'facts.drain_budget_usd' | 'facts.drain_daily_budget_usd', suggested: number): Action {
  return {
    argv: ['gbrain', 'config', 'set', key, suggested.toFixed(2)], consent: ['paid'], actor: 'agent', requires_exclusive: false,
    why: `Raises the cap so more queued pages are extracted per ${key === 'facts.drain_budget_usd' ? 'run' : 'day'}; each page is one paid chat call. Ask the user first. Doing nothing is also fine: the jobs wait and run when budget frees up.`,
    user_message: `Automatic fact extraction reached its ${key === 'facts.drain_budget_usd' ? 'per-run' : 'daily'} spending cap and queued pages are waiting. Raise the cap to ${fmtUsd(suggested)}, or let them run as budget frees up?`,
    verify: { argv: ['gbrain', 'doctor', '--only', 'facts_drain', '--json'] },
  };
}

export interface FactsDrainRunResult extends Omit<FactsDrainRunRecord, 'outcome'> { outcome: FactsDrainOutcome; notice?: Notice }

export interface FactsDrainRunOpts {
  owner: FactsDrainOwner;
  signal?: AbortSignal;
  wallClockMs?: number;
  /** Stderr sink (default process.stderr). Never stdout. */
  log?: (line: string) => void;
  /** Pause between jobs so foreground work interleaves (default 25 ms). */
  yieldMs?: number;
}

/** Pending notice for the next stdio MCP call (dispatch takes it); one per reason per process. */
let pendingNotice: Notice | null = null;
const noticedReasons = new Set<string>();
export function takeFactsDrainNotice(): Notice | null {
  const n = pendingNotice;
  pendingNotice = null;
  return n;
}
/** Test-only: reset the process-wide notice memo. */
export function __resetFactsDrainNoticesForTests(): void { pendingNotice = null; noticedReasons.clear(); }

function findError<T>(err: unknown, match: (e: unknown) => e is T): T | null {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    if (match(cur)) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Estimated cost of extracting the queued pages, from their text length and the model price. */
async function estimateBacklogUsd(engine: BrainEngine, model: string, backlog: number, maxTokens: number): Promise<number | null> {
  const { reservationCostUsd } = await import('../budget/reservation-cost.ts');
  const { MAX_TURN_TEXT_CHARS } = await import('./extract.ts');
  const [row] = await engine.executeRaw<{ chars: number | null }>(
    `SELECT avg(LEAST(length(p.compiled_truth), $3))::float AS chars FROM minion_jobs j
       JOIN pages p ON p.slug = j.data->>'slug' AND p.source_id = COALESCE(j.data->>'sourceId', 'default')
      WHERE j.name = $1 AND j.queue = $2 AND j.status IN ('waiting', 'delayed')`,
    [FACTS_DRAIN_JOB, FACTS_DRAIN_QUEUE, MAX_TURN_TEXT_CHARS]).catch(() => [{ chars: null }]);
  const inputTokens = Math.ceil((row?.chars ?? MAX_TURN_TEXT_CHARS / 2) / 4) + PROMPT_OVERHEAD_TOKENS;
  const perJob = reservationCostUsd(model, 'chat', inputTokens, Math.min(maxTokens, 300));
  return perJob === null ? null : perJob * backlog;
}

/**
 * Run one bounded drain pass. Never throws: failures become the `error`
 * outcome with the cause recorded in `facts.drain_state`.
 */
export async function runFactsDrain(engine: BrainEngine, opts: FactsDrainRunOpts): Promise<FactsDrainRunResult> {
  const log = opts.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const startedAt = new Date();
  const result: FactsDrainRunResult = {
    owner: opts.owner, started_at: startedAt.toISOString(), finished_at: null, outcome: 'idle',
    completed: 0, failed: 0, deferred: 0, facts_inserted: 0, spent_usd: 0, unpriced_calls: 0,
    backlog_before: 0, backlog_after: null, model: null,
  };
  const finish = (outcome: FactsDrainOutcome): FactsDrainRunResult => {
    result.outcome = outcome;
    result.finished_at = new Date().toISOString();
    return result;
  };
  if (engine.kind !== 'pglite') return finish('not_applicable');
  const { isEngineDegraded } = await import('../degraded-marker.ts');
  if (isEngineDegraded(engine)) return finish('not_applicable');

  let state: FactsDrainState | null = null;
  let recorded = false;
  const save = async () => {
    if (!state) return;
    const rec: FactsDrainRunRecord = { ...result, outcome: result.finished_at ? result.outcome : 'running' };
    delete (rec as { notice?: unknown }).notice;
    if (recorded) state.runs[state.runs.length - 1] = rec;
    else { state.runs.push(rec); recorded = true; }
    await writeFactsDrainState(engine, state).catch(() => undefined);
  };
  const defer = async (outcome: FactsDrainOutcome, reason: string, message: string, fix?: Action): Promise<FactsDrainRunResult> => {
    result.error = { code: 'facts_drain_deferred', reason, message, ...(fix ? { fix } : {}) };
    finish(outcome);
    result.notice = { code: 'facts_drain_deferred', kind: 'degraded', why: message, ...(fix ? { fix } : {}) };
    if (!noticedReasons.has(reason)) {
      noticedReasons.add(reason);
      log(`[gbrain notice facts_drain_deferred] ${message}${fix?.argv ? ` Next: ${command(fix.argv)}` : ''}`);
      pendingNotice = result.notice;
    }
    await save();
    return result;
  };

  try {
    const settings = await factsDrainSettings(engine);
    if (!settings.enabled) return finish('disabled');
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(engine);
    await queue.promoteDelayed();
    await queue.handleStalled();
    const backlog = await factsDrainBacklog(engine);
    result.backlog_before = backlog.waiting;
    // Retain the observed queue state for pre-claim deferrals too (missing key,
    // daily cap, unpriced model). Those paths do not reach the post-loop read.
    result.waiting_after = backlog.waiting;
    result.delayed_after = backlog.delayed;
    result.active_after = backlog.active;
    result.waiting_children_after = backlog.waiting_children;
    result.paused_after = backlog.paused;
    result.remaining_after = backlog.waiting + backlog.delayed + backlog.active + backlog.waiting_children + backlog.paused;
    if (backlog.waiting === 0) { result.backlog_after = 0; return finish('idle'); }

    const { refreshGatewayEnvFromFilePlane, reconfigureGatewayWithEngine, withBudgetTracker } = await import('../ai/gateway.ts');
    refreshGatewayEnvFromFilePlane();
    await reconfigureGatewayWithEngine(engine).catch(() => undefined);
    const { resolveExtractionAvailability } = await import('./extraction-availability.ts');
    const { getFactsExtractionMaxTokens } = await import('./extract.ts');
    const { model, available } = await resolveExtractionAvailability(engine);
    result.model = model;
    state = await readFactsDrainState(engine);

    if (!available) {
      const { classifyUnavailable } = await import('./backstop.ts');
      if ((await classifyUnavailable(model)) === 'keyless') {
        return defer('no_key', 'no_key',
          `${backlog.waiting} page(s) wait for automatic fact extraction, which needs a chat provider key (OpenAI or Anthropic). They stay queued and run on the next drain after a key is set.`,
          keySetupFix());
      }
      return defer('extraction_unavailable', 'extraction_unavailable',
        `The facts extraction model ${model} is not servable (its provider is not configured); ${backlog.waiting} page(s) stay queued.`,
        { argv: ['gbrain', 'config', 'set', 'facts.extraction_model', '<provider:model>'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
          why: 'Points extraction at a model whose provider has a key, or set that provider\'s key instead.',
          inputs: [{ name: 'provider:model', how: 'Pick a chat model whose provider key is configured (gbrain models doctor --json lists them).' }],
          verify: { argv: ['gbrain', 'doctor', '--only', 'facts_drain', '--json'] } });
    }

    const maxTokens = await getFactsExtractionMaxTokens(engine);
    if (!state.first_run_reported_at) {
      const est = await estimateBacklogUsd(engine, model, backlog.waiting, maxTokens);
      const line = `[gbrain notice facts_drain] Automatic fact extraction is on: ${backlog.waiting} queued page(s), about ${est === null ? 'an unknown amount (unpriced model)' : fmtUsd(est)} with ${model}, ` +
        `at most ${fmtUsd(settings.budgetUsd)} per run and ${fmtUsd(settings.dailyBudgetUsd)} per day. To opt out: ${command(FACTS_DRAIN_OPT_OUT_ARGV)}`;
      log(line);
      noticedReasons.add('first_run');
      pendingNotice = { code: 'facts_drain_first_run', kind: 'info', why: line.replace('[gbrain notice facts_drain] ', ''),
        fix: { argv: [...FACTS_DRAIN_OPT_OUT_ARGV], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Only if the user does not want automatic paid extraction; queued pages are then left unextracted.', verify: { argv: ['gbrain', 'doctor', '--only', 'facts_drain', '--json'] } } };
      state.first_run_reported_at = startedAt.toISOString();
    }

    const dailyRemaining = settings.dailyBudgetUsd - dailySpentUsd(state, startedAt.getTime());
    if (dailyRemaining <= 0) {
      return defer('daily_budget_exhausted', 'daily_budget_exhausted',
        `Automatic fact extraction used its ${fmtUsd(settings.dailyBudgetUsd)} daily budget; ${backlog.waiting} page(s) stay queued and run as the 24-hour window frees budget.`,
        budgetFix('facts.drain_daily_budget_usd', settings.dailyBudgetUsd * 2));
    }
    const runCap = Math.min(settings.budgetUsd, dailyRemaining);
    const capIsDaily = dailyRemaining < settings.budgetUsd;
    const { BudgetTracker, BudgetExhausted, loadPricingOverrides } = await import('../budget/budget-tracker.ts');
    const { reservationCostUsd } = await import('../budget/reservation-cost.ts');
    const { MAX_TURN_TEXT_CHARS } = await import('./extract.ts');
    const pricingOverrides = await loadPricingOverrides(engine);
    const ceiling = reservationCostUsd(model, 'chat', Math.ceil(MAX_TURN_TEXT_CHARS / 4) + PROMPT_OVERHEAD_TOKENS, maxTokens, pricingOverrides);
    if (ceiling === null && settings.explicitCap) {
      const { noPricingGuidance, noPricingFix, noPricingMessage } = await import('../budget/no-pricing.ts');
      const guidance = noPricingGuidance(model, 'chat');
      return defer('no_pricing', 'no_pricing', noPricingMessage(guidance, { label: 'facts drain', capUsd: runCap }), noPricingFix(guidance));
    }
    const tracker = new BudgetTracker({ maxCostUsd: runCap, capSource: settings.explicitCap ? 'user' : 'default', label: 'facts:drain', pricingOverrides });
    await save();

    const { makeFactsAbsorbHandler } = await import('../minions/handlers/facts-absorb.ts');
    const { withFactsAbsorbHaltCooldown } = await import('../minions/llm-halt-cooldown.ts');
    const { JobDeferredError, UnrecoverableError } = await import('../minions/errors.ts');
    const { RateLeaseUnavailableError, leaseFullBackoffMs } = await import('../minions/rate-leases.ts');
    const { buildJobContext } = await import('../minions/job-context.ts');
    const { authorizeJobExecution, withSubmissionAuthority } = await import('../minions/submission-authority.ts');
    const { withChatPhase } = await import('../ai/chat-usage.ts');
    const { calculateBackoff } = await import('../minions/backoff.ts');
    const { defaultLockDurationMsFor } = await import('../minions/handler-timeouts.ts');
    const handler = withFactsAbsorbHaltCooldown(makeFactsAbsorbHandler(engine));
    const lockMs = defaultLockDurationMsFor(FACTS_DRAIN_JOB) ?? 120_000;
    const deadline = startedAt.getTime() + (opts.wallClockMs ?? FACTS_DRAIN_WALL_MS);
    let outcome: FactsDrainOutcome = 'drained';
    let stopReason: { reason: string; message: string; fix?: Action } | null = null;

    while (true) {
      if (opts.signal?.aborted) { outcome = 'aborted'; break; }
      if (result.completed + result.failed >= settings.maxJobs) { outcome = 'max_jobs'; break; }
      if (Date.now() >= deadline) { outcome = 'deadline'; break; }
      const spent = tracker.totalSpent;
      if (ceiling !== null && spent + ceiling > runCap) {
        if (result.completed + result.failed === 0 && ceiling > settings.budgetUsd) {
          outcome = 'job_over_budget';
          stopReason = { reason: 'job_over_budget', message: `One queued page can cost up to ${fmtUsd(ceiling)} with ${model}, above the ${fmtUsd(settings.budgetUsd)} per-run cap, so automatic fact extraction cannot start it. The pages stay queued.`,
            fix: budgetFix('facts.drain_budget_usd', Math.max(1, Math.ceil(ceiling * 2 * 100) / 100)) };
        } else if (capIsDaily) {
          outcome = 'daily_budget_exhausted';
          stopReason = { reason: 'daily_budget_exhausted', message: `Automatic fact extraction reached its ${fmtUsd(settings.dailyBudgetUsd)} daily budget; the remaining pages stay queued and run as the 24-hour window frees budget.`, fix: budgetFix('facts.drain_daily_budget_usd', settings.dailyBudgetUsd * 2) };
        } else {
          outcome = 'budget_exhausted';
          stopReason = { reason: 'budget_exhausted', message: `Automatic fact extraction reached its ${fmtUsd(settings.budgetUsd)} per-run budget; the remaining pages stay queued for the next run.`, fix: budgetFix('facts.drain_budget_usd', settings.budgetUsd * 2) };
        }
        break;
      }
      const lockToken = randomUUID();
      const job: MinionJob | null = await queue.claim(lockToken, lockMs, FACTS_DRAIN_QUEUE, [FACTS_DRAIN_JOB]);
      if (!job) { outcome = 'drained'; break; }

      const abort = new AbortController();
      const onShutdown = () => { if (!abort.signal.aborted) abort.abort(new Error('shutdown')); };
      opts.signal?.addEventListener('abort', onShutdown, { once: true });
      let renewing = false;
      const renew = setInterval(() => {
        if (renewing) return;
        renewing = true;
        queue.renewLock(job.id, lockToken, lockMs)
          .then(ok => { if (!ok && !abort.signal.aborted) abort.abort(new Error('lock-lost')); }, () => undefined)
          .finally(() => { renewing = false; });
      }, Math.max(1000, Math.floor(lockMs / 3)));
      let value: unknown;
      let thrown: unknown = null;
      try {
        const authority = await authorizeJobExecution(engine, job);
        const ctx = buildJobContext(engine, queue, job, lockToken, abort.signal, opts.signal ?? abort.signal);
        value = await withBudgetTracker(tracker, () => withSubmissionAuthority(authority, () => withChatPhase(`job:${job.name}`, () => handler(ctx)), abort.signal));
      } catch (e) {
        thrown = e ?? new Error('facts-absorb failed');
      } finally {
        clearInterval(renew);
        opts.signal?.removeEventListener('abort', onShutdown);
      }

      const budgetErr = thrown ? findError(thrown, (e): e is InstanceType<typeof BudgetExhausted> => e instanceof BudgetExhausted) : null;
      if (!thrown) {
        await queue.completeJob(job.id, lockToken, value != null && typeof value === 'object' ? value as Record<string, unknown> : undefined);
        result.completed++;
        result.facts_inserted += Number((value as { inserted?: number } | null)?.inserted ?? 0);
      } else if (opts.signal?.aborted) {
        await queue.deferJob(job.id, lockToken, 'deferred (shutdown): the owning process stopped mid-job', 0);
        result.deferred++;
        outcome = 'aborted';
      } else if (thrown instanceof JobDeferredError) {
        await queue.deferJob(job.id, lockToken, `deferred (${thrown.reason}): ${thrown.message}`, thrown.retryInMs);
        result.deferred++;
        if (thrown.reason === 'no_key') { outcome = 'no_key'; stopReason = { reason: 'no_key', message: thrown.message, fix: keySetupFix() }; }
      } else if (thrown instanceof RateLeaseUnavailableError) {
        await queue.deferJob(job.id, lockToken, `deferred (provider_halted): ${thrown.message}`, thrown.retryInMs ?? leaseFullBackoffMs());
        result.deferred++;
        outcome = 'provider_halted';
        stopReason = { reason: 'provider_halted', message: `The chat provider for ${model} is refusing calls (${thrown.message}); queued pages wait for its cooldown.` };
      } else if (budgetErr) {
        await queue.deferJob(job.id, lockToken, `deferred (${budgetErr.reason === 'no_pricing' ? 'no_pricing' : 'budget_exhausted'}): ${budgetErr.message}`, 0);
        result.deferred++;
        outcome = budgetErr.reason === 'no_pricing' ? 'no_pricing' : capIsDaily ? 'daily_budget_exhausted' : 'budget_exhausted';
        stopReason = { reason: outcome, message: budgetErr.message, ...(budgetErr.fix ? { fix: budgetErr.fix } : {}) };
      } else if (abort.signal.aborted && String((abort.signal.reason as Error)?.message) === 'lock-lost') {
        result.failed++;
      } else {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        const dead = thrown instanceof UnrecoverableError || job.attempts_made + 1 >= job.max_attempts;
        await queue.failJob(job.id, lockToken, message, dead ? 'dead' : 'delayed', dead ? 0 : calculateBackoff({ ...job, attempts_made: job.attempts_made + 1 }));
        result.failed++;
        result.error = { code: 'facts_drain_job_failed', reason: dead ? 'dead' : 'retrying', message: `facts-absorb job ${job.id} (${String(job.data.slug ?? '')}) failed: ${message}`,
          fix: { argv: ['gbrain', 'jobs', 'get', String(job.id), '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the job\'s error and attempts; a retrying job runs again on a later drain.' } };
      }
      const snap = tracker.snapshot();
      result.spent_usd = snap.cumulativeCostUsd;
      result.unpriced_calls = snap.models.filter(m => m.cost_usd === null).reduce((n, m) => n + m.calls, 0);
      await save();
      if (outcome !== 'drained') break;
      await new Promise(resolve => setTimeout(resolve, opts.yieldMs ?? 25));
    }

    const backlogAfter = await factsDrainBacklog(engine);
    result.backlog_after = backlogAfter.waiting;
    result.waiting_after = backlogAfter.waiting;
    result.delayed_after = backlogAfter.delayed;
    result.active_after = backlogAfter.active;
    result.waiting_children_after = backlogAfter.waiting_children;
    result.paused_after = backlogAfter.paused;
    result.remaining_after = backlogAfter.waiting + backlogAfter.delayed + backlogAfter.active + backlogAfter.waiting_children + backlogAfter.paused;
    if (stopReason) return defer(outcome, stopReason.reason, stopReason.message, stopReason.fix);
    finish(outcome);
    await save();
    return result;
  } catch (e) {
    // An error can follow successful claims/writes and even the final count query.
    // Never label a pre-processing snapshot as the unverified remaining queue.
    result.backlog_after = null;
    delete result.waiting_after;
    delete result.delayed_after;
    delete result.active_after;
    delete result.waiting_children_after;
    delete result.paused_after;
    delete result.remaining_after;
    const message = e instanceof Error ? e.message : String(e);
    state ??= await readFactsDrainState(engine).catch(() => ({ version: 1 as const, runs: [] }));
    return defer('error', 'drain_error', `Automatic fact extraction failed before finishing its run: ${message}. Queued pages stay queued.`,
      { argv: ['gbrain', 'doctor', '--only', 'facts_drain', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the drain status and the last error.' });
  }
}

export const FACTS_DRAIN_RUN_NOW_ARGV = ['gbrain', 'dream', '--phase', 'facts_drain'] as const;
/** A backlog older than this with no run means no owner is draining it. */
const STALE_RUN_MS = 45 * 60_000;

export type FactsDrainHealth = 'not_applicable' | 'disabled' | 'idle' | 'ok' | 'deferred' | 'no_owner';
export interface FactsDrainStatus {
  health: FactsDrainHealth;
  message: string;
  fix?: Action;
  settings: FactsDrainSettings | null;
  backlog: FactsDrainBacklog;
  last_run: FactsDrainRunRecord | null;
  daily_spent_usd: number;
}

/** The one status read for doctor `facts_drain` and the MCP readiness entry `facts_drain`. */
export async function readFactsDrainStatus(engine: BrainEngine, now = Date.now()): Promise<FactsDrainStatus> {
  const empty: FactsDrainBacklog = { waiting: 0, delayed: 0, active: 0, waiting_children: 0, paused: 0 };
  if (engine.kind !== 'pglite') {
    return { health: 'not_applicable', message: 'Postgres brains run facts-absorb jobs on the job worker (gbrain jobs supervisor), not the automatic drain.', settings: null, backlog: empty, last_run: null, daily_spent_usd: 0 };
  }
  const settings = await factsDrainSettings(engine);
  const backlog = await factsDrainBacklog(engine);
  const state = await readFactsDrainState(engine);
  const last = state.runs.at(-1) ?? null;
  const daily = dailySpentUsd(state, now);
  const base = { settings, backlog, last_run: last, daily_spent_usd: daily };
  const queued = backlog.waiting + backlog.delayed + backlog.active + backlog.waiting_children + backlog.paused;
  const lastText = last ? `last run ${last.finished_at ?? last.started_at} by ${last.owner}: ${last.outcome}, ${last.completed} extracted, ${fmtUsd(last.spent_usd)}` : 'no run recorded yet';
  if (!settings.enabled) {
    return { ...base, health: 'disabled', message: `Facts extraction is off (facts.extraction_enabled false); ${queued} facts-absorb job(s) remain and are skipped when they run.`,
      fix: { argv: ['gbrain', 'config', 'set', 'facts.extraction_enabled', 'true'], consent: ['paid', 'egress'], actor: 'agent', requires_exclusive: false,
        why: 'Turns automatic fact extraction back on: one paid chat call per eligible page write, bounded per run and per day.' } };
  }
  if (queued === 0) return { ...base, health: 'idle', message: `No facts-absorb jobs are queued (${lastText}).` };
  if (last?.error && last.outcome !== 'running' && FACTS_DRAIN_DEFERRALS.has(last.outcome as FactsDrainOutcome)) {
    return { ...base, health: 'deferred', message: `${queued} facts-absorb job(s) wait: ${last.error.message}`, ...(last.error.fix ? { fix: last.error.fix } : {}) };
  }
  const lastAt = last ? Date.parse(last.finished_at ?? last.started_at) : 0;
  if (now - lastAt > STALE_RUN_MS) {
    return { ...base, health: 'no_owner', message: `${queued} facts-absorb job(s) are queued and no drain ran in the last ${STALE_RUN_MS / 60_000} minutes (${lastText}). ` +
      'The drain runs inside a resident gbrain serve (stdio or --http) and the dream/autopilot cycle; with none running, run it now.',
      fix: { argv: [...FACTS_DRAIN_RUN_NOW_ARGV], consent: ['paid'], actor: 'agent', requires_exclusive: true,
        why: 'Runs one bounded drain (per-run and daily caps apply) in this process; each page is one paid chat call.', verify: { argv: ['gbrain', 'doctor', '--only', 'facts_drain', '--json'] } } };
  }
  return { ...base, health: 'ok', message: `${queued} facts-absorb job(s) queued; the drain is running them (${lastText}; ${fmtUsd(daily)} of ${fmtUsd(settings.dailyBudgetUsd)} used in 24 h).` };
}

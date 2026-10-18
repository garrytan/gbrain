/**
 * #6696 B1: doctor tiers and budgets.
 *
 * `--tier ops|standard|deep` selects which registry entries run (see
 * `DoctorTier` in ./context.ts); `--budget-ms <n>` is one absolute end-to-end
 * deadline that starts before the CLI connects (default 4000 for `ops`, none
 * for the other tiers; `--budget-ms 0`: none). A plain non-interactive CLI
 * `gbrain doctor --json` caps its check run at `doctor.default_budget_ms`
 * (./default-budget.ts), started after connect and migrations. Every entry also
 * has its own budget (`doctor.entry_budget_ms`, default 15000; the remaining
 * overall time when that is shorter; under `--only` with an explicit
 * `--budget-ms`, the overall budget).
 *
 * An entry past its budget reports each check it emits with the shared unknown
 * convention: `status: 'warn'`, `details.health: 'unknown'`,
 * `details.reason: 'budget'`, `details.limit` (which budget), `details.exact:
 * false`, `elapsed_ms`. On every tier the entry reads through the run's
 * deadline-bound engine (src/core/statement-deadline.ts) under its own deadline:
 * its raw statements carry that deadline to the server (a transaction-local
 * `statement_timeout` recomputed after the pool wait, and an abort of the pool
 * wait itself), a statement after it is never sent, and a cancelled statement
 * marks the entry expired even when the check caught the error, so no doctor
 * backend outlives its entry and the next entry starts with a fresh deadline.
 * PGLite gets only the refusal before each statement: one already running
 * cannot be pre-empted.
 */
import { AGENT_TOOL_LIMIT_MS } from '../../core/agent-output.ts';
import { opError } from '../../core/ops/contract.ts';
import { StatementDeadlineError } from '../../core/statement-deadline.ts';
import type { Check, DoctorReport } from '../doctor.ts';
import { agentFix } from './check-fix.ts';
import type { DoctorTier } from './context.ts';

export const DOCTOR_TIERS: readonly DoctorTier[] = ['ops', 'standard', 'deep'];
/** Default `--budget-ms` for `--tier ops`; the other tiers have no overall deadline unless one is given. */
export const OPS_BUDGET_MS_DEFAULT = 4000;
/** Config key and default of the per-entry budget (standard and deep tiers; ops entries use the overall deadline). */
export const ENTRY_BUDGET_KEY = 'doctor.entry_budget_ms';
export const ENTRY_BUDGET_MS_DEFAULT = 15_000;

/**
 * The deadline of one doctor run: `deadlineAt` is absolute epoch ms, null without an overall budget.
 * `explicit`: `--budget-ms` was given. `deferredBudgetMs`: the non-interactive default, started when the
 * check run starts (`startDeferredDeadline`), so connect and migrations stay outside it.
 */
export interface DoctorDeadline {
  startedAt: number;
  budgetMs: number | null;
  deadlineAt: number | null;
  explicit?: boolean;
  deferredBudgetMs?: number;
  /** The stderr line the deferred default prints when the check run starts (a run refused before it prints nothing). */
  deferredNotice?: string;
  nonInteractiveDefault?: boolean;
}

/** Thrown (and caught by the runner) when a read starts after the deadline passed. */
export class DoctorBudgetError extends StatementDeadlineError {
  override readonly code = 'doctor_budget';
  constructor(elapsedMs: number) {
    super(elapsedMs, `The doctor budget ran out after ${elapsedMs} ms.`);
    this.name = 'DoctorBudgetError';
  }
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

/** `--tier <t>` (default `standard`); an unknown value is `invalid_params` naming the valid tiers. */
export function parseDoctorTier(args: readonly string[]): DoctorTier {
  const raw = flagValue(args, '--tier');
  if (raw === undefined) return 'standard';
  if ((DOCTOR_TIERS as readonly string[]).includes(raw)) return raw as DoctorTier;
  throw opError('invalid_params', `Unknown doctor tier: ${raw}`, `Valid tiers: ${DOCTOR_TIERS.join(', ')}.`,
    { fix: { argv: ['gbrain', 'doctor', '--tier', 'ops', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'The ops tier answers the operational questions (capacity, failures, embedding, sync, compaction, serve build) in seconds.' } });
}

/** `--budget-ms <n>` (a non-negative integer; 0: no overall budget), else the tier default. */
export function parseBudgetMs(args: readonly string[], tier: DoctorTier): number | null {
  const raw = flagValue(args, '--budget-ms');
  if (raw === undefined) return tier === 'ops' ? OPS_BUDGET_MS_DEFAULT : null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw opError('invalid_params', `--budget-ms must be a whole number of milliseconds, 0 for no overall budget (got ${raw}).`, 'Example: --budget-ms 4000.');
  }
  return n === 0 ? null : n;
}

/** The deadline of a run starting now (call it before connecting). */
export function startDoctorDeadline(args: readonly string[], now = Date.now()): DoctorDeadline {
  const budgetMs = parseBudgetMs(args, parseDoctorTier(args));
  return { startedAt: now, budgetMs, deadlineAt: budgetMs === null ? null : now + budgetMs, explicit: flagValue(args, '--budget-ms') !== undefined };
}

/** The non-interactive default starts with the check run (after connect and migrations), and says so then. */
export function startDeferredDeadline(deadline: DoctorDeadline | undefined, now = Date.now()): void {
  if (!deadline || deadline.deferredBudgetMs === undefined || deadline.deadlineAt !== null) return;
  Object.assign(deadline, { startedAt: now, budgetMs: deadline.deferredBudgetMs, deadlineAt: now + deadline.deferredBudgetMs, nonInteractiveDefault: true });
  if (deadline.deferredNotice) process.stderr.write(deadline.deferredNotice);
  delete deadline.deferredBudgetMs;
  delete deadline.deferredNotice;
}

/** Time a scan keeps before its entry's deadline to report what it read. */
export const SCAN_REPORT_RESERVE_MS = 250;

/** #6803 C3: a scan's wall-clock end: its own timeout, or its entry's (and so the run's) deadline less the report reserve when sooner. */
export function scanDeadline(ctx: { entryDeadlineAt?: number }, ownTimeoutMs: number, now = Date.now()): number {
  return Math.min(now + ownTimeoutMs, (ctx.entryDeadlineAt ?? Infinity) - SCAN_REPORT_RESERVE_MS);
}

/** Whether a registry entry runs at `tier` (`standard` includes `ops`; `deep` includes both). */
export function entryRunsAt(entryTier: DoctorTier | undefined, tier: DoctorTier): boolean {
  const own = entryTier ?? 'standard';
  if (tier === 'ops') return own === 'ops';
  if (tier === 'standard') return own !== 'deep';
  return true;
}

const EXPIRED: unique symbol = Symbol('doctor_budget_expired');

/** Resolves `work`, or `EXPIRED` once `ms` passes (the work keeps running; its result is dropped). */
export async function raceBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof EXPIRED>((resolve) => { timer = setTimeout(() => resolve(EXPIRED), Math.max(0, ms)); });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export { EXPIRED as BUDGET_EXPIRED };
export type BudgetExpired = typeof EXPIRED;

/** Whether a raced result is the budget's expiry marker. */
export function budgetExpired(value: unknown): value is BudgetExpired {
  return value === EXPIRED;
}

/** Which budget stopped an entry: its own (`doctor.entry_budget_ms`) or the run's overall deadline. */
export type BudgetLimit = 'entry' | 'overall';

/** A rerun alone gets this many times the budget it ran out of (the time it needs is unknown: the budget cut it off). */
const RERUN_BUDGET_FACTOR = 10;

/** Headroom under AGENT_TOOL_LIMIT_MS for the process start and connect around a rerun. */
const AGENT_RERUN_HEADROOM_MS = 10_000;

/**
 * One check an entry could not finish within its budget, in the shared unknown convention. The fix reruns the
 * check alone with `--budget-ms N` (which `--only` makes its entry budget), N ten times the budget it ran out of:
 * the agent's while N fits an agent tool call (AGENT_TOOL_LIMIT_MS), else the user's to run in a terminal.
 */
export function budgetUnknownCheck(name: string, elapsedMs: number, budgetMs: number, limit: BudgetLimit = 'entry'): Check {
  const agentCap = AGENT_TOOL_LIMIT_MS - AGENT_RERUN_HEADROOM_MS;
  const wanted = Math.ceil(Math.max(elapsedMs, budgetMs, 1) * RERUN_BUDGET_FACTOR / 1000) * 1000;
  const n = wanted <= agentCap || elapsedMs >= agentCap ? wanted : agentCap;
  const argv = ['gbrain', 'doctor', '--only', name, '--budget-ms', String(n), '--json'];
  const which = limit === 'overall' ? `the run's overall budget (${budgetMs} ms: --budget-ms or doctor.default_budget_ms)` : `its per-check budget (${budgetMs} ms, doctor.entry_budget_ms)`;
  const why = `Runs only this check with a ${n} ms budget, above the ${elapsedMs} ms it already took; read-only.`;
  return {
    name, status: 'warn', elapsed_ms: elapsedMs,
    message: `Not finished within ${which}. Health is unknown, not clear; rerun this check alone: ${argv.join(' ')}`,
    details: { health: 'unknown', reason: 'budget', limit, exact: false, elapsed_ms: elapsedMs, budget_ms: budgetMs, rerun_budget_ms: n },
    fix: n <= agentCap ? agentFix(argv, why, name)
      : { argv, consent: [], actor: 'user', requires_exclusive: false, why: `${why} It can run longer than an agent tool call, so run it in a terminal.` },
  };
}

/** An ops section skipped by design on PGLite: info, so the ops report stays complete. */
export function opsNotApplicableCheck(name: string): Check {
  return {
    name, status: 'ok', severity: 'info', readiness_state: 'not_applicable', elapsed_ms: 0,
    message: 'Not applicable to the ops tier on PGLite (it reads only counters, config and catalog there); run gbrain doctor for this check.',
    details: { health: 'not_applicable', reason: 'pglite_ops_tier', exact: true },
  };
}

/** Whether a check is an over-budget unknown (the ops report's `unknown_sections`). */
export function isBudgetUnknown(check: Pick<Check, 'details'>): boolean {
  return check.details?.health === 'unknown' && check.details?.reason === 'budget';
}

/** #6696 B1: what the report says about the run's tier and deadline (`--tier` / `--budget-ms` given). */
export interface DoctorRunSummary { tier: DoctorTier; startedAt: number; budgetMs: number | null }

export function tierFields(checks: Check[], run: DoctorRunSummary): Pick<DoctorReport, 'tier' | 'complete' | 'unknown_sections' | 'elapsed_ms' | 'budget_ms'> {
  const unknown = checks.filter((c) => c.status !== 'ok' && c.details?.health === 'unknown').map((c) => c.name);
  return { tier: run.tier, complete: unknown.length === 0, unknown_sections: unknown, elapsed_ms: Date.now() - run.startedAt, budget_ms: run.budgetMs };
}

/** The run summary a report carries: when the caller chose a tier or a budget, or the non-interactive default capped the run. */
export function doctorRunSummary(args: readonly string[], deadline: DoctorDeadline): DoctorRunSummary | undefined {
  if (!deadline.nonInteractiveDefault && !args.some((a) => a === '--tier' || a.startsWith('--tier=') || a === '--budget-ms' || a.startsWith('--budget-ms='))) return undefined;
  return { tier: parseDoctorTier(args), startedAt: deadline.startedAt, budgetMs: deadline.budgetMs };
}

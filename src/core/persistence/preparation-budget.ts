/**
 * #6278: how long a claimed write may prepare before the consumer takes it
 * off its root, and how many such cut-offs a request survives.
 *
 * A preparation that never settles used to hold its root for as long as its
 * owner renewed the claim: only `remember` and intent-less page writes had the
 * 30 s budget. Every kind now has one. The budgets form one config family
 * (none repurposes `persistence.max_claim_ms`, doctor's warning threshold):
 *
 * - `persistence.sync_preparation_ms` (default 120000): a `managed_sync_*` member;
 * - `persistence.maintenance_preparation_ms` (default 120000): maintenance and
 *   every other kind (the adoption preparer is put_page-sized);
 * - `persistence.preparation_ceiling_ms` (default 600000, 60000 to 3600000, at
 *   least the larger budget plus 30 s): how long an abandoned preparation that
 *   ignores cancellation may keep its root blocked, measured from the claim;
 * - `persistence.max_preparation_attempts` (default 2, 1 to 10): the request is
 *   finished `failed`/`preparation_stalled` once its counter reaches it.
 *
 * `remember`, `put_page` and `edit_page` without an internal intent keep the
 * consumer's `preparationMs` (30 s). The deadlines sit behind the
 * `preparation_deadlines` write switch (switches.ts); off restores the old
 * predicate and never charges the counter. `racePreparation` is the one race
 * every caller uses (the consumer's single and group routes, and the sync's
 * out-of-consumer preparations): the budget wins even when the preparer
 * ignores its signal, and the late result is then the caller's to drop.
 */
import type { SqlEngine, WriteRequest } from './model.ts';

export const PREPARATION_BUDGET_KEYS = {
  syncMs: 'persistence.sync_preparation_ms',
  maintenanceMs: 'persistence.maintenance_preparation_ms',
  ceilingMs: 'persistence.preparation_ceiling_ms',
  maxAttempts: 'persistence.max_preparation_attempts',
} as const;
export type PreparationBudgetKey = keyof typeof PREPARATION_BUDGET_KEYS;
export const PREPARATION_BUDGET_CONFIG_KEYS: readonly string[] = Object.values(PREPARATION_BUDGET_KEYS);

export interface PreparationPolicy {
  syncMs: number;
  maintenanceMs: number;
  ceilingMs: number;
  maxAttempts: number;
}
export const DEFAULT_PREPARATION_POLICY: Readonly<PreparationPolicy> = Object.freeze({ syncMs: 120_000, maintenanceMs: 120_000, ceilingMs: 600_000, maxAttempts: 2 });
/** The ceiling must leave an abandoned preparation this much past the larger budget before the root is freed. */
export const PREPARATION_CEILING_GRACE_MS = 30_000;
const RANGES: Record<PreparationBudgetKey, { min: number; max: number; unit: string }> = {
  syncMs: { min: 1_000, max: 3_600_000, unit: 'milliseconds' },
  maintenanceMs: { min: 1_000, max: 3_600_000, unit: 'milliseconds' },
  ceilingMs: { min: 60_000, max: 3_600_000, unit: 'milliseconds' },
  maxAttempts: { min: 1, max: 10, unit: 'attempts' },
};

function parseWhole(raw: string | null | undefined): number | null {
  const text = raw?.trim() ?? '';
  return /^\d+$/.test(text) ? Number(text) : null;
}
/** The value of one key, or null when it is missing or out of range (the caller falls back to the default). */
export function parsePreparationBudget(name: PreparationBudgetKey, raw: string | null | undefined): number | null {
  const n = parseWhole(raw);
  return n !== null && n >= RANGES[name].min && n <= RANGES[name].max ? n : null;
}
/** The policy from the config rows read (key → value); a missing or invalid key keeps its default. */
export function resolvePreparationPolicy(configured: Map<string, string>): PreparationPolicy {
  const out = { ...DEFAULT_PREPARATION_POLICY };
  for (const [name, key] of Object.entries(PREPARATION_BUDGET_KEYS) as Array<[PreparationBudgetKey, string]>) {
    const value = parsePreparationBudget(name, configured.get(key));
    if (value !== null) out[name] = value;
  }
  // A ceiling below the budgets would free a root before its preparation could finish; it floors at the larger budget plus the grace.
  out.ceilingMs = Math.max(out.ceilingMs, Math.max(out.syncMs, out.maintenanceMs) + PREPARATION_CEILING_GRACE_MS);
  return out;
}

export interface PreparationConfigRefusal { message: string; suggestion: string; example: string }
/**
 * `config set` validation for the key family. `others` holds the current
 * values of the sibling keys so the ceiling rule is checked across keys. Null
 * when the value is valid or the key is another one.
 */
export function validatePreparationConfigValue(key: string, value: string, others: Map<string, string> = new Map()): PreparationConfigRefusal | null {
  const name = (Object.keys(PREPARATION_BUDGET_KEYS) as PreparationBudgetKey[]).find(candidate => PREPARATION_BUDGET_KEYS[candidate] === key);
  if (!name) return null;
  const range = RANGES[name];
  const n = parseWhole(value);
  if (n === null || n < range.min || n > range.max) {
    return { message: `${key} must be a whole number of ${range.unit} from ${range.min} to ${range.max} (default ${DEFAULT_PREPARATION_POLICY[name]}); got '${value}'. Nothing was written.`,
      suggestion: `Re-run with a value in range, for example gbrain config set ${key} ${DEFAULT_PREPARATION_POLICY[name]}.`, example: String(DEFAULT_PREPARATION_POLICY[name]) };
  }
  const merged = new Map(others);
  merged.set(key, value);
  const policy = resolvePreparationPolicyStrict(merged);
  const floor = Math.max(policy.syncMs, policy.maintenanceMs) + PREPARATION_CEILING_GRACE_MS;
  if (policy.ceilingMs < floor) {
    const fix = name === 'ceilingMs' ? `gbrain config set ${key} ${floor}` : `gbrain config set ${PREPARATION_BUDGET_KEYS.ceilingMs} ${Math.min(floor, RANGES.ceilingMs.max)}`;
    return { message: `${PREPARATION_BUDGET_KEYS.ceilingMs} (${policy.ceilingMs}) must be at least the larger preparation budget plus ${PREPARATION_CEILING_GRACE_MS} ms (${floor}); nothing was written.`,
      suggestion: `Raise the ceiling first (${fix}), or lower the budget so the ceiling stays above it.`, example: String(floor) };
  }
  return null;
}
/** Like `resolvePreparationPolicy` without the ceiling floor, for validation. */
function resolvePreparationPolicyStrict(configured: Map<string, string>): PreparationPolicy {
  const out = { ...DEFAULT_PREPARATION_POLICY };
  for (const [name, key] of Object.entries(PREPARATION_BUDGET_KEYS) as Array<[PreparationBudgetKey, string]>) {
    const value = parsePreparationBudget(name, configured.get(key));
    if (value !== null) out[name] = value;
  }
  return out;
}
/** The current values of the key family (for cross-key validation at `config set`). */
export async function readPreparationConfigValues(engine: SqlEngine): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key,value FROM config WHERE key = ANY($1::text[])', [PREPARATION_BUDGET_CONFIG_KEYS]).catch(() => []);
  return new Map(rows.map(row => [row.key, row.value]));
}

export type PreparationKind = 'foreground' | 'sync' | 'maintenance';
/** Which budget a request takes: the foreground 30 s, the sync member budget, or the maintenance budget for everything else. */
export function preparationKind(row: Pick<WriteRequest, 'operation' | 'intent'>): PreparationKind {
  const kind = row.intent?.kind;
  if (row.operation === 'remember' || (row.operation === 'put_page' || row.operation === 'edit_page') && !kind) return 'foreground';
  return String(kind ?? '').startsWith('managed_sync_') ? 'sync' : 'maintenance';
}
export function preparationBudgetMs(row: Pick<WriteRequest, 'operation' | 'intent'>, policy: PreparationPolicy, foregroundMs: number): number {
  const kind = preparationKind(row);
  return kind === 'foreground' ? foregroundMs : kind === 'sync' ? policy.syncMs : policy.maintenanceMs;
}

/** What a preparation's `outcome` yields when the budget passes before the work settles. */
export const PREPARATION_DEADLINE: unique symbol = Symbol('preparation_deadline');
export type PreparationOutcome<T> = { result: T } | { deadline: typeof PREPARATION_DEADLINE };
export interface PreparationRun<T> {
  /** The preparer's own promise; after a deadline the caller owns it and must never publish its result. */
  work: Promise<T>;
  /** The result, or the deadline when the budget passes first (the work keeps running); a failure inside the budget rejects. */
  outcome: Promise<PreparationOutcome<T>>;
  /** The preparer's signal: aborted `{ code: 'preparation_deadline' }` at the budget, or with `abort(reason)`'s reason. */
  signal: AbortSignal;
  /** Cancels the preparer for another reason (a lost claim, a stopping consumer); the outcome then follows the work. */
  abort(reason: unknown): void;
  /** Whether the budget has passed (by timer, or by `late()` when the work settled after it). */
  readonly expired: boolean;
  /** Whether the budget passed on the clock, for a synchronous preparation that outran the timer. */
  late(): boolean;
  /** Treats the preparation as over budget now (aborts it, runs `onDeadline`). */
  expire(): void;
}
/**
 * Starts `work` under a budget. The budget wins the `outcome` race whether or
 * not the preparer honours its signal (the deadline settles before the abort
 * reaches the work, so a preparer that rejects on abort cannot win), and a
 * result that lands after the budget on the clock still reads as a deadline.
 * `budgetMs` undefined means no deadline: the outcome follows the work.
 */
export function startPreparation<T>(work: (signal: AbortSignal) => Promise<T>, budgetMs: number | undefined,
  opts: { now?: () => number; onDeadline?: () => void } = {}): PreparationRun<T> {
  const now = opts.now ?? (() => performance.now());
  const abort = new AbortController();
  const deadline = Promise.withResolvers<{ deadline: typeof PREPARATION_DEADLINE }>();
  let expired = false;
  const expire = () => {
    if (expired) return;
    expired = true;
    deadline.resolve({ deadline: PREPARATION_DEADLINE });
    if (!abort.signal.aborted) abort.abort({ code: 'preparation_deadline' });
    opts.onDeadline?.();
  };
  const timer = budgetMs === undefined ? undefined : setTimeout(expire, budgetMs);
  const started = now();
  const late = () => budgetMs !== undefined && (expired || now() - started >= budgetMs);
  const run = (async () => work(abort.signal))();
  run.catch(() => undefined);
  const outcome = (async (): Promise<PreparationOutcome<T>> => {
    try {
      const won = await Promise.race([run.then(result => ({ result })), deadline.promise]);
      if ('result' in won && late()) { expire(); return { deadline: PREPARATION_DEADLINE }; }
      return won;
    } catch (error) {
      if (late()) { expire(); return { deadline: PREPARATION_DEADLINE }; }
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  })();
  outcome.catch(() => undefined);
  return { work: run, outcome, signal: abort.signal, abort: reason => { if (!abort.signal.aborted) abort.abort(reason); }, get expired() { return expired; }, late, expire };
}
/** The outcome alone: the sync's out-of-consumer preparations (waivers, origin equivalence) race their work against the budget this way. */
export function racePreparation<T>(work: (signal: AbortSignal) => Promise<T>, budgetMs: number, opts: { now?: () => number; onDeadline?: () => void } = {}): Promise<PreparationOutcome<T>> {
  return startPreparation(work, budgetMs, opts).outcome;
}

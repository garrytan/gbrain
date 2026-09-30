import { randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { loadPricingOverrides } from './budget/budget-tracker.ts';
import { reservationCostUsd, usageCostUsd, type BudgetKind } from './budget/reservation-cost.ts';
import type { AIInvocation, AIInvocationPermit, AIInvocationUsage } from './ai/invocation-guard.ts';
import { MIGRATION_STATE_KEY, readMigrationState, type EmbeddingMigrationPlan, type MigrationState } from './embedding-migration.ts';
import type { DbLockHandle } from './db-lock.ts';

export const EMBEDDING_BUDGET_BELOW_WORST_CASE = 'embedding_budget_below_worst_case';
export const EMBEDDING_BUDGET_REFUSAL_DOCS = 'https://github.com/garrytan/gbrain/blob/master/docs/guides/write-refusals.md#embedding_budget_below_worst_case';
const USD_EPSILON = 1e-9;

/** Σ maximum input over the planned requests, from the same batcher the run dispatches through. `usd` is null only when the embedding model is unpriced. */
export interface MigrationWorstCase { requests: number; input_tokens: number; usd: number | null; unpriced_models: string[] }

export interface MigrationBudgetRefusalDetails {
  error: typeof EMBEDDING_BUDGET_BELOW_WORST_CASE;
  message: string;
  cap_usd: number;
  worst_case_usd: number;
  debited_usd: number;
  required_cap_usd: number;
  suggestion: string;
  docs: string;
}

/** Whole cents, rounded up, so a printed amount is always enough to authorize what it describes. */
export function ceilCents(usd: number): number {
  return usd <= 0 ? 0 : Math.ceil(usd * 100 - USD_EPSILON) / 100;
}

export class MigrationBudgetRefusal extends Error {
  readonly details: MigrationBudgetRefusalDetails;
  constructor(plan: EmbeddingMigrationPlan, cap: number, worst: number, debited: number) {
    const required = ceilCents(worst + debited);
    const suggestion = `gbrain migrate embeddings --to ${plan.to_model} --dim ${plan.to_dims} --max-cost-usd ${required.toFixed(2)} --yes`;
    const message = `Migration refused before any change (${EMBEDDING_BUDGET_BELOW_WORST_CASE}): the cap is $${cap} (--max-cost-usd), `
      + `but the worst-case authorization is $${ceilCents(worst).toFixed(2)}${debited > 0 ? ` on top of $${debited.toFixed(4)} already debited` : ''}. `
      + `No provider request was sent and no vector was dropped. Raise the cap to at least $${required.toFixed(2)}: ${suggestion}`;
    super(message);
    this.name = 'MigrationBudgetRefusal';
    this.details = { error: EMBEDDING_BUDGET_BELOW_WORST_CASE, message, cap_usd: cap, worst_case_usd: worst, debited_usd: debited,
      required_cap_usd: required, suggestion, docs: EMBEDDING_BUDGET_REFUSAL_DOCS };
  }
}

export async function assertMigrationLeases(engine: BrainEngine, locks: DbLockHandle[]) {
  if (!locks.length) return;
  const owned = await engine.executeRaw<{ id: string; token: string }>(`SELECT id,acquisition_token::text AS token
    FROM gbrain_cycle_locks WHERE id=ANY($1::text[]) AND ttl_expires_at>now() ORDER BY id FOR SHARE`, [locks.map(lock => lock.id)]);
  if (owned.length !== locks.length || locks.some(lock => !owned.some(row => row.id === lock.id && row.token === lock.acquisitionToken))) {
    throw new Error('Migration lease lost; authorization debit and provider dispatch refused');
  }
}

type MigrationBudget = NonNullable<MigrationState['budget']>;

function budgetIsValid(budget: MigrationBudget): boolean {
  return Number.isFinite(budget.max_cost_usd) && budget.max_cost_usd >= 0 && Number.isFinite(budget.debited_usd)
    && budget.debited_usd >= 0 && Number.isSafeInteger(budget.requests) && budget.requests >= 0
    && (budget.pending === undefined || (typeof budget.pending === 'object' && budget.pending !== null
      && Object.values(budget.pending).every(n => Number.isFinite(n) && n >= 0)))
    && (budget.overshoot_usd === undefined || Number.isFinite(budget.overshoot_usd) && budget.overshoot_usd >= 0);
}

async function lockMigrationState(tx: BrainEngine): Promise<MigrationState | null> {
  await tx.executeRaw('SELECT key FROM config WHERE key=$1 FOR UPDATE', [MIGRATION_STATE_KEY]);
  return (await readMigrationState(tx)).state;
}

/**
 * Durable migration authorization. Each provider attempt reserves its maximum
 * input size under the migration state row lock and settles, under the same
 * lock, to the provider's reported usage (#5680). A missing usage report or a
 * crash before settlement keeps the maximum; usage above the reservation
 * debits actual, records the overshoot and stops further dispatch. When a
 * worst case is supplied, a cap below it refuses before any state changes.
 */
export async function authorizeMigrationBudget(engine: BrainEngine, plan: EmbeddingMigrationPlan, maxCostUsd?: number, locks: DbLockHandle[] = [], rerankerModel?: string, worstCase?: MigrationWorstCase) {
  const prior = await readMigrationState(engine);
  if (prior.corrupt) {
    let legacy = false;
    try {
      const raw = JSON.parse(prior.raw ?? 'null');
      legacy = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        && !Object.hasOwn(raw, 'budget') && !Object.hasOwn(raw, 'authorization_version');
    } catch {}
    if (!legacy || maxCostUsd === undefined) throw new Error('Migration state is corrupt; no paid request or invalidation was authorized. Inspect migrate embeddings --status.');
  }
  const same = prior.state?.to_model === plan.to_model && prior.state.to_dims === plan.to_dims;
  const state: MigrationState = same ? prior.state! : {
    version: 2, to_model: plan.to_model, to_dims: plan.to_dims, from_model: plan.from_model,
    from_dims: plan.from_dims, started_at: new Date().toISOString(),
  };
  const old = state.budget;
  if (state.authorization_version && !old) throw new Error('Migration authorization is missing; automatic renewal refused');
  if (old && !budgetIsValid(old)) throw new Error('Migration authorization is corrupt; no request dispatched');
  if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)) throw new Error('--max-cost-usd must be finite and nonnegative');
  if (!old && maxCostUsd === undefined) throw new Error('Paid work requires explicit --max-cost-usd. Preview with --dry-run; resume retains spent authorization.');
  const cap = maxCostUsd ?? old!.max_cost_usd;
  const debited = old?.debited_usd ?? 0;
  if (worstCase?.usd != null && cap + USD_EPSILON < debited + worstCase.usd) throw new MigrationBudgetRefusal(plan, cap, worstCase.usd, debited);
  state.budget = old ? { ...old, max_cost_usd: cap } : { max_cost_usd: cap, debited_usd: 0, requests: 0 };
  if (maxCostUsd !== undefined) delete state.budget.halted;
  state.authorization_version = 1;
  const generation = (state.authorization_generation ?? 0) + 1;
  state.authorization_generation = generation;
  if (!same && prior.state) {
    state.retargeted_at = state.started_at;
    state.superseded = [...prior.state.superseded ?? [], { to_model: prior.state.to_model, to_dims: prior.state.to_dims, started_at: prior.state.started_at }];
  }
  await engine.transaction(async tx => {
    await assertMigrationLeases(tx, locks);
    await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify(state));
  });
  const pricingOverrides = await loadPricingOverrides(engine);
  const ownsBudget = (current: MigrationState | null): current is MigrationState & { budget: MigrationBudget } =>
    !!current?.budget && current.to_model === plan.to_model && current.to_dims === plan.to_dims
    && current.authorization_generation === generation;

  const settle = async (attempt: string, call: AIInvocation, kind: BudgetKind, usage: AIInvocationUsage | null) => {
    await engine.transaction(async tx => {
      const current = await lockMigrationState(tx);
      if (!ownsBudget(current) || !budgetIsValid(current.budget)) return;
      const reserved = current.budget.pending?.[attempt];
      if (reserved === undefined) return;
      const billable = usage && usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      const actual = usage ? usageCostUsd(call.model, billable!, usage.outputTokens, kind, pricingOverrides) : null;
      const { [attempt]: _settled, ...pending } = current.budget.pending!;
      current.budget.pending = pending;
      if (!Object.keys(pending).length) delete current.budget.pending;
      if (actual !== null && Number.isFinite(actual) && actual >= 0) {
        current.budget.debited_usd = Math.max(0, current.budget.debited_usd + actual - reserved);
        if (actual > reserved + USD_EPSILON) {
          current.budget.overshoot_usd = (current.budget.overshoot_usd ?? 0) + actual - reserved;
          current.budget.halted = true;
        }
      }
      await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify(current));
    });
  };

  return async (call: AIInvocation): Promise<AIInvocationPermit> => {
    if (call.kind !== 'embedding' && call.kind !== 'rerank') throw new Error('Migration permits embedding and reranker probes only');
    if (call.model !== (call.kind === 'embedding' ? plan.to_model : rerankerModel)) throw new Error('Provider model differs from the authorized migration plan; no request dispatched');
    if (!Number.isSafeInteger(call.maxInputTokens) || call.maxInputTokens! <= 0) throw new Error('Provider request has no conservative input ceiling; no request dispatched');
    const kind: BudgetKind = call.kind === 'embedding' ? 'embed' : 'rerank';
    const reserved = reservationCostUsd(call.model, kind, call.maxInputTokens!, 0, pricingOverrides);
    if (reserved === null) {
      throw new Error(`Migration authorization cannot price ${call.model} (${kind}); no request dispatched. Declare an operator rate with gbrain config set pricing.overrides '{"${call.model}": <usd-per-1M-tokens>}'.`);
    }
    const attempt = randomUUID();
    await engine.transaction(async tx => {
      await assertMigrationLeases(tx, locks);
      const current = await lockMigrationState(tx);
      if (!ownsBudget(current)) throw new Error('Migration authorization changed; no request dispatched');
      const budget = current.budget;
      if (!budgetIsValid(budget)) throw new Error('Migration authorization is corrupt; no request dispatched');
      if (budget.halted) {
        throw new Error(`Migration dispatch stopped: provider usage exceeded its reservation by $${(budget.overshoot_usd ?? 0).toFixed(6)} (recorded as overshoot). No request dispatched. Inspect gbrain migrate embeddings --status, then re-run with --max-cost-usd to renew dispatch.`);
      }
      if (budget.debited_usd + reserved > budget.max_cost_usd + USD_EPSILON) {
        throw new Error(`Migration authorization exhausted: this request needs up to $${reserved.toFixed(6)} at its maximum input size, but $${budget.debited_usd.toFixed(6)} of the $${budget.max_cost_usd} cap (--max-cost-usd) is already debited. No request dispatched. Raise --max-cost-usd to renew; prior debits remain.`);
      }
      budget.debited_usd += reserved;
      budget.requests++;
      budget.pending = { ...budget.pending, [attempt]: reserved };
      await tx.setConfig(MIGRATION_STATE_KEY, JSON.stringify(current));
    });
    return { settle: usage => settle(attempt, call, kind, usage) };
  };
}

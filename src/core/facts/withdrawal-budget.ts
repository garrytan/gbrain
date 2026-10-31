import type { BrainEngine } from '../engine.ts';

/** One complete discovery scan, not a target/byte/visibility override. */
export const WITHDRAWAL_BUDGET_KEY = 'facts.withdrawal_budget_ms';
export const WITHDRAWAL_BUDGET_DEFAULT_MS = 10_000;
export const WITHDRAWAL_BUDGET_MAX_MS = 120_000;

export function parseWithdrawalBudgetMs(raw: string | null | undefined): number {
  const value = Number(raw?.trim());
  return Number.isInteger(value) && value >= 1_000 && value <= WITHDRAWAL_BUDGET_MAX_MS
    ? value : WITHDRAWAL_BUDGET_DEFAULT_MS;
}

/** Read before admission; the same frozen budget is used by discovery in that attempt. */
export async function readWithdrawalBudgetMs(engine: Pick<BrainEngine, 'getConfig'>): Promise<number> {
  return parseWithdrawalBudgetMs(await engine.getConfig(WITHDRAWAL_BUDGET_KEY));
}

/** Discovery runs inside admission; reserve five seconds for authority and committing its receipt. */
export function withdrawalAdmissionBudgetMs(scanMs: number): number { return scanMs + 5_000; }

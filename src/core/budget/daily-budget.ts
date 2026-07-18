/**
 * Cross-process daily AI budget governor.
 *
 * Uses the existing reserve/settle spend ledger so every GBrain process sees
 * the same daily cap. When enabled, missing pricing and ledger failures fail
 * closed before provider transport. Pending reservations remain charged at
 * their estimate if a process crashes.
 */

import type { BrainEngine } from '../engine.ts';
import {
  BudgetExhausted,
  costForUsage,
  estimateBudgetCostUsd,
  type BudgetActualUsage,
  type BudgetEstimate,
  type BudgetKind,
} from './budget-tracker.ts';
import {
  BudgetExceededError,
  reserve,
  settle,
  type Reservation,
} from '../minions/budget-meter.ts';
import { splitProviderModelId } from '../model-id.ts';

const DAILY_CLIENT_ID = 'gbrain:daily-ai';

interface DailyBudgetState {
  engine: BrainEngine;
  capUsd: number;
}

export interface DailyBudgetReservation {
  reservation: Reservation;
  estimate: BudgetEstimate;
  estimatedCents: number;
}

let state: DailyBudgetState | null = null;

export function configureDailyBudget(engine: BrainEngine, rawCap: unknown): void {
  const capUsd = Number(rawCap);
  state = Number.isFinite(capUsd) && capUsd > 0 ? { engine, capUsd } : null;
}

export function resetDailyBudget(): void {
  state = null;
}

export function getDailyBudgetCapUsd(): number | null {
  return state?.capUsd ?? null;
}

export async function reserveDailyBudget(
  estimate: BudgetEstimate,
): Promise<DailyBudgetReservation | null> {
  if (!state) return null;
  const estimatedUsd = estimateBudgetCostUsd(estimate);
  if (estimatedUsd === null) {
    throw new BudgetExhausted(
      `daily AI budget: no pricing entry for model "${estimate.modelId}" (${estimate.kind}); refusing provider call`,
      { reason: 'no_pricing', spent: 0, cap: state.capUsd, modelId: estimate.modelId },
    );
  }
  const estimatedCents = Math.max(estimatedUsd * 100, 0.000001);
  const { provider } = splitProviderModelId(estimate.modelId);
  try {
    const reservation = await reserve(state.engine, {
      clientId: DAILY_CLIENT_ID,
      estimatedCents,
      capCents: state.capUsd * 100,
      model: estimate.modelId,
      provider: provider || 'unknown',
    });
    return { reservation, estimate, estimatedCents };
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      throw new BudgetExhausted(
        `daily AI budget of $${state.capUsd.toFixed(2)} exhausted; refusing provider call`,
        { reason: 'cost', spent: error.spentCents / 100, cap: state.capUsd, modelId: estimate.modelId },
      );
    }
    throw new BudgetExhausted(
      `daily AI budget ledger unavailable; refusing provider call: ${error instanceof Error ? error.message : String(error)}`,
      { reason: 'cost', spent: 0, cap: state.capUsd, modelId: estimate.modelId },
    );
  }
}

export async function settleDailyBudget(
  daily: DailyBudgetReservation | null,
  usage?: BudgetActualUsage & { kind?: BudgetKind },
): Promise<void> {
  if (!daily || !state) return;
  const actualUsd = usage
    ? costForUsage(
        usage.modelId,
        usage.inputTokens,
        usage.outputTokens ?? 0,
        usage.kind ?? daily.estimate.kind,
      )
    : null;
  const actualCents = actualUsd === null
    ? daily.estimatedCents
    : Math.max(actualUsd * 100, 0.000001);
  await settle(state.engine, daily.reservation.reservationId, actualCents, `ai_gateway_${daily.estimate.kind}`);
}

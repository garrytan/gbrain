import type { BrainEngine } from '../engine.ts';
import { configureBudgetTrackerDefaults } from './budget-tracker.ts';
import { resolveMonthlyBudgetCapFromEngine } from './monthly-cap.ts';

/**
 * Apply DB-backed process-wide BudgetTracker defaults after the engine is
 * connected. Gateway calls outside an explicit withBudgetTracker scope use
 * these defaults too, which is the path unattended Dream/autopilot work relies on.
 */
export async function configureBudgetTrackerDefaultsFromEngine(engine: Pick<BrainEngine, 'getConfig'>): Promise<void> {
  configureBudgetTrackerDefaults({
    monthlyBudget: await resolveMonthlyBudgetCapFromEngine(engine),
  });
}

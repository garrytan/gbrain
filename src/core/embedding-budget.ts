/** Run-wide embedding caps compose with any enclosing budget. */
import type { BrainEngine } from './engine.ts';
import type { CapSource } from './consent.ts';
import { BudgetTracker, loadPricingOverrides } from './budget/budget-tracker.ts';
import { getCurrentBudgetTracker, withBudgetTracker } from './ai/gateway.ts';
import { parseUsdLimit } from './spend-posture.ts';

/** An explicitly configured cap applies even when spend.posture is tokenmax. */
export async function configuredEmbeddingCapUsd(engine: Pick<BrainEngine, 'getConfig'>): Promise<number | undefined> {
  const raw = await engine.getConfig('embed.backfill_max_usd');
  if (raw == null || raw.trim() === '') return undefined;
  const parsed = parseUsdLimit(raw, NaN);
  if (parsed === Infinity) return undefined;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('embed.backfill_max_usd must be a finite positive USD cap or off');
  return parsed;
}

/** Bound one invocation by the lower of its authorization and configured cap. */
export async function withEmbeddingBudget<T>(
  engine: Pick<BrainEngine, 'getConfig'>,
  fn: () => Promise<T>,
  opts: { maxCostUsd?: number; capSource?: CapSource; label?: string } = {},
): Promise<T> {
  const configured = await configuredEmbeddingCapUsd(engine);
  if (opts.maxCostUsd !== undefined && (!Number.isFinite(opts.maxCostUsd) || opts.maxCostUsd <= 0)) {
    throw new Error('Embedding authorization must carry a finite positive USD cap');
  }
  const maxCostUsd = configured === undefined ? opts.maxCostUsd
    : opts.maxCostUsd === undefined ? configured : Math.min(configured, opts.maxCostUsd);
  if (maxCostUsd === undefined) return fn();
  const parent = getCurrentBudgetTracker();
  if (parent && parent.getRemaining() <= maxCostUsd) return fn();
  const tracker = new BudgetTracker({
    label: opts.label ?? 'embed', maxCostUsd,
    capSource: configured !== undefined && configured <= (opts.maxCostUsd ?? Infinity) ? 'user' : opts.capSource,
    pricingOverrides: await loadPricingOverrides(engine),
    parentTracker: parent ?? undefined,
    providerRetries: 0,
  });
  return withBudgetTracker(tracker, fn);
}

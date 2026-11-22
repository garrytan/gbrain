// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/commands/doctor/checks/consolidation-cycle.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/commands/doctor/checks/consolidation-cycle.ts:133-148
export async function checkPoolBudget(_engine: BrainEngine): Promise<Check> {
  try {
    const { resolveMaxConnections } = await import('../../../core/sync-concurrency.ts');
    const { resolvePoolSize } = await import('../../../core/db.ts');
    const maxConnections = resolveMaxConnections();
    const parentPool = resolvePoolSize();
    const perWorkerPool = Math.min(2, resolvePoolSize(2));
    return computePoolBudgetCheck(maxConnections, parentPool, perWorkerPool);
  } catch (err) {
    return {
      name: 'pool_budget',
      status: 'ok',
      message: `Skipped (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

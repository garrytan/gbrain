// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/core/search/hybrid.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/core/search/hybrid.ts:789-807
async function readSupersededBy(
  results: SearchResult[],
  engine: import('../engine.ts').BrainEngine,
  policy?: PageReadPolicy,
): Promise<Map<number, string>> {
  const supersededBy = new Map<number, string>();
  const pageIds = Array.from(
    new Set(results.map(r => r.page_id).filter((id): id is number => typeof id === 'number')),
  );
  if (pageIds.length === 0) return supersededBy;
  if (!(await hasAnySupersedeEdges(engine))) return supersededBy;
  try {
    return await engine.supersedingPageSlugs(pageIds, policy);
  } catch (err) {
    rethrowCapabilityRefusal(err);
    // Pre-links schema or SQL miss; no-op.
    return supersededBy;
  }
}

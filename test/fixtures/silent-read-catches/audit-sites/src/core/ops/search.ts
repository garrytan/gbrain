// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/core/ops/search.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/core/ops/search.ts:213-224
async function evidenceOutput(ctx: OperationContext, p: Record<string, unknown>, results: SearchResult[], plan: EvidencePlan | null, scope: DeliveryScope,
  meta: HybridSearchMeta | null, snippetCap: number, timings: SearchTimings, buildMeta: (rows: SearchResult[]) => Promise<Record<string, unknown>>, keepEnumerated = false, delivered?: Awaited<ReturnType<typeof withEvidence>>): Promise<SearchResult[]> {
  return timings.stage('response', async () => {
    // Every returned row is a copy of one of `results`, so their page trust is read alongside evidence delivery.
    const pageTrust = loadPageTrust(ctx.engine, results.filter(r => typeof r.fact_row?.id !== 'number'));
    pageTrust.catch(() => {});
    const ev = delivered ?? await timings.part('response', 'evidence', () => withEvidence(ctx, p, results, plan, scope, meta));
    const rows = await timings.part('response', 'trust', () => stampPageTrust(ctx.engine, keepEnumerated ? keepEnumeratedRows(results, ev.rows) : ev.rows, scope.minTrust, pageTrust, worldOnlyFacts(ctx.remote)));
    const responseMeta = await timings.part('response', 'meta', () => buildMeta(rows));
    return searchOutput(ctx, p, rows, responseMeta, snippetCap, timings, ev.evidence);
  });
}

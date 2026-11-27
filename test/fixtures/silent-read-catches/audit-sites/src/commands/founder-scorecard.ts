// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/commands/founder-scorecard.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

export async function runFounder(engine: any) {
  // verbatim src/commands/founder-scorecard.ts:314-324
    try {
      takes = await engine.listTakes({
        page_slug: parsed.entitySlug,
        active: true,
        resolved: true,
        limit: 100,
      });
    } catch {
      // Some entity pages don't exist; treat as no takes.
      takes = [];
    }
}

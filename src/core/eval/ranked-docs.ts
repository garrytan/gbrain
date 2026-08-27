/**
 * Collapse chunk-level retrieval output to page-level ranked keys.
 *
 * Search may intentionally return several chunks from one page. Evaluation
 * treats that page as one document, preserving only its first (best) rank.
 */
export function dedupeRankedKeys(ranked: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const key of ranked) {
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

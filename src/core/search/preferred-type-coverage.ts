import type { PageType, SearchResult } from '../types.ts';

export interface PreferredTypeWinner {
  sourceId: string | undefined;
  slug: string;
  type: PageType;
}

export interface PreferredTypeCoverageOptions {
  /** One-based ceiling for later winners. Defaults to rank 15. */
  secondaryMaxRank?: number;
}

/** Build the composite page identity used across retrieval stages. */
function pageKey(sourceId: string | undefined, slug: string): string {
  return `${sourceId ?? 'default'}:${slug}`;
}

/** Match a result to a selected page-grain winner. */
function matchesWinner(result: SearchResult, winner: PreferredTypeWinner): boolean {
  return pageKey(result.source_id, result.slug) === pageKey(winner.sourceId, winner.slug);
}

/** Identify post-rerank identity rows that must remain ahead of preferences. */
function isPinnedIdentity(result: SearchResult): boolean {
  return result.alias_hit === true || result.exact_lookup !== undefined;
}

/** Select the first composite-page winner for each preferred type in typed rank order. */
export function selectPreferredTypeWinners(
  preferredTypes: readonly PageType[],
  typedResults: readonly SearchResult[],
): PreferredTypeWinner[] {
  if (preferredTypes.length === 0 || typedResults.length === 0) return [];

  const wantedTypes = new Set(preferredTypes);
  const selectedTypes = new Set<PageType>();
  const selectedPages = new Set<string>();
  const winners: PreferredTypeWinner[] = [];

  for (const result of typedResults) {
    if (!wantedTypes.has(result.type) || selectedTypes.has(result.type)) continue;
    const key = pageKey(result.source_id, result.slug);
    if (selectedPages.has(key)) continue;

    winners.push({ sourceId: result.source_id, slug: result.slug, type: result.type });
    selectedTypes.add(result.type);
    selectedPages.add(key);
    if (selectedTypes.size === wantedTypes.size) break;
  }

  return winners;
}

/** Check whether a result is one of the selected page-grain winners. */
export function isPreferredTypeWinner(
  result: SearchResult,
  winners: readonly PreferredTypeWinner[],
): boolean {
  return winners.some((winner) => matchesWinner(result, winner));
}

/**
 * Restore bounded preferred-type coverage without reordering ordinary rows.
 * Identity rows stay pinned ahead of the best preferred winner. Missing
 * winners can be re-admitted from the pre-trim candidate pool.
 */
export function applyPreferredTypeCoverage(
  ranked: readonly SearchResult[],
  winners: readonly PreferredTypeWinner[],
  candidates: readonly SearchResult[] = ranked,
  options: PreferredTypeCoverageOptions = {},
): SearchResult[] {
  if (winners.length === 0) return [...ranked];

  const covered = [...ranked];
  for (const winner of winners) {
    if (covered.some((result) => matchesWinner(result, winner))) continue;
    const candidate = candidates.find((result) => matchesWinner(result, winner));
    if (candidate) covered.push(candidate);
  }

  const availableWinners = winners.filter((winner) =>
    covered.some((result) => matchesWinner(result, winner)));
  const bestWinner = availableWinners[0];
  if (!bestWinner) return covered;

  const bestIndex = covered.findIndex((result) => matchesWinner(result, bestWinner));
  const bestResult = covered[bestIndex];
  if (bestResult && !isPinnedIdentity(bestResult)) {
    const pinnedPrefix = covered.findIndex((result) => !isPinnedIdentity(result));
    const bestTarget = pinnedPrefix === -1 ? covered.length : pinnedPrefix;
    if (bestIndex !== bestTarget) {
      const [best] = covered.splice(bestIndex, 1);
      const adjustedTarget = bestIndex < bestTarget ? bestTarget - 1 : bestTarget;
      covered.splice(Math.min(adjustedTarget, covered.length), 0, best!);
    }
  }

  const secondaryMaxRank = Math.max(1, Math.floor(options.secondaryMaxRank ?? 15));
  for (const [winnerOffset, winner] of availableWinners.slice(1).entries()) {
    const index = covered.findIndex((result) => matchesWinner(result, winner));
    const current = covered[index];
    if (!current || isPinnedIdentity(current)) continue;
    const priorWinners = availableWinners.slice(0, winnerOffset + 1);
    const earliestIndex = Math.max(
      ...priorWinners.map((prior) =>
        covered.findIndex((result) => matchesWinner(result, prior))),
    ) + 1;
    const latestIndex = secondaryMaxRank - 1;
    if (index >= earliestIndex && index <= latestIndex) continue;
    // A tight result window may have no rank that is both behind earlier
    // winners and ahead of the reserved final relational slot.
    if (earliestIndex > latestIndex) continue;
    const [result] = covered.splice(index, 1);
    const refreshedEarliestIndex = Math.max(
      ...priorWinners.map((prior) =>
        covered.findIndex((item) => matchesWinner(item, prior))),
    ) + 1;
    const targetIndex = index < earliestIndex ? refreshedEarliestIndex : latestIndex;
    covered.splice(Math.min(targetIndex, covered.length), 0, result!);
  }

  return covered;
}

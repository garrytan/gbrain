/**
 * Save-time caller around the shipped entity resolver.
 *
 * Bulk extract writes go through insertFacts and therefore skip
 * writeSingleFact's resolveEntitySlug hop. This module is the missing
 * write-path caller: it runs each extractor-provided entity through
 * resolveEntitySlugWithSource, which already owns the v0.46.15
 * alias_exact cascade via engine.resolveAliases.
 *
 * It does not re-implement the read-time cascade and does not introduce
 * alias_match / alias_redirect labels.
 */

import { BudgetExhausted } from '../budget/budget-tracker.ts';
import type { BrainEngine } from '../engine.ts';
import type { ExtractedFact } from '../facts/extract.ts';
import {
  resolveEntitySlugWithSource,
  type ResolutionSource,
} from './resolve.ts';

/** Shipped resolution tags, in stable log order. */
export const SAVE_TIME_RESOLUTION_SOURCES = [
  'exact_page',
  'alias_exact',
  'fuzzy_match',
  'fallback_slugify',
] as const satisfies readonly ResolutionSource[];

export interface SaveTimeResolutionCounts {
  counts: Partial<Record<ResolutionSource, number>>;
  fallback_slugify_count: number;
  resolution_errors: number;
}

export function emptySaveTimeResolutionCounts(): SaveTimeResolutionCounts {
  return { counts: {}, fallback_slugify_count: 0, resolution_errors: 0 };
}

export function mergeSaveTimeResolutionCounts(
  into: SaveTimeResolutionCounts,
  add: SaveTimeResolutionCounts,
): void {
  for (const [source, count] of Object.entries(add.counts)) {
    const typed = source as ResolutionSource;
    into.counts[typed] = (into.counts[typed] ?? 0) + (count ?? 0);
  }
  into.fallback_slugify_count += add.fallback_slugify_count;
  into.resolution_errors += add.resolution_errors;
}

export function formatSaveTimeResolutionCounts(
  counts: Partial<Record<ResolutionSource, number>>,
): string {
  const ordered: Partial<Record<ResolutionSource, number>> = {};
  for (const source of SAVE_TIME_RESOLUTION_SOURCES) {
    const count = counts[source];
    if (count) ordered[source] = count;
  }
  return JSON.stringify(ordered);
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /aborted|cancell?ed/i.test(err.message);
}

/**
 * Canonicalize extractor-provided entity slugs through the shipped
 * resolver. Mutates `facts` in place. Sequential so a PGLite-pinned
 * transaction sees one alias probe at a time.
 *
 * Ordinary resolver failures keep the raw value and increment
 * resolution_errors. Abort and BudgetExhausted propagate.
 */
export async function resolveExtractedEntitiesForSave(
  engine: BrainEngine,
  sourceId: string,
  facts: ExtractedFact[],
  onError?: (raw: string, message: string) => void,
): Promise<SaveTimeResolutionCounts> {
  const stats = emptySaveTimeResolutionCounts();
  for (let i = 0; i < facts.length; i++) {
    const raw = facts[i].entity_slug;
    if (raw === null) continue;
    try {
      const resolved = await resolveEntitySlugWithSource(engine, sourceId, raw);
      facts[i] = { ...facts[i], entity_slug: resolved?.slug ?? null };
      if (!resolved) continue;
      stats.counts[resolved.source] = (stats.counts[resolved.source] ?? 0) + 1;
      if (resolved.source === 'fallback_slugify') {
        stats.fallback_slugify_count++;
      }
    } catch (err) {
      if (isAbortError(err) || err instanceof BudgetExhausted) throw err;
      stats.resolution_errors++;
      const message = err instanceof Error ? err.message : String(err);
      onError?.(raw, message);
    }
  }
  return stats;
}

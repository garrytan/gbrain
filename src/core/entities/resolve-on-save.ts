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
  'prefix_expansion',
  'fuzzy_match',
  'fallback_slugify',
] as const satisfies readonly ResolutionSource[];

export interface SaveTimeResolutionCounts {
  counts: Partial<Record<ResolutionSource, number>>;
  fallback_slugify_count: number;
  /** GBRA-574: fallback_slugify resolutions kept as a name key (facts.unbacked_entity_keys) instead of NULL. */
  unbacked_key_count?: number;
  resolution_errors: number;
}

export function emptySaveTimeResolutionCounts(): SaveTimeResolutionCounts {
  return { counts: {}, fallback_slugify_count: 0, resolution_errors: 0 };
}

/** The setting that keeps a name key on conversation facts whose entity has no page; on unless set to an off value. */
export const UNBACKED_ENTITY_KEYS_KEY = 'facts.unbacked_entity_keys';

export async function unbackedEntityKeysEnabled(engine: BrainEngine): Promise<boolean> {
  return !/^(false|off|0|no)$/i.test(((await engine.getConfig(UNBACKED_ENTITY_KEYS_KEY)) ?? '').trim());
}

/**
 * GBRA-574 B1: the name key of an extractor entity that resolved only by fallback_slugify: the bare basename slug
 * (`Alice Example`, `alice-example` and `people/alice-example` all give `alice-example`), kept only for a name of at least
 * two words. A first name or a topic (`Alice`, `travel`) gives null.
 */
export function unbackedEntityKey(fallbackSlug: string): string | null {
  const key = fallbackSlug.split('/').filter(Boolean).pop() ?? '';
  return key.split('-').filter(Boolean).length >= 2 ? key : null;
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
  if (add.unbacked_key_count) into.unbacked_key_count = (into.unbacked_key_count ?? 0) + add.unbacked_key_count;
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
 * Unresolved references keep the fact unparented, unless `unbacked` is given (conversation extraction with
 * facts.unbacked_entity_keys on): then a two-word name keeps its name key (unbackedEntityKey) when no page sits at that
 * key, and `unbacked` records the row index and the extractor's own name text. No page is created. Ordinary resolver
 * failures increment resolution_errors. Abort and BudgetExhausted propagate.
 */
export async function resolveExtractedEntitiesForSave(
  engine: BrainEngine,
  sourceId: string,
  facts: ExtractedFact[],
  onError?: (raw: string, message: string) => void,
  unbacked?: Map<number, string>,
): Promise<SaveTimeResolutionCounts> {
  const stats = emptySaveTimeResolutionCounts();
  for (let i = 0; i < facts.length; i++) {
    const raw = facts[i].entity_slug;
    if (raw === null) continue;
    try {
      const resolved = await resolveEntitySlugWithSource(engine, sourceId, raw);
      const key = unbacked && resolved?.source === 'fallback_slugify' ? unbackedEntityKey(resolved.slug) : null;
      const kept = key && (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1',
        [sourceId, key])).length === 0 ? key : null;
      facts[i] = { ...facts[i], entity_slug: resolved?.source === 'fallback_slugify' ? kept : resolved?.slug ?? null };
      if (!resolved) continue;
      stats.counts[resolved.source] = (stats.counts[resolved.source] ?? 0) + 1;
      if (resolved.source === 'fallback_slugify') {
        stats.fallback_slugify_count++;
        if (kept) {
          stats.unbacked_key_count = (stats.unbacked_key_count ?? 0) + 1;
          unbacked!.set(i, raw.trim());
        }
      }
    } catch (err) {
      if (isAbortError(err) || err instanceof BudgetExhausted) throw err;
      facts[i] = { ...facts[i], entity_slug: null };
      stats.resolution_errors++;
      const message = err instanceof Error ? err.message : String(err);
      onError?.(raw, message);
    }
  }
  return stats;
}

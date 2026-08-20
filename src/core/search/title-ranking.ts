/**
 * Pure title-ranking stages shared by hybrid search and focused tests.
 * Kept outside hybrid.ts so the hot-path orchestrator stays within its
 * committed module-size ceiling.
 */

import type { SearchResult } from '../types.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { isTitlePhraseMatch } from './title-match.ts';

/** Default title-phrase boost multiplier (mode-overridable via `title_boost`). */
export const DEFAULT_TITLE_BOOST = 1.25;

/**
 * Apply the bounded title-phrase boost. Mutates in place; caller re-sorts.
 * The optional floor keeps a weak surface-overlap page from leapfrogging a
 * strong primary result in broad search.
 */
export function applyTitleBoost(
  results: SearchResult[],
  query: string,
  factor: number,
  floorThreshold?: number,
): void {
  if (!query || !Number.isFinite(factor) || factor <= 1.0) return;
  for (const result of results) {
    if (!Number.isFinite(result.score)) continue;
    if (floorThreshold !== undefined && result.score < floorThreshold) continue;
    if (!result.title) continue;
    if (isTitlePhraseMatch(query, result.title)) {
      result.score *= factor;
      result.title_match_boost = factor;
    }
  }
}

const EXACT_TITLE_LOOKUP_TYPES = new Set([
  'person', 'company', 'organization', 'entity', 'project', 'product',
]);
const preferredExactTitleLookups = new WeakSet<SearchResult>();

/** Internal marker query used by evidence stamping and autocut preservation. */
export function isPreferredExactTitleLookup(result: SearchResult): boolean {
  return preferredExactTitleLookups.has(result);
}

/**
 * Explicit canonical named-page filters make a query a precision lookup.
 * Keep alias hits first, then full normalized title matches, then the blended
 * semantic/body order. Untyped and other page-type searches are identity
 * returns.
 * A private WeakSet carries the ordering marker into evidence/autocut without
 * adding a staging field to the public SearchResult wire shape.
 */
export function preferExactTitleForTypedEntityLookup(
  results: SearchResult[],
  query: string,
  types: string[] | undefined,
): SearchResult[] {
  if (
    results.length === 0
    || !types
    || types.length === 0
    || types.some(type => !EXACT_TITLE_LOOKUP_TYPES.has(type.toLowerCase()))
  ) return results;

  const normalizedQuery = normalizeAlias(query);
  if (!normalizedQuery) return results;

  const aliases: SearchResult[] = [];
  const exactTitles: SearchResult[] = [];
  const rest: SearchResult[] = [];
  for (const result of results) {
    if (result.alias_hit === true) {
      aliases.push(result);
    } else if (
      EXACT_TITLE_LOOKUP_TYPES.has((result.type ?? '').toLowerCase())
      && normalizeAlias(result.title ?? '') === normalizedQuery
    ) {
      preferredExactTitleLookups.add(result);
      exactTitles.push(result);
    } else {
      rest.push(result);
    }
  }

  return exactTitles.length > 0 ? [...aliases, ...exactTitles, ...rest] : results;
}

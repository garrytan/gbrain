/**
 * Notability-filter vocabulary shared by the durable facts-absorb payload
 * writers (backstop.ts queue mode, the persistence facts-backstop effect) and
 * their only reader, the minion handler. #4870: the reader must accept every
 * value a writer can send; `coerceNotabilityFilter` is the validated
 * pass-through (unknown or absent → 'all', the documented default).
 *
 * Kept free of the extraction pipeline so the persistence outbox can read it
 * without loading backstop.ts.
 */
import type { BrainEngine } from '../engine.ts';

export const NOTABILITY_FILTERS = ['all', 'high-only', 'medium-and-up'] as const;
export type FactNotabilityFilter = typeof NOTABILITY_FILTERS[number];
export function coerceNotabilityFilter(v: unknown): FactNotabilityFilter {
  return (NOTABILITY_FILTERS as readonly unknown[]).includes(v) ? (v as FactNotabilityFilter) : 'all';
}

/**
 * #6231: which tiers the extraction a page write (put_page, capture,
 * edit_page) queues keeps. `all` (the default, unchanged behavior) keeps
 * every tier; `medium-and-up` skips low-notability facts (logistics, routine
 * scheduling); `high-only` is sync's filter. No background pass re-reads a
 * page's prose later, so a tier left out is not saved from that write.
 */
export const PAGE_WRITE_NOTABILITY_FILTER_KEY = 'facts.page_write_notability_filter';
export const PAGE_WRITE_NOTABILITY_FILTER_DEFAULT: FactNotabilityFilter = 'all';

export function parseNotabilityFilter(raw: string): FactNotabilityFilter | null {
  const value = raw.trim().toLowerCase();
  return (NOTABILITY_FILTERS as readonly string[]).includes(value) ? value as FactNotabilityFilter : null;
}

/** The page-write filter in force: unset or unreadable reads as the default (config set refuses other values). */
export async function resolvePageWriteNotabilityFilter(engine: Pick<BrainEngine, 'getConfig'>): Promise<FactNotabilityFilter> {
  const raw = await engine.getConfig(PAGE_WRITE_NOTABILITY_FILTER_KEY).catch(() => null);
  return (raw == null ? null : parseNotabilityFilter(raw)) ?? PAGE_WRITE_NOTABILITY_FILTER_DEFAULT;
}

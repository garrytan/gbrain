import type { BrainEngine } from './engine.ts';
import type { Page, PageFilters } from './types.ts';

export const LIST_ALL_PAGES_BATCH = 1000;

/**
 * Read every page matching `filters`, for callers that must see the whole
 * set (export, engine migration). A single `listPages` call is capped by
 * the engine's LIMIT, so a fixed large limit silently truncates big brains.
 *
 * Batches page by offset over the `slug` sort, which is a total order
 * (slug, source_id, id), so a stable page set yields each row exactly once
 * even when one slug spans several sources across a batch boundary. The
 * loop stops on an EMPTY batch rather than a short one, so an engine that
 * returns fewer rows than asked for still yields the full set.
 *
 * Offset paging is not snapshot-consistent: a concurrent insert can push a
 * row into the next batch, so rows are deduped on (source_id, slug). A
 * concurrent delete can still shift a row back past the cursor and skip it.
 * Cost grows faster than the page count: each OFFSET batch rescans the rows
 * before it, and the whole set is held in memory.
 */
export async function listAllPages(
  engine: Pick<BrainEngine, 'listPages'>,
  filters: Omit<PageFilters, 'limit' | 'offset' | 'sort' | 'updatedAfterKeyset'> = {},
  batchSize: number = LIST_ALL_PAGES_BATCH,
): Promise<Page[]> {
  const pages: Page[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; ) {
    const batch = await engine.listPages({ ...filters, sort: 'slug', limit: batchSize, offset });
    if (batch.length === 0) return pages;
    offset += batch.length;
    for (const page of batch) {
      const key = `${page.source_id}::${page.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push(page);
    }
  }
}

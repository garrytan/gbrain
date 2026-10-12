/**
 * Page enumeration for `gbrain extract-conversation-facts` (#6500).
 *
 * The extractor used to page a source's conversation pages with OFFSET over
 * `updated_desc`, which is not a total order: a bulk import stamps one
 * `now()` across its transaction, and any concurrent non-timestamp write to a
 * tied row (a connector, `embed --stale`, an outcome stamp) reorders the tie
 * cluster between two windows, so one page is listed twice and another never.
 * The second listing extracted the page again (a second paid model call) and
 * froze a second entry into the batch, which the envelope validator refused
 * (`invalid_params`) for every member.
 *
 * Two guards replace that:
 *   - `listConversationPagesBySlug` walks ONE source by slug keyset
 *     (`sort: 'slug'`, `slugAfter`): slug is a total order inside a source
 *     and does not move when a row is touched or deleted. The extractor's
 *     core always has a `sourceId` (its strict per-source contract), so the
 *     single-source `slugAfter` contract holds here.
 *   - `ConversationRunClaims` is the run's claimed set: a page seen twice in
 *     one run (a keyset race, or `--slugs` naming it twice) is extracted once
 *     and counted as `pages_skipped_duplicate_listing`.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';

/** The pages one run has claimed, by source-qualified slug. */
export class ConversationRunClaims {
  private readonly claimed = new Set<string>();

  /** True the first time this run sees `(sourceId, slug)`; false for every later listing of it. */
  claim(sourceId: string, slug: string): boolean {
    const key = `${sourceId}|${slug}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  get size(): number { return this.claimed.size; }
}

/**
 * Lists one source's pages of `type` in slug order, `batchSize` at a time,
 * resuming each window after the last slug of the previous one. A window
 * shorter than `batchSize` ends the walk.
 */
export async function* listConversationPagesBySlug(engine: BrainEngine,
  opts: { type: string; sourceId: string; batchSize: number }): AsyncGenerator<Page[]> {
  let slugAfter: string | undefined;
  for (;;) {
    const batch = await engine.listPages({ type: opts.type, sourceId: opts.sourceId, sort: 'slug', slugAfter, limit: opts.batchSize });
    if (batch.length === 0) return;
    yield batch;
    if (batch.length < opts.batchSize) return;
    slugAfter = batch.at(-1)!.slug;
  }
}

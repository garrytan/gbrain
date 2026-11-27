/**
 * The generation ledger statements of the purge scrub (generations/ledger-scrub.ts) as typed engine members. One SQL
 * implementation for both engines; each statement is the text ledger-scrub.ts sent through `executeRaw`, byte for byte,
 * with the same parameters, on the engine's own `executeRaw`. Only its home moved. The Rust engine serves them from its
 * `derived_generations` family (rust/crates/gbrain-store/src/generations.rs). These are ledger rows, not pages, so the
 * members take no page read policy.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

/** The ledger rows a purge scrub changed: item preimages nulled, and generation rows deleted or changed. */
export interface LedgerScrubCounts { derived_generation_items: number; derived_generations: number }

/** Deletes the held fence rows of the page $3 (kinds $2) in source $1. */
const SCRUB_PAGE_FENCE_HOLDS_SQL = `DELETE FROM derived_generations WHERE source_id=$1 AND kind=ANY($2::text[]) AND owner_key='page:' || $3::text
      AND state='held' RETURNING 1`;
/** Nulls every preimage of the item $2 in source $1. */
const SCRUB_PAGE_ITEMS_SQL = `UPDATE derived_generation_items i SET preimage=NULL FROM derived_generations g
      WHERE g.id=i.generation_id AND g.source_id=$1 AND i.item_key=$2 AND i.preimage IS NOT NULL RETURNING 1`;
/** Nulls every held proposal that names the page $2 (its owner key or a proposed item) in source $1. */
const SCRUB_PAGE_PROPOSALS_SQL = `UPDATE derived_generations SET proposal=NULL, updated_at=now()
      WHERE source_id=$1 AND proposal IS NOT NULL AND (right(owner_key, length($2) + 1) = ':' || $2 OR proposal @> jsonb_build_array(jsonb_build_object('key', $2::text)))
      RETURNING 1`;
/** Drops the recorded fence blocks of the page $2's generations in source $1. */
const SCRUB_PAGE_FENCES_SQL = `UPDATE derived_generations SET completeness=completeness - 'fence'::text, updated_at=now()
      WHERE source_id=$1 AND owner_key='page:' || $2::text AND completeness->'fence' IS NOT NULL RETURNING 1`;
/** Nulls every preimage in source $1 whose text carries one of the lowercase needles $2. */
const SCRUB_TEXT_ITEMS_SQL = `UPDATE derived_generation_items i SET preimage=NULL FROM derived_generations g
    WHERE g.id=i.generation_id AND g.source_id=$1 AND i.preimage IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(i.preimage::text), n) > 0) RETURNING 1`;
/** Nulls the proposal and the held context of every row in source $1 where either carries one of the needles $2. */
const SCRUB_TEXT_HELD_SQL = `UPDATE derived_generations SET proposal=NULL, held_context=NULL, updated_at=now()
    WHERE source_id=$1 AND (proposal IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(proposal::text), n) > 0) OR held_context IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower(held_context::text), n) > 0)) RETURNING 1`;
/** Drops every recorded fence block in source $1 that carries one of the needles $2. */
const SCRUB_TEXT_FENCES_SQL = `UPDATE derived_generations SET completeness=completeness - 'fence'::text, updated_at=now()
    WHERE source_id=$1 AND completeness->'fence' IS NOT NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) n WHERE strpos(lower((completeness->'fence')::text), n) > 0) RETURNING 1`;

/**
 * The page purge scrub of `slug` in `sourceId`: deletes the page's held fence rows of `fenceKinds`, nulls every
 * preimage of the item and every held proposal naming it, and drops the page's recorded fence blocks. Each count is the
 * rows its statement returned, so a row two statements change counts twice. Runs in the caller's transaction.
 */
export async function scrubGenerationPageRows(raw: EngineRawRead, sourceId: string, fenceKinds: readonly string[], slug: string): Promise<LedgerScrubCounts> {
  const fenceHolds = await raw(SCRUB_PAGE_FENCE_HOLDS_SQL, [sourceId, [...fenceKinds], slug]);
  const items = await raw(SCRUB_PAGE_ITEMS_SQL, [sourceId, slug]);
  const held = await raw(SCRUB_PAGE_PROPOSALS_SQL, [sourceId, slug]);
  const fences = await raw(SCRUB_PAGE_FENCES_SQL, [sourceId, slug]);
  return { derived_generation_items: items.length, derived_generations: fenceHolds.length + held.length + fences.length };
}

/**
 * The fact purge scrub in `sourceId`: nulls every preimage, held proposal and held context, and drops every recorded
 * fence block, whose `lower(::text)` carries one of `needles` (already lowercase). Runs in the caller's transaction.
 */
export async function scrubGenerationTextRows(raw: EngineRawRead, sourceId: string, needles: readonly string[]): Promise<LedgerScrubCounts> {
  const items = await raw(SCRUB_TEXT_ITEMS_SQL, [sourceId, needles]);
  const held = await raw(SCRUB_TEXT_HELD_SQL, [sourceId, needles]);
  const fences = await raw(SCRUB_TEXT_FENCES_SQL, [sourceId, needles]);
  return { derived_generation_items: items.length, derived_generations: held.length + fences.length };
}

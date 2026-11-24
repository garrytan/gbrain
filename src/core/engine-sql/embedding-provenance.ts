/**
 * The read behind `stampIfPageProvenanceComplete` (embed-stale.ts): whether every visible chunk of a page carries a vector
 * in the active column, written by the signature's model from the chunk's current text, at the signature's width.
 * The statement text is the one that function ran through `executeRaw`, unchanged
 * (`test/embed-stale-sql-pin.test.ts`). The Rust engine answers from its store (rust/docs/store/embeddings.md).
 */
import type { BrainEngine } from '../engine.ts';
import { currentSpaceChunkPredicate } from '../embedding-invalidation.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { chunkVisibleFilter, currentTextProjectionFilter } from '../search/safe-chunks.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * True when the page `slug` of `sourceId` (an unarchived source) has at least one visible chunk of the current text
 * projection and every one holds a vector in `column` that is current for `model` and `dims`; false for no such page.
 */
export async function readPageProvenanceComplete(engine: Raw, slug: string, sourceId: string, model: string, dims: number | null, column: string): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`SELECT count(*) > 0
              AND bool_and(${currentSpaceFragment(quoteIdentifier(column), model, dims)}) AS complete
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = ${slug} AND p.source_id = ${sourceId} AND ${trustedSql(chunkVisibleFilter('p', 'cc', currentTextProjectionFilter))}
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)`);
  const rows = await engine.executeRaw<{ complete: boolean }>(text, params);
  return rows[0]?.complete === true;
}

/**
 * `currentSpaceChunkPredicate` (embedding-invalidation.ts) as a fragment: built from its text, with the model and the
 * width bound in place of its two placeholders, so the predicate cannot drift from the one every other reader uses.
 */
function currentSpaceFragment(colId: string, model: string, dims: number | null): SqlFragment {
  const strings = currentSpaceChunkPredicate(colId, 9001, 9002).split(/\$9001|\$9002/);
  if (strings.length !== 3) throw new Error('currentSpaceChunkPredicate no longer binds the model and the width once each');
  return sqlFragment(Object.assign([...strings], { raw: [...strings] }), model, dims);
}

import type { BrainEngine } from '../engine.ts';
import type { ChunkInput } from '../types.ts';

/**
 * #7172: the most vector-index writes one transaction of a page's chunk replacement makes.
 *
 * A vector-index write is a new content_chunks row version that carries a vector: an inserted passage with one, or an
 * UPDATE of a passage with one (moving it to another `chunk_index` changes an indexed column, so the update is not HOT
 * and the new version gets an entry in every index, the HNSW index included). Each such entry is an HNSW insert: a
 * graph search over the whole index whose pages have no locality with the page being written, so nothing amortizes
 * across rows and on a large uncached index each costs disk reads. A version with a NULL vector gets no HNSW entry
 * (pgvector skips NULL), and its other entries are cheap: the b-tree entries of one page land on the same leaves and
 * the search-vector GIN entries go to its pending list. Measured on pgvector with a 20,000-row 1,536-dimension HNSW
 * index, warm: 300 passages inserted with vectors took 2.2 s and without 0.06 s; 300 passages renumbered took 0.7 to
 * 1.3 s with vectors and 0.002 s without. So only vector-carrying versions are counted, and inserting passages
 * without vectors, deleting rows and clearing a vector are not. The slowest vector-carrying passage writes reported on
 * a large production index ran at about 0.5 s per row, so the bound charges 0.5 s per vector-index write with nothing
 * amortized. A publication's statements each run under a transaction-local 5 s `statement_timeout` (protocol.ts
 * `declareDurablePersistence`), and half of it is left for the work every write does besides (lock waits, the page
 * row, the passages without vectors, a GIN pending-list flush): floor(2.5 s / 0.5 s) = 5. A replacement that needs
 * more commits its page with the projection pending and finishes in post-commit transactions of at most this many
 * vector-index writes each (`continueDeferredProjection`).
 */
export const CHUNK_VECTOR_WRITE_BUDGET = 5;

/**
 * A stored chunk row that keeps its id and vector and changes index (`to`), with the span its new chunk records.
 * `vectorless`: the row has no vector, so moving it makes no vector-index write.
 */
export interface ChunkMove { id: number; from: number; to: number; projected_byte_start?: number | null; projected_byte_end?: number | null; vectorless?: boolean }

/**
 * The UPDATE statements (waves) that move `moves` without breaking the (page_id, chunk_index) unique index, using at
 * most `budget` vector-index writes (a move of a row with a vector; a vectorless move is free). `occupied` maps each
 * index a remaining row holds to its id. A wave moves rows whose target is free; when none is (a cycle), one row parks
 * at the negative index `-1 - to` and lands later, a vectorless one when the cycle has one. `done` says every move
 * fits; `updates` counts the vector-index writes; `pending` and `at` are the moves left and the occupied indexes once
 * the waves ran.
 */
export function planMoveWaves(moves: readonly ChunkMove[], occupied: ReadonlyMap<number, number>, budget: number):
  { waves: ChunkMove[][]; updates: number; done: boolean; pending: ChunkMove[]; at: Map<number, number> } {
  const at = new Map(occupied);
  let pending = moves.map(move => ({ ...move }));
  const waves: ChunkMove[][] = [];
  let updates = 0;
  const cost = (move: ChunkMove) => move.vectorless ? 0 : 1;
  while (pending.length) {
    const open = pending.filter(move => !at.has(move.to));
    const free: ChunkMove[] = [];
    for (const move of open) if (updates + cost(move) <= budget) { free.push(move); updates += cost(move); }
    const parked = open.length ? undefined : pending.find(move => move.vectorless) ?? (updates < budget ? pending[0] : undefined);
    if (!free.length && !parked) break;
    const wave = parked ? [{ ...parked, to: -1 - parked.to }] : free;
    if (parked) updates += cost(parked);
    for (const move of wave) { at.delete(move.from); at.set(move.to, move.id); }
    waves.push(wave);
    if (parked) parked.from = wave[0]!.to;
    else pending = pending.filter(move => !free.includes(move));
  }
  return { waves, updates, done: pending.length === 0, pending, at };
}

/**
 * #7172: an import's chunk row writes. `kept` maps a new chunk's position in `fresh` to the stored row it keeps (`vector`:
 * the row has one); a kept row whose chunk sits at another index moves there (`waves`). With `bounded` (a managed
 * publication), `defer` says the vector-index writes (moves of rows with a vector, inserts of chunks carrying one) pass
 * CHUNK_VECTOR_WRITE_BUDGET, so the publication leaves the replacement to `continueDeferredProjection`.
 */
export function planImportChunkWrites(fresh: readonly ChunkInput[], kept: ReadonlyMap<number, { id: number; chunk_index: number; vector: boolean }>, bounded: boolean):
  { waves: ChunkMove[][]; defer: boolean } {
  const moves = [...kept].filter(([i, row]) => row.chunk_index !== fresh[i]!.chunk_index).map(([i, row]) => ({ id: row.id, from: row.chunk_index,
    to: fresh[i]!.chunk_index, projected_byte_start: fresh[i]!.projected_byte_start ?? null, projected_byte_end: fresh[i]!.projected_byte_end ?? null,
    ...(row.vector ? {} : { vectorless: true }) }));
  const vectorInserts = fresh.filter((chunk, i) => !kept.has(i) && (chunk.embedding || chunk.embedding_image)).length;
  const plan = planMoveWaves(moves, new Map([...kept.values()].map(row => [row.chunk_index, row.id])),
    bounded ? Math.max(0, CHUNK_VECTOR_WRITE_BUDGET - vectorInserts) : Number.POSITIVE_INFINITY);
  return { waves: plan.waves, defer: bounded && fresh.length > 0 && (!plan.done || vectorInserts > CHUNK_VECTOR_WRITE_BUDGET) };
}

/** One UPDATE per wave; a landed row takes its new chunk's span, a parked row keeps its own until it lands. */
export async function applyMoveWaves(tx: Pick<BrainEngine, 'executeRaw'>, pageId: number, waves: readonly ChunkMove[][]): Promise<void> {
  for (const wave of waves) {
    await tx.executeRaw(`UPDATE content_chunks c SET chunk_index = m.target,
        projected_byte_start = CASE WHEN m.target < 0 THEN c.projected_byte_start ELSE m.byte_start END,
        projected_byte_end = CASE WHEN m.target < 0 THEN c.projected_byte_end ELSE m.byte_end END
      FROM unnest($2::int[], $3::int[], $4::bigint[], $5::bigint[]) AS m(id, target, byte_start, byte_end)
      WHERE c.page_id = $1 AND c.id = m.id`,
    [pageId, wave.map(move => move.id), wave.map(move => move.to),
      wave.map(move => move.projected_byte_start ?? null), wave.map(move => move.projected_byte_end ?? null)]);
  }
}

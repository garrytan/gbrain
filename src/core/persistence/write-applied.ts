/**
 * #7190: the answer `get_write_request` gives to "is this write searchable yet?": the written page's state and
 * `searchable` (the resolve-path vocabulary), the gap when it is not, and the source's write watermark.
 *
 *   - pending_write: the request has not settled; `gap.requests_ahead` counts the source's unsettled requests queued before it.
 *   - not_written: it settled without committing (conflict, failed, cancelled).
 *   - deleted: it committed and the page is gone (a delete).
 *   - otherwise the page's state from `page-searchability.ts`; `gap.unembedded_chunks` counts chunks still waiting for a
 *     vector and `embedding_hold` names a budget hold that waits for approval.
 * `searchable_yet` is true only when search finds the page by keyword and vector. It is read live on every receipt read, never
 * frozen into the write's reply: a same-request-id replay of a write returns its first reply unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import { readPageSearchability, type PageSearchState } from '../page-searchability.ts';
import { readWriteWatermark, type WriteWatermark } from './applied-watermark.ts';

export interface WriteApplied {
  sequence: number;
  searchable_yet: boolean;
  searchable: true | 'keyword' | false;
  state: PageSearchState | 'pending_write' | 'not_written' | 'deleted';
  page: { slug: string; chunks: number; unembedded: number } | null;
  embedding_hold: { state: 'held' | 'capped'; reason: string; updated_at: string } | null;
  gap: { requests_ahead: number; unembedded_chunks: number };
  watermark: WriteWatermark;
}

const UNSETTLED = ['queued', 'running', 'recovering'];

export async function readWriteApplied(engine: BrainEngine, row: { source_id: string; source_incarnation: string; slug: string; sequence: string | number; state: string }): Promise<WriteApplied> {
  const sequence = Number(row.sequence);
  const watermark = await readWriteWatermark(engine, row.source_id);
  const base = { sequence, watermark, page: null, embedding_hold: null, searchable_yet: false, searchable: false as const };
  if (UNSETTLED.includes(row.state)) {
    const [ahead] = await engine.executeRaw<{ count: number | string }>(`SELECT count(*) AS count FROM persistence_requests
      WHERE source_id=$1 AND source_incarnation=$2::uuid AND state IN ('queued','running','recovering') AND sequence < $3::bigint`, [row.source_id, row.source_incarnation, sequence]);
    return { ...base, state: 'pending_write', gap: { requests_ahead: Number(ahead?.count ?? 0), unembedded_chunks: 0 } };
  }
  if (row.state !== 'committed') return { ...base, state: 'not_written', gap: { requests_ahead: 0, unembedded_chunks: 0 } };
  const page = (await readPageSearchability(engine, row.source_id, [row.slug])).get(row.slug);
  if (!page) return { ...base, state: 'deleted', gap: { requests_ahead: 0, unembedded_chunks: 0 } };
  return { sequence, watermark, searchable_yet: page.searchable === true && !page.embedding_hold, searchable: page.searchable, state: page.state,
    page: { slug: row.slug, chunks: page.chunks, unembedded: page.unembedded }, embedding_hold: page.embedding_hold,
    gap: { requests_ahead: 0, unembedded_chunks: page.unembedded } };
}


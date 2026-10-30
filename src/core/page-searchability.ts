/**
 * Whether search can find each live page of a source now, in the vocabulary `gbrain sources resolve-path` and
 * `gbrain pages status` share: a page state, `searchable: true | 'keyword' | false`, its visible chunks, `unembedded`
 * (visible chunks with no vector in the active embedding column), and `embedding_hold` (a large page whose embedding
 * budget is held or capped: it reads `pending_embedding`, never `keyword_only`, which means `embed_skip`).
 * Readers: resolve-path and write receipts (#7190). Indexed reads only.
 */
import type { BrainEngine } from './engine.ts';
import { DELETED_PAGE_PURGE_WINDOW_HOURS, type EmbeddingState } from './embedding-state.ts';
import { budgetRowAppliesFilter } from './page-size-policy.ts';
import { chunkGenerationFilter } from './search/safe-chunks.ts';
import { quoteIdentifier } from './search/embedding-column.ts';
import { embeddingWriteTarget } from './page-state/projections.ts';

export type PageSearchState = 'searchable' | 'pending_embedding' | 'chunkless' | 'keyword_only' | 'quarantined' | 'empty';

export interface PageSearchability {
  /** The page's worst embedding state, or null when it has no chunk rows at all. */
  embedding_state: EmbeddingState | null;
  state: PageSearchState;
  searchable: true | 'keyword' | false;
  chunks: number;
  unembedded: number;
  embedding_hold: { state: 'held' | 'capped'; reason: string; updated_at: string } | null;
}

export const PAGE_SEARCHABLE: Record<EmbeddingState, true | 'keyword' | false> = { embedded: true, pending: 'keyword', keyword_only: 'keyword', quarantined: false, empty: false,
  deleted_page_chunks: false, chunkless_healable: false };
const PAGE_STATE: Record<Exclude<EmbeddingState, 'deleted_page_chunks'>, PageSearchState> = { embedded: 'searchable', pending: 'pending_embedding',
  keyword_only: 'keyword_only', quarantined: 'quarantined', empty: 'empty', chunkless_healable: 'chunkless' };
/** Worst first: a page with some chunks embedded and some pending reads as pending. */
export const PAGE_STATE_ORDER: EmbeddingState[] = ['quarantined', 'chunkless_healable', 'pending', 'keyword_only', 'empty', 'embedded'];

/** The searchability of each live page of `sourceId` named in `slugs` (a slug with no live page is absent). */
export async function readPageSearchability(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<Map<string, PageSearchability>> {
  const out = new Map<string, PageSearchability>();
  if (!slugs.length) return out;
  const live = (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug = ANY($2::text[])', [sourceId, slugs])).map(row => row.slug);
  if (!live.length) return out;
  const rows = await engine.listEmbeddingStateRows({ sourceIds: [sourceId], slugs: live, states: PAGE_STATE_ORDER, limit: live.length * PAGE_STATE_ORDER.length,
    purgeWindowHours: DELETED_PAGE_PURGE_WINDOW_HOURS });
  const column = `cc.${quoteIdentifier((await embeddingWriteTarget(engine)).column.name)}`;
  const unembedded = new Map((await engine.executeRaw<{ slug: string; unembedded: number | string }>(
    `SELECT p.slug, count(cc.id) AS unembedded FROM pages p JOIN content_chunks cc ON cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc')} AND ${column} IS NULL
      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND p.deleted_at IS NULL GROUP BY p.slug`, [sourceId, live])).map(row => [row.slug, Number(row.unembedded)]));
  const folded = new Map<string, { state: EmbeddingState; chunks: number }>();
  for (const row of rows) {
    const prior = folded.get(row.slug);
    const state = prior && PAGE_STATE_ORDER.indexOf(prior.state) < PAGE_STATE_ORDER.indexOf(row.state) ? prior.state : row.state;
    folded.set(row.slug, { state, chunks: (prior?.chunks ?? 0) + Number(row.chunks) });
  }
  const keywordOnly = [...folded].filter(([, emb]) => emb.state === 'keyword_only').map(([slug]) => slug);
  const holds = new Map<string, NonNullable<PageSearchability['embedding_hold']>>();
  if (keywordOnly.length) {
    for (const row of await engine.executeRaw<{ slug: string; state: 'held' | 'capped'; reason: string; updated_at: Date | string }>(
      `SELECT p.slug, b.state, COALESCE(b.reason, 'awaiting_approval') AS reason, b.updated_at
       FROM pages p JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND p.deleted_at IS NULL AND ${budgetRowAppliesFilter('b', 'p')}
        AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`, [sourceId, keywordOnly])) {
      holds.set(row.slug, { state: row.state, reason: row.reason, updated_at: new Date(row.updated_at).toISOString() });
    }
  }
  for (const slug of live) {
    const emb = folded.get(slug), hold = holds.get(slug) ?? null;
    out.set(slug, {
      embedding_state: emb?.state ?? null,
      state: hold ? 'pending_embedding' : emb ? PAGE_STATE[emb.state as Exclude<EmbeddingState, 'deleted_page_chunks'>] ?? 'searchable' : 'chunkless',
      searchable: emb ? PAGE_SEARCHABLE[emb.state] : false,
      chunks: emb?.chunks ?? 0,
      unembedded: unembedded.get(slug) ?? 0,
      embedding_hold: hold,
    });
  }
  return out;
}

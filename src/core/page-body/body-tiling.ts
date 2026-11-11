/**
 * Wave B PR 2 (N5): a segmented body is read only when its manifest rows tile it. The rows of a generation must run
 * from byte 0 without a gap and sum to that generation's body_bytes (the page's for the live generation, its
 * segmented version's for a retained one). A role that sees the page row but not its manifest rows, or rows that
 * went missing, would otherwise read as a short or empty body: an export, digest or rewrite of it would succeed and
 * be wrong. Checked from the row metadata before any text is read, so it costs one pass over the rows.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import type { ManifestRow } from './types.ts';
import { liveTilingSql, untiledSql } from './schema.ts';

export interface RowSpan { byteStart: number; byteLen: number }

/** Throws page_body_rows_unreadable unless `rows` (in seq order) tile [0, total); a null total checks only a gapless start at 0. */
export function assertRowsTile(rows: readonly RowSpan[], at: { slug: string; sourceId: string; total: number | null }): void {
  let end = 0;
  for (const row of rows) {
    if (row.byteStart !== end) { end = -1; break; }
    end += row.byteLen;
  }
  if (end >= 0 && (at.total === null ? rows.length > 0 : end === at.total)) return;
  throw opError('page_body_rows_unreadable', `Page ${at.slug} (source ${at.sourceId}): the segment rows readable here do not cover its ${at.total ?? 'stored'}-byte body, so nothing was read.`,
    `Give the role that reads the brain the same access to page_body_manifest and page_segment_texts it has to pages, then read again. When gbrain doctor --only segmented_tiling lists the page, its rows are missing: preview gbrain repair segmented-tiling --source ${at.sourceId}.`,
    { detail: JSON.stringify({ rows: rows.length, covered_bytes: end >= 0 ? end : null, body_bytes: at.total }) });
}

/**
 * body_bytes of generation `generation` of a segmented page: the page's when it is live, else the segmented version
 * that references it (null when none does: nothing records that generation's size).
 */
export async function generationBodyBytes(engine: Pick<BrainEngine, 'executeRaw'>, page: { id: number; body_generation: unknown; body_bytes: unknown },
  generation: number): Promise<number | null> {
  if (generation === Number(page.body_generation)) return Number(page.body_bytes ?? 0);
  const [version] = await engine.executeRaw<{ body_bytes: number | string | null }>(`SELECT body_bytes FROM page_versions
    WHERE page_id=$1 AND body_generation=$2 AND body_storage='segmented' AND body_bytes IS NOT NULL ORDER BY id DESC LIMIT 1`, [page.id, generation]);
  return version ? Number(version.body_bytes) : null;
}

/** Attempts of a live read whose generation a publish retired between its reads (`readTiledManifest`). */
export const LIVE_READ_ATTEMPTS = 3;

/**
 * GBRA-287: the manifest rows of `generation`, checked to tile it. A live read (no `generation`) names the live generation
 * first and reads that generation's rows, so the rows and the size they are checked against are one generation's even
 * when a body is published between the statements; reading the live rows and the page in two statements compared one
 * generation's rows with the next one's size and refused a healthy page `page_body_rows_unreadable`. A live read whose
 * generation no longer tiles because a publish retired it meanwhile (its rows gone) reads the new live generation, up to
 * LIVE_READ_ATTEMPTS times; an explicit generation, or a live one that did not move, refuses as before. `bodyBytes`: the
 * size the caller read with an explicit generation (a snapshot's body_bytes), checked instead of the size a retained
 * version records, so a generation whose version was pruned never passes on the prefix the live generation shares.
 */
export async function readTiledManifest(engine: Pick<BrainEngine, 'executeRaw' | 'readManifest'>, pageId: number,
  generation?: number, bodyBytes?: number): Promise<{ generation: number | null; rows: ManifestRow[] }> {
  const live = async () => (await engine.executeRaw<{ body_generation: unknown; body_bytes: unknown }>('SELECT body_generation, body_bytes FROM pages WHERE id=$1', [pageId]))[0];
  for (let attempt = 1; ; attempt++) {
    const page = generation === undefined ? await live() : null;
    const at = generation ?? (page ? Number(page.body_generation) : null);
    const rows = await engine.readManifest(pageId, at === null ? {} : { generation: at });
    try {
      await assertGenerationTiles(engine, pageId, at ?? undefined, rows, page ? Number(page.body_bytes ?? 0) : bodyBytes);
      return { generation: at, rows };
    } catch (error) {
      const now = generation === undefined && attempt < LIVE_READ_ATTEMPTS ? await live() : undefined;
      if (!now || Number(now.body_generation) === at) throw error;
    }
  }
}

/**
 * The tiling check for a reader that read `rows` of `generation` (default live) through readManifest. `bodyBytes`: the
 * size the reader read with the generation (a live generation's page body_bytes), so a generation a publish retired
 * meanwhile, whose size nothing records any more, is still checked whole and never passes on a surviving prefix.
 */
export async function assertGenerationTiles(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, generation: number | undefined, rows: readonly RowSpan[],
  bodyBytes?: number): Promise<void> {
  const [page] = await engine.executeRaw<{ id: number; slug: string; source_id: string; body_generation: unknown; body_bytes: unknown }>(
    'SELECT id, slug, source_id, body_generation, body_bytes FROM pages WHERE id=$1', [pageId]);
  if (!page) return;
  const at = generation ?? Number(page.body_generation);
  assertRowsTile(rows, { slug: page.slug, sourceId: page.source_id, total: bodyBytes ?? await generationBodyBytes(engine, { ...page, id: pageId }, at) });
}

/** GST-1209: a live page stored in segments whose live generation's rows do not tile its body (`untiledSegmentedPages`). */
export interface UntiledPage {
  source_id: string; slug: string; page_id: number; revision: string; body_generation: number; body_bytes: number;
  segment_count: number | null; source_path: string | null;
  /** The live generation's rows, and the bytes they cover gapless from 0 (null: they leave a gap). */
  rows: number; covered_bytes: number | null;
}

/**
 * GST-1209: the live (not deleted) pages of unarchived sources stored in segments whose live generation's rows do not cover body_bytes gapless
 * from 0, so every read of them refuses page_body_rows_unreadable. One aggregate per page over its live rows, read-only;
 * `sourceIds` and `slugs` narrow the scan, `limit` bounds the list (ordered by source and slug).
 */
export async function untiledSegmentedPages(engine: Pick<BrainEngine, 'executeRaw'>, opts: { sourceIds?: readonly string[]; slugs?: readonly string[]; limit?: number } = {}):
  Promise<UntiledPage[]> {
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; revision: string; body_generation: unknown; body_bytes: unknown;
    segment_count: number | null; source_path: string | null; n: unknown; covered: unknown; gapless: boolean }>(
    `SELECT p.id, p.source_id, p.slug, p.knowledge_revision::text AS revision, p.body_generation, p.body_bytes, p.segment_count, p.source_path, t.n, t.covered, t.gapless
       FROM pages p JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE CROSS JOIN LATERAL (${liveTilingSql('p')}) t
      WHERE p.body_storage = 'segmented' AND p.deleted_at IS NULL AND ($1::text[] IS NULL OR p.source_id = ANY($1::text[]))
        AND ($2::text[] IS NULL OR p.slug = ANY($2::text[])) AND ${untiledSql('p', 't')}
      ORDER BY p.source_id, p.slug LIMIT $3`, [opts.sourceIds ? [...opts.sourceIds] : null, opts.slugs ? [...opts.slugs] : null, opts.limit ?? 1000]);
  return rows.map(row => ({ source_id: row.source_id, slug: row.slug, page_id: Number(row.id), revision: row.revision, body_generation: Number(row.body_generation),
    body_bytes: Number(row.body_bytes), segment_count: row.segment_count === null ? null : Number(row.segment_count), source_path: row.source_path,
    rows: Number(row.n), covered_bytes: row.gapless ? Number(row.covered) : null }));
}

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
import type { UntiledPage, UntiledPageQuery } from '../engine-sql/repair-plan-scans.ts';

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
export async function generationBodyBytes(engine: Pick<BrainEngine, 'readSegmentedVersionBodyBytes'>, page: { id: number; body_generation: unknown; body_bytes: unknown },
  generation: number): Promise<number | null> {
  if (generation === Number(page.body_generation)) return Number(page.body_bytes ?? 0);
  return engine.readSegmentedVersionBodyBytes(page.id, generation);
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
export async function readTiledManifest(engine: Pick<BrainEngine, 'readManifest' | 'readSegmentedPageHead' | 'readSegmentedVersionBodyBytes'>, pageId: number,
  generation?: number, bodyBytes?: number): Promise<{ generation: number | null; rows: ManifestRow[] }> {
  const live = () => engine.readSegmentedPageHead(pageId);
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
export async function assertGenerationTiles(engine: Pick<BrainEngine, 'readSegmentedPageHead' | 'readSegmentedVersionBodyBytes'>, pageId: number, generation: number | undefined,
  rows: readonly RowSpan[], bodyBytes?: number): Promise<void> {
  const page = await engine.readSegmentedPageHead(pageId);
  if (!page) return;
  const at = generation ?? Number(page.body_generation);
  assertRowsTile(rows, { slug: page.slug, sourceId: page.source_id, total: bodyBytes ?? await generationBodyBytes(engine, { ...page, id: pageId }, at) });
}

export type { UntiledPage } from '../engine-sql/repair-plan-scans.ts';

/**
 * GST-1209: the live (not deleted) pages of unarchived sources stored in segments whose live generation's rows do not cover body_bytes gapless
 * from 0, so every read of them refuses page_body_rows_unreadable (BrainEngine listUntiledSegmentedPages, engine-sql/repair-plan-scans.ts).
 * `sourceIds` and `slugs` narrow the scan, `limit` bounds the list (ordered by source and slug).
 */
export function untiledSegmentedPages(engine: Pick<BrainEngine, 'listUntiledSegmentedPages'>, opts: UntiledPageQuery = {}): Promise<UntiledPage[]> {
  return engine.listUntiledSegmentedPages(opts);
}

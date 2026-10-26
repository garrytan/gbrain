import type { BrainEngine } from './engine.ts';
import { overlayCanonicalBodies } from './page-state/snapshot.ts';
import type { PageWithdrawal } from './page-state/types.ts';
import { rowToPage } from './utils.ts';
import { EXPORT_PAYLOAD_LIMIT } from './export-stage.ts';
import { isSegmentedPage } from './page-body/page-shape.ts';
import { openSegmentedBody, readBodyRange, type BodyLedger } from './page-body/read-range.ts';
import { assertRowsTile } from './page-body/body-tiling.ts';
import { TIMELINE_SEPARATOR } from './page-window/document.ts';
import type { Page } from './types.ts';
import { serializeMarkdown, slugStampedFrontmatter } from './markdown.ts';

const EXPORT_COLLECT_BYTES = 64 * 1024 * 1024;

/** Withdrawals are entity-scoped: `subject` is the entity slug, '*' applies to every page. */
export type ExportWithdrawal = PageWithdrawal & { subject: string };

export async function readExportWithdrawals(tx: BrainEngine, sourceId: string): Promise<ExportWithdrawal[]> {
  const [size] = await tx.executeRaw<{ bytes: number }>(`SELECT COALESCE(sum(octet_length(
    jsonb_build_object('visibility',visibility,'fact_hash',fact_hash,'withdrawn_at',withdrawn_at,'subject',subject)::text)+1),0)+2 AS bytes
    FROM fact_withdrawals WHERE source_id=$1`, [sourceId]);
  if (Number(size.bytes) > EXPORT_PAYLOAD_LIMIT) throw new Error('Export withdrawal ledger capacity exceeded. No destination output was published.');
  // Purge tombstones ride the same overlay and drop their rows from the export.
  return tx.executeRaw<ExportWithdrawal>(`SELECT visibility,fact_hash,withdrawn_at,subject,false AS purged
    FROM fact_withdrawals WHERE source_id=$1
    UNION ALL SELECT visibility,fact_hash,purged_at,subject,true FROM fact_purges WHERE source_id=$1
    ORDER BY visibility,fact_hash,subject`, [sourceId]);
}

export async function readExportPage(tx: BrainEngine, key: { id: string; source_id: string; slug: string }, withdrawals: ExportWithdrawal[]) {
  const [row] = await tx.executeRaw<Record<string, unknown>>(`WITH export_page AS MATERIALIZED (
    SELECT * FROM pages WHERE id=$1::bigint
  ) SELECT p.*,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS export_tags
    FROM export_page p WHERE p.source_id=$2 AND p.slug=$3 AND p.deleted_at IS NULL`,
  [key.id, key.source_id, key.slug]);
  if (!row) throw new Error('Export snapshot unexpectedly lost a selected page.');
  const page = rowToPage(row);
  if (!isSegmentedPage(page) && (page.compiled_truth.includes('gbrain:facts:') || page.timeline.includes('gbrain:facts:'))) {
    Object.assign(page, await overlayCanonicalBodies(tx.executeRaw.bind(tx), page.compiled_truth, page.timeline, applicableWithdrawals(page.slug, withdrawals)));
  }
  return { page, tags: row.export_tags as string[], generation: row.body_generation == null ? null : Number(row.body_generation) };
}

export type ExportSnapshot = Awaited<ReturnType<typeof readExportPage>>;

/**
 * The frontmatter and header fields of a page's exported file. #5966: the slug stamp rule lives in
 * slugStampedFrontmatter (markdown.ts), shared with every render; an escaped file always carries its slug.
 */
function exportHeader(snapshot: ExportSnapshot, escaped: boolean) {
  const { page } = snapshot;
  const frontmatter = escaped ? { ...(page.frontmatter ?? {}), slug: page.slug } : slugStampedFrontmatter(page.slug, page.frontmatter ?? {});
  return { frontmatter, meta: { type: page.type, title: page.title, tags: snapshot.tags } };
}

/** The exported Markdown of an inline page read by readExportPage, so its withdrawal overlay is applied. */
export function inlineExportMarkdown(snapshot: ExportSnapshot, escaped = false): string {
  const { frontmatter, meta } = exportHeader(snapshot, escaped);
  return serializeMarkdown(frontmatter, snapshot.page.compiled_truth, snapshot.page.timeline, meta);
}

/** The `head` segmentedExportMarkdown starts a segmented page's file with. */
export function segmentedExportHead(snapshot: ExportSnapshot, escaped = false): string {
  const { frontmatter, meta } = exportHeader(snapshot, escaped);
  return serializeMarkdown(frontmatter, '', '', meta).slice(0, -1);
}

/** The ledger an export overlays one page's body with: the source's withdrawals that apply to the page. */
export function exportBodyLedger(slug: string, withdrawals: ExportWithdrawal[]): BodyLedger {
  return { withdrawals: applicableWithdrawals(slug, withdrawals) };
}

function applicableWithdrawals(slug: string, withdrawals: ExportWithdrawal[]): PageWithdrawal[] {
  return withdrawals.filter(w => w.subject === '*' || w.subject === slug)
    .map(({ visibility, fact_hash, withdrawn_at, purged }) => ({ visibility, fact_hash, withdrawn_at, ...(purged ? { purged: true } : {}) }));
}

/**
 * The Markdown file of a segmented page, piece by piece: `head` (serializeMarkdown's frontmatter and blank line), the
 * truth, TIMELINE_SEPARATOR before the first timeline byte, the timeline and the final newline. Each segment is read
 * once (readBodyRange, trusted stored body) under `ledger` (export: `exportBodyLedger`, the overlay readExportPage gives
 * an inline page; a restore: the page snapshot's), so the bytes are those serializeMarkdown gives the same page read inline. A full collection every EXPORT_COLLECT_BYTES read keeps the
 * reads' garbage (protocol buffers, decoded texts) from piling up as in the streamed import (ingest.ts): a 127 MiB page
 * peaked ~700 MiB above a 2 MiB one without it.
 *
 * With `pinned` the body read is that generation's, outside the snapshot that read `page` (export streams after its
 * snapshot commits, holding a read pin on the generation, page-body/read-pins.ts): its rows must tile the snapshot's
 * body_bytes, so a generation collected or changed since refuses (page_body_rows_unreadable) instead of a short file.
 */
export async function* segmentedExportMarkdown(tx: BrainEngine, page: Pick<Page, 'id' | 'slug' | 'source_id' | 'body_bytes'>, ledger: BodyLedger, head: string,
  pinned?: number): AsyncIterable<Uint8Array | string> {
  const body = await openSegmentedBody(tx, { pageId: page.id, ledger, ...(pinned !== undefined ? { generation: pinned } : {}) });
  if (pinned !== undefined) assertRowsTile(body.rows, { slug: page.slug, sourceId: page.source_id, total: Number(page.body_bytes ?? 0) });
  let uncollected = 0;
  const collect = (bytes: number) => {
    uncollected += bytes;
    if (uncollected < EXPORT_COLLECT_BYTES) return;
    Bun.gc(true);
    uncollected = 0;
  };
  yield head;
  for await (const piece of readBodyRange(tx, { pageId: page.id, space: 'stored', start: 0, end: Infinity, audience: 'trusted', region: 'truth', body })) {
    yield piece.bytes;
    collect(piece.bytes.length);
  }
  let separated = false;
  for await (const piece of readBodyRange(tx, { pageId: page.id, space: 'stored', start: 0, end: Infinity, audience: 'trusted', region: 'timeline', body })) {
    if (!piece.bytes.length) continue;
    if (!separated) yield TIMELINE_SEPARATOR;
    separated = true;
    yield piece.bytes;
    collect(piece.bytes.length);
  }
  yield '\n';
}

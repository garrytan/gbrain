import type { BrainEngine } from './engine.ts';
import { overlayWithdrawalBody } from './facts/withdrawal-overlay.ts';
import type { PageWithdrawal } from './page-state/types.ts';
import { rowToPage } from './utils.ts';
import { EXPORT_PAYLOAD_LIMIT } from './export-stage.ts';
import { isSegmentedPage } from './page-body/page-shape.ts';
import { openSegmentedBody, readBodyRange, type BodyLedger } from './page-body/read-range.ts';
import { TIMELINE_SEPARATOR } from './page-window/document.ts';
import type { Page } from './types.ts';
import { serializeMarkdown, slugStampedFrontmatter } from './markdown.ts';

const EXPORT_COLLECT_BYTES = 1024 * 1024;

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

export type ExportSnapshot = { page: Page; tags: string[] };

export async function readExportPage(tx: BrainEngine, key: { id: string; source_id: string; slug: string }, withdrawals: ExportWithdrawal[]): Promise<ExportSnapshot> {
  return (await readExportPages(tx, [key], withdrawals))[0]!;
}

/**
 * The export snapshots of `keys`, in key order, in at most two statements however many keys there are (#7617: a
 * per-page read made a large source's conversion plan one round trip per page): the rows with their tags, then one
 * fence normalization for every inline page whose withdrawal overlay applies, by overlayCanonicalBodies' rules and SQL.
 * Rows are looked up by primary key (#7618: a join on the keys let the planner scan the whole source for each key, so a
 * per-page export went quadratic), and each row must still carry its key's source and slug.
 */
export async function readExportPages(tx: BrainEngine, keys: ReadonlyArray<{ id: string; source_id: string; slug: string }>, withdrawals: ExportWithdrawal[]): Promise<ExportSnapshot[]> {
  if (!keys.length) return [];
  const rows = await tx.executeRaw<Record<string, unknown>>(`WITH export_page AS MATERIALIZED (
    SELECT * FROM pages WHERE id = ANY($1::bigint[])
  ) SELECT p.*,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS export_tags
    FROM export_page p WHERE p.deleted_at IS NULL`,
  [keys.map(key => key.id)]);
  const byId = new Map(rows.map(row => [String(row.id), row]));
  const snapshots = keys.map(key => {
    const row = byId.get(String(key.id));
    if (!row || row.source_id !== key.source_id || row.slug !== key.slug) throw new Error('Export snapshot unexpectedly lost a selected page.');
    return { page: rowToPage(row), tags: row.export_tags as string[] };
  });
  const fenced = snapshots.flatMap(({ page }) => {
    if (isSegmentedPage(page) || !(page.compiled_truth.includes('gbrain:facts:begin') || page.timeline.includes('gbrain:facts:begin'))) return [];
    const applicable = applicableWithdrawals(page.slug, withdrawals);
    return applicable.length ? [{ page, applicable }] : [];
  });
  if (!fenced.length) return snapshots;
  const normalized = await tx.executeRaw<{ i: number; body: string | null; timeline: string | null }>(`SELECT t.i::int AS i,
    (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array(t.body,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS body,
    (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array(t.timeline,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS timeline
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(body, timeline, i)`,
  [fenced.map(({ page }) => page.compiled_truth), fenced.map(({ page }) => page.timeline)]);
  for (const row of normalized) {
    const { page, applicable } = fenced[Number(row.i) - 1]!;
    page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, row.body ?? '', applicable);
    page.timeline = overlayWithdrawalBody(page.timeline, row.timeline ?? '', applicable);
  }
  return snapshots;
}

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
 * peaked ~700 MiB above a 2 MiB one without it, 8-55 MiB with it.
 */
export async function* segmentedExportMarkdown(tx: BrainEngine, page: Pick<Page, 'id'>, ledger: BodyLedger, head: string): AsyncIterable<Uint8Array | string> {
  const body = await openSegmentedBody(tx, { pageId: page.id, ledger });
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

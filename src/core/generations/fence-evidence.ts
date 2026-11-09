/**
 * #8819: whether a page's `## Facts` fence ever held a fact row. A writer that retires the fact rows a fence no longer
 * holds (the page publication's projection, the extract_facts reconcile) may retire only a row some fence held at the
 * same row number, claim and visibility: a fact_fence generation of the page recorded it, the page body the writer read
 * carried it, or a stored version of the page did. Any other row attached to the page with a row number (a put_page
 * row, or one an older writer stamped) was never in the fence, so no fence edit can have withdrawn it; it stays active.
 */
import type { BrainEngine } from '../engine.ts';
import { scanCanonicalFences } from '../fence-repair/refusal.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import { factRowIdentity, fenceOwnerKey, fenceRowKey, FACT_FENCE_KIND } from './fence.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { segmentedFactsFenceView } from '../page-body/segment-facts.ts';

export interface FenceRowRef { id: number; row_num: number | null; fact: string; visibility: string }
export interface FenceBody { id?: number | string | null; compiled_truth?: string | null; timeline?: string | null; body_storage?: string | null }

/** Stored versions read per batch, and at most in all, newest first. */
const VERSION_BATCH = 50;
const VERSIONS_MAX = 1000;

const rowKey = (row: { row_num: number | null; fact: string; visibility?: string | null }) => `${Number(row.row_num)}\u0000${row.fact}\u0000${row.visibility ?? 'private'}`;

/** The (row number, claim, visibility) of every row a body's facts fence holds; nothing for a body that was not read whole. */
export function fenceRowKeys(body: FenceBody, slug: string, sourceId: string): Set<string> {
  if (isSegmentedPage(body as { body_storage?: 'segmented' | null }) || body.compiled_truth == null) return new Set();
  const scan = scanCanonicalFences({ compiled_truth: body.compiled_truth, timeline: body.timeline ?? '' });
  return new Set(extractFactsFromFenceText(scan.facts, slug, sourceId).map(rowKey));
}

/** fenceRowKeys of a stored page, a segmented one read from the runs that hold its fence markers. */
export async function pageFenceRowKeys(db: BrainEngine, page: FenceBody, slug: string, sourceId: string): Promise<Set<string>> {
  if (!isSegmentedPage(page as { body_storage?: 'segmented' | null })) return fenceRowKeys(page, slug, sourceId);
  const view = await segmentedFactsFenceView(db, { id: Number(page.id), slug, source_id: sourceId });
  return new Set(extractFactsFromFenceText([...view.body.facts, ...view.timeline.facts], slug, sourceId).map(rowKey));
}

/**
 * The ids of `rows` some fence of the page held (see the module comment). `complete` is false when stored versions were
 * left unread (more than VERSIONS_MAX, or a version stored without a body, as a segmented page's are), so a row outside
 * `held` was only not found, not proven absent. `prior` is pageFenceRowKeys of the body the writer replaces.
 */
export async function factsFenceHeld(db: BrainEngine, input: { sourceId: string; slug: string; rows: readonly FenceRowRef[]; prior?: ReadonlySet<string> | null }):
  Promise<{ held: Set<number>; complete: boolean }> {
  const { sourceId, slug } = input;
  const held = new Set<number>();
  const open = () => input.rows.filter(row => row.row_num != null && !held.has(Number(row.id)));
  if (!open().length) return { held, complete: true };
  const keyOf = (row: FenceRowRef) => fenceRowKey(Number(row.row_num), factRowIdentity({ row_num: Number(row.row_num), fact: row.fact, visibility: row.visibility }));
  const recorded = new Set((await db.executeRaw<{ item_key: string }>(`SELECT DISTINCT i.item_key FROM derived_generation_items i
      JOIN derived_generations g ON g.id = i.generation_id
     WHERE g.source_id = $1 AND g.kind = $2 AND g.owner_key = $3 AND g.state <> 'held' AND i.action <> 'retired' AND i.item_key = ANY($4::text[])`,
  [sourceId, FACT_FENCE_KIND, fenceOwnerKey(slug), open().map(keyOf)])).map(row => row.item_key));
  for (const row of open()) if (recorded.has(keyOf(row))) held.add(Number(row.id));
  const markHeld = (keys: Set<string>) => { for (const row of open()) if (keys.has(rowKey(row))) held.add(Number(row.id)); };
  if (input.prior) markHeld(new Set(input.prior));
  let before: number | null = null;
  let complete = !open().length || !(await db.executeRaw(`SELECT 1 FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NULL LIMIT 1`, [sourceId, slug])).length;
  for (let read = 0; open().length; read += VERSION_BATCH) {
    if (read >= VERSIONS_MAX) { complete = false; break; }
    const versions: Array<{ id: number; compiled_truth: string; timeline: string | null }> = await db.executeRaw(`SELECT v.id, v.compiled_truth, v.timeline FROM page_versions v
        JOIN pages p ON p.id = v.page_id
       WHERE p.source_id = $1 AND p.slug = $2 AND v.compiled_truth IS NOT NULL AND ($3::bigint IS NULL OR v.id < $3::bigint)
         AND (strpos(v.compiled_truth, 'gbrain:facts:') > 0 OR strpos(COALESCE(v.timeline, ''), 'gbrain:facts:') > 0)
       ORDER BY v.id DESC LIMIT $4`, [sourceId, slug, before, VERSION_BATCH]);
    for (const version of versions) markHeld(fenceRowKeys(version, slug, sourceId));
    if (versions.length < VERSION_BATCH) break;
    before = Number(versions[versions.length - 1]!.id);
  }
  return { held, complete };
}

/**
 * Moves the kept rows `ids` whose row number a fence row claims (`claimed`) to fresh numbers above every row of the
 * page and every claimed number, so the fence row takes its position and the kept row stays active with its id.
 */
export async function moveKeptRows(tx: BrainEngine, sourceId: string, slug: string, ids: readonly number[], claimed: readonly number[]): Promise<void> {
  if (!ids.length || !claimed.length) return;
  await tx.executeRaw(`UPDATE facts f SET row_num = m.next FROM (
      SELECT k.id, b.top + row_number() OVER (ORDER BY k.row_num, k.id) AS next FROM facts k,
        (SELECT GREATEST(COALESCE((SELECT max(row_num) FROM facts WHERE source_id = $1 AND source_markdown_slug = $2), 0),
          COALESCE((SELECT max(c) FROM unnest($4::integer[]) AS c), 0)) AS top) b
       WHERE k.source_id = $1 AND k.id = ANY($3::bigint[]) AND k.row_num = ANY($4::integer[])) m
    WHERE f.id = m.id`, [sourceId, slug, [...ids], [...claimed]]);
}

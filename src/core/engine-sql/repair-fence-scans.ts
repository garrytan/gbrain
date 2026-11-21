/**
 * The page scans of the `contact-rows`, `split-facts` and `atom-fence-rows` repair plans, moved here from their repair
 * modules so the Rust engine can serve them as typed members. PGLite and Postgres read unscoped through executeRaw, as
 * before; the two atom reads take the engine's raw read so Postgres keeps their statement deadline. The Rust engine scans its page records and body manifests (rust/crates/gbrain-store/src/repair_fence_scans.rs;
 * rust/docs/store/repair-bookkeeping.md, "Repair fence scans").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment } from './fragment.ts';

/** A page a repair plan reads next: its id and where it lives. */
export interface RepairPageRef { id: number; source_id: string; slug: string }

/** Which pages `listContactRowPages` reads: the pages past `afterId` (at most `limit`), among `slugs` when not empty. */
export interface ContactRowQuery { afterId: number; limit: number; slugs: readonly string[] }

/** The pages `gbrain repair split-facts` reads: inline pages that hold a facts fence in both sections, segmented ones whose live manifest does. */
export interface SplitFactsPages { inline: RepairPageRef[]; segmented: Array<{ source_id: string; slug: string }> }

/** Which world atoms `listAtomFenceCandidates` reads: one atom (`atomId`) or every one, past `afterId`, at most `limit`. */
export interface AtomFenceQuery { atomId: number | null; afterId: number; limit: number; timeoutMs?: number }

/** A world atom whose source page names a facts or takes fence (or is stored in segments: `origin_unread`). */
export interface AtomFenceCandidate {
  id: number; source_id: string; slug: string; revision: string; text: string | null; origin_id: number; origin_slug: string;
  origin_hash: string | null; origin_unread: boolean;
}

/** The live inline pages of `sourceIds` with two or more frontmatter contact rows, by id. */
export async function listContactRowPages(exec: LegacyUnscopedRead, sourceIds: readonly string[], q: ContactRowQuery): Promise<RepairPageRef[]> {
  const slugs = [...q.slugs];
  const { text, params } = renderFragment(sqlFragment`SELECT id, source_id, slug FROM pages
        WHERE source_id=ANY(${[...sourceIds]}::text[]) AND deleted_at IS NULL AND body_storage='inline' AND id>${q.afterId}
          AND CASE WHEN jsonb_typeof(frontmatter->'contacts')='array' THEN jsonb_array_length(frontmatter->'contacts') ELSE 0 END>1
          AND (cardinality(${slugs}::text[])=0 OR slug=ANY(${slugs}::text[]))
        ORDER BY id LIMIT ${Math.max(1, Math.floor(q.limit))}`);
  const rows = await exec.executeRaw<RepairPageRef>(text, params);
  return rows.map(row => ({ ...row, id: Number(row.id) }));
}

/** The live pages of `sourceIds` a split-facts preview reads, each list by id. */
export async function listSplitFactsPages(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<SplitFactsPages> {
  const inline = await exec.executeRaw<RepairPageRef>(
    `SELECT id, source_id, slug FROM pages
        WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND compiled_truth LIKE '%gbrain:facts:begin%' AND timeline LIKE '%gbrain:facts:begin%' ORDER BY id`,
    [[...sourceIds]]);
  const segmented = await exec.executeRaw<{ source_id: string; slug: string }>(`SELECT p.source_id, p.slug FROM pages p
      WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.body_storage='segmented'
        AND EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.region='truth'
          AND m.protected_regions @> '[{"kind":"facts"}]'::jsonb)
        AND EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.region='timeline'
          AND m.protected_regions @> '[{"kind":"facts"}]'::jsonb)
      ORDER BY p.id`, [[...sourceIds]]);
  return { inline: inline.map(row => ({ ...row, id: Number(row.id) })), segmented };
}

/** The world atoms of `sourceIds` whose live source page names a facts or takes fence or is segmented, by id. */
export async function listAtomFenceCandidates(raw: EngineRawRead, sourceIds: readonly string[], q: AtomFenceQuery): Promise<AtomFenceCandidate[]> {
  const rows = await raw<AtomFenceCandidate>(
    `SELECT a.id, a.source_id, a.slug, a.knowledge_revision::text AS revision,
              concat_ws(E'\\n', a.title, a.compiled_truth, a.frontmatter->>'source_quote') AS text,
              o.id AS origin_id, o.slug AS origin_slug, o.content_hash AS origin_hash, o.compiled_truth IS NULL AS origin_unread
         FROM pages a
         JOIN pages o ON o.source_id=a.source_id AND o.slug=a.frontmatter->>'source_slug' AND o.deleted_at IS NULL
        WHERE a.source_id=ANY($1::text[]) AND a.type='atom' AND a.deleted_at IS NULL AND a.frontmatter->>'visibility'='world'
          AND ($2::int IS NULL OR a.id=$2::int) AND a.id>$3
          AND (o.compiled_truth IS NULL OR strpos(o.compiled_truth, 'gbrain:facts:begin')>0 OR strpos(o.compiled_truth, 'gbrain:takes:begin')>0)
        ORDER BY a.id LIMIT $4`, [[...sourceIds], q.atomId, q.afterId, q.limit], q.timeoutMs ? { timeoutMs: q.timeoutMs } : undefined);
  return rows.map(row => ({ ...row, id: Number(row.id), origin_id: Number(row.origin_id), origin_unread: row.origin_unread === true }));
}

/** The compiled truth of the pages `ids` (null for a segmented page), in no set order. */
export async function listPageTruths(raw: EngineRawRead, ids: readonly number[], timeoutMs?: number): Promise<Array<{ id: number; body: string | null }>> {
  const rows = await raw<{ id: number; body: string | null }>('SELECT id, compiled_truth AS body FROM pages WHERE id=ANY($1::int[])',
    [ids.map(Number)], timeoutMs ? { timeoutMs } : undefined);
  return rows.map(row => ({ id: Number(row.id), body: row.body }));
}

/**
 * #9653: the reads and the link carry of a held-concept rebuild (persistence/concept-rebuild.ts orchestrates them).
 * Each ran through executeRaw; SQL once for both engines. Values bind once in a `q` row and the statements read them
 * from it, so the held predicate stays constant text. The stated-row check, the access read and the held-concept report
 * are here too (readConceptStatedKinds, readRebuildAccess, readHeldConceptRows), each the statement
 * persistence/concept-rebuild.ts sent, byte for byte. The Rust store serves every member (rust/docs/store/concept_rebuild.md).
 */
import type { BrainEngine } from '../engine.ts';
import { OWED_PURGE_OP } from '../persistence/derived-origin-hold.ts';
import { privacyPartSql, privatePagesFilterFragment } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * A synthesized concept tombstone `p` still held for a rebuild: its needs_rederive mark is open at the delete it set
 * and no owner purge is owed on it. Reads `q.owed_op` (OWED_PURGE_OP) from a `q` row in the FROM list.
 */
export const HELD_CONCEPT_SQL = `p.deleted_at IS NOT NULL AND p.type = 'concept' AND coalesce(p.frontmatter->>'synthesized_by', '') LIKE 'synthesize_concepts%'
  AND EXISTS (SELECT 1 FROM needs_rederive n WHERE n.derived_table = 'pages' AND n.derived_id = p.id::text AND n.marked_at = p.deleted_at)
  AND NOT EXISTS (SELECT 1 FROM op_checkpoints o WHERE o.op = q.owed_op AND o.fingerprint = p.id::text)`;

/** The delete instant of `p`, in microseconds since the epoch, as text (it round-trips through a request payload). */
const DELETED_US_SQL = 'floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text';

/** The incoming-link columns a rebuilt concept carries over (persistence/concept-rebuild.ts REBUILD_LINK_COLUMNS). */
export const CARRIED_LINK_COLUMNS = ['from_page_id', 'to_page_id', 'link_type', 'context', 'link_source', 'link_kind', 'origin_page_id',
  'origin_field', 'resolution_type', 'created_at', 'assertion_tense'] as const;

/**
 * The fresh row at (`$1`, `$2`), with the incoming links `$3` (to_jsonb rows of the old row `$4`) carried onto it:
 * to_page_id, and an origin_page_id naming the old row, point at the fresh row. Its column list is CARRIED_LINK_COLUMNS.
 */
export const CARRY_LINKS_SQL = `WITH fresh AS (SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL),
  carried AS (INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, link_kind, origin_page_id, origin_field, resolution_type, created_at, assertion_tense)
    SELECT r.from_page_id, fresh.id, r.link_type, r.context, r.link_source, r.link_kind, CASE WHEN r.origin_page_id = $4::int THEN fresh.id ELSE r.origin_page_id END,
      r.origin_field, r.resolution_type, r.created_at, r.assertion_tense
    FROM fresh, jsonb_populate_recordset(NULL::links, $3::text::jsonb) r ON CONFLICT DO NOTHING RETURNING 1)
  SELECT id, (SELECT count(*)::int FROM carried) AS carried FROM fresh`;

/** The delete instant (DELETED_US_SQL) of the tombstone `pageId` while it is held for a rebuild, or null. */
export async function readHeldConcept(engine: Raw, pageId: number): Promise<{ deleted_us: string } | null> {
  const { text, params } = renderFragment(sqlFragment`WITH q AS (SELECT ${pageId}::int AS id, ${OWED_PURGE_OP}::text AS owed_op)
    SELECT ${trustedSql(DELETED_US_SQL)} AS deleted_us FROM q, pages p WHERE p.id = q.id AND ${trustedSql(HELD_CONCEPT_SQL)}`);
  const [row] = await engine.executeRaw<{ deleted_us: string }>(text, params);
  return row ? { deleted_us: String(row.deleted_us) } : null;
}

/** Whether the tombstone `pageId` is still held for a rebuild at the delete `deletedUs` (DELETED_US_SQL text). */
export async function isConceptStillHeld(engine: Raw, pageId: number, deletedUs: string): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`WITH q AS (SELECT ${pageId}::int AS id, ${deletedUs}::text AS deleted_us, ${OWED_PURGE_OP}::text AS owed_op)
    SELECT 1 FROM q, pages p WHERE p.id = q.id AND ${trustedSql(DELETED_US_SQL)} = q.deleted_us AND ${trustedSql(HELD_CONCEPT_SQL)}`);
  return (await engine.executeRaw(text, params)).length > 0;
}

/** Locks the tombstone `pageId` at (`sourceId`, `slug`) for update while it is still held at `deletedUs`; whether it was. */
export async function lockHeldConcept(engine: Raw, pageId: number, sourceId: string, slug: string, deletedUs: string): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`WITH q AS (SELECT ${pageId}::int AS id, ${sourceId}::text AS source_id, ${slug}::text AS slug,
      ${deletedUs}::text AS deleted_us, ${OWED_PURGE_OP}::text AS owed_op)
    SELECT p.id FROM q, pages p WHERE p.id = q.id AND p.source_id = q.source_id AND p.slug = q.slug
      AND ${trustedSql(DELETED_US_SQL)} = q.deleted_us AND ${trustedSql(HELD_CONCEPT_SQL)} FOR UPDATE OF p`);
  return (await engine.executeRaw(text, params)).length > 0;
}

/** How many of `members` are live in `sourceId` at the revision given; inside a transaction it locks them FOR SHARE. */
export async function lockLiveConceptMembers(engine: Raw, sourceId: string, members: ReadonlyArray<{ slug: string; revision: string }>): Promise<number> {
  if (!members.length) return 0;
  return (await engine.executeRaw(`SELECT m.slug FROM pages m JOIN jsonb_to_recordset($2::text::jsonb) AS r(slug text, revision text)
    ON m.slug = r.slug AND m.knowledge_revision::text = r.revision WHERE m.source_id = $1 AND m.deleted_at IS NULL FOR SHARE OF m`,
  [sourceId, JSON.stringify(members.map(m => ({ slug: m.slug, revision: m.revision })))])).length;
}

/** The live pages of `slugs` in `sourceId`, with their knowledge revision as text. */
export async function listLiveConceptMemberRevisions(engine: Raw, sourceId: string, slugs: readonly string[]): Promise<Array<{ slug: string; revision: string }>> {
  if (!slugs.length) return [];
  const rows = await engine.executeRaw<{ slug: string; revision: string }>(`SELECT slug, knowledge_revision::text AS revision FROM pages
    WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`, [sourceId, [...new Set(slugs)]]);
  return rows.map(row => ({ slug: row.slug, revision: String(row.revision) }));
}

/** The links into `pageId` from other live pages, except concept provenance, as to_jsonb rows (carried by carryConceptIncomingLinks). */
export async function listConceptIncomingLinks(engine: Raw, pageId: number): Promise<unknown[]> {
  return (await engine.executeRaw<{ link: unknown }>(`SELECT to_jsonb(l) AS link FROM links l JOIN pages f ON f.id = l.from_page_id
    WHERE l.to_page_id = $1 AND l.from_page_id <> $1 AND f.deleted_at IS NULL AND l.link_source IS DISTINCT FROM 'concept-provenance'`, [pageId])).map(row => row.link);
}

/**
 * Carries `incoming` (listConceptIncomingLinks rows of the old row `oldId`) onto the live page at (`sourceId`, `slug`).
 * The fresh row's id and how many links were inserted, or null when no live page is there.
 */
export async function carryConceptIncomingLinks(engine: Raw, sourceId: string, slug: string, incoming: readonly unknown[], oldId: number): Promise<{ id: number; carried: number } | null> {
  const [fresh] = await engine.executeRaw<{ id: number; carried: number }>(CARRY_LINKS_SQL, [sourceId, slug, JSON.stringify(incoming), oldId]);
  return fresh ? { id: Number(fresh.id), carried: Number(fresh.carried) } : null;
}

/** When the tombstone `pageId`'s recovery window ends: its delete plus `hours` (UTC, to the second), and whether that passed. */
export async function readTombstoneWindow(engine: Raw, pageId: number, hours: number): Promise<{ until: string; past: boolean } | null> {
  const [window] = await engine.executeRaw<{ until: string; past: boolean }>(`SELECT to_char((deleted_at + ($2 || ' hours')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS until,
    deleted_at + ($2 || ' hours')::interval <= now() AS past FROM pages WHERE id = $1 AND deleted_at IS NOT NULL`, [pageId, String(hours)]);
  return window ? { until: window.until, past: window.past === true } : null;
}

/**
 * What on or about the concept row `$1` (source `$2`, slug `$3`) synthesis did not write: REBUILD_STORES kinds for rows a
 * person or an agent stated, plus a title other than the slug's, a frontmatter key synthesis does not write, a stored
 * timeline, a file other than `<slug>.md`, dated link transitions, an attached raw_data payload, a person's decision on an
 * edge proposal (rejected, undone or reverted), an entity identity, a guest mark or promotion, and a sealed secret original the purge would delete with the page
 * (one also recorded on another page or a commit survives it and holds nothing). The statement is written out (the
 * dynamic-SQL guard allows a `$n` used more than once only in a static statement): it is extractedFromPageSql('f', '$3'),
 * holdAppliesToPageSql('h', '$1', '$3') and boundedBodyPrefixSql('p') rendered in, and the caller raw-SQL pins rebuild it
 * from those builders, so a drift in either fails.
 */
export const STATED_SQL = `SELECT array_remove(ARRAY[
  CASE WHEN EXISTS (SELECT 1 FROM facts f WHERE f.source_id = $2 AND (f.entity_slug = $3 OR f.source_markdown_slug = $3) AND NOT (f.source_markdown_slug IS NULL AND f.source IN ('mcp:put_page', 'sync:import', 'file_upload', 'code_import')
    AND md5(split_part(f.context, ' — ', 1)) = md5($3) AND split_part(f.context, ' — ', 1) = $3)) THEN 'facts' END,
  CASE WHEN EXISTS (SELECT 1 FROM takes t WHERE t.page_id = $1) THEN 'takes' END,
  CASE WHEN EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = $1) THEN 'timeline_entries' END,
  CASE WHEN EXISTS (SELECT 1 FROM links l WHERE (l.to_page_id = $1 OR l.from_page_id = $1) AND l.link_source IS NOT NULL
    AND l.link_source <> ALL($4::text[])) THEN 'links' END,
  CASE WHEN EXISTS (SELECT 1 FROM tags t WHERE t.page_id = $1) THEN 'tags' END,
  CASE WHEN EXISTS (SELECT 1 FROM files x WHERE x.page_id = $1) THEN 'files' END,
  CASE WHEN EXISTS (SELECT 1 FROM page_aliases a WHERE a.source_id = $2 AND a.slug = $3) THEN 'page_aliases' END,
  CASE WHEN EXISTS (SELECT 1 FROM slug_aliases a WHERE a.source_id = $2 AND a.canonical_slug = $3) THEN 'slug_aliases' END,
  CASE WHEN EXISTS (SELECT 1 FROM core_edit_notices c WHERE c.source_id = $2 AND c.slug = $3) THEN 'core_edit_notices' END,
  CASE WHEN EXISTS (SELECT 1 FROM write_gate_holds h WHERE h.source_id = $2 AND (h.page_id = $1 OR (h.page_id IS NULL AND (h.slug = $3 OR $1 = ANY(COALESCE(h.page_candidates, '{}'::bigint[])) OR EXISTS (WITH RECURSIVE reach(s) AS (SELECT h.slug UNION SELECT n.t FROM reach x JOIN LATERAL (
      SELECT a.canonical_slug AS t FROM slug_aliases a WHERE a.source_id = h.source_id AND a.alias_slug = x.s
      UNION SELECT r.new_slug FROM slug_rename_history r WHERE r.source_id = h.source_id AND r.old_slug = x.s) n ON true) SELECT 1 FROM reach WHERE reach.s = $3))))) THEN 'write_gate_holds' END,
  CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.id = $1 AND p.title <> replace(regexp_replace(p.slug, '^.*/', ''), '-', ' ')) THEN 'title' END,
  CASE WHEN EXISTS (SELECT 1 FROM pages p, jsonb_each(p.frontmatter) e WHERE p.id = $1 AND e.key <> ALL($6::text[]) AND e.key <> ALL($5::text[])
    AND NOT (e.key = 'tags' AND e.value = '[]'::jsonb)) THEN 'frontmatter' END,
  CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.id = $1 AND p.body_storage IS DISTINCT FROM 'segmented' AND coalesce(p.timeline, '') <> '') THEN 'timeline' END,
  CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.id = $1 AND ((p.source_path IS NOT NULL AND p.source_path <> p.slug || '.md')
    OR p.source_uri IS NOT NULL OR p.withheld_source_path IS NOT NULL)) THEN 'source_path' END,
  CASE WHEN EXISTS (SELECT 1 FROM link_transitions t WHERE t.from_page_id = $1 OR t.to_page_id = $1 OR t.origin_page_id = $1) THEN 'link_transitions' END,
  CASE WHEN EXISTS (SELECT 1 FROM raw_data r WHERE r.page_id = $1) THEN 'raw_data' END,
  CASE WHEN EXISTS (SELECT 1 FROM link_edge_proposals e WHERE $1 IN (e.from_page_id, e.a_to_page_id, e.b_to_page_id, e.ending_to_page_id)
    AND e.status IN ('rejected', 'undone', 'reverted_by_user')) THEN 'link_edge_proposals' END,
  CASE WHEN EXISTS (SELECT 1 FROM entity_identities i WHERE i.page_id = $1) THEN 'entity_identities' END,
  CASE WHEN EXISTS (SELECT 1 FROM guest_marks g WHERE g.page_id = $1) THEN 'guest_marks' END,
  CASE WHEN EXISTS (SELECT 1 FROM guest_promotions g WHERE g.guest_page_id = $1) THEN 'guest_promotions' END,
  CASE WHEN EXISTS (SELECT 1 FROM secret_store_occurrence o WHERE o.source_id = $2 AND o.commit_sha IS NULL
    AND (o.page_id = $1 OR (o.page_id IS NULL AND o.slug = $3)) AND NOT EXISTS (SELECT 1 FROM secret_store_occurrence k WHERE k.entry_id = o.entry_id
      AND NOT (k.source_id = $2 AND k.commit_sha IS NULL AND (k.page_id = $1 OR (k.page_id IS NULL AND k.slug = $3)))
      AND (k.commit_sha IS NOT NULL OR EXISTS (SELECT 1 FROM pages pk WHERE pk.deleted_at IS NULL
        AND (pk.id = k.page_id OR (k.page_id IS NULL AND pk.source_id = k.source_id AND pk.slug = k.slug)))))) THEN 'secret_store_occurrence' END,
  CASE WHEN EXISTS (SELECT 1 FROM page_label_guards g WHERE g.page_id = $1) OR EXISTS (SELECT 1 FROM pages p WHERE p.id = $1
    AND p.frontmatter ?| $5::text[]) THEN 'labels' END
], NULL) AS kinds,
  (SELECT left(coalesce(p.compiled_truth, p.truth_lead), 65536) FROM pages p WHERE p.id = $1) AS lead, (SELECT p.body_storage = 'segmented' FROM pages p WHERE p.id = $1) AS segmented`;

/** The lists STATED_SQL binds as `$4`, `$5` and `$6` (persistence/concept-rebuild.ts owns their values). */
export interface StatedKindLists { derivedLinkSources: readonly string[]; statedLabelKeys: readonly string[]; synthesisKeys: readonly string[] }

/** STATED_SQL's row: the stated kinds, the bounded body lead and whether the body is segmented (null for no page). */
export interface ConceptStatedRow { kinds: string[] | null; lead: string | null; segmented: boolean | null }

/** What on or about the concept row `pageId` synthesis did not write (STATED_SQL), with its bounded lead. */
export async function readConceptStatedKinds(engine: Raw, pageId: number, sourceId: string, slug: string, lists: StatedKindLists): Promise<ConceptStatedRow> {
  const [row] = await engine.executeRaw<ConceptStatedRow>(STATED_SQL,
    [pageId, sourceId, slug, [...lists.derivedLinkSources], [...lists.statedLabelKeys], [...lists.synthesisKeys]]);
  return { kinds: row?.kinds ?? null, lead: row?.lead ?? null, segmented: row?.segmented ?? null };
}

/** Who may read a page, as the read predicate decides it: compared before and after a rebuild (rebuildWidens). */
export interface RebuildAccess { open: boolean; public_part: boolean; readers: string[] | null; page_readers: string[] | null; folder_rule_ids: string[] | null }

/**
 * The page predicate and privacy part the access read splices, rendered once when this module loads, as the caller's
 * module constant was: the Rust store member reads its policy off these same texts.
 */
export const ACCESS_OPEN_SQL = privatePagesFilterFragment('p');
export const ACCESS_PUBLIC_SQL = privacyPartSql('p');

/** The access of page `pageId` (any row, live or deleted), or null when no row has the id. */
export async function readRebuildAccess(engine: Raw, pageId: number): Promise<RebuildAccess | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(ACCESS_OPEN_SQL)} AS open, ${trustedSql(ACCESS_PUBLIC_SQL)} AS public_part, gbrain_access_readers(p.frontmatter) AS readers,
  p.page_readers, p.folder_rule_ids FROM pages p WHERE p.id = ${pageId}`);
  return (await engine.executeRaw<RebuildAccess>(text, params))[0] ?? null;
}

/** One held concept of the report: its id, source and slug, whether it is private and whether a live member is. */
export interface HeldConceptRow { id: number; source_id: string; slug: string; private: boolean; members_private: boolean }

/**
 * Every held concept (HELD_CONCEPT_SQL), by source then slug: whether its privacy part hides it, and whether a live input
 * page of its derivation fails the no-caller page predicate. Both predicates render at call time, as the caller did.
 */
export async function readHeldConceptRows(engine: Raw): Promise<HeldConceptRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.source_id, p.slug,
    NOT ${trustedSql(privacyPartSql('p'))} AS private,
    EXISTS (SELECT 1 FROM derivation_inputs d JOIN pages m ON m.id::text = d.input_id AND d.input_table = 'pages'
      WHERE d.derived_table = 'pages' AND d.derived_id = p.id::text AND m.deleted_at IS NULL AND NOT (${trustedSql(privatePagesFilterFragment('m'))})) AS members_private
    FROM (SELECT ${OWED_PURGE_OP}::text AS owed_op) q, pages p WHERE ${trustedSql(HELD_CONCEPT_SQL)} ORDER BY p.source_id, p.slug`);
  return engine.executeRaw<HeldConceptRow>(text, params);
}

/**
 * #9653: the reads and the link carry of a held-concept rebuild (persistence/concept-rebuild.ts orchestrates them).
 * Each ran through executeRaw; SQL once for both engines. Values bind once in a `q` row and the statements read them
 * from it, so the held predicate stays constant text.
 *
 * Three reads of the rebuild stay raw SQL in persistence/concept-rebuild.ts (the stated-row check, the access read and
 * the held-concept report), so the Rust engine refuses the whole rebuild up front there, before any write. It does not
 * serve these members yet either: each refuses with `engine_capability_missing` naming the member.
 */
import type { BrainEngine } from '../engine.ts';
import { OWED_PURGE_OP } from '../persistence/derived-origin-hold.ts';
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

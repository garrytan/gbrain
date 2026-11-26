/**
 * The managed link-edit statements (`manualLinkStore()`): what `add_link` and `remove_link` on a managed page read and
 * delete (persistence/manual-links.ts), and the links fence projection that rewrites the page's fenced edges and their
 * dated statements (links-fence-projection.ts). Each method sends the text its caller has always sent, moved unchanged
 * (`LINKS_FENCE_ORIGIN_FIELD`, `RELATIONSHIP`, `DATABASE_ONLY` and `FENCED` written out).
 *
 * The relationship filter binds: $1 the from page id, $2 its source, $3 the target slug, $4 the provenances a
 * reconciliation producer owns (`MANAGED_LINK_SOURCES`), $5 the link type (null for any), $6 the link source (null for
 * any). The Rust store answers the same calls from its link, page and link-transition records
 * (rust/crates/gbrain-store/src/link_queries/manual_links.rs).
 */
import type { BrainEngine } from '../engine.ts';
import { executeRawJsonb } from '../sql-query.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** The relationship one link edit names. */
export interface ManualRelationship { pageId: number; sourceId: string; to: string; managedSources: readonly string[]; linkType: string | null; linkSource: string | null }
export interface FencedEdgeRow { to_page_id: number; to: string; type: string; source: string; context: string | null }
export interface ManualStatementRow { to_page_id: number; type: string; source: string | null; kind: string; on: string }
export interface FenceEdgeRow { id: number; to_page_id: number; link_type: string; link_source: string; context: string }
export interface FenceTransitionRow { id: number; to_page_id: number; link_type: string; link_source: string | null; kind: string; occurred_on: string }
export interface RelationshipKeyRow { from_page_id: number; to_page_id: number; link_type: string }

export interface ManualLinkStore {
  /** The edges page `pageId`'s links fence projected that are still stored, by target slug, type and source in byte order. */
  fencedEdges(pageId: number, originField: string): Promise<FencedEdgeRow[]>;
  /** The page's manual dated statements. */
  manualStatements(pageId: number): Promise<ManualStatementRow[]>;
  /** The distinct targets of the page's fenced edges, and whether each is deleted. */
  fencedTargets(pageId: number, originField: string): Promise<{ slug: string; deleted: boolean }[]>;
  /** add_link: deletes the relationship's database-only edges with no origin page. */
  deleteDatabaseOnly(rel: ManualRelationship): Promise<void>;
  /** remove_link: how many database-only or fenced edges the relationship has. */
  countRelationship(rel: ManualRelationship): Promise<number>;
  /** remove_link: deletes the relationship's database-only edges, and its fenced ones when `withFenced`. */
  dropRelationship(rel: ManualRelationship, withFenced: boolean): Promise<{ to_page_id: number; link_type: string; link_source: string; fenced: boolean }[]>;
  /** remove_link: deletes the manual statements of the removed fenced rows; the relationships they touched. */
  deleteRowTransitions(pageId: number, originField: string, rows: readonly { to_page_id: number; link_type: string; link_source: string }[]): Promise<RelationshipKeyRow[]>;
  /** remove_link: the relationship's edges a reconciliation producer owns (derived from the page text). */
  derivedEdges(rel: ManualRelationship): Promise<{ link_type: string; link_source: string }[]>;
  // The links fence projection.
  pageIds(sourceId: string, slugs: readonly string[]): Promise<{ id: number; slug: string }[]>;
  fenceEdges(pageId: number, originField: string): Promise<FenceEdgeRow[]>;
  fenceTransitions(pageId: number): Promise<FenceTransitionRow[]>;
  /** Deletes the page's links with these ids (`pageId` is the from page of each; the SQL names the ids alone). */
  deleteLinks(pageId: number, ids: readonly number[]): Promise<void>;
  /** Sets the context of the page's links with these ids (`pageId` as for deleteLinks). */
  updateContexts(pageId: number, rows: readonly { id: number; context: string }[]): Promise<void>;
  insertFenceLinks(pageId: number, originField: string, rows: readonly { to_page_id: number; link_type: string; context: string; link_source: string }[]): Promise<void>;
  deleteTransitions(ids: readonly number[]): Promise<void>;
  insertTransitions(sourceId: string, pageId: number, rows: readonly { to_page_id: number; link_type: string; link_source: string | null; kind: string; occurred_on: string }[]): Promise<void>;
  /** Whether the link-transition identity index carries link_source (schema v302); `index` names it. */
  identityHasSource(index: string): Promise<boolean>;
}

const FENCED_EDGES_SQL = `SELECT l.to_page_id, t.slug AS to, l.link_type AS type, l.link_source AS source, l.context FROM links l JOIN pages t ON t.id=l.to_page_id
        WHERE l.from_page_id=$1 AND l.origin_page_id=$1 AND l.origin_field=$2 ORDER BY t.slug COLLATE "C", l.link_type COLLATE "C", l.link_source COLLATE "C"`;
const MANUAL_STATEMENTS_SQL = `SELECT to_page_id, link_type AS type, link_source AS source, kind, occurred_on::text AS on FROM link_transitions
        WHERE origin_page_id=$1 AND from_page_id=$1 AND producer='manual'`;
const FENCED_TARGETS_SQL = `SELECT DISTINCT t.slug, t.deleted_at IS NOT NULL AS deleted
      FROM links l JOIN pages t ON t.id=l.to_page_id WHERE l.from_page_id=$1 AND l.origin_page_id=$1 AND l.origin_field=$2`;
const DELETE_DATABASE_ONLY_SQL = `DELETE FROM links l USING pages t WHERE l.from_page_id=$1 AND l.to_page_id=t.id AND t.source_id=$2 AND t.slug=$3
  AND ($5::text IS NULL OR l.link_type=$5) AND ($6::text IS NULL OR l.link_source=$6) AND l.origin_field IS DISTINCT FROM 'links_fence' AND l.link_source <> ALL($4::text[]) AND l.origin_page_id IS NULL`;
const COUNT_RELATIONSHIP_SQL = `SELECT count(*)::int AS n FROM links l, pages t WHERE l.from_page_id=$1 AND l.to_page_id=t.id AND t.source_id=$2 AND t.slug=$3
  AND ($5::text IS NULL OR l.link_type=$5) AND ($6::text IS NULL OR l.link_source=$6) AND ((l.origin_field IS DISTINCT FROM 'links_fence' AND l.link_source <> ALL($4::text[])) OR (l.origin_field='links_fence' AND l.origin_page_id=$1))`;
const DROP_RELATIONSHIP_SQL = `DELETE FROM links l USING pages t
      WHERE l.from_page_id=$1 AND l.to_page_id=t.id AND t.source_id=$2 AND t.slug=$3
  AND ($5::text IS NULL OR l.link_type=$5) AND ($6::text IS NULL OR l.link_source=$6) AND ((l.origin_field IS DISTINCT FROM 'links_fence' AND l.link_source <> ALL($4::text[])) OR ($7::boolean AND l.origin_field='links_fence' AND l.origin_page_id=$1))
      RETURNING l.to_page_id, l.link_type, l.link_source, l.origin_field IS NOT DISTINCT FROM 'links_fence' AS fenced`;
const DELETE_ROW_TRANSITIONS_SQL = `DELETE FROM link_transitions lt
        USING jsonb_to_recordset(($3::jsonb)->'rows') AS v(to_page_id integer, link_type text, link_source text)
      WHERE lt.from_page_id=$1 AND lt.origin_page_id=$1 AND lt.producer='manual' AND lt.to_page_id=v.to_page_id AND lt.link_type=v.link_type
        AND (lt.link_source=v.link_source OR (lt.link_source IS NULL AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id=$1
          AND l.origin_page_id=$1 AND l.origin_field=$2 AND l.to_page_id=v.to_page_id AND l.link_type=v.link_type)))
      RETURNING lt.from_page_id, lt.to_page_id, lt.link_type`;
const DERIVED_EDGES_SQL = `SELECT DISTINCT l.link_type COLLATE "C" AS link_type, l.link_source COLLATE "C" AS link_source FROM links l, pages t
      WHERE l.from_page_id=$1 AND l.to_page_id=t.id AND t.source_id=$2 AND t.slug=$3
  AND ($5::text IS NULL OR l.link_type=$5) AND ($6::text IS NULL OR l.link_source=$6) AND l.link_source = ANY($4::text[]) ORDER BY l.link_type COLLATE "C", l.link_source COLLATE "C"`;
const PAGE_IDS_SQL = `SELECT id, slug FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL`;
const FENCE_EDGES_SQL = `SELECT id, to_page_id, link_type, link_source, context FROM links WHERE origin_page_id=$1 AND from_page_id=$1 AND origin_field=$2`;
const FENCE_TRANSITIONS_SQL = `SELECT id, to_page_id, link_type, link_source, kind, occurred_on::text AS occurred_on FROM link_transitions
        WHERE origin_page_id=$1 AND from_page_id=$1 AND producer='manual'`;
const DELETE_LINKS_SQL = `DELETE FROM links WHERE id=ANY($1::bigint[])`;
const UPDATE_CONTEXTS_SQL = `UPDATE links l SET context=v.context
      FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(id bigint, context text) WHERE l.id=v.id`;
const INSERT_FENCE_LINKS_SQL = `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
      SELECT $1, v.to_page_id, v.link_type, v.context, v.link_source, $1, $2
        FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(to_page_id integer, link_type text, context text, link_source text)
      ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET context=EXCLUDED.context, origin_field=EXCLUDED.origin_field`;
const DELETE_TRANSITIONS_SQL = `DELETE FROM link_transitions WHERE id=ANY($1::bigint[])`;
const INSERT_TRANSITIONS_SQL = `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, link_source, kind, occurred_on, producer, origin_page_id)
      SELECT $1, $2, v.to_page_id, v.link_type, v.link_source, v.kind, v.occurred_on::date, 'manual', $2
        FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(to_page_id integer, link_type text, link_source text, kind text, occurred_on text)
      ON CONFLICT DO NOTHING`;
const IDENTITY_HAS_SOURCE_SQL = `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indexrelid = to_regclass($1) AND a.attname = 'link_source') AS has`;

const relParams = (rel: ManualRelationship) => [rel.pageId, rel.sourceId, rel.to, [...rel.managedSources], rel.linkType, rel.linkSource];

/** `manualLinkStore()` on PGLite and Postgres: the store over `exec` (a transaction engine runs every call in it). */
export async function manualLinkStore(exec: RawSql): Promise<ManualLinkStore> {
  return {
    fencedEdges: (pageId, originField) => exec.executeRaw<FencedEdgeRow>(FENCED_EDGES_SQL, [pageId, originField]),
    manualStatements: pageId => exec.executeRaw<ManualStatementRow>(MANUAL_STATEMENTS_SQL, [pageId]),
    fencedTargets: (pageId, originField) => exec.executeRaw(FENCED_TARGETS_SQL, [pageId, originField]),
    async deleteDatabaseOnly(rel) { await exec.executeRaw(DELETE_DATABASE_ONLY_SQL, relParams(rel)); },
    countRelationship: async rel => Number((await exec.executeRaw<{ n: number }>(COUNT_RELATIONSHIP_SQL, relParams(rel)))[0]?.n ?? 0),
    dropRelationship: (rel, withFenced) => exec.executeRaw(DROP_RELATIONSHIP_SQL, [...relParams(rel), withFenced]),
    deleteRowTransitions: (pageId, originField, rows) => executeRawJsonb<RelationshipKeyRow>(exec, DELETE_ROW_TRANSITIONS_SQL, [pageId, originField], [{ rows }]),
    derivedEdges: rel => exec.executeRaw(DERIVED_EDGES_SQL, relParams(rel)),
    pageIds: (sourceId, slugs) => exec.executeRaw(PAGE_IDS_SQL, [sourceId, [...slugs]]),
    fenceEdges: (pageId, originField) => exec.executeRaw<FenceEdgeRow>(FENCE_EDGES_SQL, [pageId, originField]),
    fenceTransitions: pageId => exec.executeRaw<FenceTransitionRow>(FENCE_TRANSITIONS_SQL, [pageId]),
    async deleteLinks(_pageId, ids) { await exec.executeRaw(DELETE_LINKS_SQL, [[...ids]]); },
    async updateContexts(_pageId, rows) { await executeRawJsonb(exec, UPDATE_CONTEXTS_SQL, [], [{ rows }]); },
    async insertFenceLinks(pageId, originField, rows) { await executeRawJsonb(exec, INSERT_FENCE_LINKS_SQL, [pageId, originField], [{ rows }]); },
    async deleteTransitions(ids) { await exec.executeRaw(DELETE_TRANSITIONS_SQL, [[...ids]]); },
    async insertTransitions(sourceId, pageId, rows) { await executeRawJsonb(exec, INSERT_TRANSITIONS_SQL, [sourceId, pageId], [{ rows }]); },
    identityHasSource: async index => (await exec.executeRaw<{ has: boolean }>(IDENTITY_HAS_SOURCE_SQL, [index]))[0]?.has === true,
  };
}

/** The statements whose text a test pins against the fragments the callers built. */
export const MANUAL_LINK_STATEMENTS = {
  FENCED_EDGES_SQL, MANUAL_STATEMENTS_SQL, FENCED_TARGETS_SQL, DELETE_DATABASE_ONLY_SQL, COUNT_RELATIONSHIP_SQL, DROP_RELATIONSHIP_SQL,
  DELETE_ROW_TRANSITIONS_SQL, DERIVED_EDGES_SQL, PAGE_IDS_SQL, FENCE_EDGES_SQL, FENCE_TRANSITIONS_SQL, UPDATE_CONTEXTS_SQL,
  INSERT_FENCE_LINKS_SQL, INSERT_TRANSITIONS_SQL, IDENTITY_HAS_SOURCE_SQL,
} as const;

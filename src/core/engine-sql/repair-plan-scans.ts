/**
 * The plan reads of the `frontmatter`, `segmented-tiling`, `attribution-backfill` and `failed-writes` repairs, the drift-conflict audit
 * (`gbrain repair file-drift`'s survey) and the source hold listing, moved here from repair/frontmatter.ts, page-body/body-tiling.ts,
 * repair/attribution-backfill.ts, repair/failed-writes.ts, persistence/drift-conflicts.ts and persistence/sync-holds.ts so the Rust engine can serve them as typed
 * members. PGLite and Postgres read unscoped through executeRaw, as before. The Rust engine scans its records
 * (rust/crates/gbrain-store/src/repair_plan_scans.rs; rust/docs/store/repair-bookkeeping.md, "Repair plan scans").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { liveTilingSql, untiledSql } from '../page-body/schema.ts';
import { remoteReadFloorSql } from '../search/private-visibility.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** A live page of a source that records an origin, with the first 400 characters of its compiled truth (null when segmented). */
export interface OriginPathPageRow { id: number; slug: string; source_path: string; revision: string; title: string; head: string | null }

/** A segmented page's tiling row as the SQL returns it, before `untiledPageOf` names its fields. */
export interface UntiledPageRow {
  id: number | string; source_id: string; slug: string; revision: string; body_generation: unknown; body_bytes: unknown;
  segment_count: unknown; source_path: string | null; n: unknown; covered: unknown; gapless: boolean;
}

/** GST-1209: a live page stored in segments whose live generation's rows do not tile its body (`untiledSegmentedPages`). */
export interface UntiledPage {
  source_id: string; slug: string; page_id: number; revision: string; body_generation: number; body_bytes: number;
  segment_count: number | null; source_path: string | null;
  /** The live generation's rows, and the bytes they cover gapless from 0 (null: they leave a gap). */
  rows: number; covered_bytes: number | null;
}

/** The filters of listUntiledSegmentedPages; a missing list does not narrow, and `limit` defaults to 1000. */
export interface UntiledPageQuery { sourceIds?: readonly string[]; slugs?: readonly string[]; limit?: number }

/** One hold record (`completed_keys->0` of an op_checkpoints row) naming a source and its current incarnation. */
export interface SourceHoldRecordRow { record: Record<string, unknown>; mirror_read_only: boolean }

/** The filters of listSourceHoldRecords; a missing filter does not narrow. */
export interface SourceHoldQuery { sourceIds?: readonly string[] | null; runId?: string | null }

/** Names a tiling row's fields as UntiledPage does; every engine maps its rows through it. */
export function untiledPageOf(row: UntiledPageRow): UntiledPage {
  return { source_id: row.source_id, slug: row.slug, page_id: Number(row.id), revision: row.revision, body_generation: Number(row.body_generation),
    body_bytes: Number(row.body_bytes), segment_count: row.segment_count === null ? null : Number(row.segment_count), source_path: row.source_path,
    rows: Number(row.n), covered_bytes: row.gapless ? Number(row.covered) : null };
}

/** The live pages of the source that record an origin, by slug in byte order. */
export async function listPagesByOriginPath(exec: LegacyUnscopedRead, sourceId: string): Promise<OriginPathPageRow[]> {
  const rows = await exec.executeRaw<OriginPathPageRow>(`SELECT id, slug, source_path, knowledge_revision::text AS revision, title, left(compiled_truth, 400) AS head
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL ORDER BY slug COLLATE "C"`, [sourceId]);
  return rows.map(row => ({ id: Number(row.id), slug: row.slug, source_path: row.source_path, revision: row.revision, title: row.title, head: row.head ?? null }));
}

/** How many live file-backed pages of `sourceIds` store their body in segments. */
export async function countSegmentedOriginPages(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages
    WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND source_path IS NOT NULL AND body_storage='segmented'`, [[...sourceIds]]);
  return Number(row?.n ?? 0);
}

/**
 * The live segmented pages of source `sourceId`, by slug in byte order (`gbrain repair segmented-mirror`'s preview walk;
 * the text it sent through executeRaw, with `COLLATE "C"` so Postgres orders as PGLite does).
 */
export async function listSegmentedPageSlugs(exec: LegacyUnscopedRead, sourceId: string): Promise<string[]> {
  const rows = await exec.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id=$1 AND body_storage='segmented' AND deleted_at IS NULL ORDER BY slug COLLATE "C"`, [sourceId]);
  return rows.map(row => row.slug);
}

/**
 * GST-1209: the live (not deleted) pages of unarchived sources stored in segments whose live generation's rows do not cover body_bytes gapless
 * from 0, so every read of them refuses page_body_rows_unreadable. One aggregate per page over its live rows, read-only;
 * `sourceIds` and `slugs` narrow the scan, `limit` bounds the list (ordered by source and slug).
 */
export async function listUntiledSegmentedPages(exec: LegacyUnscopedRead, opts: UntiledPageQuery = {}): Promise<UntiledPage[]> {
  const sourceIds = opts.sourceIds ? [...opts.sourceIds] : null;
  const slugs = opts.slugs ? [...opts.slugs] : null;
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.source_id, p.slug, p.knowledge_revision::text AS revision, p.body_generation, p.body_bytes, p.segment_count, p.source_path, t.n, t.covered, t.gapless
       FROM pages p JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE CROSS JOIN LATERAL (${trustedSql(liveTilingSql('p'))}) t
      WHERE p.body_storage = 'segmented' AND p.deleted_at IS NULL AND (${sourceIds}::text[] IS NULL OR p.source_id = ANY(${sourceIds}::text[]))
        AND (${slugs}::text[] IS NULL OR p.slug = ANY(${slugs}::text[])) AND ${trustedSql(untiledSql('p', 't'))}
      ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C" LIMIT ${opts.limit ?? 1000}`);
  const rows = await exec.executeRaw<UntiledPageRow>(text, params);
  return rows.map(untiledPageOf);
}

/**
 * The first record of each `op` checkpoint naming a source and its current incarnation, narrowed to `sourceIds` and to records whose
 * `run_id` is `runId`, by source id then fingerprint in byte order. `mirror_read_only` is the source's `config.mirror_read_only` flag.
 */
export async function listSourceHoldRecords(exec: LegacyUnscopedRead, op: string, opts: SourceHoldQuery = {}): Promise<SourceHoldRecordRow[]> {
  const rows = await exec.executeRaw<SourceHoldRecordRow>(`SELECT h.completed_keys->0 AS record, COALESCE(s.config->>'mirror_read_only','false')='true' AS mirror_read_only
    FROM op_checkpoints h JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id COLLATE "C", h.fingerprint COLLATE "C"`, [op, opts.sourceIds ? [...opts.sourceIds] : null, opts.runId ?? null]);
  return rows.map(row => ({ record: row.record, mirror_read_only: row.mirror_read_only === true }));
}

/** The tables `attribution-backfill` fills, in phase order. */
export type AttributionTable = 'pages' | 'page_versions' | 'facts';

const FACT_ID = "CASE WHEN r.outcome->>'id' ~ '^[0-9]{1,18}$' THEN (r.outcome->>'id')::bigint END";

/** A committed request that changed the page to the revision it reports. */
const MUTATED_PAGE = `(r.operation IN ('put_page','capture','edit_page','append_page','delete_page','restore_page','revert_version')
    AND r.outcome->>'status' IN ('created_or_updated','restored','reverted','soft_deleted')
    AND COALESCE(r.outcome->>'noop', 'false') <> 'true'
  OR r.operation = 'remember' AND r.outcome->>'status' IN ('inserted','superseded') AND EXISTS (
    SELECT 1 FROM facts f WHERE f.id = ${FACT_ID} AND f.source_id = r.source_id
       AND f.row_num IS NOT NULL AND f.source_markdown_slug = r.slug))`;

/** One attribution-backfill phase: the table, its three attribution columns, the proof join and the unfilled count, each over the source ids it binds. */
export interface AttributionPhase {
  table: AttributionTable; columns: [string, string, string];
  proof: (sourceIds: readonly string[]) => SqlFragment; unfilled: (sourceIds: readonly string[]) => SqlFragment;
}

export const ATTRIBUTION_PHASES: AttributionPhase[] = [
  {
    table: 'pages', columns: ['revision_write_request_id', 'revision_principal_kind', 'revision_principal_id'],
    proof: sourceIds => sqlFragment`SELECT t.id AS target_id, t.source_id, t.slug, r.id::text AS request_id, r.principal_kind, r.principal_id
      FROM pages t JOIN persistence_requests r ON r.state = 'committed' AND r.source_id = t.source_id
       AND r.outcome->>'revision' = t.knowledge_revision::text
     WHERE t.source_id = ANY(${[...sourceIds]}::text[]) AND t.revision_write_request_id IS NULL AND t.revision_principal_kind IS NULL AND ${trustedSql(MUTATED_PAGE)}`,
    unfilled: sourceIds => sqlFragment`SELECT count(*)::int AS n FROM pages t
     WHERE t.source_id = ANY(${[...sourceIds]}::text[]) AND t.revision_write_request_id IS NULL AND t.revision_principal_kind IS NULL`,
  },
  {
    table: 'page_versions', columns: ['write_request_id', 'write_principal_kind', 'write_principal_id'],
    proof: sourceIds => sqlFragment`SELECT t.id AS target_id, p.source_id, p.slug, r.id::text AS request_id, r.principal_kind, r.principal_id
      FROM page_versions t JOIN pages p ON p.id = t.page_id
      JOIN persistence_requests r ON r.state = 'committed' AND r.source_id = p.source_id
       AND r.outcome->>'revision' = t.knowledge_revision::text
     WHERE p.source_id = ANY(${[...sourceIds]}::text[]) AND t.write_request_id IS NULL AND t.write_principal_kind IS NULL AND ${trustedSql(MUTATED_PAGE)}`,
    unfilled: sourceIds => sqlFragment`SELECT count(*)::int AS n FROM page_versions t JOIN pages p ON p.id = t.page_id
     WHERE p.source_id = ANY(${[...sourceIds]}::text[]) AND t.write_request_id IS NULL AND t.write_principal_kind IS NULL`,
  },
  {
    table: 'facts', columns: ['write_request_id', 'write_principal_kind', 'write_principal_id'],
    proof: sourceIds => sqlFragment`SELECT t.id AS target_id, r.source_id, r.slug, r.id::text AS request_id, r.principal_kind, r.principal_id
      FROM persistence_requests r JOIN facts t ON t.id = ${trustedSql(FACT_ID)} AND t.source_id = r.source_id
     WHERE r.state = 'committed' AND r.operation = 'remember' AND r.outcome->>'status' IN ('inserted','superseded')
       AND t.source_id = ANY(${[...sourceIds]}::text[]) AND t.write_request_id IS NULL AND t.write_principal_kind IS NULL`,
    unfilled: sourceIds => sqlFragment`SELECT count(*)::int AS n FROM facts t
     WHERE t.source_id = ANY(${[...sourceIds]}::text[]) AND t.write_request_id IS NULL AND t.write_principal_kind IS NULL`,
  },
];

/** Rows exactly one committed request proves in `sourceIds`, optionally within an id range of `t.id`. */
export function attributionProvenFragment(phase: AttributionPhase, sourceIds: readonly string[], range?: { first: number; last: number }): SqlFragment {
  const within = range ? sqlFragment` AND t.id BETWEEN ${range.first} AND ${range.last}` : sqlFragment``;
  return sqlFragment`SELECT target_id, (array_agg(source_id))[1] AS source_id, (array_agg(slug))[1] AS slug,
      (array_agg(request_id))[1] AS request_id, (array_agg(principal_kind))[1] AS principal_kind,
      (array_agg(principal_id))[1] AS principal_id
    FROM (${phase.proof(sourceIds)}${within}) proof
   GROUP BY target_id HAVING count(*) = 1`;
}

/**
 * `attributionProvenFragment` as text with its parameters numbered $1 source ids, then, when `ranged`, $2 and $3 the id range, for
 * the caller (repair/attribution-backfill.ts) that wraps the statement in its own UPDATE and binds `[source_ids, first, last]`.
 */
export function attributionProvenSql(phase: AttributionPhase, ranged: boolean): string {
  return renderFragment(attributionProvenFragment(phase, [], ranged ? { first: 0, last: 0 } : undefined)).text;
}

function attributionPhase(table: AttributionTable): AttributionPhase {
  const phase = ATTRIBUTION_PHASES.find(p => p.table === table);
  if (!phase) throw new Error(`attribution-backfill: unknown table ${String(table)}`);
  return phase;
}

/** The ids of the `table` rows of `sourceIds` whose attribution is unset and that exactly one committed request proves, ascending. */
export async function listProvenAttributionTargets(exec: LegacyUnscopedRead, table: AttributionTable, sourceIds: readonly string[]): Promise<number[]> {
  const { text, params } = renderFragment(sqlFragment`${attributionProvenFragment(attributionPhase(table), sourceIds)} ORDER BY target_id`);
  const rows = await exec.executeRaw<{ target_id: number | string }>(text, params);
  return rows.map(row => Number(row.target_id));
}

/** How many `table` rows of `sourceIds` have no attribution. */
export async function countUnfilledAttribution(exec: LegacyUnscopedRead, table: AttributionTable, sourceIds: readonly string[]): Promise<number> {
  const { text, params } = renderFragment(attributionPhase(table).unfilled(sourceIds));
  const [row] = await exec.executeRaw<{ n: number }>(text, params);
  return Number(row?.n ?? 0);
}

/**
 * `gbrain repair failed-writes`' candidate read. `replayable` names the operations a caller replays (a `put_page` with an
 * owner `kind` is never one); `factsMovedMessages`, when given, adds the managed fact requests refused because their entity
 * page moved; `id` reads one request. The refusal predicates are `GUARD_REFUSAL_SQL('r')` and `DRIFT_REFUSAL_SQL('r')`
 * of persistence/terminal-classify.ts written out, so this module imports no persistence code
 * (test/persistence-journal-statements.test.ts checks each copy).
 */
export interface FailedWriteQuery { replayable: readonly string[]; factsMovedMessages?: readonly string[]; id?: string }

/** A refused request as the failed-writes preview reads it. `producer` is null for a write a caller made. */
export interface FailedWriteRow {
  id: string; request_id: string; sequence: string; operation: string; source_id: string; slug: string; digest: string; state: string;
  intent: Record<string, unknown>; authority: Record<string, unknown>; created_at: string; origin: string | null; error_code: string | null;
  page_id: string | null; producer: string | null;
}

export const FAILED_WRITE_GUARD_REFUSAL = `(r.state='failed' AND (r.error_code='writer_coordinator_required'
  OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%')))`;
export const FAILED_WRITE_DRIFT_REFUSAL = `(r.state='conflict' AND r.error_code='source_changed')`;
/** #7602: a managed fact request refused because its entity page moved (`messages` the refusal messages). */
const factsMovedRefusal = (messages: readonly string[]): SqlFragment => sqlFragment`(r.operation='extract_facts' AND r.state='conflict' AND r.error_code='revision_conflict'
  AND r.error_message = ANY(${[...messages]}::text[]))`;
/** #7602: a refused fact request whose retained facts a later request of the same extraction committed on the same page. */
const FACTS_RECOVERED = `EXISTS (SELECT 1 FROM persistence_requests c WHERE r.operation='extract_facts' AND c.operation='extract_facts'
  AND c.source_id=r.source_id AND c.slug=r.slug AND c.state='committed' AND c.sequence>r.sequence
  AND COALESCE(c.intent->>'inputDigest', c.outcome->>'input_digest')=r.intent->>'inputDigest'
  AND COALESCE(c.intent->>'batchKey', c.outcome->>'batch_key') IS DISTINCT FROM r.intent->>'batchKey')`;

export function failedWriteRequestsFragment(sourceIds: readonly string[], query: FailedWriteQuery): SqlFragment {
  const facts = query.factsMovedMessages !== undefined;
  const moved = facts ? sqlFragment` OR ${factsMovedRefusal(query.factsMovedMessages!)}` : sqlFragment``;
  const byId = query.id ? sqlFragment`AND r.id=${query.id}::uuid` : sqlFragment``;
  return sqlFragment`SELECT r.id::text, r.request_id::text, r.sequence::text, r.operation, r.source_id, r.slug, r.digest, r.state, r.intent, r.authority,
      to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, r.error_detail->>'origin' AS origin, r.error_code, r.page_id::text AS page_id,
      CASE WHEN r.operation = ANY(${[...query.replayable]}::text[]) AND NOT (r.operation='put_page' AND r.intent ? 'kind') THEN NULL
        ELSE r.operation || COALESCE(':' || (r.intent->>'kind'), '') END AS producer
    FROM persistence_requests r
    WHERE r.source_id = ANY(${[...sourceIds]}::text[]) AND NOT r.compacted AND r.intent IS NOT NULL AND (${trustedSql(FAILED_WRITE_GUARD_REFUSAL)} OR ${trustedSql(FAILED_WRITE_DRIFT_REFUSAL)}${moved})
      ${byId}
    ORDER BY r.sequence`;
}

const recoveredFactRequestsFragment = (ids: readonly string[]): SqlFragment =>
  sqlFragment`SELECT r.id::text FROM persistence_requests r WHERE r.id = ANY(${[...ids]}::uuid[]) AND ${trustedSql(FACTS_RECOVERED)}`;

/**
 * The refused requests of `sourceIds` the failed-writes preview lists, by sequence. Without `id`, a refused fact request a
 * later request of the same extraction recovered is left out (#8707: one statement over the refused fact requests only).
 */
export async function listFailedWriteRequests(exec: LegacyUnscopedRead, sourceIds: readonly string[], query: FailedWriteQuery): Promise<FailedWriteRow[]> {
  const { text, params } = renderFragment(failedWriteRequestsFragment(sourceIds, query));
  const rows = await exec.executeRaw<FailedWriteRow>(text, params);
  if (query.id) return rows;
  const factIds = rows.filter(row => row.operation === 'extract_facts').map(row => row.id);
  if (!factIds.length) return rows;
  const recoveredRead = renderFragment(recoveredFactRequestsFragment(factIds));
  const recovered = new Set((await exec.executeRaw<{ id: string }>(recoveredRead.text, recoveredRead.params)).map(row => row.id));
  return rows.filter(row => !recovered.has(row.id));
}

/** A source's current incarnation and the newest and oldest request sequence it holds (null: none). */
export interface DriftConflictBounds { incarnation: string; top: string | null; bottom: string | null }

/**
 * The drift-conflict audit window of one source: its conflict receipts (`conflict` with `source_changed`) of `incarnation` with
 * a sequence above `floor` through `through`. `slugPrefixes` (normalized, at least one) fences the slugs; `requireLivePage`
 * keeps receipts whose page is live, and `excludePrivate` also applies the caller's remote read floor to that page. The
 * groups are the slugs after `after`, at most `limit`; `driftMessage` is the refusal message a drift receipt carries.
 */
export interface DriftConflictQuery {
  incarnation: string; floor: string; through: string; slugPrefixes?: readonly string[]; requireLivePage: boolean; excludePrivate: boolean;
  after: string; limit: number; driftMessage: string;
}

/** One slug's conflict receipts in the window. */
export interface DriftConflictGroupRow {
  slug: string; receipts: number; drift_receipts: number; first_seen: string; last_seen: string; producers: string[]; last_request_id: string;
}

/** The window's distinct slugs and receipts, and the asked page of slug groups. */
export interface DriftConflictGroups { slugs: number; receipts: number; rows: DriftConflictGroupRow[] }

/** The newest committed receipt of each slug, and (with `paths`) each live page's recorded file. */
export interface DriftConflictDetails {
  committed: Array<{ slug: string; request_id: string; completed_at: string }>;
  recorded: Array<{ slug: string; source_path: string | null; source_uri: string | null }>;
}

const likeEscape = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

export async function readDriftConflictBounds(exec: LegacyUnscopedRead, sourceId: string): Promise<DriftConflictBounds | null> {
  // The window is bounded by this source's own requests (its current incarnation, the request table's
  // (source_incarnation, sequence) index), so its sequences never reveal write activity in other sources.
  const [bounds] = await exec.executeRaw<DriftConflictBounds>(
    `SELECT s.incarnation::text AS incarnation,
        (SELECT max(r.sequence) FROM persistence_requests r WHERE r.source_incarnation=s.incarnation)::text AS top,
        (SELECT min(r.sequence) FROM persistence_requests r WHERE r.source_incarnation=s.incarnation)::text AS bottom
       FROM sources s WHERE s.id=$1`, [sourceId]);
  return bounds ?? null;
}

export async function listDriftConflictGroups(exec: LegacyUnscopedRead, sourceId: string, query: DriftConflictQuery): Promise<DriftConflictGroups> {
  const where: SqlFragment[] = [sqlFragment`r.source_id=${sourceId}`, sqlFragment`r.source_incarnation=${query.incarnation}::uuid`, sqlFragment`r.sequence > ${query.floor}::bigint`,
    sqlFragment`r.sequence <= ${query.through}::bigint`, sqlFragment`r.state='conflict'`, sqlFragment`r.error_code='source_changed'`];
  if (query.slugPrefixes) {
    const alternatives = query.slugPrefixes.map(base => {
      const pattern = base.endsWith('/') ? `${likeEscape(base)}%` : likeEscape(base);
      return base.endsWith('/') ? sqlFragment`lower(r.slug) LIKE ${pattern}` : sqlFragment`(lower(r.slug) = ${pattern} OR lower(r.slug) LIKE ${pattern} || '/%')`;
    });
    where.push(sqlFragment`(${joinFragments(alternatives, ' OR ')})`);
  }
  if (query.requireLivePage || query.excludePrivate) {
    const floor = query.excludePrivate ? sqlFragment` AND ${trustedSql(remoteReadFloorSql('p'))}` : sqlFragment``;
    where.push(sqlFragment`EXISTS (SELECT 1 FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug AND p.deleted_at IS NULL${floor})`);
  }
  const filtered = joinFragments(where, ' AND ');
  const totalsRead = renderFragment(sqlFragment`SELECT count(DISTINCT r.slug)::int AS slugs, count(*)::int AS receipts FROM persistence_requests r WHERE ${filtered}`);
  const [totals] = await exec.executeRaw<{ slugs: number; receipts: number }>(totalsRead.text, totalsRead.params);
  const { text, params } = renderFragment(sqlFragment`SELECT r.slug COLLATE "C" AS slug, count(*)::int AS receipts, count(*) FILTER (WHERE r.error_message=${query.driftMessage})::int AS drift_receipts,
        to_char(min(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_seen,
        to_char(max(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
        array_agg(DISTINCT (r.operation || COALESCE(':' || (r.intent->>'kind'), '')) COLLATE "C" ORDER BY (r.operation || COALESCE(':' || (r.intent->>'kind'), '')) COLLATE "C") AS producers,
        (array_agg(r.request_id::text ORDER BY r.sequence DESC))[1] AS last_request_id
      FROM persistence_requests r WHERE ${filtered} AND r.slug COLLATE "C" > ${query.after}
      GROUP BY r.slug COLLATE "C" ORDER BY r.slug COLLATE "C" LIMIT ${query.limit}`);
  const rows = await exec.executeRaw<DriftConflictGroupRow>(text, params);
  return { slugs: Number(totals?.slugs ?? 0), receipts: Number(totals?.receipts ?? 0), rows };
}

export async function readDriftConflictDetails(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[], opts: { paths: boolean }): Promise<DriftConflictDetails> {
  if (!slugs.length) return { committed: [], recorded: [] };
  // The newest committed receipt per slug, read through the slug intent index (receipts within retention).
  const committed = await exec.executeRaw<DriftConflictDetails['committed'][number]>(
    `SELECT DISTINCT ON (r.slug) r.slug, r.request_id::text, to_char(r.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_at
       FROM persistence_requests r WHERE r.source_id=$1 AND r.slug=ANY($2::text[]) AND r.intent IS NOT NULL AND NOT r.compacted AND r.state='committed'
      ORDER BY r.slug, r.sequence DESC`, [sourceId, [...slugs]]);
  const recorded = opts.paths ? await exec.executeRaw<DriftConflictDetails['recorded'][number]>(
    'SELECT slug, source_path, source_uri FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL', [sourceId, [...slugs]]) : [];
  return { committed, recorded };
}

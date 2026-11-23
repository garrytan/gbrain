/**
 * Doctor brain reads: the statements `gbrain doctor` checks (storage manifest, conversation archive, backup coverage, git
 * holds, connector checkpoints) ran through `executeRaw` over `pages`, `tags`, `facts`, `sources`, `op_checkpoints` and
 * `persistence_requests`, each with the same text and parameters, on the engine's own `executeRaw`; only their home
 * moved. PGLite and Postgres run these exact statements. The orphan-connector statement splices nothing:
 * `orphanPredicate(2)` of `connector-checkpoint-migration.ts` is inlined, and test/doctor-brain-sql.test.ts pins the
 * inlined text against it.
 *
 * The Rust engine answers each member in one of two ways (rust/docs/store/cli-reads-doctor-brain.md):
 *  - served from its store: the members that read pages, tags, facts and sources;
 *  - empty, no writer: git-hold, managed-sync and connector checkpoints are written only through `executeRaw`, which a
 *    Rust brain refuses, so no such row exists there. The Rust member answers the empty value (`0`, `[]`) in
 *    TypeScript without a store call, which is what the same read finds on a brain nothing has written to.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_BRAIN_MEMBERS: readonly string[] = [
  'listInterimStoredObjectCounts', 'readOldestSourceCreatedAt', 'listVisibilityCandidatePages',
  'countVisibilityNoncanonicalHolds', 'listContentBlockedReceipts', 'listPassAdmittedReceipts', 'listOrphanConnectorCheckpoints',
  'countReadersNoncanonicalHolds', 'listReaderCandidatePages',
];

/** A timestamp column as an engine returns it: a Date, or the text a driver without a timestamp codec gives. */
type Stamp = Date | string;

/** Live stored-object pages outside the shelf, per source, that no adoption tag marks. */
export interface InterimStoredObjectCount { source_id: string; n: number }
/** Live pages and active facts, and the brain's first source or page timestamp. */
/** A live page whose frontmatter carries a `visibility` key that is not the text `private`. */
export interface VisibilityCandidatePage { source_id: string; slug: string; frontmatter: Record<string, unknown> | string | null }
/** The failed request a blocked managed-sync cursor or pass waits on. */
export interface ContentBlockedReceipt { source_id: string; error_code: string | null; error_message: string | null; error_detail: unknown }
/** A connector checkpoint or retry row no source can load. */
export interface OrphanCheckpointRow { op: 'managed-connector' | 'managed-connector-retry'; fingerprint: string; updated_at: string }
/** The arguments of the orphan-connector read: the loadable keys, the migration start, the age floor in days, the row limit and the connector-state op. */
export interface OrphanConnectorCheckpointQuery { loadable: readonly string[]; before: string | null; minAgeDays: number | null; limit: number; stateOp: string }

const LIST_INTERIM_STORED_OBJECT_COUNTS_SQL = `
      SELECT p.source_id, count(*)::int AS n FROM pages p
      WHERE p.type = $1 AND p.source_id <> $2 AND left(p.slug, length($3)) = $3 AND p.slug <> $3 || 'index' AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag = $4)
      GROUP BY p.source_id ORDER BY p.source_id COLLATE "C"`;

const READ_OLDEST_SOURCE_CREATED_AT_SQL = 'SELECT min(created_at) AS created_at FROM sources';

const LIST_VISIBILITY_CANDIDATE_PAGES_SQL = `SELECT p.source_id, p.slug, p.frontmatter
    FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE AND ($1::text[] IS NULL OR p.source_id=ANY($1::text[])) AND jsonb_typeof(p.frontmatter)='object'
      AND EXISTS (SELECT 1 FROM jsonb_object_keys(p.frontmatter) k WHERE lower(k)='visibility') AND p.frontmatter->>'visibility' IS DISTINCT FROM 'private'
    ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"`;

const COUNT_VISIBILITY_NONCANONICAL_HOLDS_SQL = `SELECT count(*)::int AS n FROM op_checkpoints x
      JOIN sources s ON x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
    WHERE x.op=$1 AND x.completed_keys->0->>'code'='visibility_noncanonical' AND s.archived IS NOT TRUE AND ($2::text[] IS NULL OR s.id=ANY($2::text[]))`;

// moved from commands/doctor/checks/git-holds.ts readNoncanonicalReaders unchanged (its first statement)
const COUNT_READERS_NONCANONICAL_HOLDS_SQL = `SELECT count(*)::int AS n FROM op_checkpoints x
      JOIN sources s ON x.completed_keys->0->>'source_id'=s.id AND x.completed_keys->0->>'incarnation'=s.incarnation::text
    WHERE x.op=$1 AND x.completed_keys->0->>'code'='readers_noncanonical' AND s.archived IS NOT TRUE AND ($2::text[] IS NULL OR s.id=ANY($2::text[]))`;

// moved from commands/doctor/checks/git-holds.ts readNoncanonicalReaders unchanged (its second statement)
const LIST_READER_CANDIDATE_PAGES_SQL = `SELECT p.source_id, p.slug, p.frontmatter
    FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE AND ($1::text[] IS NULL OR p.source_id=ANY($1::text[])) AND jsonb_typeof(p.frontmatter)='object'
      AND EXISTS (SELECT 1 FROM jsonb_object_keys(p.frontmatter) k WHERE k<>'readable_by' AND regexp_replace(lower(k),'[-_[:space:]]+','','g')='readableby')
    ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C"`;

const LIST_CONTENT_BLOCKED_RECEIPTS_SQL = `SELECT c.completed_keys->0->>'sourceId' AS source_id,
      r.error_code, r.error_message, r.error_detail FROM op_checkpoints c JOIN persistence_requests r ON r.request_id::text = c.completed_keys->0->'pending'->>'requestId'
      AND r.source_id = c.completed_keys->0->>'sourceId'
    WHERE c.op = 'managed-sync' AND COALESCE(c.completed_keys->0->>'done','false') <> 'true' AND r.state IN ('failed','conflict','cancelled')
    ORDER BY (c.completed_keys->0->>'sourceId') COLLATE "C"`;

const LIST_PASS_ADMITTED_RECEIPTS_SQL = `SELECT source_id,
        error_code, error_message, error_detail FROM persistence_requests WHERE source_id=$1 AND intent->>'passId'=$2 AND state IN ('failed','conflict','cancelled')`;

const LIST_ORPHAN_CONNECTOR_CHECKPOINTS_SQL = `SELECT c.op, c.fingerprint, c.updated_at::text AS updated_at FROM op_checkpoints c
    WHERE c.op IN ('managed-connector','managed-connector-retry') AND (
      ((c.op='managed-connector' AND NOT (c.fingerprint = ANY($2::text[])))
        OR (c.op='managed-connector-retry' AND NOT (COALESCE(c.completed_keys->0->>'checkpointKey','') = ANY($2::text[]))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests r
        WHERE (r.state IN ('queued','deferred','running','recovering') OR r.recovery IS NOT NULL)
          AND (r.intent->>'kind' LIKE 'connector\\_v2\\_%' OR r.intent->>'kind' LIKE 'managed\\_connector\\_%')
          AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey'
            OR r.request_id::text = c.completed_keys->0->>'requestId'))
      AND NOT EXISTS (SELECT 1 FROM op_checkpoints s
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.completed_keys->0->'pending','[]'::jsonb)) p
        JOIN persistence_requests r ON r.request_id::text = p->>'requestId'
        WHERE s.op=$5 AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey'
          OR r.request_id::text = c.completed_keys->0->>'requestId'))
      AND ($3::text IS NULL OR c.updated_at <= $3::text::timestamptz)
      AND ($4::integer IS NULL OR c.updated_at < now() - make_interval(days => $4::integer)))
    ORDER BY c.op COLLATE "C", c.fingerprint COLLATE "C" LIMIT $1`;

/** Interim `stored-object` pages outside the shelf that carry no adoption tag, per source. */
export async function listInterimStoredObjectCounts(raw: EngineRawRead, type: string, shelfSourceId: string, prefix: string, adoptedTag: string): Promise<InterimStoredObjectCount[]> {
  return raw<InterimStoredObjectCount>(LIST_INTERIM_STORED_OBJECT_COUNTS_SQL, [type, shelfSourceId, prefix, adoptedTag]);
}

/** The earliest `created_at` of any source row, or null for a brain with no source. */
export async function readOldestSourceCreatedAt(raw: EngineRawRead): Promise<Stamp | null> {
  const [row] = await raw<{ created_at: Stamp | null }>(READ_OLDEST_SOURCE_CREATED_AT_SQL);
  return row?.created_at ?? null;
}

/** Live pages of non-archived sources whose frontmatter has a `visibility` key (any letter case) that is not `private`. */
export async function listVisibilityCandidatePages(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<VisibilityCandidatePage[]> {
  return raw<VisibilityCandidatePage>(LIST_VISIBILITY_CANDIDATE_PAGES_SQL, [sourceIds ? [...sourceIds] : null]);
}

/** Held files of non-archived sources that a git hold of `holdOp` records as `visibility_noncanonical`. */
export async function countVisibilityNoncanonicalHolds(raw: EngineRawRead, holdOp: string, sourceIds: readonly string[] | null): Promise<number> {
  const [row] = await raw<{ n: number | string }>(COUNT_VISIBILITY_NONCANONICAL_HOLDS_SQL, [holdOp, sourceIds ? [...sourceIds] : null]);
  return Number(row?.n ?? 0);
}

/** Held files of non-archived sources that a git hold of `holdOp` records as `readers_noncanonical`. */
export async function countReadersNoncanonicalHolds(raw: EngineRawRead, holdOp: string, sourceIds: readonly string[] | null): Promise<number> {
  const [row] = await raw<{ n: number | string }>(COUNT_READERS_NONCANONICAL_HOLDS_SQL, [holdOp, sourceIds ? [...sourceIds] : null]);
  return Number(row?.n ?? 0);
}

/** Live pages of non-archived sources whose frontmatter has a key other than `readable_by` that reads `readableby` once separators are dropped. */
export async function listReaderCandidatePages(raw: EngineRawRead, sourceIds: readonly string[] | null): Promise<VisibilityCandidatePage[]> {
  return raw<VisibilityCandidatePage>(LIST_READER_CANDIDATE_PAGES_SQL, [sourceIds ? [...sourceIds] : null]);
}

/** The failed, conflicted or cancelled receipts that unfinished managed-sync cursors wait on. */
export async function listContentBlockedReceipts(raw: EngineRawRead): Promise<ContentBlockedReceipt[]> {
  return raw<ContentBlockedReceipt>(LIST_CONTENT_BLOCKED_RECEIPTS_SQL);
}

/** The failed, conflicted or cancelled receipts a source's pass admitted (the receipt intent carries the pass id). */
export async function listPassAdmittedReceipts(raw: EngineRawRead, sourceId: string, passId: string): Promise<ContentBlockedReceipt[]> {
  return raw<ContentBlockedReceipt>(LIST_PASS_ADMITTED_RECEIPTS_SQL, [sourceId, passId]);
}

/** Checkpoint and retry rows no source can load (`before` bounds `updated_at`; `minAgeDays` adds the age floor). */
export async function listOrphanConnectorCheckpoints(raw: EngineRawRead, query: OrphanConnectorCheckpointQuery): Promise<OrphanCheckpointRow[]> {
  return raw<OrphanCheckpointRow>(LIST_ORPHAN_CONNECTOR_CHECKPOINTS_SQL, [query.limit, [...query.loadable], query.before, query.minAgeDays, query.stateOp]);
}

/** The statements, for the test that pins them to the text their readers composed. */
export const DOCTOR_BRAIN_STATEMENTS = {
  interimStoredObjects: LIST_INTERIM_STORED_OBJECT_COUNTS_SQL, oldestSource: READ_OLDEST_SOURCE_CREATED_AT_SQL,
  visibilityCandidates: LIST_VISIBILITY_CANDIDATE_PAGES_SQL, noncanonicalHolds: COUNT_VISIBILITY_NONCANONICAL_HOLDS_SQL,
  contentBlockedReceipts: LIST_CONTENT_BLOCKED_RECEIPTS_SQL, passAdmittedReceipts: LIST_PASS_ADMITTED_RECEIPTS_SQL, orphanConnectorCheckpoints: LIST_ORPHAN_CONNECTOR_CHECKPOINTS_SQL,
} as const;

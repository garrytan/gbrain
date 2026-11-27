/**
 * Doctor reads, second set: the statements doctor checks and the repairs they share (privacy labels, safe-chunk index,
 * credential re-seal, schema packs, derived visibility, segmented bodies, timeline history, atom fences and retirements,
 * embedding backlog and budget holds, extraction receipts, derived generations, ontology facts, atom provenance, the
 * extract rollup) ran through `executeRaw`. Each function runs the statement its caller ran, with the same text and
 * parameters, on the engine's own `executeRaw` and returns the rows unchanged; only its home moved
 * (src/commands/doctor/**, src/core/**). Doctor output on PGLite and Postgres does not change. Every statement is one
 * constant (pinned against its old composer by test/doctor-derived-sql.test.ts); the one open name is an embedding
 * column, put in by `withEmbeddingColumn` from a registry-checked name.
 *
 * The Rust engine answers the same members from its store (rust/crates/gbrain-store/src/cli_reads/doctor_derived.rs,
 * doctor_derived_health.rs and doctor_derived_ledgers.rs, rust/docs/store/cli-reads-doctor-derived.md). Two answers, per member:
 *  - served from the store's records;
 *  - the empty answer where the store keeps no writer for the relation at all (`page_embedding_budget`,
 *    `derived_generations`, `derived_generation_items`, `derived_generation_activations`,
 *    `belief_events`, `extract_rollup_7d` never get a row on a Rust brain), so the empty answer is the true one.
 * No member is left to refuse with `engine_capability_missing`.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement a doctor check (or a repair it shares) ran through its
 * deadline-bound executeRaw, so src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_DERIVED_MEMBERS: readonly string[] = [
  'readIgnoredPrivacyLabelCounts', 'countSafeIndexPending', 'countCredentialProjectionPending', 'countPagesByTypeAndOwner',
  'listRecordedTombstones', 'countDerivedVisibility', 'listUntiledSegmentedPageRows', 'listTimelineHistoryBatch',
  'listAtomFenceCandidates', 'readPageCompiledTruths', 'readEmbeddingBacklogAge', 'readEmbedBacklogRows', 'listBudgetLimitedRows', 'readBudgetHoldAge',
  'listImageAssetFiles', 'listAmbiguousExtractionInputs', 'listExtractionInputReceipts', 'listUnpricedDerivationModels',
  'listRestorableAtomRetirements', 'countLedgerCoveredAtomRetirements', 'listLiveGenerationRetirements', 'listHeldGenerations',
  'listOrphanGenerationCandidates', 'listOntologyFactCandidates', 'readAtomProvenanceCounts',
  'readExtractRollup7d', 'listRecordedHaltReasons7d', 'listBodyRecheckGroups', 'readBodyRecheckPage', 'listBodyRecheckVersions',
];

/** The `content_chunks` vector column name `withEmbeddingColumn` puts in: a registry-resolved or COLUMN_NAME_REGEX-checked name. */
const COLUMN_NAME = /^[a-z_][a-z0-9_]*$/;

/** One constant statement with its `"__COL__"` marker replaced by the quoted embedding column (a vetted builder of the dynamic-SQL guard). */
export function withEmbeddingColumn(sql: string, column: string): string {
  if (!COLUMN_NAME.test(column)) throw new Error(`'${column}' is not an embedding column name`);
  return sql.replaceAll('"__COL__"', `"${column}"`);
}

// ---- privacy_label_ignored -------------------------------------------------------------------------------------

export interface IgnoredPrivacyLabelRow { key: string; raw: string; is_string: boolean; pages: number; scanned: number; groups: number }

const PRIVACY_LABEL_SQL = `WITH hits AS (SELECT p.frontmatter FROM pages p
          WHERE p.deleted_at IS NULL 
            AND (p.frontmatter ? 'access' OR p.frontmatter ? 'confidentiality') AND (p.frontmatter->>'visibility' IS NULL AND NOT (COALESCE(translate(btrim(p.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(p.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false))
    AND p.frontmatter->>'pinned_question' IS NULL AND COALESCE(p.type, '') NOT IN ('atom', 'question')
    AND NOT (p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)
    AND NOT (p.type = 'event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')
    AND p.frontmatter->>'derived_from' IS NULL AND p.frontmatter->>'source_slug' IS NULL
    AND (NULLIF(btrim(p.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL OR NULLIF(btrim(p.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL))
          LIMIT 100001)
       SELECT l.key, l.raw, l.is_string, count(*)::int AS pages, (SELECT count(*)::int FROM hits) AS scanned, (count(*) OVER ())::int AS groups
       FROM hits p CROSS JOIN LATERAL (VALUES ('access', p.frontmatter->>'access', jsonb_typeof(p.frontmatter->'access') = 'string'), ('confidentiality', p.frontmatter->>'confidentiality', jsonb_typeof(p.frontmatter->'confidentiality') = 'string')) AS l(key, raw, is_string)
       WHERE NULLIF(btrim(l.raw, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL
       GROUP BY l.key, l.raw, l.is_string
       ORDER BY pages DESC, l.key COLLATE "C", l.raw COLLATE "C", l.is_string
       LIMIT 50`;
const PRIVACY_LABEL_SCOPED_SQL = `WITH hits AS (SELECT p.frontmatter FROM pages p
          WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[])
            AND (p.frontmatter ? 'access' OR p.frontmatter ? 'confidentiality') AND (p.frontmatter->>'visibility' IS NULL AND NOT (COALESCE(translate(btrim(p.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(p.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false))
    AND p.frontmatter->>'pinned_question' IS NULL AND COALESCE(p.type, '') NOT IN ('atom', 'question')
    AND NOT (p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)
    AND NOT (p.type = 'event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')
    AND p.frontmatter->>'derived_from' IS NULL AND p.frontmatter->>'source_slug' IS NULL
    AND (NULLIF(btrim(p.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL OR NULLIF(btrim(p.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL))
          LIMIT 100001)
       SELECT l.key, l.raw, l.is_string, count(*)::int AS pages, (SELECT count(*)::int FROM hits) AS scanned, (count(*) OVER ())::int AS groups
       FROM hits p CROSS JOIN LATERAL (VALUES ('access', p.frontmatter->>'access', jsonb_typeof(p.frontmatter->'access') = 'string'), ('confidentiality', p.frontmatter->>'confidentiality', jsonb_typeof(p.frontmatter->'confidentiality') = 'string')) AS l(key, raw, is_string)
       WHERE NULLIF(btrim(l.raw, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL
       GROUP BY l.key, l.raw, l.is_string
       ORDER BY pages DESC, l.key COLLATE "C", l.raw COLLATE "C", l.is_string
       LIMIT 50`;

/** The ignored-privacy-label values of live pages by key (at most 50), scanning at most 100001 pages; `sourceIds` narrows it. */
export function readIgnoredPrivacyLabelCounts(raw: EngineRawRead, opts: { sourceIds?: string[]; timeoutMs: number }): Promise<IgnoredPrivacyLabelRow[]> {
  return opts.sourceIds
    ? raw<IgnoredPrivacyLabelRow>(PRIVACY_LABEL_SCOPED_SQL, [opts.sourceIds], { timeoutMs: opts.timeoutMs })
    : raw<IgnoredPrivacyLabelRow>(PRIVACY_LABEL_SQL, [], { timeoutMs: opts.timeoutMs });
}

// ---- safe_index_pending, credential re-seal --------------------------------------------------------------------

/** Live pages of unarchived sources that a repair can rebuild (`rebuildable`) and the ones it keeps (`kept`). */
export interface RebuildableCounts { rebuildable: number; kept: number }

const SAFE_INDEX_SQL = `SELECT
        COUNT(*) FILTER (WHERE p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL))::int AS rebuildable,
        COUNT(*) FILTER (WHERE NOT (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)))::int AS kept
      FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
      WHERE p.deleted_at IS NULL AND p.chunker_version < 4 `;
const SAFE_INDEX_SCOPED_SQL = `SELECT
        COUNT(*) FILTER (WHERE p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL))::int AS rebuildable,
        COUNT(*) FILTER (WHERE NOT (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)))::int AS kept
      FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
      WHERE p.deleted_at IS NULL AND p.chunker_version < 4 AND p.source_id=ANY($1::text[])`;

/** Pages chunked below the safe-chunk fence, in unarchived sources (`sourceIds` narrows it). */
export async function countSafeIndexPending(raw: EngineRawRead, sourceIds?: string[]): Promise<RebuildableCounts> {
  const [row] = await raw<RebuildableCounts>(sourceIds ? SAFE_INDEX_SCOPED_SQL : SAFE_INDEX_SQL, sourceIds ? [sourceIds] : []);
  return { rebuildable: Number(row?.rebuildable ?? 0), kept: Number(row?.kept ?? 0) };
}

const CREDENTIAL_PENDING_SQL = `SELECT
      COUNT(*) FILTER (WHERE (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)))::int AS rebuildable,
      COUNT(*) FILTER (WHERE NOT (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)))::int AS kept
    FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
    WHERE p.deleted_at IS NULL AND p.page_kind IN ('markdown','code')
  AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
  AND (p.compiled_truth ~ '-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----' OR COALESCE(p.timeline,'') ~ '-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----' OR (p.body_storage='segmented' AND EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL
    AND m.protected_regions @> '[{"kind":"pem"}]'::jsonb))) `;
const CREDENTIAL_PENDING_SCOPED_SQL = `SELECT
      COUNT(*) FILTER (WHERE (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)))::int AS rebuildable,
      COUNT(*) FILTER (WHERE NOT (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)))::int AS kept
    FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
    WHERE p.deleted_at IS NULL AND p.page_kind IN ('markdown','code')
  AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
  AND (p.compiled_truth ~ '-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----' OR COALESCE(p.timeline,'') ~ '-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----' OR (p.body_storage='segmented' AND EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL
    AND m.protected_regions @> '[{"kind":"pem"}]'::jsonb))) AND p.source_id=ANY($1::text[])`;

/** Pages whose text projection is behind and whose body holds a private key block, in unarchived sources (`sourceIds` narrows it). */
export async function countCredentialProjectionPending(raw: EngineRawRead, sourceIds?: string[]): Promise<RebuildableCounts> {
  const [row] = await raw<RebuildableCounts>(sourceIds ? CREDENTIAL_PENDING_SCOPED_SQL : CREDENTIAL_PENDING_SQL, sourceIds ? [sourceIds] : []);
  return { rebuildable: Number(row?.rebuildable ?? 0), kept: Number(row?.kept ?? 0) };
}

// ---- schema_pack_consistency -----------------------------------------------------------------------------------

export interface PageTypeOwnerRow { src: string; type: string | null; own: boolean; n: string }

const PAGE_TYPE_OWNER_SQL = `SELECT COALESCE(p.source_id, 'default') AS src, p.type, ((p.type = 'code' AND p.page_kind = 'code') OR (p.type = 'extract_receipt' AND p.slug LIKE 'extracts/%' AND p.frontmatter->>'dream_generated' = 'true')) AS own, COUNT(*)::text AS n
         FROM pages p
        WHERE p.deleted_at IS NULL
        GROUP BY p.source_id, p.type, own
        ORDER BY p.source_id COLLATE "C"`;
const PAGE_TYPE_OWNER_SCOPED_SQL = `SELECT COALESCE(p.source_id, 'default') AS src, p.type, ((p.type = 'code' AND p.page_kind = 'code') OR (p.type = 'extract_receipt' AND p.slug LIKE 'extracts/%' AND p.frontmatter->>'dream_generated' = 'true')) AS own, COUNT(*)::text AS n
         FROM pages p
        WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[])
        GROUP BY p.source_id, p.type, own
        ORDER BY p.source_id COLLATE "C"`;

/** Live pages per source and stored type, split by whether gbrain's own writers wrote them (`n` is text). */
export function countPagesByTypeAndOwner(raw: EngineRawRead, sourceIds?: string[]): Promise<PageTypeOwnerRow[]> {
  return raw<PageTypeOwnerRow>(sourceIds ? PAGE_TYPE_OWNER_SCOPED_SQL : PAGE_TYPE_OWNER_SQL, sourceIds ? [sourceIds] : []);
}

// ---- purge-deleted (belief ledger expiry) ------------------------------------------------------------------------

export interface RecordedTombstoneRow { id: number; source_id: string; slug: string; deleted_us: string }

const RECORDED_TOMBSTONES_SQL = `SELECT p.id, p.source_id, p.slug,
      floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text AS deleted_us FROM pages p
    WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - ($1 || ' hours')::interval AND NOT EXISTS (SELECT 1 FROM op_checkpoints dg WHERE dg.op = 'sync-identity-downgrade' AND dg.fingerprint = p.id::text
    AND dg.completed_keys->0->>'disposition' IS NULL AND p.deleted_at = (dg.completed_keys->0->>'old_deleted_at')::timestamptz) AND NOT (p.type='atom' AND p.frontmatter->>'retired_by'='managed-reextract'
    AND p.deleted_at > now() - interval '30 days'
    AND p.id IN (SELECT held.id FROM (WITH retired AS (
      SELECT p.id, p.source_id, p.slug, CASE WHEN NULLIF(p.frontmatter->>'source_slug','') IS NOT NULL THEN 'slug:'||(p.frontmatter->>'source_slug')
      WHEN NULLIF(p.frontmatter->>'source_path','') IS NOT NULL THEN 'path:'||(p.frontmatter->>'source_path') END AS okey, NULLIF(p.frontmatter->>'source_slug','') AS origin_slug,
             COALESCE(NULLIF(p.frontmatter->>'source_slug',''), p.frontmatter->>'source_path') AS origin,
             regexp_replace(COALESCE(p.frontmatter->>'source_hash',''),'^pending:','') AS hash, p.frontmatter->>'retired_at' AS retired_at
        FROM pages p
       WHERE p.type='atom' AND p.deleted_at IS NOT NULL AND p.frontmatter->>'retired_by'='managed-reextract' AND NULLIF(p.frontmatter->>'imported_from','') IS NULL
         AND (true)
    ), latest AS (
      SELECT DISTINCT ON (source_id, okey) source_id, okey, hash FROM retired WHERE okey IS NOT NULL
       ORDER BY source_id, okey, retired_at COLLATE "C" DESC NULLS LAST, id DESC
    ), live AS (
      SELECT p.source_id, CASE WHEN NULLIF(p.frontmatter->>'source_slug','') IS NOT NULL THEN 'slug:'||(p.frontmatter->>'source_slug')
      WHEN NULLIF(p.frontmatter->>'source_path','') IS NOT NULL THEN 'path:'||(p.frontmatter->>'source_path') END AS okey, array_agg(DISTINCT regexp_replace(COALESCE(p.frontmatter->>'source_hash',''),'^pending:','')) AS hashes
        FROM pages p WHERE p.type='atom' AND p.deleted_at IS NULL AND NULLIF(p.frontmatter->>'imported_from','') IS NULL AND (true)
       GROUP BY 1, 2
    )
    SELECT r.id, r.source_id, r.slug, CASE WHEN r.origin_slug IS NOT NULL THEN 'page' ELSE 'transcript' END AS origin_kind, r.origin,
           o.id AS origin_page_id, r.hash, r.retired_at,
           (r.okey IS NOT NULL AND (r.origin_slug IS NULL OR o.id IS NOT NULL)) AS origin_live,
           (lv.hashes IS NOT NULL AND NOT (lv.hashes <@ ARRAY[r.hash])) AS replaced,
           COALESCE(l.hash = r.hash, false) AS latest,
           (r.okey IS NOT NULL AND (r.origin_slug IS NULL OR o.id IS NOT NULL) AND NOT COALESCE(lv.hashes IS NOT NULL AND NOT (lv.hashes <@ ARRAY[r.hash]), false)
             AND COALESCE(l.hash = r.hash, false)) AS restorable,
           (SELECT g.id FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
             WHERE g.source_id=r.source_id AND g.kind='atom' AND g.state='live' AND i.item_key=r.slug AND i.action='retired' ORDER BY g.id DESC LIMIT 1) AS ledger_generation
      FROM retired r
      LEFT JOIN pages o ON o.source_id=r.source_id AND o.slug=r.origin_slug AND o.deleted_at IS NULL
      LEFT JOIN live lv ON lv.source_id=r.source_id AND lv.okey=r.okey
      LEFT JOIN latest l ON l.source_id=r.source_id AND l.okey=r.okey) held WHERE held.restorable)) AND NOT (COALESCE(p.frontmatter->>'retired_by','') IN ('extract-atoms','managed-reextract','stale-atoms','life-chronicle','generation-restore','synthesis-resynthesis','synthesis-cleanup')
    AND p.deleted_at > now() - interval '1 day' * (SELECT COALESCE(MAX(CASE WHEN c.value ~ '^[0-9]{1,3}$' THEN CASE WHEN c.value::int BETWEEN 3 AND 365
  THEN c.value::int END END), 30) FROM config c WHERE c.key = 'generations.restore_days')) AND (NOT EXISTS (SELECT 1 FROM op_checkpoints dop WHERE dop.op = 'derived-origin-park' AND dop.fingerprint = p.id::text) OR p.id = ANY($2::int[]))
      AND EXISTS (SELECT 1 FROM belief_events e WHERE e.source_id = p.source_id AND e.subject_kind = 'coverage')
    ORDER BY p.deleted_at ASC, p.source_id COLLATE "C" ASC, p.slug COLLATE "C" ASC`;

/** Expired tombstones of a source the belief ledger records, in scan order (`hours` is the retention text, `released` the origins to purge anyway). */
export function listRecordedTombstones(raw: EngineRawRead, hours: string, released: readonly number[]): Promise<RecordedTombstoneRow[]> {
  return raw<RecordedTombstoneRow>(RECORDED_TOMBSTONES_SQL, [hours, [...released]]);
}

// ---- derived_visibility ----------------------------------------------------------------------------------------

export interface DerivedVisibilityCounts {
  unstamped_atoms: number; unstamped_concepts: number; looser_atoms: number; looser_concepts: number; looser_events: number;
  alias_pages_without_visibility: number;
}

const DERIVED_VISIBILITY_SQL = `WITH derived AS (
         SELECT p.* FROM pages p WHERE p.deleted_at IS NULL AND p.source_id=ANY($1::text[])
           AND (p.type='atom' OR (p.type='concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)
             OR (p.type='event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')))
       SELECT
         COUNT(*) FILTER (WHERE d.type='atom' AND d.frontmatter->>'visibility' IS NULL)::int AS unstamped_atoms,
         COUNT(*) FILTER (WHERE d.type='concept' AND d.frontmatter->>'visibility' IS NULL)::int AS unstamped_concepts,
         COUNT(*) FILTER (WHERE d.type='atom' AND d.frontmatter->>'visibility'='world' AND (NOT EXISTS (SELECT 1 FROM pages o
           WHERE o.source_id=d.source_id AND o.slug=COALESCE(CASE WHEN NOT EXISTS (SELECT 1 FROM pages live_origin WHERE live_origin.source_id=d.source_id
      AND live_origin.slug=(d.frontmatter->>'source_slug')) THEN (SELECT renamed.canonical_slug FROM slug_aliases renamed
    WHERE renamed.source_id=d.source_id AND renamed.alias_slug=(d.frontmatter->>'source_slug') AND renamed.notes='rename') END, (d.frontmatter->>'source_slug')) AND o.deleted_at IS NULL
             AND (COALESCE(o.frontmatter->>'visibility', CASE WHEN (o.type IN ('atom', 'question') OR (o.type = 'concept' AND o.frontmatter->>'synthesized_by' IS NOT NULL)) THEN 'private' ELSE 'world' END) <> 'private'
    AND NOT COALESCE(o.frontmatter ? 'pinned_question', false)
    AND NOT (o.frontmatter->>'visibility' IS NULL AND (COALESCE(translate(btrim(o.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(o.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false)))) AND NOT (o.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(o.source_id, o.slug) OR (SELECT gbrain_access_state_unreadable()))) OR EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ON moved_to.source_id=moved.source_id
    AND moved_to.slug=moved.new_slug WHERE moved.source_id=d.source_id AND moved.old_slug=(d.frontmatter->>'source_slug')
    AND moved_to.frontmatter->>'visibility'='private')))::int AS looser_atoms,
         COUNT(*) FILTER (WHERE d.type='concept' AND d.frontmatter->>'visibility'='world' AND EXISTS (SELECT 1 FROM links l
           JOIN pages a ON a.id=l.to_page_id WHERE l.from_page_id=d.id AND l.link_source='concept-provenance' AND l.link_type='synthesized_from'
             AND (COALESCE(a.frontmatter->>'visibility','private')='private' OR EXISTS (SELECT 1 FROM pages ao WHERE ao.source_id=a.source_id
               AND ao.slug=ANY(ARRAY[(a.frontmatter->>'source_slug'), (SELECT renamed.canonical_slug FROM slug_aliases renamed
    WHERE renamed.source_id=a.source_id AND renamed.alias_slug=(a.frontmatter->>'source_slug') AND renamed.notes='rename')]) AND (ao.frontmatter->>'visibility'='private' OR (ao.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(ao.source_id, ao.slug) OR (SELECT gbrain_access_state_unreadable())))) OR EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ON moved_to.source_id=moved.source_id
    AND moved_to.slug=moved.new_slug WHERE moved.source_id=a.source_id AND moved.old_slug=(a.frontmatter->>'source_slug')
    AND moved_to.frontmatter->>'visibility'='private'))))::int AS looser_concepts,
         COUNT(*) FILTER (WHERE d.type='event' AND COALESCE(d.frontmatter->>'visibility','world')<>'private' AND EXISTS (SELECT 1 FROM pages o
           WHERE o.source_id=d.source_id AND o.slug=d.frontmatter->'event'->>'depth' AND o.deleted_at IS NULL
             AND (NOT (COALESCE(o.frontmatter->>'visibility', CASE WHEN (o.type IN ('atom', 'question') OR (o.type = 'concept' AND o.frontmatter->>'synthesized_by' IS NOT NULL)) THEN 'private' ELSE 'world' END) <> 'private'
    AND NOT COALESCE(o.frontmatter ? 'pinned_question', false)
    AND NOT (o.frontmatter->>'visibility' IS NULL AND (COALESCE(translate(btrim(o.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(o.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false)))) OR (COALESCE(translate(btrim(o.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(o.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false)) OR (o.frontmatter ? 'readable_by') OR (o.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(o.source_id, o.slug) OR (SELECT gbrain_access_state_unreadable())))))::int AS looser_events,
         (SELECT COUNT(*)::int FROM pages ap WHERE (ap.deleted_at IS NULL AND ap.frontmatter->>'visibility' IS NULL AND (COALESCE(translate(btrim(ap.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(ap.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false))
    AND ap.type <> 'atom' AND NOT (ap.type = 'concept' AND ap.frontmatter->>'synthesized_by' IS NOT NULL)
    AND NOT (ap.type = 'event' AND ap.frontmatter->>'captured_via' LIKE 'life-chronicle:%')) AND ap.source_id=ANY($1::text[])) AS alias_pages_without_visibility
       FROM derived d`;

/** The derived-page visibility counts of `sourceIds`, under a statement deadline. */
export async function countDerivedVisibility(raw: EngineRawRead, sourceIds: string[], timeoutMs: number): Promise<DerivedVisibilityCounts> {
  const rows = await raw<DerivedVisibilityCounts>(DERIVED_VISIBILITY_SQL, [sourceIds], { timeoutMs });
  return rows[0]!;
}

// ---- body tiling, timeline history, atom fences ------------------------------------------------------------------

export interface UntiledPageRow {
  id: number; source_id: string; slug: string; revision: string; body_generation: unknown; body_bytes: unknown;
  segment_count: number | null; source_path: string | null; n: unknown; covered: unknown; gapless: boolean;
}

const UNTILED_SQL = `SELECT p.id, p.source_id, p.slug, p.knowledge_revision::text AS revision, p.body_generation, p.body_bytes, p.segment_count, p.source_path, t.n, t.covered, t.gapless
       FROM pages p JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE CROSS JOIN LATERAL (SELECT count(*)::bigint AS n, COALESCE(sum(r.byte_len), 0)::bigint AS covered, COALESCE(bool_and(r.byte_start = r.prior), true) AS gapless
      FROM (SELECT m.byte_start, m.byte_len, COALESCE(sum(m.byte_len) OVER (ORDER BY m.seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior
              FROM page_body_manifest m WHERE m.page_id = p.id AND m.staging_id IS NULL AND m.gen_from <= p.body_generation
               AND (m.gen_to IS NULL OR m.gen_to > p.body_generation)) r) t
      WHERE p.body_storage = 'segmented' AND p.deleted_at IS NULL AND ($1::text[] IS NULL OR p.source_id = ANY($1::text[]))
        AND ($2::text[] IS NULL OR p.slug = ANY($2::text[])) AND (NOT t.gapless OR t.covered <> p.body_bytes)
      ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C" LIMIT $3`;

/** Live segmented pages of unarchived sources whose live generation's rows do not tile the body (ordered by source and slug). */
export function listUntiledSegmentedPageRows(raw: EngineRawRead, sourceIds: readonly string[] | null, slugs: readonly string[] | null, limit: number): Promise<UntiledPageRow[]> {
  return raw<UntiledPageRow>(UNTILED_SQL, [sourceIds ? [...sourceIds] : null, slugs ? [...slugs] : null, limit]);
}

export interface TimelineHistoryPageRow { id: number; source_id: string; slug: string; compiled_truth: string; timeline: string | null }

const TIMELINE_BATCH_SQL = `SELECT p.id,p.source_id,p.slug,p.compiled_truth,p.timeline FROM pages p
      WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.id>$2 AND p.body_storage='inline'
        AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id=p.id AND t.event_page_id IS NULL)
      ORDER BY p.id LIMIT 200`;

/** The next 200 inline pages after `afterId` (id order) carrying a timeline row no event page owns. */
export function listTimelineHistoryBatch(raw: EngineRawRead, sourceIds: string[], afterId: number): Promise<TimelineHistoryPageRow[]> {
  return raw<TimelineHistoryPageRow>(TIMELINE_BATCH_SQL, [sourceIds, afterId]);
}

export interface AtomFenceCandidateRow {
  id: number; source_id: string; slug: string; revision: string; text: string; origin_id: number; origin_slug: string;
  origin_hash: string | null; origin_unread: boolean;
}

const ATOM_FENCE_SQL = `SELECT a.id, a.source_id, a.slug, a.knowledge_revision::text AS revision,
              concat_ws(E'\\n', a.title, a.compiled_truth, a.frontmatter->>'source_quote') AS text,
              o.id AS origin_id, o.slug AS origin_slug, o.content_hash AS origin_hash, o.compiled_truth IS NULL AS origin_unread
         FROM pages a
         JOIN pages o ON o.source_id=a.source_id AND o.slug=a.frontmatter->>'source_slug' AND o.deleted_at IS NULL
        WHERE a.source_id=ANY($1::text[]) AND a.type='atom' AND a.deleted_at IS NULL AND a.frontmatter->>'visibility'='world'
          AND ($2::int IS NULL OR a.id=$2::int) AND a.id>$3
          AND (o.compiled_truth IS NULL OR strpos(o.compiled_truth, 'gbrain:facts:begin')>0 OR strpos(o.compiled_truth, 'gbrain:takes:begin')>0)
        ORDER BY a.id LIMIT $4`;
const PAGE_COMPILED_TRUTHS_SQL = 'SELECT id, compiled_truth AS body FROM pages WHERE id=ANY($1::int[])';

/** One keyset batch of world atoms whose source page names a facts or takes fence (`atomId` narrows it to one atom). */
export function listAtomFenceCandidates(raw: EngineRawRead, opts: { sourceIds: string[]; atomId: number | null; after: number; limit: number; timeoutMs?: number }): Promise<AtomFenceCandidateRow[]> {
  return raw<AtomFenceCandidateRow>(ATOM_FENCE_SQL, [opts.sourceIds, opts.atomId, opts.after, opts.limit], opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined);
}

/** The compiled text of pages by id (null for a page whose text is not stored inline). */
export function readPageCompiledTruths(raw: EngineRawRead, ids: number[], timeoutMs?: number): Promise<Array<{ id: number; body: string | null }>> {
  return raw<{ id: number; body: string | null }>(PAGE_COMPILED_TRUTHS_SQL, [ids], timeoutMs ? { timeoutMs } : undefined);
}

// ---- embedding backlog and budget holds --------------------------------------------------------------------------

export interface EmbeddingBacklogAgeRow { age_s: number | null; unaged: number; backfilled: boolean | null }

// chunk-visibility-ok: doctor embeddings backlog age moved verbatim from doctor/checks/schema-health.ts; it reads every live chunk row with no vector, as before
const BACKLOG_AGE_SQL = `SELECT EXTRACT(EPOCH FROM now() - min(cc.embedding_pending_since))::float8 AS age_s,
              count(*) FILTER (WHERE cc.embedding_pending_since IS NULL)::int AS unaged,
              min(cc.embedding_pending_since) <= (SELECT value::timestamptz FROM config
                WHERE key = 'embedding_pending_since_backfilled_at') AS backfilled
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE cc."__COL__" IS NULL AND p.deleted_at IS NULL
          AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')`;

/** Age of the oldest live chunk with no vector in `column`, how many such chunks carry no pending-since stamp, and whether the oldest predates the backfill. */
export async function readEmbeddingBacklogAge(raw: EngineRawRead, column: string): Promise<EmbeddingBacklogAgeRow | undefined> {
  const [row] = await raw<EmbeddingBacklogAgeRow>(withEmbeddingColumn(BACKLOG_AGE_SQL, column));
  return row;
}

export interface EmbedBacklogRow { source_id: string; pending: number; unaged: number; oldest: Date | string | null }

// chunk-visibility-ok: the chunkGenerationFilter('p', 'cc') predicate is inlined as literal text (check:engine-sql-dynamic forbids composed SQL), moved verbatim from sync-pending.ts readEmbedBacklog
const EMBED_BACKLOG_ROWS_SQL = `SELECT p.source_id, count(*)::int AS pending, count(*) FILTER (WHERE cc.embedding_pending_since IS NULL)::int AS unaged,
            min(cc.embedding_pending_since) AS oldest
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc."__COL__" IS NULL AND p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND ((cc.body_generation IS NULL AND p.body_storage <> 'segmented')
       OR (cc.body_generation <= p.body_generation
           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = cc.page_id AND lm.occurrence_id = cc.occurrence_id
             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation))))
        AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')
      GROUP BY p.source_id`;

/**
 * Per source among `sourceIds`: the live-body chunks of live pages (not `embed_skip`) with no vector in `column`, how
 * many of them carry no pending-since stamp, and the oldest stamp (`gbrain sync` pending and the doctor's managed-sync
 * latency). A source with no such chunk has no row.
 */
export async function readEmbedBacklogRows(raw: EngineRawRead, column: string, sourceIds: string[]): Promise<EmbedBacklogRow[]> {
  return raw<EmbedBacklogRow>(withEmbeddingColumn(EMBED_BACKLOG_ROWS_SQL, column), [sourceIds]);
}

export interface BudgetLimitedRow { source_id: string; state: 'held' | 'capped'; reason: string; pages: number; chunks: number; chars: number }

// chunk-visibility-ok: the chunkGenerationFilter('p', 'cc') predicate is inlined as literal text (check:engine-sql-dynamic forbids composed SQL), moved from held-embedding.ts
const BUDGET_LIMITED_SQL = `SELECT p.source_id, b.state, COALESCE(b.reason, 'awaiting_approval') AS reason, count(*)::int AS pages,
            sum(w.chunks)::bigint AS chunks, sum(w.chars)::bigint AS chars
       FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id
       CROSS JOIN LATERAL (SELECT count(*)::int AS chunks, COALESCE(sum(length(cc.chunk_text)), 0)::bigint AS chars
         FROM content_chunks cc WHERE cc.page_id = p.id AND ((cc.body_generation IS NULL AND p.body_storage <> 'segmented')
       OR (cc.body_generation <= p.body_generation
           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = cc.page_id AND lm.occurrence_id = cc.occurrence_id
             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation)))) AND (cc."__COL__" IS NULL OR (p.body_storage IS DISTINCT FROM 'segmented' AND cc.embedded_at IS NULL)
      OR ($1::text IS NOT NULL AND p.embedding_signature IS NOT NULL AND p.embedding_signature <> $1::text))) w
      WHERE b.state <> 'open' AND ((CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END) > 1048576 OR b.reason IN ('archive_backfill', 'archive_open_day', 'call_import')) AND p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND w.chunks > 0
      GROUP BY 1, 2, 3 ORDER BY p.source_id COLLATE "C", b.state COLLATE "C", COALESCE(b.reason, 'awaiting_approval') COLLATE "C"`;
// chunk-visibility-ok: the chunkGenerationFilter('p', 'cc') predicate is inlined as literal text (check:engine-sql-dynamic forbids composed SQL), moved from held-embedding.ts
const BUDGET_LIMITED_SOURCE_SQL = `SELECT p.source_id, b.state, COALESCE(b.reason, 'awaiting_approval') AS reason, count(*)::int AS pages,
            sum(w.chunks)::bigint AS chunks, sum(w.chars)::bigint AS chars
       FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id
       CROSS JOIN LATERAL (SELECT count(*)::int AS chunks, COALESCE(sum(length(cc.chunk_text)), 0)::bigint AS chars
         FROM content_chunks cc WHERE cc.page_id = p.id AND ((cc.body_generation IS NULL AND p.body_storage <> 'segmented')
       OR (cc.body_generation <= p.body_generation
           AND EXISTS (SELECT 1 FROM page_body_manifest lm WHERE lm.page_id = cc.page_id AND lm.occurrence_id = cc.occurrence_id
             AND lm.staging_id IS NULL AND lm.gen_from <= p.body_generation AND (lm.gen_to IS NULL OR lm.gen_to > p.body_generation)))) AND (cc."__COL__" IS NULL OR (p.body_storage IS DISTINCT FROM 'segmented' AND cc.embedded_at IS NULL)
      OR ($1::text IS NOT NULL AND p.embedding_signature IS NOT NULL AND p.embedding_signature <> $1::text))) w
      WHERE b.state <> 'open' AND ((CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END) > 1048576 OR b.reason IN ('archive_backfill', 'archive_open_day', 'call_import')) AND p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND w.chunks > 0 AND p.source_id = $2
      GROUP BY 1, 2, 3 ORDER BY p.source_id COLLATE "C", b.state COLLATE "C", COALESCE(b.reason, 'awaiting_approval') COLLATE "C"`;

/** Held and capped large pages with chunks still waiting for `column`, by source, state and reason (`sourceId` narrows it). */
export function listBudgetLimitedRows(raw: EngineRawRead, opts: { column: string; sourceId?: string; signature: string | null }): Promise<BudgetLimitedRow[]> {
  return opts.sourceId
    ? raw<BudgetLimitedRow>(withEmbeddingColumn(BUDGET_LIMITED_SOURCE_SQL, opts.column), [opts.signature, opts.sourceId])
    : raw<BudgetLimitedRow>(withEmbeddingColumn(BUDGET_LIMITED_SQL, opts.column), [opts.signature]);
}

export interface BudgetHoldAge { stale: number; oldest: Date | string | null }

const BUDGET_AGE_SQL = `SELECT count(*) FILTER (WHERE b.updated_at < now() - interval '1 day')::int AS stale, min(b.updated_at) AS oldest
       FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id
      WHERE b.state <> 'open' AND ((CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END) > 1048576 OR b.reason IN ('archive_backfill', 'archive_open_day', 'call_import')) AND p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`;

/** How many applying budget holds are older than a day, and the oldest update time. */
export async function readBudgetHoldAge(raw: EngineRawRead): Promise<BudgetHoldAge | undefined> {
  const [row] = await raw<BudgetHoldAge>(BUDGET_AGE_SQL);
  return row;
}

// ---- image_assets ------------------------------------------------------------------------------------------------

export interface ImageAssetFileRow { storage_path: string; source_local_path: string | null; page_source_path: string | null; metadata: unknown }

const IMAGE_ASSET_FILES_SQL = `SELECT f.storage_path, f.metadata, s.local_path AS source_local_path, p.source_path AS page_source_path FROM files f
           LEFT JOIN sources s ON s.id = COALESCE(f.source_id, 'default') LEFT JOIN pages p ON p.id = f.page_id
          WHERE f.mime_type LIKE 'image/%' ORDER BY f.id LIMIT 1000`;

/** The first 1000 image file rows (id order) with their source root and page source path. */
export function listImageAssetFiles(raw: EngineRawRead): Promise<ImageAssetFileRow[]> {
  return raw<ImageAssetFileRow>(IMAGE_ASSET_FILES_SQL);
}

// ---- extraction input receipts, derivation pricing ---------------------------------------------------------------

export interface AmbiguousExtractionRow { page: string; grammars: Record<string, number> | string | null; total: number }
export interface ExtractionReceiptRow { pipeline: string; kind: string; pages: number; samples: string[] }

const AMBIGUOUS_EXTRACTION_SQL = `SELECT p.source_id || ':' || p.slug AS page, s.input_truncated->'grammars' AS grammars, count(*) OVER ()::int AS total
         FROM page_extraction_state s JOIN pages p ON p.id = s.page_id AND p.deleted_at IS NULL
        WHERE s.pipeline = 'conversation_facts' AND s.input_truncated->>'kind' = 'detection_ambiguous'
        ORDER BY s.updated_at DESC, s.page_id LIMIT 20`;

/** The conversation pages held for an undetected format (at most 20, newest first), with the total. */
export function listAmbiguousExtractionInputs(raw: EngineRawRead): Promise<AmbiguousExtractionRow[]> {
  return raw<AmbiguousExtractionRow>(AMBIGUOUS_EXTRACTION_SQL);
}

const EXTRACTION_RECEIPTS_SQL = `WITH receipts AS (
         SELECT s.page_id, s.pipeline, COALESCE(s.input_truncated->>'kind', 'unknown') AS kind, s.updated_at, NULL::text AS detail
           FROM page_extraction_state s WHERE s.input_truncated IS NOT NULL AND COALESCE(s.input_truncated->>'kind', '') NOT IN ('detection_ambiguous', 'grammar_chosen')
         UNION ALL
         SELECT d.page_id, d.pipeline, CASE WHEN d.receipt->>'reason' = 'purge_sweep_pending' THEN 'purge_sweep_pending' ELSE COALESCE(d.receipt->>'kind', 'unknown') END AS kind,
                max(d.updated_at) AS updated_at,
                min(CASE WHEN d.receipt->>'kind' = 'failed_windows' THEN ' window ' || (d.receipt->'windows'->0->>'ordinal') || ' of occurrence ' || d.occurrence_id END) AS detail
           FROM page_segment_derivations d
          WHERE ((d.receipt->>'kind' IS NOT NULL AND d.receipt->>'kind' <> 'unpriced_model') OR d.receipt->>'reason' = 'purge_sweep_pending')
            AND NOT EXISTS (SELECT 1 FROM page_extraction_state h WHERE h.page_id = d.page_id AND h.pipeline = d.pipeline AND h.input_truncated->>'kind' = 'detection_ambiguous')
          GROUP BY 1, 2, 3)
       SELECT r.pipeline, r.kind, count(DISTINCT r.page_id)::int AS pages,
              (array_agg(p.source_id || ':' || p.slug || COALESCE(r.detail, '') ORDER BY r.updated_at DESC))[1:3] AS samples
         FROM receipts r JOIN pages p ON p.id = r.page_id AND p.deleted_at IS NULL
        GROUP BY 1, 2 ORDER BY r.pipeline COLLATE "C", r.kind COLLATE "C"`;

/** The page extraction receipts that read only part of their input, by pipeline and kind. */
export function listExtractionInputReceipts(raw: EngineRawRead): Promise<ExtractionReceiptRow[]> {
  return raw<ExtractionReceiptRow>(EXTRACTION_RECEIPTS_SQL);
}

export interface UnpricedModelRow { model: string; pipelines: string[]; pages: number; samples: string[] }

const UNPRICED_MODELS_SQL = `SELECT d.receipt->>'model' AS model, array_agg(DISTINCT d.pipeline COLLATE "C" ORDER BY d.pipeline COLLATE "C") AS pipelines, count(DISTINCT d.page_id)::int AS pages,
              (array_agg(DISTINCT (p.source_id || ':' || p.slug) COLLATE "C" ORDER BY (p.source_id || ':' || p.slug) COLLATE "C"))[1:3] AS samples
         FROM page_segment_derivations d JOIN pages p ON p.id = d.page_id AND p.deleted_at IS NULL
        WHERE (d.receipt->>'kind' = 'unpriced_model' OR d.receipt->>'reason' = 'unpriced_model') AND d.receipt->>'model' IS NOT NULL
        GROUP BY 1 ORDER BY 3 DESC, (d.receipt->>'model') COLLATE "C"`;

/** The models whose derivation receipts say they had no price, with their pipelines and pages. */
export function listUnpricedDerivationModels(raw: EngineRawRead): Promise<UnpricedModelRow[]> {
  return raw<UnpricedModelRow>(UNPRICED_MODELS_SQL);
}

// ---- atom retirements --------------------------------------------------------------------------------------------

export interface RestorableAtomRetirementRow { source_id: string; count: number; origins: number; oldest: string | null; newest: string | null; hold_until: string }

const ATOM_RETIREMENTS_SQL = `
      SELECT p.source_id, count(*)::int AS count,
             count(DISTINCT c.origin_kind||':'||c.origin)::int AS origins, min(c.retired_at) AS oldest, max(c.retired_at) AS newest,
             to_char((min(p.deleted_at) + interval '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hold_until
        FROM (WITH retired AS (
      SELECT p.id, p.source_id, p.slug, CASE WHEN NULLIF(p.frontmatter->>'source_slug','') IS NOT NULL THEN 'slug:'||(p.frontmatter->>'source_slug')
      WHEN NULLIF(p.frontmatter->>'source_path','') IS NOT NULL THEN 'path:'||(p.frontmatter->>'source_path') END AS okey, NULLIF(p.frontmatter->>'source_slug','') AS origin_slug,
             COALESCE(NULLIF(p.frontmatter->>'source_slug',''), p.frontmatter->>'source_path') AS origin,
             regexp_replace(COALESCE(p.frontmatter->>'source_hash',''),'^pending:','') AS hash, p.frontmatter->>'retired_at' AS retired_at
        FROM pages p
       WHERE p.type='atom' AND p.deleted_at IS NOT NULL AND p.frontmatter->>'retired_by'='managed-reextract' AND NULLIF(p.frontmatter->>'imported_from','') IS NULL
         AND (p.source_id=ANY($1::text[]))
    ), latest AS (
      SELECT DISTINCT ON (source_id, okey) source_id, okey, hash FROM retired WHERE okey IS NOT NULL
       ORDER BY source_id, okey, retired_at COLLATE "C" DESC NULLS LAST, id DESC
    ), live AS (
      SELECT p.source_id, CASE WHEN NULLIF(p.frontmatter->>'source_slug','') IS NOT NULL THEN 'slug:'||(p.frontmatter->>'source_slug')
      WHEN NULLIF(p.frontmatter->>'source_path','') IS NOT NULL THEN 'path:'||(p.frontmatter->>'source_path') END AS okey, array_agg(DISTINCT regexp_replace(COALESCE(p.frontmatter->>'source_hash',''),'^pending:','')) AS hashes
        FROM pages p WHERE p.type='atom' AND p.deleted_at IS NULL AND NULLIF(p.frontmatter->>'imported_from','') IS NULL AND (p.source_id=ANY($1::text[]))
       GROUP BY 1, 2
    )
    SELECT r.id, r.source_id, r.slug, CASE WHEN r.origin_slug IS NOT NULL THEN 'page' ELSE 'transcript' END AS origin_kind, r.origin,
           o.id AS origin_page_id, r.hash, r.retired_at,
           (r.okey IS NOT NULL AND (r.origin_slug IS NULL OR o.id IS NOT NULL)) AS origin_live,
           (lv.hashes IS NOT NULL AND NOT (lv.hashes <@ ARRAY[r.hash])) AS replaced,
           COALESCE(l.hash = r.hash, false) AS latest,
           (r.okey IS NOT NULL AND (r.origin_slug IS NULL OR o.id IS NOT NULL) AND NOT COALESCE(lv.hashes IS NOT NULL AND NOT (lv.hashes <@ ARRAY[r.hash]), false)
             AND COALESCE(l.hash = r.hash, false)) AS restorable,
           (SELECT g.id FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
             WHERE g.source_id=r.source_id AND g.kind='atom' AND g.state='live' AND i.item_key=r.slug AND i.action='retired' ORDER BY g.id DESC LIMIT 1) AS ledger_generation
      FROM retired r
      LEFT JOIN pages o ON o.source_id=r.source_id AND o.slug=r.origin_slug AND o.deleted_at IS NULL
      LEFT JOIN live lv ON lv.source_id=r.source_id AND lv.okey=r.okey
      LEFT JOIN latest l ON l.source_id=r.source_id AND l.okey=r.okey) c JOIN pages p ON p.id=c.id
       WHERE c.restorable AND c.ledger_generation IS NULL GROUP BY p.source_id ORDER BY p.source_id COLLATE "C"`;
const ATOM_RETIREMENTS_COVERED_SQL = `SELECT count(*)::int AS count FROM (WITH retired AS (
      SELECT p.id, p.source_id, p.slug, CASE WHEN NULLIF(p.frontmatter->>'source_slug','') IS NOT NULL THEN 'slug:'||(p.frontmatter->>'source_slug')
      WHEN NULLIF(p.frontmatter->>'source_path','') IS NOT NULL THEN 'path:'||(p.frontmatter->>'source_path') END AS okey, NULLIF(p.frontmatter->>'source_slug','') AS origin_slug,
             COALESCE(NULLIF(p.frontmatter->>'source_slug',''), p.frontmatter->>'source_path') AS origin,
             regexp_replace(COALESCE(p.frontmatter->>'source_hash',''),'^pending:','') AS hash, p.frontmatter->>'retired_at' AS retired_at
        FROM pages p
       WHERE p.type='atom' AND p.deleted_at IS NOT NULL AND p.frontmatter->>'retired_by'='managed-reextract' AND NULLIF(p.frontmatter->>'imported_from','') IS NULL
         AND (p.source_id=ANY($1::text[]))
    ), latest AS (
      SELECT DISTINCT ON (source_id, okey) source_id, okey, hash FROM retired WHERE okey IS NOT NULL
       ORDER BY source_id, okey, retired_at COLLATE "C" DESC NULLS LAST, id DESC
    ), live AS (
      SELECT p.source_id, CASE WHEN NULLIF(p.frontmatter->>'source_slug','') IS NOT NULL THEN 'slug:'||(p.frontmatter->>'source_slug')
      WHEN NULLIF(p.frontmatter->>'source_path','') IS NOT NULL THEN 'path:'||(p.frontmatter->>'source_path') END AS okey, array_agg(DISTINCT regexp_replace(COALESCE(p.frontmatter->>'source_hash',''),'^pending:','')) AS hashes
        FROM pages p WHERE p.type='atom' AND p.deleted_at IS NULL AND NULLIF(p.frontmatter->>'imported_from','') IS NULL AND (p.source_id=ANY($1::text[]))
       GROUP BY 1, 2
    )
    SELECT r.id, r.source_id, r.slug, CASE WHEN r.origin_slug IS NOT NULL THEN 'page' ELSE 'transcript' END AS origin_kind, r.origin,
           o.id AS origin_page_id, r.hash, r.retired_at,
           (r.okey IS NOT NULL AND (r.origin_slug IS NULL OR o.id IS NOT NULL)) AS origin_live,
           (lv.hashes IS NOT NULL AND NOT (lv.hashes <@ ARRAY[r.hash])) AS replaced,
           COALESCE(l.hash = r.hash, false) AS latest,
           (r.okey IS NOT NULL AND (r.origin_slug IS NULL OR o.id IS NOT NULL) AND NOT COALESCE(lv.hashes IS NOT NULL AND NOT (lv.hashes <@ ARRAY[r.hash]), false)
             AND COALESCE(l.hash = r.hash, false)) AS restorable,
           (SELECT g.id FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
             WHERE g.source_id=r.source_id AND g.kind='atom' AND g.state='live' AND i.item_key=r.slug AND i.action='retired' ORDER BY g.id DESC LIMIT 1) AS ledger_generation
      FROM retired r
      LEFT JOIN pages o ON o.source_id=r.source_id AND o.slug=r.origin_slug AND o.deleted_at IS NULL
      LEFT JOIN live lv ON lv.source_id=r.source_id AND lv.okey=r.okey
      LEFT JOIN latest l ON l.source_id=r.source_id AND l.okey=r.okey) c WHERE c.restorable AND c.ledger_generation IS NOT NULL`;

/** Restorable re-extraction retirements no live generation's ledger records, per source, with the purge-hold end of the earliest. */
export function listRestorableAtomRetirements(raw: EngineRawRead, sourceIds: string[]): Promise<RestorableAtomRetirementRow[]> {
  return raw<RestorableAtomRetirementRow>(ATOM_RETIREMENTS_SQL, [sourceIds]);
}

/** Restorable re-extraction retirements a live generation's ledger records. */
export async function countLedgerCoveredAtomRetirements(raw: EngineRawRead, sourceIds: string[]): Promise<number> {
  const [row] = await raw<{ count: number }>(ATOM_RETIREMENTS_COVERED_SQL, [sourceIds]);
  return Number(row?.count ?? 0);
}

// ---- derived generations -----------------------------------------------------------------------------------------

export interface GenerationRetirementRow { source_id: string; kind: string; keys: number; items: number; oldest: string | null }
export interface HeldGenerationRow { source_id: string; kind: string; held_reason: string; count: number; oldest: string | null }
export interface OrphanGenerationCandidateRow { source_id: string; kind: string; owner_key: string; activation_id: string; slug: string; created_at: string }

const GENERATION_RETIREMENTS_SQL = `
      SELECT g.source_id, g.kind, count(DISTINCT g.id)::int AS keys, count(*)::int AS items, min(g.created_at)::text AS oldest
        FROM derived_generations g JOIN derived_generation_items i ON i.generation_id=g.id AND i.action='retired'
       WHERE g.source_id=ANY($1::text[]) AND g.state='live' AND g.created_at >= now() - interval '1 day' * $2
       GROUP BY g.source_id, g.kind ORDER BY g.source_id COLLATE "C", g.kind COLLATE "C"`;
const HELD_GENERATIONS_SQL = `
      SELECT source_id, kind, held_reason, count(*)::int AS count, min(created_at)::text AS oldest
        FROM derived_generations WHERE source_id=ANY($1::text[]) AND state='held'
       GROUP BY source_id, kind, held_reason ORDER BY source_id COLLATE "C", kind COLLATE "C", held_reason COLLATE "C"`;
const ORPHAN_GENERATION_CANDIDATES_SQL = `SELECT a.source_id, a.kind, a.owner_key, a.id AS activation_id, m->>'slug' AS slug, a.created_at::text AS created_at
       FROM derived_generation_activations a CROSS JOIN LATERAL jsonb_array_elements(a.members) m
      WHERE a.state='pending' AND a.source_id=ANY($1::text[]) AND ($2::text IS NULL OR a.kind=$2) AND m->>'action'='create'
        AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.request_id=a.id::uuid AND r.state IN ('queued','deferred','running','recovering'))
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=m->>'slug' AND p.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
          WHERE g.source_id=a.source_id AND g.kind=a.kind AND g.state='live' AND i.item_key=m->>'slug' AND i.action<>'retired')
      ORDER BY a.source_id, a.kind, a.owner_key, slug`;

/** Live generations that retired items within the last `restoreDays` days, by source and kind. */
export function listLiveGenerationRetirements(raw: EngineRawRead, sourceIds: string[], restoreDays: number): Promise<GenerationRetirementRow[]> {
  return raw<GenerationRetirementRow>(GENERATION_RETIREMENTS_SQL, [sourceIds, restoreDays]);
}

/** Held derived generations by source, kind and reason. */
export function listHeldGenerations(raw: EngineRawRead, sourceIds: string[]): Promise<HeldGenerationRow[]> {
  return raw<HeldGenerationRow>(HELD_GENERATIONS_SQL, [sourceIds]);
}

/** Pages a `create` member wrote for an activation that never happened and no live generation owns (`kind` narrows it). */
export function listOrphanGenerationCandidates(raw: EngineRawRead, sourceIds: readonly string[], kind: string | null): Promise<OrphanGenerationCandidateRow[]> {
  return raw<OrphanGenerationCandidateRow>(ORPHAN_GENERATION_CANDIDATES_SQL, [[...sourceIds], kind]);
}

// ---- ontology facts, atom provenance, extract rollup -------------------------------------------------------------

export interface OntologyFactRow {
  id: number | string; source_id: string; entity_slug: string; dimension: string; source: string; page: string | null;
  row_num: number | string | null; expired_at: string | null; withdrawn: boolean; consolidated: boolean; duplicate: boolean;
}

const ONTOLOGY_FACTS_SQL = `
    SELECT f.id, f.source_id, f.entity_slug, f.dimension, f.source, f.source_markdown_slug AS page, f.row_num,
           to_char(f.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expired_at,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
             AND (w.subject='*' OR w.subject=f.entity_slug)
             AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v2(f.fact), gbrain_fact_fingerprint_v1(f.fact))) AS withdrawn,
           f.consolidated_into IS NOT NULL AS consolidated,
           EXISTS (SELECT 1 FROM facts d WHERE d.source_id=f.source_id AND d.entity_slug=f.entity_slug
  AND d.dimension=f.dimension AND d.value_hash=f.value_hash AND d.source_markdown_slug=f.source
  AND d.valid_from=f.valid_from AND d.id<>f.id) AS duplicate
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.dimension IS NOT NULL AND f.entity_slug IS NOT NULL AND f.source IS NOT NULL
       AND (f.row_num IS NOT NULL OR f.source_markdown_slug IS DISTINCT FROM f.source) AND COALESCE(source, '') NOT LIKE 'cli:extract-conversation-facts%'
     ORDER BY f.id`;

/** Facts the ontology fence step moved, with their withdrawn, consolidated and duplicate verdicts, in id order. */
export function listOntologyFactCandidates(raw: EngineRawRead, sourceIds: string[]): Promise<OntologyFactRow[]> {
  return raw<OntologyFactRow>(ONTOLOGY_FACTS_SQL, [sourceIds]);
}

export interface AtomProvenanceCounts {
  total: number; slug_unbound: number; drifted: number; source_changed: number; source_gone: number;
  oldest_ext: string | null;
}

const ATOM_PROVENANCE_SQL = `WITH atom AS (
         SELECT a.source_id,
                -- managed atoms keep their provisional prefix for good (#5770)
                CASE WHEN a.frontmatter->>'managed_extraction' = 'true'
                     THEN regexp_replace(a.frontmatter->>'source_hash', '^pending:', '')
                     ELSE a.frontmatter->>'source_hash' END AS sh,
                -- NULL = slug-unbound: transcript-minted (source_path only) or
                -- pre-binding-era. \`ss IS NULL\` is THE predicate for that
                -- population everywhere below (#4799 / #4806).
                NULLIF(a.frontmatter->>'source_slug', '') AS ss,
                CASE WHEN a.frontmatter->>'extracted_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                     THEN a.frontmatter->>'extracted_at' END AS ext
           FROM pages a
          WHERE a.type = 'atom'
            AND a.deleted_at IS NULL
            AND a.frontmatter->>'source_hash' IS NOT NULL
            -- in-flight marker written before an unmanaged extraction commits
            AND (a.frontmatter->>'source_hash' NOT LIKE 'pending:%' OR a.frontmatter->>'managed_extraction' = 'true')
         ),
       -- Lookup sets are built ONCE and joined (#4937). A correlated EXISTS in
       -- the SELECT list is not rewritten to a semi-join — Postgres re-runs it
       -- per atom over substring(content_hash), which no index serves, so the
       -- check went O(atoms x same-source pages) and blew health-check budgets.
       -- DISTINCT is load-bearing: duplicate live content_hash values are a
       -- real state and would otherwise fan one atom out into several rows.
       live_hashes AS MATERIALIZED (
         SELECT DISTINCT source_id, substring(content_hash from 1 for 16) AS sh
           FROM pages WHERE deleted_at IS NULL AND content_hash IS NOT NULL
       ), live_slugs AS MATERIALIZED (
         SELECT DISTINCT source_id, slug FROM pages WHERE deleted_at IS NULL
       ), drift AS (
         SELECT atom.*,
                -- a slug-unbound atom is never drift: its hash is over a file,
                -- not a page, so the page probe is meaningless (#4806)
                (atom.ss IS NOT NULL AND h.sh IS NULL) AS drifted,
                (s.slug IS NOT NULL OR rs.slug IS NOT NULL) AS src_alive
           FROM atom
           LEFT JOIN live_hashes h ON h.source_id = atom.source_id AND h.sh = atom.sh
           LEFT JOIN live_slugs  s ON s.source_id = atom.source_id AND s.slug = atom.ss
           LEFT JOIN slug_aliases r ON s.slug IS NULL AND r.source_id = atom.source_id AND r.alias_slug = atom.ss AND r.notes = 'rename'
           LEFT JOIN live_slugs rs ON rs.source_id = r.source_id AND rs.slug = r.canonical_slug
       )
       SELECT count(*) FILTER (WHERE ss IS NOT NULL) AS total,
              count(*) FILTER (WHERE ss IS NULL) AS slug_unbound,
              count(*) FILTER (WHERE drifted) AS drifted,
              count(*) FILTER (WHERE drifted AND src_alive) AS source_changed,
              -- drifted implies a slug binding, so "gone" is always a binding
              -- that failed to resolve — never a slug-unbound atom (#4799)
              count(*) FILTER (WHERE drifted AND NOT src_alive) AS source_gone,
              -- lexicographic min of ISO-shaped strings ≈ chronological min
              -- (oldest); informational only, never verdict-bearing
              min(ext) FILTER (WHERE drifted) AS oldest_ext
         FROM drift`;

/**
 * The atom provenance drift counts (the first row; none when the aggregate returned no row). extracted_at stays TEXT end
 * to end: an unguarded ::timestamptz cast let one malformed frontmatter value abort the whole aggregate and degrade
 * the check to a spurious "check failed" warn. The ISO-shape regex drops garbage from the min(); the age math happens in
 * the caller, where Date parsing cannot throw.
 */
export async function readAtomProvenanceCounts(raw: EngineRawRead): Promise<AtomProvenanceCounts | undefined> {
  const rows = await raw<Record<keyof AtomProvenanceCounts, unknown>>(ATOM_PROVENANCE_SQL, []);
  const r = rows?.[0];
  if (!r) return undefined;
  // count(*) is a bigint on Postgres and a number on PGLite; every caller reads it with Number(), so hand back numbers.
  const n = (v: unknown) => (v == null ? 0 : Number(v));
  return {
    total: n(r.total), slug_unbound: n(r.slug_unbound), drifted: n(r.drifted), source_changed: n(r.source_changed),
    source_gone: n(r.source_gone), oldest_ext: r.oldest_ext == null ? null : String(r.oldest_ext),
  };
}

// ---- the unchanged-body recheck of atom_provenance_drift (commands/doctor/checks/atom-body-recheck.ts) -----------------

/** The page-bound and slug-unbound atoms atom_provenance_drift reads (`ss` NULL: slug-unbound), as a CTE body. */
export const ATOM_PROVENANCE_CTE = `atom AS (
         SELECT a.source_id,
                -- managed atoms keep their provisional prefix for good (#5770)
                CASE WHEN a.frontmatter->>'managed_extraction' = 'true'
                     THEN regexp_replace(a.frontmatter->>'source_hash', '^pending:', '')
                     ELSE a.frontmatter->>'source_hash' END AS sh,
                -- NULL = slug-unbound: transcript-minted (source_path only) or
                -- pre-binding-era. \`ss IS NULL\` is THE predicate for that
                -- population everywhere below (#4799 / #4806).
                NULLIF(a.frontmatter->>'source_slug', '') AS ss,
                CASE WHEN a.frontmatter->>'extracted_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                     THEN a.frontmatter->>'extracted_at' END AS ext
           FROM pages a
          WHERE a.type = 'atom'
            AND a.deleted_at IS NULL
            AND a.frontmatter->>'source_hash' IS NOT NULL
            -- in-flight marker written before an unmanaged extraction commits
            AND (a.frontmatter->>'source_hash' NOT LIKE 'pending:%' OR a.frontmatter->>'managed_extraction' = 'true')
         )`;

/** (page, source_hash) groups of drifted atoms the recheck reads per run; the rest keep their drift verdict. */
export const BODY_RECHECK_GROUPS = 200;
/** The newest versions of a page searched for an atom's extraction edition. */
export const BODY_RECHECK_VERSIONS = 20;

export interface BodyRecheckGroup { page_id: number; sh: string; n: number }
export interface BodyRecheckPage { body_storage: string | null; compiled_truth: string | null; timeline: string | null }
export interface BodyRecheckVersion { compiled_truth: string | null; timeline: string | null; title: string; type: string; frontmatter: unknown; tags: unknown }

/**
 * The drifted atoms of live inline pages, grouped by page and 16-character source hash, whose hash names no live page
 * of their source: the first BODY_RECHECK_GROUPS groups by page id, then hash in byte order.
 */
export async function listBodyRecheckGroups(raw: EngineRawRead): Promise<BodyRecheckGroup[]> {
  const rows = await raw<{ page_id: number | string; sh: string; n: number | string }>(
    `WITH ${ATOM_PROVENANCE_CTE}, live_hashes AS MATERIALIZED (
       SELECT DISTINCT source_id, substring(content_hash from 1 for 16) AS sh FROM pages WHERE deleted_at IS NULL AND content_hash IS NOT NULL
     )
     SELECT p.id AS page_id, atom.sh, count(*)::int AS n
       FROM atom
       JOIN pages p ON p.source_id = atom.source_id AND p.slug = atom.ss AND p.deleted_at IS NULL AND p.body_storage = 'inline'
       LEFT JOIN live_hashes h ON h.source_id = atom.source_id AND h.sh = atom.sh
      WHERE h.sh IS NULL AND length(atom.sh) = 16
      GROUP BY p.id, atom.sh ORDER BY p.id, atom.sh COLLATE "C" LIMIT ${BODY_RECHECK_GROUPS}`, []);
  return rows.map(r => ({ page_id: Number(r.page_id), sh: r.sh, n: Number(r.n) }));
}

/** The body storage and body columns of the page with this id, or null when no page has it. */
export async function readBodyRecheckPage(raw: EngineRawRead, pageId: number): Promise<BodyRecheckPage | null> {
  const [page] = await raw<BodyRecheckPage>('SELECT body_storage, compiled_truth, timeline FROM pages WHERE id = $1', [pageId]);
  return page ?? null;
}

/** The newest BODY_RECHECK_VERSIONS inline versions of the page that hold a body, newest first. */
export async function listBodyRecheckVersions(raw: EngineRawRead, pageId: number): Promise<BodyRecheckVersion[]> {
  return raw<BodyRecheckVersion>(
    `SELECT compiled_truth, timeline, title, type, frontmatter, tags FROM page_versions
        WHERE page_id = $1 AND body_storage = 'inline' AND compiled_truth IS NOT NULL ORDER BY id DESC LIMIT $2`, [pageId, BODY_RECHECK_VERSIONS]);
}

export interface ExtractRollupRow {
  kind: string; cost_7d_usd: number; eval_pass_count: number; eval_fail_count: number; halt_count: number; round_completed_count: number;
  expected_limit_count: number; rollup_write_failures: number; last_updated_at: Date | string | null; last_halt_age_days: number | string | null;
}

const EXTRACT_ROLLUP_SQL = `SELECT
         kind,
         SUM(cost_usd) AS cost_7d_usd,
         SUM(eval_pass_count) AS eval_pass_count,
         SUM(eval_fail_count) AS eval_fail_count,
         SUM(halt_count) AS halt_count,
         SUM(round_completed_count) AS round_completed_count,
         SUM(expected_limit_count) AS expected_limit_count,
         SUM(rollup_write_failures) AS rollup_write_failures,
         MAX(updated_at) AS last_updated_at,
         (now() AT TIME ZONE 'UTC')::date - MAX(day) FILTER (WHERE halt_count > 0) AS last_halt_age_days
       FROM extract_rollup_7d
       WHERE day >= (now() AT TIME ZONE 'UTC')::date - 7
       GROUP BY kind
       ORDER BY kind COLLATE "C"`;
const EXTRACT_ROLLUP_NO_EXPECTED_SQL = `SELECT
         kind,
         SUM(cost_usd) AS cost_7d_usd,
         SUM(eval_pass_count) AS eval_pass_count,
         SUM(eval_fail_count) AS eval_fail_count,
         SUM(halt_count) AS halt_count,
         SUM(round_completed_count) AS round_completed_count,
         0 AS expected_limit_count,
         SUM(rollup_write_failures) AS rollup_write_failures,
         MAX(updated_at) AS last_updated_at,
         (now() AT TIME ZONE 'UTC')::date - MAX(day) FILTER (WHERE halt_count > 0) AS last_halt_age_days
       FROM extract_rollup_7d
       WHERE day >= (now() AT TIME ZONE 'UTC')::date - 7
       GROUP BY kind
       ORDER BY kind COLLATE "C"`;

/**
 * The 7-day extract rollup per kind; `withExpected: false` is the pre-v141 text for a brain without `expected_limit_count`.
 * Days are UTC days (the rollup writer's), so the window and the last halt's age do not move with the session time zone
 * (#10356).
 */
export function readExtractRollup7d(raw: EngineRawRead, withExpected: boolean): Promise<ExtractRollupRow[]> {
  return raw<ExtractRollupRow>(withExpected ? EXTRACT_ROLLUP_SQL : EXTRACT_ROLLUP_NO_EXPECTED_SQL, []);
}

/** One kind's 7-day extract rollup aggregate (`extract --explain`): one row, every column null when the kind has none. */
export interface ExtractKindRollupRow {
  cost_7d_usd: number | null; eval_pass_count: string | null; eval_fail_count: string | null; halt_count: string | null;
  round_completed_count: string | null; last_updated_at: Date | string | null;
}

const EXTRACT_KIND_ROLLUP_SQL = `SELECT
         SUM(cost_usd) AS cost_7d_usd,
         SUM(eval_pass_count)::text AS eval_pass_count,
         SUM(eval_fail_count)::text AS eval_fail_count,
         SUM(halt_count)::text AS halt_count,
         SUM(round_completed_count)::text AS round_completed_count,
         MAX(updated_at) AS last_updated_at
       FROM extract_rollup_7d
       WHERE day >= CURRENT_DATE - 7 AND kind = $1`;

/** The 7-day extract rollup of one kind, the aggregate `extract --explain <kind>` prints (sums as text: see the caller). */
export async function readExtractKindRollup7d(raw: EngineRawRead, kind: string): Promise<ExtractKindRollupRow | null> {
  return (await raw<ExtractKindRollupRow>(EXTRACT_KIND_ROLLUP_SQL, [kind]))[0] ?? null;
}

export interface RecordedHaltReasonRow { kind: string; reason: string; n: number | string }

const RECORDED_HALT_REASONS_SQL = `SELECT r.kind, e.key AS reason, SUM(e.value::int) AS n
         FROM extract_rollup_7d r, jsonb_each_text(r.halt_reasons) e
        WHERE r.day >= CURRENT_DATE - 7
        GROUP BY r.kind, e.key`;

/** The recorded halt reasons of the 7-day extract rollup, summed per kind and reason (migration v239 added the column). */
export function listRecordedHaltReasons7d(raw: EngineRawRead): Promise<RecordedHaltReasonRow[]> {
  return raw<RecordedHaltReasonRow>(RECORDED_HALT_REASONS_SQL, []);
}

/** The statements built from other modules' composers, exposed for test/doctor-derived-sql.test.ts, which rebuilds each from the live composers. */
export const COMPOSED_SQL = {
  PRIVACY_LABEL_SQL, PRIVACY_LABEL_SCOPED_SQL, SAFE_INDEX_SQL, SAFE_INDEX_SCOPED_SQL, CREDENTIAL_PENDING_SQL, CREDENTIAL_PENDING_SCOPED_SQL,
  PAGE_TYPE_OWNER_SQL, PAGE_TYPE_OWNER_SCOPED_SQL, RECORDED_TOMBSTONES_SQL, DERIVED_VISIBILITY_SQL, UNTILED_SQL, TIMELINE_BATCH_SQL,
  BACKLOG_AGE_SQL, BUDGET_LIMITED_SQL, BUDGET_LIMITED_SOURCE_SQL, BUDGET_AGE_SQL, ATOM_RETIREMENTS_SQL, ATOM_RETIREMENTS_COVERED_SQL,
  ONTOLOGY_FACTS_SQL, ATOM_PROVENANCE_SQL,
} as const;

/**
 * The statements gbrain export runs (src/commands/export.ts, src/core/export-snapshot.ts), one function per
 * BrainEngine member. PGLite and Postgres run the same text the export ran through executeRaw before; the Rust engine
 * answers from its store (rust/docs/store/cli-reads-export.md). Each runs on the engine it is given, so a call on a
 * transaction engine reads inside that transaction.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { rowToPage } from '../utils.ts';
import { FACT_SPACE_CLASS } from '../facts/withdrawal-schema.ts';
import { liveTilingSql, untiledSql } from '../page-body/schema.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One page key of an export batch: the page's identity, whether its body is segmented, its raw_data row count and its payload size in bytes. */
export interface ExportPageKey {
  id: string;
  segmented: boolean;
  slug: string;
  source_id: string;
  source_path: string | null;
  source_path_bytes: number | null;
  raw_count: number;
  bytes: number;
}

export interface ExportPageKeyQuery { afterId: string; sourceId: string | null; type: string | null; slugPrefix: string | null }

/** The next 256 live pages after page id `afterId`, in id order, within the source, type and slug prefix (null: any). */
export async function listExportPageKeys(tx: Raw, q: ExportPageKeyQuery): Promise<ExportPageKey[]> {
  return tx.executeRaw<ExportPageKey>(
    `SELECT p.id::text, p.body_storage='segmented' AS segmented, left(p.slug,4097) AS slug, p.source_id, left(p.source_path,4097) AS source_path, octet_length(p.source_path) AS source_path_bytes,
            (SELECT count(*) FROM raw_data r WHERE r.page_id=p.id) AS raw_count,
            CASE WHEN p.body_storage='segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth)::bigint + octet_length(p.timeline) END
              + octet_length(p.frontmatter::text)
              + octet_length(p.title) + octet_length(p.slug) + COALESCE(octet_length(p.source_path),0)
              + COALESCE((SELECT sum(octet_length(r.data::text)+octet_length(r.source)) FROM raw_data r WHERE r.page_id=p.id),0)
              + COALESCE((SELECT sum(octet_length(t.tag)) FROM tags t WHERE t.page_id=p.id),0) AS bytes
           FROM pages p WHERE p.id > $1::bigint AND p.deleted_at IS NULL
             AND ($2::text IS NULL OR p.source_id=$2) AND ($3::text IS NULL OR p.type=$3)
             AND ($4::text IS NULL OR starts_with(p.slug,$4)) ORDER BY p.id LIMIT 256`,
    [q.afterId, q.sourceId, q.type, q.slugPrefix]);
}

/** The bytes of the source's withdrawal ledger as the export sizes it: each row's jsonb text plus a separator, plus the brackets. */
export async function readExportWithdrawalLedgerBytes(tx: Raw, sourceId: string): Promise<number> {
  const [size] = await tx.executeRaw<{ bytes: number }>(`SELECT COALESCE(sum(octet_length(
    jsonb_build_object('visibility',visibility,'fact_hash',fact_hash,'withdrawn_at',withdrawn_at,'subject',subject)::text)+1),0)+2 AS bytes
    FROM fact_withdrawals WHERE source_id=$1`, [sourceId]);
  return Number(size!.bytes);
}

/** One row of the export's withdrawal ledger: a withdrawal, or a purge tombstone (`purged`), which drops its fact row. */
export interface ExportWithdrawalRow { visibility: string; fact_hash: string; withdrawn_at: Date; subject: string; purged: boolean }

/** The source's withdrawals and purge tombstones, by visibility, fact hash and subject. */
export async function listExportWithdrawals(tx: Raw, sourceId: string): Promise<ExportWithdrawalRow[]> {
  // A UNION's ORDER BY takes only output column names, so the byte order sorts the wrapped union.
  return tx.executeRaw<ExportWithdrawalRow>(`SELECT * FROM (SELECT visibility,fact_hash,withdrawn_at,subject,false AS purged
    FROM fact_withdrawals WHERE source_id=$1
    UNION ALL SELECT visibility,fact_hash,purged_at,subject,true FROM fact_purges WHERE source_id=$1) w
    ORDER BY visibility COLLATE "C",fact_hash COLLATE "C",subject COLLATE "C"`, [sourceId]);
}

/** One fact purge tombstone of a source, as `fact_purges` stores it (the request id as text). */
export interface FactPurgeTombstone { subject: string; visibility: string; fact_hash: string; request_id: string | null; actor: string | null; reason: string | null }
/** One take purge tombstone of a source, as `take_purges` stores it (the request id as text). */
export interface TakePurgeTombstone { subject: string; claim_hash: string; request_id: string | null }

/**
 * The source's fact purge tombstones by visibility, subject and fact hash, and its take purge tombstones by subject and
 * claim hash, each in byte order: what a purge stored, with the request, actor and reason it recorded.
 */
export async function listPurgeTombstones(tx: Raw, sourceId: string): Promise<{ facts: FactPurgeTombstone[]; takes: TakePurgeTombstone[] }> {
  const facts = await tx.executeRaw<FactPurgeTombstone>(`SELECT subject, visibility, fact_hash, request_id::text AS request_id, actor, reason FROM fact_purges
    WHERE source_id = $1 ORDER BY visibility COLLATE "C", subject COLLATE "C", fact_hash COLLATE "C"`, [sourceId]);
  const takes = await tx.executeRaw<TakePurgeTombstone>(`SELECT subject, claim_hash, request_id::text AS request_id FROM take_purges
    WHERE source_id = $1 ORDER BY subject COLLATE "C", claim_hash COLLATE "C"`, [sourceId]);
  return { facts, takes };
}

/** A page the export writes, with its tags in tag order. */
export interface ExportPageRow { page: Page; tags: string[] }

/**
 * The live pages among `ids`, each with its tags, in no set order. Rows are looked up by primary key (#7618: a join on
 * the keys let the planner scan the whole source for each key, so a per-page export went quadratic).
 */
export async function readExportPageRows(tx: Raw, ids: readonly string[]): Promise<ExportPageRow[]> {
  const rows = await tx.executeRaw<Record<string, unknown>>(`WITH export_page AS MATERIALIZED (
    SELECT * FROM pages WHERE id = ANY($1::bigint[])
  ) SELECT p.*,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS export_tags
    FROM export_page p WHERE p.deleted_at IS NULL`,
  [ids]);
  return rows.map(row => ({ page: rowToPage(row), tags: row.export_tags as string[] }));
}

/** One normalized body pair: `i` is the 1-based position in the input; a body that is empty or null normalizes to null. */
export interface NormalizedFenceLines { i: number; body: string | null; timeline: string | null }

/**
 * Each body and timeline lower-cased with every run of FACT_SPACE_CLASS made one space, line by line (overlayCanonicalBodies'
 * rule), so a withdrawal overlay can match fact rows the way gbrain_fact_fingerprint folds them on every engine.
 */
export async function normalizeFenceLines(tx: Raw, bodies: readonly string[], timelines: readonly string[]): Promise<NormalizedFenceLines[]> {
  return tx.executeRaw<NormalizedFenceLines>(`SELECT t.i::int AS i,
    (SELECT string_agg(regexp_replace(lower(line),$3::text,' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array(t.body,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS body,
    (SELECT string_agg(regexp_replace(lower(line),$3::text,' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array(t.timeline,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS timeline
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(body, timeline, i)`,
  [bodies, timelines, `${FACT_SPACE_CLASS}+`]);
}

/** A segmented page's head row. Bigint columns come back as numbers on PGLite and strings on Postgres. */
export interface SegmentedPageHead {
  id: number | string;
  source_id: string;
  slug: string;
  body_storage: string;
  body_generation: number | string;
  body_bytes: number | string | null;
  body_lines: number | string | null;
  truth_bytes: number | string | null;
  body_flags: unknown;
  segmenter_version: number | null;
  revision: string | null;
}

/** Page `pageId`'s segmented-body columns and revision, whether or not it is deleted, or undefined when there is no such page. */
export async function readSegmentedPageHead(tx: Raw, pageId: number): Promise<SegmentedPageHead | undefined> {
  const [page] = await tx.executeRaw<SegmentedPageHead>(`SELECT id, source_id, slug, body_storage, body_generation, body_bytes, body_lines, truth_bytes,
      body_flags, segmenter_version, knowledge_revision::text AS revision FROM pages WHERE id=$1`, [pageId]);
  return page;
}

/** One published manifest row of a segmented body, with the generation it was read at. Bigint columns: numbers on PGLite, strings on Postgres. */
export interface BodyManifestRow {
  seq: number;
  occurrence_id: number | string;
  region: string;
  sha256: Uint8Array;
  byte_start: number | string;
  byte_len: number | string;
  line_start: number | string;
  line_count: number | string;
  static_proj_bytes: number | string;
  static_proj_lines: number | string;
  outline_count: number;
  has_facts: boolean;
  has_date: boolean;
  generation: number | string;
}

/** Generation `generation`'s published manifest rows of page `pageId` in seq order (`generation` null: the page's live one at the statement). */
export async function readBodyManifestRows(tx: Raw, pageId: number, generation: number | null): Promise<BodyManifestRow[]> {
  return tx.executeRaw<BodyManifestRow>(`SELECT m.seq, m.occurrence_id, m.region, m.sha256, m.byte_start, m.byte_len,
      m.line_start, m.line_count, m.static_proj_bytes, m.static_proj_lines, jsonb_array_length(m.outline) AS outline_count,
      jsonb_array_length(m.facts_slots) > 0 AS has_facts, m.date_min IS NOT NULL AS has_date, g.generation
    FROM (SELECT COALESCE($2::bigint, (SELECT body_generation FROM pages WHERE id=$1)) AS generation) g
    JOIN page_body_manifest m ON m.page_id=$1 AND m.staging_id IS NULL AND m.gen_from<=g.generation AND (m.gen_to IS NULL OR m.gen_to>g.generation)
    ORDER BY m.seq`, [pageId, generation]);
}

/** One manifest row's entry state and protected regions (JSON: objects on PGLite and Postgres). Occurrence ids: numbers on PGLite, strings on Postgres. */
export interface BodyManifestMeta {
  occurrence_id: number | string;
  entry_state: unknown;
  protected_regions: unknown;
}

/** The published rows of generation `generation` of page `pageId` among `occurrenceIds`: their entry state and protected regions, in no set order. */
export async function readBodyManifestMeta(tx: Raw, pageId: number, occurrenceIds: readonly number[], generation: number): Promise<BodyManifestMeta[]> {
  return tx.executeRaw<BodyManifestMeta>(`SELECT occurrence_id, entry_state, protected_regions
      FROM page_body_manifest WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[]) AND staging_id IS NULL AND gen_from<=$3 AND (gen_to IS NULL OR gen_to>$3)`,
  [pageId, [...occurrenceIds], generation]);
}

/** One manifest row's facts slots and stored outline (both jsonb arrays), read for the page outline. */
export interface BodyManifestOutline {
  occurrence_id: number | string;
  facts_slots: unknown;
  outline: unknown;
}

/** The published rows of generation `generation` of page `pageId` among `occurrenceIds`: their facts slots and stored outline, in no set order. */
export async function readBodyManifestOutline(tx: Raw, pageId: number, occurrenceIds: readonly number[], generation: number): Promise<BodyManifestOutline[]> {
  return tx.executeRaw<BodyManifestOutline>(`SELECT occurrence_id, facts_slots, outline
      FROM page_body_manifest WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[]) AND staging_id IS NULL AND gen_from<=$3 AND (gen_to IS NULL OR gen_to>$3)`,
  [pageId, [...occurrenceIds], generation]);
}

/** The seqs of generation `generation`'s published rows of page `pageId` that end at a forced cut, in seq order. */
export async function listForcedCutSeqs(tx: Raw, pageId: number, generation: number): Promise<number[]> {
  return (await tx.executeRaw<{ seq: number }>(`SELECT seq FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL
      AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2) AND cut_kind='forced' ORDER BY seq`, [pageId, generation])).map(row => Number(row.seq));
}

/** The seq of generation `generation`'s published row of page `pageId` holding stored byte `byteOffset` (the last row starting at or before it), or null. */
export async function readManifestSeqAt(tx: Raw, pageId: number, generation: number, byteOffset: number): Promise<number | null> {
  const [row] = await tx.executeRaw<{ seq: number }>(`SELECT seq FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2
      AND (gen_to IS NULL OR gen_to>$2) AND byte_start<=$3 ORDER BY byte_start DESC, seq DESC LIMIT 1`, [pageId, generation, byteOffset]);
  return row ? Number(row.seq) : null;
}

/** body_bytes of the newest segmented version of page `pageId` that references generation `generation` and records a size, or null. */
export async function readSegmentedVersionBodyBytes(tx: Raw, pageId: number, generation: number): Promise<number | null> {
  const [row] = await tx.executeRaw<{ body_bytes: number | string }>(`SELECT body_bytes FROM page_versions
      WHERE page_id=$1 AND body_generation=$2 AND body_storage='segmented' AND body_bytes IS NOT NULL ORDER BY id DESC LIMIT 1`, [pageId, generation]);
  return row ? Number(row.body_bytes) : null;
}




/** The sources with an access policy (folder rules or pending coverage), in id order: the rulebooks an export of every source carries. */
export async function listAccessPolicySourceIds(tx: Raw): Promise<string[]> {
  return (await tx.executeRaw<{ source_id: string }>('SELECT source_id FROM access_policy_state ORDER BY source_id COLLATE "C"')).map(r => r.source_id);
}

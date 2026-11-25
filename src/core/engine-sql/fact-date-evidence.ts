import type { BrainEngine } from '../engine.ts';
import type { LegacyUnscopedRead } from './brands.ts';

const MAX_ORIGINAL_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

export interface FactDateOriginalRef {
  source_id: string;
  original_page_id: string | number;
  original_revision: string;
}

export interface FactDateCandidate extends FactDateOriginalRef {
  fact_id: number;
  entity_slug: string | null;
  valid_from: string;
  claim_sha256: string;
}

export interface FactDateCohort { source_id: string; day: string }

export interface FactDateEvidenceRows {
  matches: Array<{ index: number; storedDay: string }>;
  originals: Array<FactDateOriginalRef & { body: string }>;
}

/** Use one snapshot for the official cohort and its optional evidence reads. */
export async function withFactDateEvidenceSnapshot<T>(engine: BrainEngine, read: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async tx => {
    await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return read(tx);
  }, { readOnly: true });
}

/**
 * Fetch only the exact live or historical inline revisions supplied by the host operator.
 * This diagnostic returns unknown for segmented, missing, ambiguous or oversized originals.
 */
async function readOriginals(exec: LegacyUnscopedRead, refs: FactDateOriginalRef[]): Promise<FactDateEvidenceRows['originals']> {
  const { rows } = await exec.query<FactDateEvidenceRows['originals'][number]>(`
    WITH requested AS (
      SELECT DISTINCT * FROM jsonb_to_recordset($1::text::jsonb)
        AS r(source_id text, original_page_id bigint, original_revision uuid)
    ), matched AS (
      SELECT a.*, orig.body
       FROM requested a JOIN pages p ON p.source_id=a.source_id AND p.id=a.original_page_id AND p.deleted_at IS NULL
       CROSS JOIN LATERAL (
         SELECT CASE WHEN count(*)=1 THEN min(b.body) END AS body FROM (
           SELECT p.compiled_truth AS body WHERE p.knowledge_revision=a.original_revision AND p.body_storage='inline'
           UNION ALL
           SELECT v.compiled_truth FROM page_versions v WHERE v.page_id=p.id AND v.knowledge_revision=a.original_revision
             AND v.is_deleted IS NOT TRUE AND v.body_storage='inline' AND p.knowledge_revision IS DISTINCT FROM a.original_revision
         ) b
       ) orig
       WHERE octet_length(orig.body)<=$2::integer
    ), bounded AS (
      SELECT *,sum(octet_length(body)) OVER (ORDER BY source_id,original_page_id,original_revision) AS covered_bytes FROM matched
    )
    SELECT source_id,original_page_id,original_revision::text,body FROM bounded WHERE covered_bytes<=$3::integer
    ORDER BY source_id,original_page_id,original_revision
  `, [JSON.stringify(refs), MAX_ORIGINAL_BYTES, MAX_ARCHIVE_BYTES]);
  return rows;
}

/** Match active facts and read only the originals requested for matches. Host diagnostic only. */
export async function readFactDateEvidence(
  exec: LegacyUnscopedRead, cohorts: readonly FactDateCohort[], candidates: readonly FactDateCandidate[],
): Promise<FactDateEvidenceRows> {
  if (!cohorts.length || !candidates.length) return { matches: [], originals: [] };
  const { rows } = await exec.query<{ ord: number; day: string; claim_sha256: string }>(`
    WITH cohort AS (
      SELECT * FROM jsonb_to_recordset($1::text::jsonb) AS d(source_id text, day date)
    )
    SELECT j.ord::int, to_char(d.day,'YYYY-MM-DD') AS day, encode(sha256(convert_to(f.fact, 'UTF8')), 'hex') AS claim_sha256
    FROM jsonb_array_elements($2::text::jsonb) WITH ORDINALITY j(input,ord)
    CROSS JOIN LATERAL jsonb_to_record(j.input) AS a(source_id text, fact_id bigint, entity_slug text, valid_from timestamptz)
    JOIN facts f ON f.source_id=a.source_id AND f.id=a.fact_id AND f.valid_from=a.valid_from AND f.expired_at IS NULL
      AND f.entity_slug IS NOT DISTINCT FROM a.entity_slug
    JOIN cohort d ON d.source_id=f.source_id AND d.day=(f.valid_from AT TIME ZONE 'UTC')::date
    ORDER BY j.ord
  `, [JSON.stringify(cohorts), JSON.stringify(candidates)]);
  const matches: FactDateEvidenceRows['matches'] = [];
  const refs: FactDateOriginalRef[] = [];
  for (const row of rows) {
    const index = row.ord - 1;
    const candidate = candidates[index]!;
    if (candidate.claim_sha256 !== row.claim_sha256) continue;
    matches.push({ index, storedDay: row.day });
    const { source_id, original_page_id, original_revision } = candidate;
    refs.push({ source_id, original_page_id, original_revision });
  }
  return { matches, originals: refs.length ? await readOriginals(exec, refs) : [] };
}

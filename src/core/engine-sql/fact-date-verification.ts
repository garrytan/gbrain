import type { BrainEngine } from '../engine.ts';
import type { BulkFactDay } from '../facts/bulk-days.ts';
import { DATE_CONTEXT_CHARS, FACT_DATE_REVOCATION, FACT_DATE_VERIFICATION, type DateExcerpt, type FactDateProof } from '../facts/fact-date-proof.ts';
import { digest, sha256 } from '../persistence/digest.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

const FACT_ASSERTION = trustedSql(`jsonb_build_array(f.id::text, f.source_id, f.entity_slug, f.fact, f.kind,
  f.attributed_to, f.source, f.source_markdown_slug, f.source_window,
  extract(epoch FROM f.valid_from)::text, f.write_request_id::text)`);

type SqlIdentifier = ReturnType<typeof trustedSql>;
const originalBodies = (revision: ReturnType<typeof sqlFragment>, lockHistory = false) => {
  const current = sqlFragment`p.knowledge_revision=${revision} AND p.body_storage='inline'`;
  return sqlFragment`SELECT p.compiled_truth WHERE ${current}
    UNION ALL
    SELECT retained.compiled_truth FROM (SELECT pv.compiled_truth FROM page_versions pv
      WHERE pv.page_id=p.id AND pv.knowledge_revision=${revision}
        AND pv.is_deleted IS NOT TRUE AND pv.body_storage='inline' AND (${current}) IS NOT TRUE
      ${lockHistory ? sqlFragment`FOR SHARE OF pv` : sqlFragment``}) retained`;
};
const dateExcerptSql = (start: SqlIdentifier, length: SqlIdentifier) => sqlFragment`jsonb_build_object(
  'text',substring(v.compiled_truth FROM ${start} FOR ${length}),
  'before',substring(v.compiled_truth FROM greatest(1,${start}-${DATE_CONTEXT_CHARS}::int) FOR least(${start}-1,${DATE_CONTEXT_CHARS}::int)),
  'after',substring(v.compiled_truth FROM (${start}+${length}) FOR ${DATE_CONTEXT_CHARS}::int))`;

export async function readDateVerificationIncarnation(engine: BrainEngine, sourceId: string, lock = false) {
  const q = renderFragment(sqlFragment`SELECT incarnation::text FROM sources WHERE id=${sourceId} AND NOT archived
    ${lock ? trustedSql('FOR SHARE') : sqlFragment``}`);
  const [row] = await engine.executeRaw<{ incarnation: string }>(q.text, q.params);
  return row?.incarnation;
}

export async function readFactDatePin(engine: BrainEngine, sourceId: string, factId: number, lock = false) {
  const q = renderFragment(sqlFragment`SELECT
    to_char(f.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day,
    ${FACT_ASSERTION} AS assertion
    FROM facts f WHERE f.source_id=${sourceId} AND f.id=${factId}
      AND f.expired_at IS NULL AND f.superseded_by IS NULL AND f.valid_from IS NOT NULL
    ${lock ? trustedSql('FOR SHARE OF f') : sqlFragment``}`);
  const [row] = await engine.executeRaw<{ utc_day: string; assertion: unknown[] }>(q.text, q.params);
  return row ? { utc_day: row.utc_day, fact_digest: digest(row.assertion) } : null;
}

/** Read the pinned original's current or retained inline revision. Offsets are SQL characters. */
export async function readOriginalDateExcerpt(tx: BrainEngine, sourceId: string, pageId: number,
  revision: string, start: number, length: number) {
  const excerpt = dateExcerptSql(trustedSql('a.excerpt_start'), trustedSql('a.excerpt_length'));
  const q = renderFragment(sqlFragment`SELECT ${excerpt} AS excerpt
    FROM pages p CROSS JOIN LATERAL (${originalBodies(sqlFragment`${revision}::uuid`, true)}) v
    CROSS JOIN (SELECT ${start}::int AS excerpt_start, ${length}::int AS excerpt_length) a
    WHERE p.source_id=${sourceId} AND p.id=${pageId}::bigint AND p.deleted_at IS NULL
    LIMIT 2 FOR SHARE OF p`);
  const rows = await tx.executeRaw<{ excerpt: DateExcerpt }>(q.text, q.params);
  return rows.length === 1 ? rows[0]!.excerpt : null;
}

const committedLocalAttestation = trustedSql(`r.state='committed' AND r.principal_kind='local_cli'
  AND r.authority->'remote'='false'::jsonb AND r.page_id IS NULL
  AND r.slug LIKE 'repairs/fact-date-verification/%'
  AND r.slug='repairs/fact-date-verification/' || r.request_id::text`);

export async function readRevocableDateVerification(tx: BrainEngine, sourceId: string, incarnation: string, id: string) {
  const q = renderFragment(sqlFragment`SELECT r.outcome FROM persistence_requests r
    WHERE r.id=${id}::uuid AND r.source_id=${sourceId} AND r.source_incarnation=${incarnation}::uuid
      AND r.operation=${FACT_DATE_VERIFICATION} AND ${committedLocalAttestation}`);
  const [row] = await tx.executeRaw<{ outcome: { proof?: unknown } | null }>(q.text, q.params);
  return row?.outcome;
}

export async function readFactDateAssessments(tx: BrainEngine, days: readonly BulkFactDay[]) {
  const scope = days.map(({ source_id, day }) => ({ source_id, day }));
  const q = renderFragment(sqlFragment`WITH scope AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(scope)}::text::jsonb) AS d(source_id text, day text)
    ), receipts AS MATERIALIZED (
      SELECT r.id, r.source_id, r.source_incarnation, r.operation, r.outcome
      FROM persistence_requests r JOIN sources s ON s.id=r.source_id AND s.incarnation=r.source_incarnation
      WHERE s.archived IS NOT TRUE AND r.source_id IN (SELECT source_id FROM scope)
        AND ${committedLocalAttestation} AND r.operation IN (${FACT_DATE_VERIFICATION},${FACT_DATE_REVOCATION})
    )
    SELECT r.source_id, r.source_incarnation::text, d.day, r.outcome->'proof' AS proof
    FROM receipts r JOIN scope d ON d.source_id=r.source_id AND d.day=r.outcome->>'verified_event_date'
    WHERE r.operation=${FACT_DATE_VERIFICATION} AND NOT EXISTS (
      SELECT 1 FROM receipts v WHERE v.operation=${FACT_DATE_REVOCATION}
        AND v.source_id=r.source_id AND v.source_incarnation=r.source_incarnation
        AND v.outcome->>'revoked_receipt_id'=r.id::text
    )`);
  return tx.executeRaw<{ source_id: string; source_incarnation: string; day: string; proof: unknown }>(q.text, q.params);
}

/** Fetch the live fact and its exact retained excerpt in one batch after receipt shapes have been validated. */
type DateAnchor = Pick<FactDateProof, 'fact_id' | 'utc_day' | 'original_page_id' | 'original_revision' | 'excerpt_start' | 'excerpt_length'>;
export async function readFactDateAnchors(tx: BrainEngine, assessments: Array<DateAnchor & { source_id: string }>) {
  const q = renderFragment(sqlFragment`SELECT a.ord::int AS ord, ${FACT_ASSERTION} AS assertion, f.fact AS claim,
      (SELECT CASE WHEN count(*)=1 THEN jsonb_agg(${dateExcerptSql(trustedSql('proof.excerpt_start'), trustedSql('proof.excerpt_length'))})->0 END
       FROM pages p CROSS JOIN LATERAL (${originalBodies(sqlFragment`proof.original_revision`)}) v
       WHERE p.source_id=proof.source_id AND p.id=proof.original_page_id AND p.deleted_at IS NULL) AS excerpt
    FROM jsonb_array_elements(${JSON.stringify(assessments)}::text::jsonb) WITH ORDINALITY a(input,ord)
    CROSS JOIN LATERAL jsonb_to_record(a.input) AS proof(source_id text, fact_id bigint, utc_day date,
      original_page_id bigint, original_revision uuid, excerpt_start int, excerpt_length int)
    JOIN facts f ON f.source_id=proof.source_id AND f.id=proof.fact_id
      AND f.valid_from >= (proof.utc_day::timestamp AT TIME ZONE 'UTC')
      AND f.valid_from < ((proof.utc_day+1)::timestamp AT TIME ZONE 'UTC')
      AND f.expired_at IS NULL AND f.superseded_by IS NULL`);
  const rows = await tx.executeRaw<{ ord: number; assertion: unknown[]; claim: string; excerpt: DateExcerpt | null }>(q.text, q.params);
  return rows.map(row => ({ index: row.ord - 1, fact_digest: digest(row.assertion), claim_sha256: sha256(row.claim), excerpt: row.excerpt }));
}

export async function useFactDateAuditSnapshot(tx: BrainEngine) {
  await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
}

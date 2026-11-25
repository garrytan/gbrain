import type { BrainEngine } from '../engine.ts';
import { GIT_HOLD_OP, lockGitHoldSummary } from '../persistence/sync-holds.ts';

export interface IngestStamps {
  source_kind: string;
  ingested_via: string;
  ingested_at: string;
}

interface OriginEvidence {
  incarnation: string;
  creation_request: string;
  creation_stamp: string | Date;
  creation_channel: string;
  archived_stamps: IngestStamps;
  canonical_stamps: IngestStamps;
  database_stamps: IngestStamps;
}

export interface FirstIngestRecovery {
  source_id: string;
  slug: string;
  page_id: number;
  revision: string;
  source_incarnation: string;
  creation_request: string;
  edit_request: string;
  before: IngestStamps;
  original: IngestStamps;
}

type RecoveryPage = Pick<FirstIngestRecovery, 'page_id' | 'source_id' | 'slug' | 'revision'>;

/** The physical ingest preimage and the preserved evidence of a managed creation. */
export async function readFirstIngestEvidence(engine: Pick<BrainEngine, 'executeRaw'>, item: RecoveryPage): Promise<OriginEvidence | null> {
  const [row] = await engine.executeRaw<OriginEvidence>(`
    SELECT s.incarnation::text AS incarnation, r.id::text AS creation_request, r.created_at AS creation_stamp,
      CASE r.authority->>'remote' WHEN 'true' THEN 'mcp:put_page' ELSE 'put_page' END AS creation_channel,
      jsonb_build_object('source_kind', v.frontmatter->>'source_kind', 'ingested_via', v.frontmatter->>'ingested_via',
        'ingested_at', v.frontmatter->>'ingested_at') AS archived_stamps,
      jsonb_build_object('source_kind', p.frontmatter->>'source_kind', 'ingested_via', p.frontmatter->>'ingested_via',
        'ingested_at', p.frontmatter->>'ingested_at') AS canonical_stamps,
      jsonb_build_object('source_kind', p.source_kind, 'ingested_via', p.ingested_via, 'ingested_at', to_char(p.ingested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS database_stamps
    FROM pages p JOIN sources s ON s.id=p.source_id
    JOIN LATERAL (
      SELECT write_request_id, knowledge_revision, frontmatter FROM page_versions
      WHERE page_id=p.id ORDER BY id LIMIT 1
    ) v ON true
    JOIN persistence_requests r ON r.id=v.write_request_id
    WHERE p.id=$1 AND p.source_id=$2 AND p.slug=$3 AND p.knowledge_revision=$4::uuid AND p.deleted_at IS NULL
      AND s.archived IS NOT TRUE AND s.config->>'canonical' IS DISTINCT FROM 'git'
      AND r.operation='put_page' AND r.state='committed' AND r.worktree_id IS NOT NULL
      AND r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.authority->>'remote' IN ('true','false')
      AND r.completed_at=p.created_at AND r.outcome->>'revision'=v.knowledge_revision::text AND r.outcome->>'noop'='false'
      AND p.source_kind='mcp:edit_page' AND p.ingested_via='mcp:edit_page'
      AND p.ingested_at>r.created_at`, [item.page_id, item.source_id, item.slug, item.revision]);
  return row ?? null;
}

/** Whether the exact previewed page now holds the intended ingest columns. */
export async function firstIngestAlreadyRestored(engine: Pick<BrainEngine, 'executeRaw'>,
  page: RecoveryPage, sourceIncarnation: string, original: IngestStamps): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.id=$1 AND p.source_id=$2 AND p.slug=$3 AND p.knowledge_revision=$4::uuid AND p.deleted_at IS NULL
      AND s.incarnation=$5::uuid AND s.archived IS NOT TRUE
      AND p.source_kind=$6 AND p.ingested_via=$7 AND p.ingested_at=$8::text::timestamptz`,
  [page.page_id, page.source_id, page.slug, page.revision, sourceIncarnation, original.source_kind, original.ingested_via, original.ingested_at]);
  return rows.length === 1;
}

/** The native owner publication calls this under its page guard. Match the physical preimage at database precision. */
export async function writeFirstIngestRecovery(tx: Pick<BrainEngine, 'executeRaw'>, plan: FirstIngestRecovery): Promise<boolean> {
  // Serialize with sync hold writers before taking the UPDATE's read snapshot.
  await lockGitHoldSummary(tx, plan.source_id, plan.source_incarnation);
  // Bind the timestamps as text so the driver's Date codec cannot round away the preimage's microseconds.
  const rows = await tx.executeRaw(`UPDATE pages p SET source_kind=$6, ingested_via=$7, ingested_at=$8::text::timestamptz
    WHERE id=$1 AND source_id=$2 AND slug=$3 AND knowledge_revision=$4::uuid AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM sources s WHERE s.id=$2 AND s.incarnation=$5::uuid AND s.archived IS NOT TRUE
        AND s.config->>'canonical' IS DISTINCT FROM 'git')
      AND p.source_kind=$9 AND p.ingested_via=$10 AND p.ingested_at=$11::text::timestamptz
      AND NOT EXISTS (SELECT 1 FROM op_checkpoints h WHERE h.op=$12 AND h.completed_keys->0->>'source_id'=p.source_id
        AND h.completed_keys->0->>'incarnation'=$5::uuid::text AND (h.completed_keys->0->>'page_id'=p.id::text OR h.completed_keys->0->>'slug'=p.slug))
    RETURNING p.id`,
  [plan.page_id, plan.source_id, plan.slug, plan.revision, plan.source_incarnation, plan.original.source_kind, plan.original.ingested_via,
    plan.original.ingested_at, plan.before.source_kind, plan.before.ingested_via, plan.before.ingested_at, GIT_HOLD_OP]);
  return rows.length === 1;
}

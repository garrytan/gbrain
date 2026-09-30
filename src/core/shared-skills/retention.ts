import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { declarePersistenceProtocol } from '../persistence/protocol.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from '../persistence/page-mutations.ts';
import { requireUuid } from '../persistence/digest.ts';
import { skillName } from './manifest.ts';

export const SHARED_SKILL_RETENTION_LIMITS = Object.freeze({ recentPerSkill: 20, graceHours: 24,
  sourceRevisions: 10_000, sourceBytes: 256 * 1024 * 1024, pruneBatch: 128,
  brainRevisions: 100_000, brainBytes: 1024 * 1024 * 1024,
  pinHours: 24, principalPins: 64, sourcePins: 256, brainPins: 4096 });

export interface SkillRetentionCapacity {
  retained_revisions: number;
  retained_bytes: number;
  brain_retained_revisions: number;
  brain_retained_bytes: number;
}

export interface SkillRetentionStatus extends SkillRetentionCapacity {
  source_id: string;
  source_incarnation: string;
  protected_heads: number;
  protected_tombstones: number;
  protected_leases: number;
  protected_publications: number;
  eligible_revisions: number;
  pruned_revisions: number;
  capacity_blocked: boolean;
  limits: typeof SHARED_SKILL_RETENTION_LIMITS;
}

const RETENTION_ROWS = `WITH pending AS MATERIALIZED (
  SELECT q.intent->>'expected_revision' AS revision,COALESCE(q.intent->'affected','[]'::jsonb) AS affected
  FROM persistence_requests q WHERE q.source_id=$1 AND q.source_incarnation=$2::uuid
    AND q.target_kind='skill_bundle' AND (q.state IN ('queued','running','recovering') OR q.recovery IS NOT NULL)
), publication_revisions AS MATERIALIZED (
  SELECT revision FROM pending WHERE revision IS NOT NULL
  UNION SELECT a->>'revision' FROM pending CROSS JOIN LATERAL jsonb_array_elements(affected) a WHERE a->>'revision' IS NOT NULL
), ranked AS (
  SELECT r.source_id,r.source_incarnation,r.pack_id,r.name,r.revision,r.created_at,r.deleted,r.stored_bytes,
    row_number() OVER(PARTITION BY r.pack_id,r.name ORDER BY r.created_at DESC,r.revision DESC) AS position
  FROM shared_skill_revisions r WHERE r.source_id=$1 AND r.source_incarnation=$2::uuid
), protected AS (
  SELECT r.*,r.stored_bytes AS bytes,
    EXISTS(SELECT 1 FROM shared_skill_heads h WHERE h.source_id=r.source_id AND h.source_incarnation=r.source_incarnation
      AND h.pack_id=r.pack_id AND h.name=r.name AND h.revision=r.revision) AS head,
    EXISTS(SELECT 1 FROM shared_skill_revision_leases l WHERE l.source_id=r.source_id AND l.source_incarnation=r.source_incarnation
      AND l.pack_id=r.pack_id AND l.name=r.name AND l.revision=r.revision AND l.expires_at>now()) AS leased,
    EXISTS(SELECT 1 FROM publication_revisions p WHERE p.revision=r.revision::text) AS publishing
  FROM ranked r
), candidates AS (
  SELECT *, NOT(head OR deleted OR leased OR publishing) AND position>$3 AND created_at<now()-($4::double precision*interval '1 hour') AS eligible FROM protected
)`;

export async function sharedSkillRetentionStatus(engine: BrainEngine, sourceId: string, incarnation: string): Promise<SkillRetentionStatus> {
  const [row] = await engine.executeRaw<Record<string, string | number>>(`${RETENTION_ROWS}
    SELECT COUNT(*) AS retained_revisions,COALESCE(SUM(bytes),0) AS retained_bytes,
      COUNT(*) FILTER(WHERE head) AS protected_heads,COUNT(*) FILTER(WHERE deleted) AS protected_tombstones,
      COUNT(*) FILTER(WHERE leased) AS protected_leases,COUNT(*) FILTER(WHERE publishing) AS protected_publications,
      COUNT(*) FILTER(WHERE eligible) AS eligible_revisions,
      (SELECT COUNT(*) FROM shared_skill_revisions) AS brain_retained_revisions,
      (SELECT COALESCE(SUM(stored_bytes),0) FROM shared_skill_revisions) AS brain_retained_bytes FROM candidates`,
  [sourceId, incarnation, SHARED_SKILL_RETENTION_LIMITS.recentPerSkill, SHARED_SKILL_RETENTION_LIMITS.graceHours]);
  const retained = Number(row.retained_revisions); const bytes = Number(row.retained_bytes);
  return { source_id: sourceId, source_incarnation: incarnation, retained_revisions: retained, retained_bytes: bytes,
    brain_retained_revisions: Number(row.brain_retained_revisions), brain_retained_bytes: Number(row.brain_retained_bytes),
    protected_heads: Number(row.protected_heads), protected_tombstones: Number(row.protected_tombstones),
    protected_leases: Number(row.protected_leases), protected_publications: Number(row.protected_publications),
    eligible_revisions: Number(row.eligible_revisions), pruned_revisions: 0,
    capacity_blocked: retained >= SHARED_SKILL_RETENTION_LIMITS.sourceRevisions || bytes >= SHARED_SKILL_RETENTION_LIMITS.sourceBytes ||
      Number(row.brain_retained_revisions) >= SHARED_SKILL_RETENTION_LIMITS.brainRevisions || Number(row.brain_retained_bytes) >= SHARED_SKILL_RETENTION_LIMITS.brainBytes,
    limits: SHARED_SKILL_RETENTION_LIMITS };
}

export async function sharedSkillRetentionCapacity(engine: BrainEngine, sourceId: string, incarnation: string): Promise<SkillRetentionCapacity> {
  const [row] = await engine.executeRaw<Record<keyof SkillRetentionCapacity, number | string>>(`SELECT
    COUNT(*) FILTER(WHERE source_id=$1 AND source_incarnation=$2::uuid) AS retained_revisions,
    COALESCE(SUM(stored_bytes) FILTER(WHERE source_id=$1 AND source_incarnation=$2::uuid),0) AS retained_bytes,
    COUNT(*) AS brain_retained_revisions,COALESCE(SUM(stored_bytes),0) AS brain_retained_bytes FROM shared_skill_revisions`, [sourceId, incarnation]);
  return { retained_revisions: Number(row.retained_revisions), retained_bytes: Number(row.retained_bytes),
    brain_retained_revisions: Number(row.brain_retained_revisions), brain_retained_bytes: Number(row.brain_retained_bytes) };
}

export async function pruneSharedSkillRevisionsInTransaction(tx: BrainEngine, sourceId: string, incarnation: string): Promise<number> {
  await tx.executeRaw(`DELETE FROM shared_skill_revision_leases WHERE source_id=$1 AND source_incarnation=$2::uuid AND expires_at<=now()`, [sourceId, incarnation]);
  const candidates = await tx.executeRaw<{ pack_id: string; name: string; revision: string }>(`${RETENTION_ROWS}
    SELECT r.pack_id,r.name,r.revision FROM shared_skill_revisions r JOIN candidates c
      ON c.source_id=r.source_id AND c.source_incarnation=r.source_incarnation AND c.pack_id=r.pack_id AND c.name=r.name AND c.revision=r.revision
    WHERE c.eligible ORDER BY r.created_at,r.pack_id,r.name,r.revision LIMIT $5 FOR UPDATE OF r SKIP LOCKED`,
  [sourceId, incarnation, SHARED_SKILL_RETENTION_LIMITS.recentPerSkill, SHARED_SKILL_RETENTION_LIMITS.graceHours, SHARED_SKILL_RETENTION_LIMITS.pruneBatch]);
  let count = 0;
  if (candidates.length) {
    const deleted = await tx.executeRaw(`${RETENTION_ROWS} DELETE FROM shared_skill_revisions r USING candidates c
      WHERE c.eligible AND r.source_id=c.source_id AND r.source_incarnation=c.source_incarnation AND r.pack_id=c.pack_id
        AND r.name=c.name AND r.revision=c.revision AND r.revision=ANY($5::uuid[])
        AND NOT EXISTS(SELECT 1 FROM shared_skill_revision_leases l WHERE l.source_id=r.source_id AND l.source_incarnation=r.source_incarnation
          AND l.pack_id=r.pack_id AND l.name=r.name AND l.revision=r.revision)
      RETURNING r.revision`,
    [sourceId, incarnation, SHARED_SKILL_RETENTION_LIMITS.recentPerSkill, SHARED_SKILL_RETENTION_LIMITS.graceHours, candidates.map(row => row.revision)]);
    count = deleted.length;
  }
  return count;
}

export function assertSharedSkillRetentionCapacity(status: SkillRetentionCapacity, incomingRevisions: number, incomingBytes: number, exposeCounts = false): void {
  if (status.retained_revisions + incomingRevisions <= SHARED_SKILL_RETENTION_LIMITS.sourceRevisions &&
    status.retained_bytes + incomingBytes <= SHARED_SKILL_RETENTION_LIMITS.sourceBytes &&
    status.brain_retained_revisions + incomingRevisions <= SHARED_SKILL_RETENTION_LIMITS.brainRevisions &&
    status.brain_retained_bytes + incomingBytes <= SHARED_SKILL_RETENTION_LIMITS.brainBytes) return;
  const error = new OperationError('skill_retention_capacity', 'Retained skill revisions exceed this source storage budget.',
    'Inspect get_skill_retention and run bounded prune_skill_revisions after delivery/pin leases or the 24-hour grace period expire. Active revisions and receipts are not deleted.');
  if (exposeCounts) error.detail = JSON.stringify({ ...status, incoming_revisions: incomingRevisions, incoming_bytes: incomingBytes });
  throw error;
}

async function operatorSource(ctx: OperationContext, sourceId: string): Promise<string> {
  if (ctx.remote !== false) throw new OperationError('permission_denied', 'Revision retention is controlled by the trusted local brain operator.');
  const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) throw new OperationError('source_changed', 'The retention source is unavailable.');
  return source.incarnation;
}
export async function getSharedSkillRetention(ctx: OperationContext, sourceId = ctx.sourceId) {
  const incarnation = await operatorSource(ctx, sourceId);
  return sharedSkillRetentionStatus(ctx.engine, sourceId, incarnation);
}
export async function pruneSharedSkillRevisions(ctx: OperationContext, sourceId = ctx.sourceId) {
  const incarnation = await operatorSource(ctx, sourceId);
  return ctx.engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    if (source?.incarnation !== incarnation) throw new OperationError('source_changed', 'The retention source changed.');
    return withCoordinatedWrite(tx, [sourceId], async () => {
      const count = await pruneSharedSkillRevisionsInTransaction(tx, sourceId, incarnation);
      return { ...await sharedSkillRetentionStatus(tx, sourceId, incarnation), pruned_revisions: count };
    });
  });
}
export async function retainSharedSkillRevision(ctx: OperationContext, params: { source_id?: string; source_incarnation: string; pack_id: string; name: string; revision: string; hours?: number }) {
  const sourceId = params.source_id ?? ctx.sourceId;
  const incarnation = await operatorSource(ctx, sourceId);
  if (params.source_incarnation !== incarnation) throw new OperationError('source_changed', 'The pin source incarnation changed.');
  const pack = skillName(params.pack_id, 'pack_id'); const name = skillName(params.name); const revision = requireUuid(params.revision);
  const hours = params.hours ?? SHARED_SKILL_RETENTION_LIMITS.pinHours;
  if (!Number.isFinite(hours) || hours <= 0 || hours > SHARED_SKILL_RETENTION_LIMITS.pinHours) throw new OperationError('invalid_params', 'Retention pins last more than zero and at most 24 hours.');
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  return ctx.engine.transaction(async tx => {
    await tx.executeRaw('SELECT singleton FROM shared_skill_state WHERE singleton=1 FOR UPDATE');
    const existing = await tx.executeRaw(`SELECT revision FROM shared_skill_revisions
      WHERE source_id=$1 AND source_incarnation=$2::uuid AND pack_id=$3 AND name=$4 AND revision=$5::uuid FOR KEY SHARE`, [sourceId, incarnation, pack, name, revision]);
    if (!existing.length) throw new OperationError('revision_unavailable', 'The exact revision is no longer retained.');
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    if (source?.incarnation !== incarnation) throw new OperationError('source_changed', 'The pin source changed.');
    const [count] = await tx.executeRaw<{ principal: number; source: number; brain: number }>(`SELECT COUNT(*) FILTER(WHERE principal_kind=$3 AND principal_id=$4)::int AS principal,
      COUNT(*) FILTER(WHERE source_id=$1 AND source_incarnation=$2::uuid)::int AS source,COUNT(*)::int AS brain
      FROM shared_skill_revision_leases WHERE lease_kind='pin' AND expires_at>now()`, [sourceId, incarnation, principal.kind, principal.id]);
    if (count.principal >= SHARED_SKILL_RETENTION_LIMITS.principalPins || count.source >= SHARED_SKILL_RETENTION_LIMITS.sourcePins || count.brain >= SHARED_SKILL_RETENTION_LIMITS.brainPins) {
      throw new OperationError('skill_retention_capacity', 'The bounded explicit revision-pin quota is full.', 'Wait for existing pins to expire; pins cannot extend delivery or execution authority.');
    }
    const leaseId = randomUUID();
    const [lease] = await tx.executeRaw<{ expires_at: string | Date }>(`INSERT INTO shared_skill_revision_leases
      (lease_kind,lease_id,source_id,source_incarnation,pack_id,name,revision,principal_kind,principal_id,expires_at)
      VALUES('pin',$1::uuid,$2,$3::uuid,$4,$5,$6::uuid,$7,$8,now()+($9::double precision*interval '1 hour')) RETURNING expires_at`,
    [leaseId, sourceId, incarnation, pack, name, revision, principal.kind, principal.id, hours]);
    return { lease_id: leaseId, expires_at: new Date(lease.expires_at).toISOString(), source_id: sourceId, source_incarnation: incarnation, pack_id: pack, name, revision };
  });
}

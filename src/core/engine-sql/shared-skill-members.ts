/**
 * Shared-skill membership: one SQL implementation for both engines (rust/docs/store/shared-skill-members.md).
 *
 * join_brain, sync_brain_skills and leave_brain (shared-skills/membership.ts) and the catalog reads they run
 * (shared-skills/catalog.ts, policy.ts) read and write the membership tables through these. The statements are the
 * text the callers sent through `executeRaw` before, in the same order and inside the caller's transaction. The
 * callers keep every check and every refusal; these only read and write rows.
 *
 * Numeric columns (BIGINT epochs and sequences, the member count) come back as numbers on every engine, as the
 * callers read them through Number() before.
 */
import type { SqlExecutor } from './executor.ts';
import type { StoredSkillRevision } from '../shared-skills/model.ts';

/** The catalog identity: the persistent brain id, the secret the catalog tokens are keyed with, the serving epoch. */
export interface SharedSkillCatalogIdentity { brain_id: string; token_secret: string; serving_epoch: string }

/** The catalog head filter (shared-skills/catalog.ts readSnapshot); a null term matches every row. */
export interface SharedSkillHeadQuery {
  sourceIds: string[] | null; limit: number; sourceId: string | null; sourceIncarnation: string | null;
  packId: string | null; name: string | null; hidePrivate: boolean;
}

/** One `shared_skill_heads` row with the source's current publication policy and its epoch, or null without one. */
export interface SharedSkillHeadRow {
  source_id: string; source_incarnation: string; pack_id: string; name: string; revision: string;
  metadata: Record<string, unknown> & { private?: unknown }; deleted: boolean; policy_epoch: string;
  current_policy: unknown; current_epoch: string | null; [column: string]: unknown;
}

/** One `shared_skill_members` row. */
export interface SharedSkillMemberRow {
  installation_id: string; principal_kind: string; principal_id: string; adapter: string; brain_id: string;
  epoch: number; active: boolean; follow_policy: any; issued_sequence: number; acknowledged_sequence: number;
  desired_view: string | null; acknowledged_view: string | null; joined_at: Date; last_seen_at: Date; join_window: Date; join_count: number;
}

/** A member by its installation id, under the principal that owns it, or by principal and adapter. */
export type SharedSkillMemberLookup =
  | { installationId: string; principalKind: string; principalId: string }
  | { principalKind: string; principalId: string; adapter: string };

/** One `shared_skill_delivery_batches` row. */
export interface SharedSkillBatchRow {
  token: string; installation_id: string; epoch: number; sequence: number; view_token: string; authority_digest: string;
  revisions: string[]; issued_at: Date; acknowledged_at: Date | null; evidence: any;
}

/** A new or re-activated member (join_brain). */
export interface SharedSkillMemberEnroll { installationId: string; principalKind: string; principalId: string; adapter: string; brainId: string; followPolicy: unknown }

/** The delivery batch issue() writes: the candidate batch, under the member's current epoch and issued sequence. */
export interface SharedSkillBatchIssue {
  installationId: string; epoch: number; issuedSequence: number; viewToken: string; authorityDigest: string;
  revisions: string[]; token: string; retainedBatches: number;
}

/** The batch issue() answers: the retained batch with the same view (`created` false) or the new one. */
export interface SharedSkillBatchIssued { batch: SharedSkillBatchRow | Omit<SharedSkillBatchRow, 'installation_id' | 'issued_at'>; created: boolean; issuedSequence: number }

/** An acknowledgment: the batch's evidence and, for a recorded install, the member's acknowledged sequence and view. */
export interface SharedSkillBatchAcknowledge { token: string; evidence: unknown; installationId: string; advance: { sequence: number; viewToken: string } | null }

const num = (value: unknown) => Number(value);

function member(row: SharedSkillMemberRow): SharedSkillMemberRow {
  return { ...row, epoch: num(row.epoch), issued_sequence: num(row.issued_sequence), acknowledged_sequence: num(row.acknowledged_sequence), join_count: num(row.join_count) };
}

function batch(row: SharedSkillBatchRow): SharedSkillBatchRow {
  return { ...row, epoch: num(row.epoch), sequence: num(row.sequence) };
}

/** The brain id, the token secret and the serving epoch, or undefined when either singleton row is missing. */
export async function readSharedSkillCatalogIdentity(exec: SqlExecutor): Promise<SharedSkillCatalogIdentity | undefined> {
  const [row] = await exec.executeRaw<SharedSkillCatalogIdentity>(
    'SELECT b.brain_id,s.token_secret,s.serving_epoch FROM persistence_brain b CROSS JOIN shared_skill_state s WHERE b.singleton=1 AND s.singleton=1');
  return row;
}

/** The live heads of live sources that match the query, in key order, at most `limit` rows. */
export async function listSharedSkillCatalogHeads(exec: SqlExecutor, q: SharedSkillHeadQuery): Promise<SharedSkillHeadRow[]> {
  return exec.executeRaw<SharedSkillHeadRow>(`SELECT h.*,p.policy AS current_policy,p.epoch AS current_epoch FROM shared_skill_heads h
    JOIN sources s ON s.id=h.source_id AND s.incarnation=h.source_incarnation
    LEFT JOIN shared_skill_policies p ON p.source_id=h.source_id AND p.source_incarnation=h.source_incarnation
    WHERE NOT h.deleted AND NOT s.archived AND ($1::text[] IS NULL OR h.source_id=ANY($1::text[]))
    AND ($3::text IS NULL OR h.source_id=$3) AND ($4::text IS NULL OR h.source_incarnation::text=$4)
    AND ($5::text IS NULL OR h.pack_id=$5) AND ($6::text IS NULL OR h.name=$6)
    AND ($7::boolean=false OR COALESCE((h.metadata->>'private')::boolean,false)=false)
    ORDER BY h.source_id COLLATE "C",h.source_incarnation,h.pack_id COLLATE "C",h.name COLLATE "C" LIMIT $2`,
  [q.sourceIds, q.limit, q.sourceId, q.sourceIncarnation, q.packId, q.name, q.hidePrivate]);
}

/** A source incarnation's sealed skill pack: its id, revision, manifest and manifest hash, or undefined. */
export interface SharedSkillPackRow { pack_id: string; revision: string; manifest: Record<string, unknown>; manifest_hash: string }
export async function readSharedSkillPackRow(exec: SqlExecutor, sourceId: string, incarnation: string): Promise<SharedSkillPackRow | undefined> {
  const [row] = await exec.executeRaw<SharedSkillPackRow>(
    'SELECT pack_id,revision::text AS revision,manifest,manifest_hash FROM shared_skill_packs WHERE source_id=$1 AND source_incarnation=$2::uuid', [sourceId, incarnation]);
  return row;
}

/** A source incarnation's stored publication policy and its epoch, or undefined; `lock` reads it FOR SHARE. */
export async function readSharedSkillPolicyRow(exec: SqlExecutor, sourceId: string, incarnation: string, lock: boolean): Promise<{ epoch: string; policy: unknown } | undefined> {
  const sql = lock
    ? 'SELECT epoch,policy FROM shared_skill_policies WHERE source_id=$1 AND source_incarnation=$2::uuid FOR SHARE'
    : 'SELECT epoch,policy FROM shared_skill_policies WHERE source_id=$1 AND source_incarnation=$2::uuid';
  const [row] = await exec.executeRaw<{ epoch: string; policy: unknown }>(sql, [sourceId, incarnation]);
  return row;
}

/** A source incarnation's new publication policy and its audit row (shared-skills/policy.ts setSharedSkillPolicy). */
export interface SharedSkillPolicyWrite {
  sourceId: string; incarnation: string; epoch: string; policy: unknown;
  principalKind: string; principalId: string; previousEpoch: string;
}

/** One published revision and the head it moves (shared-skills/publication.ts apply). */
export interface SharedSkillRevisionWrite {
  sourceId: string; incarnation: string; packId: string; name: string; revision: string;
  metadata: unknown; files: unknown; deleted: boolean; policyEpoch: string; requestId: string;
}

/** The key of one stored revision (shared-skills/catalog.ts get_skill). */
export interface SharedSkillRevisionKey { sourceId: string; incarnation: string; packId: string; name: string; revision: string }

/** Upserts the source incarnation's policy under the new epoch, then appends its audit row. */
export async function writeSharedSkillPolicy(exec: SqlExecutor, w: SharedSkillPolicyWrite): Promise<void> {
  await exec.executeRaw(`INSERT INTO shared_skill_policies(source_id,source_incarnation,epoch,policy) VALUES($1,$2::uuid,$3::uuid,$4::text::jsonb)
      ON CONFLICT(source_id,source_incarnation) DO UPDATE SET epoch=excluded.epoch,policy=excluded.policy,updated_at=now()`,
  [w.sourceId, w.incarnation, w.epoch, JSON.stringify(w.policy)]);
  await exec.executeRaw(`INSERT INTO shared_skill_policy_audit(source_id,source_incarnation,principal_kind,principal_id,previous_epoch,epoch,policy)
      VALUES($1,$2::uuid,$3,$4,$5,$6::uuid,$7::text::jsonb)`,
  [w.sourceId, w.incarnation, w.principalKind, w.principalId, w.previousEpoch, w.epoch, JSON.stringify(w.policy)]);
}

/**
 * Inserts the revision, then upserts its head. The publication guard trigger refuses both outside a coordinated
 * write of the source on an activated brain (code 42501); a revision that exists already is the primary key's 23505.
 */
export async function writeSharedSkillRevision(exec: SqlExecutor, w: SharedSkillRevisionWrite): Promise<void> {
  await exec.executeRaw(`INSERT INTO shared_skill_revisions(source_id,source_incarnation,pack_id,name,revision,metadata,files,deleted,policy_epoch,request_id)
          VALUES($1,$2::uuid,$3,$4,$5::uuid,$6::text::jsonb,$7::text::jsonb,$8,$9,$10::uuid)`,
  [w.sourceId, w.incarnation, w.packId, w.name, w.revision, JSON.stringify(w.metadata), JSON.stringify(w.files), w.deleted, w.policyEpoch, w.requestId]);
  await exec.executeRaw(`INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,deleted,policy_epoch)
          VALUES($1,$2::uuid,$3,$4,$5::uuid,$6::text::jsonb,$7,$8) ON CONFLICT(source_id,source_incarnation,pack_id,name)
          DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata,deleted=excluded.deleted,policy_epoch=excluded.policy_epoch,updated_at=now()`,
  [w.sourceId, w.incarnation, w.packId, w.name, w.revision, JSON.stringify(w.metadata), w.deleted, w.policyEpoch]);
}

/** One stored revision that is not deleted, or undefined. */
export async function readSharedSkillRevision(exec: SqlExecutor, k: SharedSkillRevisionKey): Promise<StoredSkillRevision | undefined> {
  const [row] = await exec.executeRaw<StoredSkillRevision>(`SELECT source_id,source_incarnation,pack_id,name,revision,metadata,files,deleted,policy_epoch FROM shared_skill_revisions
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND pack_id=$3 AND name=$4 AND revision=$5::uuid AND NOT deleted`,
  [k.sourceId, k.incarnation, k.packId, k.name, k.revision]);
  return row;
}

/** The sources a member may follow: not archived, in both lists (a null list matches all), by id, at most 65 rows. */
export async function listSharedSkillFollowSources(exec: SqlExecutor, allowed: string[] | null, sourceIds: string[] | null): Promise<Array<{ id: string; incarnation: string }>> {
  return exec.executeRaw<{ id: string; incarnation: string }>(`SELECT id,incarnation FROM sources
    WHERE NOT archived AND ($1::text[] IS NULL OR id=ANY($1::text[])) AND ($2::text[] IS NULL OR id=ANY($2::text[])) ORDER BY id COLLATE "C" LIMIT 65`, [allowed, sourceIds]);
}

/** The persistent brain id, locked FOR UPDATE (run it inside the join's transaction), or undefined without the row. */
export async function lockSharedSkillBrainId(exec: SqlExecutor): Promise<string | undefined> {
  const [row] = await exec.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1 FOR UPDATE');
  return row?.brain_id;
}

/** One member, locked FOR UPDATE, or undefined. A lookup by installation id matches only under its own principal. */
export async function readSharedSkillMember(exec: SqlExecutor, by: SharedSkillMemberLookup): Promise<SharedSkillMemberRow | undefined> {
  const [row] = 'installationId' in by
    ? await exec.executeRaw<SharedSkillMemberRow>(`SELECT * FROM shared_skill_members WHERE installation_id=$1::uuid
    AND principal_kind=$2 AND principal_id=$3 FOR UPDATE`, [by.installationId, by.principalKind, by.principalId])
    : await exec.executeRaw<SharedSkillMemberRow>('SELECT * FROM shared_skill_members WHERE principal_kind=$1 AND principal_id=$2 AND adapter=$3 FOR UPDATE', [by.principalKind, by.principalId, by.adapter]);
  return row && member(row);
}

/** The number of members, active or not. */
export async function countSharedSkillMembers(exec: SqlExecutor): Promise<number> {
  const [count] = await exec.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM shared_skill_members');
  return num(count!.n);
}

/**
 * Inserts the member, or re-activates the one with this installation id: the next epoch, the new follow policy, the
 * sequences and views reset, and the join count and window advanced (a window older than an hour restarts at 1).
 */
export async function enrollSharedSkillMember(exec: SqlExecutor, spec: SharedSkillMemberEnroll): Promise<void> {
  await exec.executeRaw(`INSERT INTO shared_skill_members(installation_id,principal_kind,principal_id,adapter,brain_id,follow_policy)
        VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::text::jsonb) ON CONFLICT(installation_id) DO UPDATE SET active=true,
        epoch=shared_skill_members.epoch+1,follow_policy=EXCLUDED.follow_policy,issued_sequence=0,acknowledged_sequence=0,desired_view=NULL,acknowledged_view=NULL,joined_at=now(),
        join_count=CASE WHEN shared_skill_members.join_window<now()-interval '1 hour' THEN 1 ELSE shared_skill_members.join_count+1 END,
        join_window=CASE WHEN shared_skill_members.join_window<now()-interval '1 hour' THEN now() ELSE shared_skill_members.join_window END`,
  [spec.installationId, spec.principalKind, spec.principalId, spec.adapter, spec.brainId, JSON.stringify(spec.followPolicy)]);
}

/** Sets an active member's narrowed follow policy and epoch, and resets its sequences and views. */
export async function rebindSharedSkillMember(exec: SqlExecutor, installationId: string, followPolicy: unknown, epoch: number): Promise<void> {
  await exec.executeRaw(`UPDATE shared_skill_members SET follow_policy=$2::text::jsonb,epoch=$3,issued_sequence=0,acknowledged_sequence=0,desired_view=NULL,acknowledged_view=NULL WHERE installation_id=$1::uuid`, [installationId, JSON.stringify(followPolicy), epoch]);
}

/** Marks the member inactive. */
export async function leaveSharedSkillMember(exec: SqlExecutor, installationId: string): Promise<void> {
  await exec.executeRaw('UPDATE shared_skill_members SET active=false WHERE installation_id=$1::uuid', [installationId]);
}

/**
 * Issues a delivery batch: drops the member's batches from another epoch or older than 24 hours; keeps the batch at
 * the issued sequence with the same view and authority, or inserts the next one and records it on the member; keeps
 * only the newest `retainedBatches` of the epoch; and marks the member seen (at most once a minute). An insert the
 * retention lease refuses throws the engine's error unchanged (code 23503, `revision_unavailable: ...`).
 */
export async function issueSharedSkillDeliveryBatch(exec: SqlExecutor, s: SharedSkillBatchIssue): Promise<SharedSkillBatchIssued> {
  await exec.executeRaw(`DELETE FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid
    AND (epoch<>$2 OR issued_at < now()-interval '24 hours')`, [s.installationId, s.epoch]);
  const [prior] = await exec.executeRaw<SharedSkillBatchRow>(`SELECT * FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid AND epoch=$2
    AND view_token=$3 AND authority_digest=$4 AND sequence=$5 ORDER BY sequence DESC LIMIT 1`, [s.installationId, s.epoch, s.viewToken, s.authorityDigest, s.issuedSequence]);
  let issued: SharedSkillBatchIssued;
  if (prior) {
    issued = { batch: batch(prior), created: false, issuedSequence: s.issuedSequence };
  } else {
    const sequence = s.issuedSequence + 1;
    await exec.executeRaw(`INSERT INTO shared_skill_delivery_batches(token,installation_id,epoch,sequence,view_token,authority_digest,revisions)
        VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7::text::jsonb)`, [s.token, s.installationId, s.epoch, sequence, s.viewToken, s.authorityDigest, JSON.stringify(s.revisions)]);
    await exec.executeRaw('UPDATE shared_skill_members SET issued_sequence=$2,desired_view=$3 WHERE installation_id=$1::uuid', [s.installationId, sequence, s.viewToken]);
    issued = { batch: { token: s.token, epoch: s.epoch, sequence, view_token: s.viewToken, authority_digest: s.authorityDigest, revisions: s.revisions, acknowledged_at: null, evidence: null },
      created: true, issuedSequence: sequence };
  }
  await exec.executeRaw(`DELETE FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid AND token NOT IN
    (SELECT token FROM shared_skill_delivery_batches WHERE installation_id=$1::uuid AND epoch=$2 ORDER BY sequence DESC LIMIT $3)`,
  [s.installationId, s.epoch, s.retainedBatches]);
  await exec.executeRaw(`UPDATE shared_skill_members SET last_seen_at=now() WHERE installation_id=$1::uuid AND last_seen_at<now()-interval '1 minute'`, [s.installationId]);
  return issued;
}

/** The member's batch under this epoch issued within 24 hours, locked FOR UPDATE, or undefined. */
export async function readSharedSkillDeliveryBatch(exec: SqlExecutor, token: string, installationId: string, epoch: number): Promise<SharedSkillBatchRow | undefined> {
  const [row] = await exec.executeRaw<SharedSkillBatchRow>(`SELECT * FROM shared_skill_delivery_batches WHERE token=$1::uuid AND installation_id=$2::uuid AND epoch=$3
        AND issued_at>=now()-interval '24 hours' FOR UPDATE`, [token, installationId, epoch]);
  return row && batch(row);
}

/** Records the batch's acknowledgment evidence and, with `advance`, the member's acknowledged sequence and view. */
export async function acknowledgeSharedSkillDeliveryBatch(exec: SqlExecutor, a: SharedSkillBatchAcknowledge): Promise<void> {
  await exec.executeRaw('UPDATE shared_skill_delivery_batches SET acknowledged_at=now(),evidence=$2::text::jsonb WHERE token=$1::uuid', [a.token, JSON.stringify(a.evidence)]);
  if (a.advance) {
    await exec.executeRaw(`UPDATE shared_skill_members SET acknowledged_sequence=GREATEST(acknowledged_sequence,$2),acknowledged_view=$3 WHERE installation_id=$1::uuid`, [a.installationId, a.advance.sequence, a.advance.viewToken]);
  }
}

/** One member following a source, as shared-skills/migration-members.ts inspects it. */
export interface SharedMemberMigrationRow {
  installation_id: string; adapter: string; epoch: string | number; active: boolean;
  approved_incarnation: string | null; desired_view: string | null; acknowledged_view: string | null; stage: string | null;
}

/** The statement shared-skills/migration-members.ts inspectSharedMemberMigration ran through executeRaw. */
export const SHARED_MEMBER_MIGRATION_SQL = `SELECT m.installation_id,m.adapter,m.epoch,m.active,m.follow_policy->'sources'->>$1 AS approved_incarnation,
      m.desired_view,m.acknowledged_view,
      (SELECT b.evidence->>'stage' FROM shared_skill_delivery_batches b WHERE b.installation_id=m.installation_id
        AND b.epoch=m.epoch AND b.sequence=m.acknowledged_sequence AND b.acknowledged_at IS NOT NULL LIMIT 1) AS stage
    FROM shared_skill_members m WHERE m.follow_policy->'sources' ? $1 ORDER BY m.adapter COLLATE "C",m.installation_id LIMIT 4096`;

/**
 * The members whose follow policy names source `sourceId`, by byte order of adapter and then installation id (at most
 * 4096), with the incarnation each approved and the stage its acknowledged batch reported. A failure is thrown unchanged.
 */
export function listSharedMemberMigrationRows(exec: Pick<SqlExecutor, 'executeRaw'>, sourceId: string): Promise<SharedMemberMigrationRow[]> {
  return exec.executeRaw<SharedMemberMigrationRow>(SHARED_MEMBER_MIGRATION_SQL, [sourceId]);
}

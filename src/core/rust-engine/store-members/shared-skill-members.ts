/**
 * The shared-skill membership members (engine-sql/shared-skill-members.ts) on the Rust store
 * (rust/docs/store/shared-skill-members.md): the catalog identity, the members join_brain enrolls and leave_brain
 * marks inactive, and the delivery batches sync_brain_skills issues and acknowledges.
 *
 * Each write is one store write: an issue (prune, reuse or insert, member update, retention trim, last-seen mark)
 * and an acknowledge (batch evidence, member advance) commit together or not at all. A store refusal names the
 * Postgres constraint, so it leaves here as the Postgres error would: `code` 23505 (unique) or 23503 (foreign key, and
 * the delivery-lease `revision_unavailable` refusal) with `constraint_name`. An id that is not a UUID leaves as
 * Postgres' 22P02.
 *
 * The store keeps no shared-skill heads and no shared-skill policies: the catalog snapshot is empty and every source
 * reads the legacy policy (allow_follow false), so a join on a Rust brain binds no source. The token secret is the
 * one the store seeded at brain creation (minted once for an older brain); the serving epoch is
 * readSharedSkillServingEpoch's (access-grants.ts). The store runs one write transaction at a time, so the FOR UPDATE
 * locks the SQL engines take change nothing here.
 */
import type {
  SharedSkillBatchAcknowledge, SharedSkillBatchIssue, SharedSkillBatchIssued, SharedSkillBatchRow, SharedSkillCatalogIdentity,
  SharedSkillHeadQuery, SharedSkillHeadRow, SharedSkillMemberEnroll, SharedSkillMemberLookup, SharedSkillMemberRow,
} from '../../engine-sql/shared-skill-members.ts';
import { withDates } from '../store-codec.ts';
import { storeErrorCode } from '../store-errors.ts';
import { readSharedSkillServingEpoch } from './access-grants.ts';
import { storeCall, type StoreMember } from './common.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

const PG_CODE: ReadonlyArray<[RegExp, string]> = [[/_(pkey|key)$/, '23505'], [/_fkey$/, '23503'], [/^shared_skill_delivery_lease$/, '23503']];

/** A store refusal as the Postgres error the SQL engines throw; any other error unchanged. */
function asPostgresError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = storeErrorCode(error);
  if (code === 'invalid_argument' && /invalid input syntax for type uuid/.test(error.message)) {
    return Object.assign(new Error(error.message), { code: '22P02' });
  }
  if (code !== 'constraint_violation') return error;
  const constraint = /\(constraint ([a-z0-9_]+)\)$/.exec(error.message)?.[1];
  const pgCode = constraint ? PG_CODE.find(([re]) => re.test(constraint))?.[1] : undefined;
  if (!constraint || !pgCode) return error;
  return Object.assign(new Error(error.message.replace(/ \(constraint [a-z0-9_]+\)$/, '')), { code: pgCode, constraint_name: constraint });
}

async function call<T>(member: string, run: () => Promise<T>): Promise<T> {
  try {
    return await storeCall({ member }, run);
  } catch (error) {
    throw asPostgresError(error);
  }
}

const MEMBER_DATES = ['joined_at', 'last_seen_at', 'join_window'];
const BATCH_DATES = ['issued_at', 'acknowledged_at'];

export const readSharedSkillCatalogIdentity: StoreMember<[], SharedSkillCatalogIdentity | undefined> = async (brain) => {
  const brainId = await readPersistenceBrainId(brain);
  if (brainId === null) return undefined;
  const tokenSecret = await call('readSharedSkillCatalogIdentity', () => brain.sharedSkillTokenSecret()) as string;
  const servingEpoch = await readSharedSkillServingEpoch(brain);
  return servingEpoch === null ? undefined : { brain_id: brainId, token_secret: tokenSecret, serving_epoch: servingEpoch };
};

/** The store keeps no shared-skill heads. */
export const listSharedSkillCatalogHeads: StoreMember<[q: SharedSkillHeadQuery], SharedSkillHeadRow[]> = async () => [];

/** The store keeps no shared-skill policies, so every source reads the legacy policy. */
export const readSharedSkillPolicyRow: StoreMember<[sourceId: string, incarnation: string, lock: boolean], { epoch: string; policy: unknown } | undefined> =
  async () => undefined;

export const listSharedSkillFollowSources: StoreMember<[allowed: string[] | null, sourceIds: string[] | null], Array<{ id: string; incarnation: string }>> =
  async (brain, allowed, sourceIds) =>
    await call('listSharedSkillFollowSources', () => brain.listSharedSkillFollowSources(allowed, sourceIds)) as Array<{ id: string; incarnation: string }>;

/** The brain id; the store runs one write at a time, so there is no row lock to take. */
export const lockSharedSkillBrainId: StoreMember<[], string | undefined> = async (brain) => (await readPersistenceBrainId(brain)) ?? undefined;

export const readSharedSkillMember: StoreMember<[by: SharedSkillMemberLookup], SharedSkillMemberRow | undefined> = async (brain, by) => {
  const row = await call('readSharedSkillMember', () => brain.readSharedSkillMember(by)) as SharedSkillMemberRow | null;
  return row ? withDates(row, MEMBER_DATES) : undefined;
};

export const countSharedSkillMembers: StoreMember<[], number> = async (brain) =>
  Number(await call('countSharedSkillMembers', () => brain.countSharedSkillMembers()));

export const enrollSharedSkillMember: StoreMember<[spec: SharedSkillMemberEnroll], void> = async (brain, spec) => {
  await call('enrollSharedSkillMember', () => brain.enrollSharedSkillMember(spec));
};

export const rebindSharedSkillMember: StoreMember<[installationId: string, followPolicy: unknown, epoch: number], void> =
  async (brain, installationId, followPolicy, epoch) => {
    await call('rebindSharedSkillMember', () => brain.rebindSharedSkillMember(installationId, followPolicy ?? null, epoch));
  };

export const leaveSharedSkillMember: StoreMember<[installationId: string], void> = async (brain, installationId) => {
  await call('leaveSharedSkillMember', () => brain.leaveSharedSkillMember(installationId));
};

export const issueSharedSkillDeliveryBatch: StoreMember<[spec: SharedSkillBatchIssue], SharedSkillBatchIssued> = async (brain, spec) => {
  const out = await call('issueSharedSkillDeliveryBatch', () => brain.issueSharedSkillDeliveryBatch(spec)) as SharedSkillBatchIssued;
  return { ...out, batch: withDates(out.batch, BATCH_DATES) };
};

export const readSharedSkillDeliveryBatch: StoreMember<[token: string, installationId: string, epoch: number], SharedSkillBatchRow | undefined> =
  async (brain, token, installationId, epoch) => {
    const row = await call('readSharedSkillDeliveryBatch', () => brain.readSharedSkillDeliveryBatch(token, installationId, epoch)) as SharedSkillBatchRow | null;
    return row ? withDates(row, BATCH_DATES) : undefined;
  };

export const acknowledgeSharedSkillDeliveryBatch: StoreMember<[spec: SharedSkillBatchAcknowledge], void> = async (brain, spec) => {
  await call('acknowledgeSharedSkillDeliveryBatch', () => brain.acknowledgeSharedSkillDeliveryBatch({ ...spec, evidence: spec.evidence ?? null }));
};

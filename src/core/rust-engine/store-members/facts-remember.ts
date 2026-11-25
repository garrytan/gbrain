/**
 * The facts members a remember, a proposal review, a page retire and a recall by id use, served from the facts store
 * (rust/crates/gbrain-store/src/facts/remember_reads.rs): `readFactEntitySlugById`, `readSupersessionReplacement`,
 * `linkSupersededFact`, `listFactsToRetireFromPage`, `listFactRowsByIds`, `readFactVisibility`,
 * `readFactActivity`, `readReviewAcceptedMark`, `readPairFactRow`, `expireSupersededFact`, `retireSupersededFact`, `restoreSupersededFact`,
 * `readReplacementTarget`, `readMemberPageWithdrawal` and `readClaimWithdrawal` (src/core/engine-sql/facts-trust.ts,
 * facts-recall.ts).
 *
 * An id that is not a whole number refuses rather than guess at PGLite's `bigint` error, and so does a time that is not
 * an ISO instant: the callers pass ids from rows and `toISOString()` text, so the refusal is a guard, never a path they
 * take. `readReplacementTarget` and `readClaimWithdrawal` under `excludePrivate` serve the remote provenance floor
 * (`storeFloorPolicy`: no caller record, or a member, owner or unrestricted record), and `readMemberPageWithdrawal` the
 * page policy of a page's member, or the owner read rule for the brain owner (`storeMemberReadPolicy`); any other
 * caller refuses.
 */
import type { BrainEngine } from '../../engine.ts';
import type { ReplacementTargetRow, SupersessionReplacementRow } from '../../engine-sql/facts-trust.ts';
import { withDates } from '../store-codec.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { FACT_DATES, withVector } from './fact-codec.ts';
import { storeFloorPolicy, storeMemberReadPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;
type Row = Record<string, unknown>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function wholeId(member: string, id: number | null): void {
  if (id !== null && !Number.isSafeInteger(id)) refuseMember(member, 'an id that is not a whole number');
}

function instant(member: string, what: string, value: string | null): void {
  if (value !== null && (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value)))) refuseMember(member, `${what} that is not an ISO instant`);
}

const fact = (row: Row): Row => withDates(withVector(row), FACT_DATES);

export const readFactEntitySlugById: Member<'readFactEntitySlugById'> = async (brain, id) => {
  wholeId('readFactEntitySlugById', id);
  return storeCall({ member: 'readFactEntitySlugById' }, () => brain.readFactEntitySlugById({ id }));
};

export const readSupersessionReplacement: Member<'readSupersessionReplacement'> = async (brain, newId, oldId) => {
  wholeId('readSupersessionReplacement', newId);
  wholeId('readSupersessionReplacement', oldId);
  const row: SupersessionReplacementRow | null = await storeCall({ member: 'readSupersessionReplacement' }, () => brain.readSupersessionReplacement({ newId, oldId }));
  return row ? withDates(row, ['valid_from', 'old_from', 'old_until']) : null;
};

export const linkSupersededFact: Member<'linkSupersededFact'> = async (brain, oldId, newId) => {
  wholeId('linkSupersededFact', oldId);
  wholeId('linkSupersededFact', newId);
  await storeCall({ member: 'linkSupersededFact' }, () => brain.linkSupersededFact({ oldId, newId }));
};

export const listFactsToRetireFromPage: Member<'listFactsToRetireFromPage'> = async (brain, sourceId, session, slug, pattern) =>
  storeCall({ member: 'listFactsToRetireFromPage', sourceId }, () => brain.listFactsToRetireFromPage({ sourceId, session, slug, pattern }));

export const listFactRowsByIds: Member<'listFactRowsByIds'> = async (brain, sourceIds, ids) => {
  for (const id of ids) wholeId('listFactRowsByIds', id);
  const rows: Row[] = await storeCall({ member: 'listFactRowsByIds' }, () => brain.listFactRowsByIds({ sourceIds: [...sourceIds], ids: [...ids] }));
  return rows.map(fact) as never;
};

export const readFactVisibility: Member<'readFactVisibility'> = async (brain, id, sourceId) => {
  wholeId('readFactVisibility', id);
  return storeCall({ member: 'readFactVisibility', sourceId }, () => brain.readFactVisibility({ id, sourceId }));
};

export const readFactActivity: Member<'readFactActivity'> = async (brain, id, sourceId) => {
  wholeId('readFactActivity', id);
  return storeCall({ member: 'readFactActivity', sourceId }, () => brain.readFactActivity({ id, sourceId }));
};

export const readReviewAcceptedMark: Member<'readReviewAcceptedMark'> = async (brain, id, sourceId, mark) => {
  wholeId('readReviewAcceptedMark', id);
  return storeCall({ member: 'readReviewAcceptedMark', sourceId }, () => brain.readReviewAcceptedMark({ id, sourceId, mark }));
};

export const readPairFactRow: Member<'readPairFactRow'> = async (brain, id, lock) => {
  wholeId('readPairFactRow', id);
  const row: Row | null = await storeCall({ member: 'readPairFactRow' }, () => brain.readPairFactRow({ id, lock: lock ?? false }));
  return row ? withDates(row, ['expired_at', 'valid_from', 'valid_until']) : null;
};

export const expireSupersededFact: Member<'expireSupersededFact'> = async (brain, q) => {
  wholeId('expireSupersededFact', q.oldId);
  wholeId('expireSupersededFact', q.newId);
  instant('expireSupersededFact', 'an until', q.until);
  return storeCall({ member: 'expireSupersededFact', sourceId: q.sourceId }, () => brain.expireSupersededFact({ oldId: q.oldId, sourceId: q.sourceId, newId: q.newId, until: q.until }));
};

export const retireSupersededFact: Member<'retireSupersededFact'> = async (brain, q) => {
  wholeId('retireSupersededFact', Number(q.oldId));
  wholeId('retireSupersededFact', q.newId);
  return storeCall({ member: 'retireSupersededFact', sourceId: q.sourceId }, () => brain.retireSupersededFact({ oldId: Number(q.oldId), sourceId: q.sourceId,
    newId: q.newId, until: q.until === null ? null : q.until.toISOString() }));
};

export const restoreSupersededFact: Member<'restoreSupersededFact'> = async (brain, q) => {
  wholeId('restoreSupersededFact', q.oldId);
  wholeId('restoreSupersededFact', q.supersededBy);
  wholeId('restoreSupersededFact', q.expectedSupersededBy);
  instant('restoreSupersededFact', 'an expiredAt', q.expiredAt);
  instant('restoreSupersededFact', 'a validUntil', q.validUntil);
  return storeCall({ member: 'restoreSupersededFact', sourceId: q.sourceId }, () => brain.restoreSupersededFact({ ...q }));
};

export const readReplacementTarget: Member<'readReplacementTarget'> = async (brain, q) => {
  wholeId('readReplacementTarget', q.targetId);
  const excludePrivate = q.excludePrivate ? storeFloorPolicy('readReplacementTarget') : undefined;
  const row: Row | null = await storeCall({ member: 'readReplacementTarget', sourceId: q.sourceId }, () =>
    brain.readReplacementTarget({ targetId: q.targetId, sourceId: q.sourceId, excludePrivate, ownPage: q.ownPage ?? null, lock: q.lock ?? false }));
  return row ? (fact(row) as unknown as ReplacementTargetRow) : null;
};

export const readMemberPageWithdrawal: Member<'readMemberPageWithdrawal'> = async (brain, q) => {
  const policy = storeMemberReadPolicy('readMemberPageWithdrawal', q);
  return storeCall({ member: 'readMemberPageWithdrawal', sourceId: q.sourceId }, () =>
    brain.readMemberPageWithdrawal({ sourceId: q.sourceId, visibility: q.visibility, fact: q.fact, entitySlug: q.entitySlug ?? null, page: q.page, owner: q.owner, policy }));
};

export const readClaimWithdrawal: Member<'readClaimWithdrawal'> = async (brain, q) => {
  const excludePrivate = q.excludePrivate ? storeFloorPolicy('readClaimWithdrawal') : undefined;
  return storeCall({ member: 'readClaimWithdrawal', sourceId: q.sourceId }, () =>
    brain.readClaimWithdrawal({ sourceId: q.sourceId, visibility: q.visibility, fact: q.fact, entitySlug: q.entitySlug ?? null, ownPage: q.ownPage ?? null, excludePrivate }));
};

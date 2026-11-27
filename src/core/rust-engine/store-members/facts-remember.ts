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
 * take. Two exceptions answer as Postgres does: `readReplacementTarget` fails a fractional id with the bigint cast error,
 * and `expireSupersededFact` / `restoreSupersededFact` read Postgres timestamp text (`2026-03-01 00:00:00+00`). `readReplacementTarget` and `readClaimWithdrawal` under `excludePrivate` serve the remote provenance floor
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

/** Postgres timestamptz text with a date, a time and a zone: `T` or a space between them, a `Z` or an hour offset. */
const PG_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * A time the SQL engines bind as `timestamptz`, as the ISO instant the store reads: an ISO instant passes as it is, and
 * the Postgres text form (`2026-03-01 00:00:00+00`) is read the way Postgres reads it. Any other text (a date alone, a
 * zone name, a word like `now`) refuses, because the store would have to guess Postgres' wider parser.
 */
function pgInstant(member: string, what: string, value: string | null): string | null {
  if (value === null || (ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value)))) return value;
  const m = PG_INSTANT.exec(value);
  if (m) {
    const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const zone = m[8]!.toUpperCase();
    const offset = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(1).replace(':', '').slice(2) || 0));
    const local = Date.UTC(y, mo - 1, d, h, mi, sec);
    const real = new Date(local);
    if (h < 24 && mi < 60 && sec < 60 && real.getUTCFullYear() === y && real.getUTCMonth() === mo - 1 && real.getUTCDate() === d) {
      const fraction = m[7] ? `.${m[7]}` : '';
      return `${new Date(local - offset * 60_000).toISOString().slice(0, 19)}${fraction}Z`;
    }
  }
  return refuseMember(member, `${what} that is not an ISO instant or Postgres timestamp text`);
}

/** A bigint id: a fraction fails as Postgres fails the `bigint` cast (22P02); NaN, an infinity or past 2^53 refuses. */
function bigintId(member: string, id: number): void {
  if (Number.isSafeInteger(id)) return;
  if (Number.isFinite(id) && Math.abs(id) <= Number.MAX_SAFE_INTEGER) {
    throw Object.assign(new Error(`invalid input syntax for type bigint: "${String(id)}"`), { code: '22P02' });
  }
  refuseMember(member, 'an id that is not a whole number');
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
  const until = pgInstant('expireSupersededFact', 'an until', q.until);
  return storeCall({ member: 'expireSupersededFact', sourceId: q.sourceId }, () => brain.expireSupersededFact({ oldId: q.oldId, sourceId: q.sourceId, newId: q.newId, until }));
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
  const expiredAt = pgInstant('restoreSupersededFact', 'an expiredAt', q.expiredAt);
  const validUntil = pgInstant('restoreSupersededFact', 'a validUntil', q.validUntil);
  return storeCall({ member: 'restoreSupersededFact', sourceId: q.sourceId }, () => brain.restoreSupersededFact({ ...q, expiredAt, validUntil }));
};

export const readReplacementTarget: Member<'readReplacementTarget'> = async (brain, q) => {
  bigintId('readReplacementTarget', q.targetId);
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

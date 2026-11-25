/**
 * The pinned-question record members (BrainEngine readPinRow ... insertQuestionEvidence, and the two reads of the records
 * that join the evidence to what it cites) on the store's `~q` family (rust/crates/gbrain-store/src/questions.rs,
 * rust/docs/store/questions.md). Rows come back as the SQL engines return them once store.ts `toPinRow` normalizes
 * them: the timestamps as `Date`s, `spend_usd` and `cooldown_days` as numbers.
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 */
import type {
  PinAnswerPublish, PinRecordFilter, PinRecordInsert, PinRecordRow, PinStatePatch, QuestionEvidenceInsert,
} from '../../engine-sql/question-store.ts';
import type { PublishedQuestionAnswer, QuestionEvidenceJoinRow } from '../../engine-sql/question-reads.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

const PIN_DATES = ['last_refresh_at', 'last_attempt_at', 'watermark_at', 'lease_expires_at', 'created_at', 'archived_at'] as const;

/** A number the store sends as its Postgres text when it is not finite (`NaN`, `Infinity`, `-Infinity`). */
const float8 = (v: number): number | string => (Number.isFinite(v) ? v : String(v));

/** A pin row as PGLite returns it: dates as `Date`, the two float columns as numbers. */
const pinRow = (r: PinRecordRow): PinRecordRow => {
  const row = withDates({ ...r }, PIN_DATES);
  row.spend_usd = Number(row.spend_usd);
  if (row.cooldown_days !== null && row.cooldown_days !== undefined) row.cooldown_days = Number(row.cooldown_days);
  return row;
};
const maybe = (r: unknown): PinRecordRow | null => (r === null || r === undefined ? null : pinRow(r as PinRecordRow));

export const readPinRow: StoreMember<[sourceId: string, slug: string, forUpdate: boolean], PinRecordRow | null> = async (brain, sourceId, slug, forUpdate) =>
  maybe(await storeCall({ member: 'readPinRow', sourceId }, () => brain.readPinRow(sourceId, slug, forUpdate)));

export const listPinRows: StoreMember<[filter: PinRecordFilter], PinRecordRow[]> = async (brain, filter) =>
  (await storeCall({ member: 'listPinRows' }, () => brain.listPinRows({
    sourceIds: filter.sourceIds === null ? null : [...filter.sourceIds], states: filter.states === null ? null : [...filter.states],
    includeArchived: filter.includeArchived,
  })) as PinRecordRow[]).map(pinRow);

export const insertPinRow: StoreMember<[pin: PinRecordInsert], PinRecordRow | null> = async (brain, pin) =>
  maybe(await storeCall({ member: 'insertPinRow', sourceId: pin.sourceId }, () => brain.insertPinRow(pin)));

export const updatePinRowState: StoreMember<[id: number, patch: PinStatePatch], PinRecordRow | null> = async (brain, id, patch) =>
  maybe(await storeCall({ member: 'updatePinRowState' }, () => brain.updatePinRowState(id, patch)));

export const acquirePinLease: StoreMember<[id: number, token: string, owner: string, ttlMs: number], PinRecordRow | null> = async (brain, id, token, owner, ttlMs) =>
  maybe(await storeCall({ member: 'acquirePinLease' }, () => brain.acquirePinLease(id, token, owner, float8(ttlMs))));

export const releasePinLease: StoreMember<[id: number, token: string, error: string | null, spendUsd: number], void> = async (brain, id, token, error, spendUsd) => {
  await storeCall({ member: 'releasePinLease' }, () => brain.releasePinLease(id, token, error, float8(spendUsd)));
};

export const addPinSpend: StoreMember<[id: number, usd: number], void> = async (brain, id, usd) => {
  await storeCall({ member: 'addPinSpend' }, () => brain.addPinSpend(id, float8(usd)));
};

export const recordPinBlocked: StoreMember<[id: number, code: string], void> = async (brain, id, code) => {
  await storeCall({ member: 'recordPinBlocked' }, () => brain.recordPinBlocked(id, code));
};

export const lockPinRowForPublish: StoreMember<[id: number], { revision: number; lease_token: string | null; state: string } | null> = async (brain, id) => {
  const row = await storeCall({ member: 'lockPinRowForPublish' }, () => brain.lockPinRowForPublish(id)) as { revision: number | string; lease_token: string | null; state: string } | null;
  return row === null ? null : { revision: Number(row.revision), lease_token: row.lease_token, state: row.state };
};

export const publishPinAnswer: StoreMember<[id: number, publish: PinAnswerPublish], void> = async (brain, id, publish) => {
  await storeCall({ member: 'publishPinAnswer' }, () => brain.publishPinAnswer(id, { ...publish, spendUsd: float8(publish.spendUsd) }));
};

export const deleteQuestionEvidence: StoreMember<[questionId: number], void> = async (brain, questionId) => {
  await storeCall({ member: 'deleteQuestionEvidence' }, () => brain.deleteQuestionEvidence(questionId));
};

export const insertQuestionEvidence: StoreMember<[rows: readonly QuestionEvidenceInsert[]], void> = async (brain, rows) => {
  if (rows.length === 0) return;
  await storeCall({ member: 'insertQuestionEvidence' }, () => brain.insertQuestionEvidence([...rows]));
};

/** `p_deleted` and `f_expired` come back from PGLite and Postgres as `Date`s (or null). */
export const listQuestionEvidenceJoin: StoreMember<[questionId: number, answerRevision: number], QuestionEvidenceJoinRow[]> = async (brain, questionId, answerRevision) =>
  (await storeCall({ member: 'listQuestionEvidenceJoin' }, () => brain.listQuestionEvidenceJoin(questionId, answerRevision)) as QuestionEvidenceJoinRow[])
    .map(r => withDates(r, ['p_deleted', 'f_expired']));

export const listPublishedQuestionAnswers: StoreMember<[sourceId: string], PublishedQuestionAnswer[]> = async (brain, sourceId) =>
  (await storeCall({ member: 'listPublishedQuestionAnswers', sourceId }, () => brain.listPublishedQuestionAnswers(sourceId)) as PublishedQuestionAnswer[])
    .map(r => withDates(r, ['published_at']));

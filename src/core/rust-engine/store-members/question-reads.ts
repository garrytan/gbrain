/**
 * The pinned-question reads the store serves (src/core/engine-sql/question-reads.ts): the candidate pages, timeline
 * entries, takes and facts of a refresh, the question page row, the refresh clock, the new-pages and new-facts checks
 * of an answer's watermark and the rows a publication rereads
 * (rust/crates/gbrain-store/src/question_reads.rs, rust/docs/store/question-reads.md). The two reads of the pin
 * records are in store-members/question-store.ts.
 *
 * `pages.generation` is the store's per-page counter (rust/crates/gbrain-store/src/page_generation.rs), the same
 * number the SQL engines' trigger keeps.
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 */
import type {
  QuestionCandidatePage, QuestionEvidenceClock, QuestionEvidenceFact, QuestionEvidenceLockKind, QuestionEvidenceTake, QuestionEvidenceTimeline,
  QuestionPageRow,
} from '../../engine-sql/question-reads.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/** `valid_from` comes back from PGLite and Postgres as a `Date`. */
export const listQuestionEvidenceFacts: StoreMember<[sourceId: string, entitySlugs: readonly string[]], QuestionEvidenceFact[]> = async (brain, sourceId, entitySlugs) =>
  (await storeCall({ member: 'listQuestionEvidenceFacts', sourceId }, () => brain.listQuestionEvidenceFacts(sourceId, [...entitySlugs])) as QuestionEvidenceFact[])
    .map(r => withDates({ ...r, id: Number(r.id) }, ['valid_from']));

export const hasNewQuestionFacts: StoreMember<[sourceId: string, factId: number, entitySlug: string | null], boolean> = async (brain, sourceId, factId, entitySlug) =>
  (await storeCall({ member: 'hasNewQuestionFacts', sourceId }, () => brain.hasNewQuestionFacts(sourceId, factId, entitySlug))) === true;

const ids = (values: readonly number[]): number[] => values.map(Number);

/** `updated_at` comes back from PGLite and Postgres as a `Date`. */
export const listQuestionCandidatePages: StoreMember<[sourceId: string, slugs: readonly string[]], QuestionCandidatePage[]> = async (brain, sourceId, slugs) =>
  (await storeCall({ member: 'listQuestionCandidatePages', sourceId }, () => brain.listQuestionCandidatePages(sourceId, [...slugs])) as QuestionCandidatePage[])
    .map(r => withDates({ ...r, id: Number(r.id), generation: Number(r.generation) }, ['updated_at']));

/** `date` is a `date` column: PGLite and Postgres return it as a `Date` (midnight UTC). */
export const listQuestionEvidenceTimeline: StoreMember<[pageIds: readonly number[]], QuestionEvidenceTimeline[]> = async (brain, pageIds) =>
  (await storeCall({ member: 'listQuestionEvidenceTimeline' }, () => brain.listQuestionEvidenceTimeline(ids(pageIds))) as QuestionEvidenceTimeline[])
    .map(r => withDates({ ...r, id: Number(r.id), page_id: Number(r.page_id), generation: Number(r.generation) }, ['date']));

export const listQuestionEvidenceTakes: StoreMember<[pageIds: readonly number[]], QuestionEvidenceTake[]> = async (brain, pageIds) =>
  (await storeCall({ member: 'listQuestionEvidenceTakes' }, () => brain.listQuestionEvidenceTakes(ids(pageIds))) as QuestionEvidenceTake[])
    .map(r => ({ ...r, id: Number(r.id), page_id: Number(r.page_id), generation: Number(r.generation) }));

export const readQuestionPageRow: StoreMember<[sourceId: string, slug: string], QuestionPageRow | null> = async (brain, sourceId, slug) => {
  const row = (await storeCall({ member: 'readQuestionPageRow', sourceId }, () => brain.readQuestionPageRow(sourceId, slug))) as QuestionPageRow | null;
  return row ? { ...row, id: Number(row.id), generation: Number(row.generation) } : null;
};

export const readQuestionEvidenceClock: StoreMember<[sourceId: string], QuestionEvidenceClock> = async (brain, sourceId) => {
  const row = (await storeCall({ member: 'readQuestionEvidenceClock', sourceId }, () => brain.readQuestionEvidenceClock(sourceId))) as QuestionEvidenceClock;
  return { generation: Number(row.generation), fact_id: Number(row.fact_id) };
};

export const hasNewQuestionPages: StoreMember<[sourceId: string, generation: number, prefix: string | null], boolean> = async (brain, sourceId, generation, prefix) =>
  (await storeCall({ member: 'hasNewQuestionPages', sourceId }, () => brain.hasNewQuestionPages(sourceId, generation, prefix))) === true;

/** The store reads the rows: its one writer needs no `FOR SHARE` (rust/docs/store/question-reads.md). */
export const lockQuestionEvidenceRows: StoreMember<[kind: QuestionEvidenceLockKind, ids: readonly number[]], Array<Record<string, unknown>>> = async (brain, kind, rowIds) =>
  (await storeCall({ member: 'lockQuestionEvidenceRows' }, () => brain.lockQuestionEvidenceRows(kind, ids(rowIds))) as Array<Record<string, unknown>>)
    .map(r => ({ ...r, id: Number(r.id), ...(kind === 'page' ? { generation: Number(r.generation) } : {}) }));

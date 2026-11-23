/**
 * The pinned-question members (BrainEngine insertPinnedQuestion, readPinnedQuestion, listPinnedQuestions; SQL in
 * engine-sql/pinned-questions.ts), served from the store's pin records (rust/crates/gbrain-store/src/jobs/pinned_questions.rs,
 * rust/docs/store/pinned-questions.md). The pin's state changes, refresh lease and answer publish stay raw SQL, so they
 * refuse on a Rust brain.
 */
import type { PinnedQuestionFilter, PinnedQuestionInsert, PinnedQuestionRow } from '../../engine-sql/pinned-questions.ts';
import { storeCall, type StoreMember } from './common.ts';

export const insertPinnedQuestion: StoreMember<[row: PinnedQuestionInsert], PinnedQuestionRow | null> = async (brain, row) =>
  await storeCall({ member: 'insertPinnedQuestion' }, () => brain.insertPinnedQuestion({
    sourceId: row.sourceId, slug: row.slug, question: row.question, scopeSlugPrefix: row.scopeSlugPrefix, scopeEntity: row.scopeEntity,
    state: row.state, inactiveReason: row.inactiveReason, publishMode: row.publishMode, createdBy: row.createdBy,
  })) as PinnedQuestionRow | null;

export const readPinnedQuestion: StoreMember<[sourceId: string, slug: string], PinnedQuestionRow | null> = async (brain, sourceId, slug) =>
  await storeCall({ member: 'readPinnedQuestion' }, () => brain.readPinnedQuestion(sourceId, slug)) as PinnedQuestionRow | null;

export const listPinnedQuestions: StoreMember<[filter: PinnedQuestionFilter], PinnedQuestionRow[]> = async (brain, filter) =>
  await storeCall({ member: 'listPinnedQuestions' }, () => brain.listPinnedQuestions({
    ...(filter.sourceIds ? { sourceIds: [...filter.sourceIds] } : {}), ...(filter.states ? { states: [...filter.states] } : {}),
    includeArchived: filter.includeArchived === true,
  })) as PinnedQuestionRow[];

/**
 * The pinned-question reads the store serves (src/core/engine-sql/question-reads.ts): the evidence facts of a refresh,
 * the newest pages under a pin's slug prefix and whether new facts arrived since an answer's watermark
 * (rust/crates/gbrain-store/src/question_reads.rs, rust/docs/store/question-reads.md). The other question reads return
 * or compare `pages.generation` or read the pin records, which the store does not keep yet; the engine refuses them by
 * name (rust-engine/question-stops.ts).
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 */
import type { QuestionEvidenceFact } from '../../engine-sql/question-reads.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

/** `valid_from` comes back from PGLite and Postgres as a `Date`. */
export const listQuestionEvidenceFacts: StoreMember<[sourceId: string, entitySlugs: readonly string[]], QuestionEvidenceFact[]> = async (brain, sourceId, entitySlugs) =>
  (await storeCall({ member: 'listQuestionEvidenceFacts', sourceId }, () => brain.listQuestionEvidenceFacts(sourceId, [...entitySlugs])) as QuestionEvidenceFact[])
    .map(r => withDates({ ...r, id: Number(r.id) }, ['valid_from']));

export const listPrefixAnchoredPages: StoreMember<[sourceId: string, prefix: string], Array<{ id: number; slug: string }>> = async (brain, sourceId, prefix) =>
  (await storeCall({ member: 'listPrefixAnchoredPages', sourceId }, () => brain.listPrefixAnchoredPages(sourceId, prefix)) as Array<{ id: number; slug: string }>)
    .map(r => ({ id: Number(r.id), slug: r.slug }));

export const hasNewQuestionFacts: StoreMember<[sourceId: string, factId: number, entitySlug: string | null], boolean> = async (brain, sourceId, factId, entitySlug) =>
  (await storeCall({ member: 'hasNewQuestionFacts', sourceId }, () => brain.hasNewQuestionFacts(sourceId, factId, entitySlug))) === true;

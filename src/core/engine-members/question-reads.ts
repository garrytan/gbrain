/**
 * The reads of pinned questions: evidence retrieval, the question page, freshness, the refresh clock and the
 * publication's revalidation (engine-sql/question-reads.ts). `BrainEngine` extends this interface.
 */
import type * as QuestionSql from '../engine-sql/question-reads.ts';

export interface QuestionReadMembers {
  /** The live inline pages of `sourceId` with these slugs that no quarantine marks, in no set order. */
  listQuestionCandidatePages(sourceId: string, slugs: readonly string[]): Promise<QuestionSql.QuestionCandidatePage[]>;
  /** Every published answer of the source's pins, with the page ids its current revision cites. */
  listPublishedQuestionAnswers(sourceId: string): Promise<QuestionSql.PublishedQuestionAnswer[]>;
  /** The live, eligible facts about these entities, newest first, at most 30. */
  listQuestionEvidenceFacts(sourceId: string, entitySlugs: readonly string[]): Promise<QuestionSql.QuestionEvidenceFact[]>;
  /** The eligible timeline entries of these pages, newest first, at most 20. */
  listQuestionEvidenceTimeline(pageIds: readonly number[]): Promise<QuestionSql.QuestionEvidenceTimeline[]>;
  /** The active, eligible takes of these pages, newest first, at most 20. */
  listQuestionEvidenceTakes(pageIds: readonly number[]): Promise<QuestionSql.QuestionEvidenceTake[]>;
  /** The highest page generation of the brain and the highest fact id of the source. */
  readQuestionEvidenceClock(sourceId: string): Promise<QuestionSql.QuestionEvidenceClock>;
  /** The live question page `slug` of `sourceId`, or null. */
  readQuestionPageRow(sourceId: string, slug: string): Promise<QuestionSql.QuestionPageRow | null>;
  /** The evidence rows of one answer revision of a pin, joined to what each cites. */
  listQuestionEvidenceJoin(questionId: number, answerRevision: number): Promise<QuestionSql.QuestionEvidenceJoinRow[]>;
  /** Whether a live non-question page of `sourceId` (under `prefix` when given) has a generation above `generation`. */
  hasNewQuestionPages(sourceId: string, generation: number, prefix: string | null): Promise<boolean>;
  /** Whether `sourceId` holds an unexpired fact (about `entitySlug` when given) with an id above `factId`. */
  hasNewQuestionFacts(sourceId: string, factId: number, entitySlug: string | null): Promise<boolean>;
  /** The evidence rows of one kind a publication rereads, FOR SHARE until its transaction ends. */
  lockQuestionEvidenceRows(kind: QuestionSql.QuestionEvidenceLockKind, ids: readonly number[]): Promise<Array<Record<string, unknown>>>;
}

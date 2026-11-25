/**
 * The pinned-question records beyond the insert and the two reads of engine-sql/pinned-questions.ts: the locked read, the
 * state change, the refresh lease, spend, and a publication's answer and `question_evidence` rewrite
 * (engine-sql/question-store.ts). `BrainEngine` extends this interface. The reads of the records that join them to the
 * rows they cite are in question-reads.ts.
 */
import type * as QuestionStoreSql from '../engine-sql/question-store.ts';

export interface QuestionStoreMembers {
  /** The pin `slug` of `sourceId` locked until the transaction ends (`FOR UPDATE`), or null. */
  readPinnedQuestionForUpdate(sourceId: string, slug: string): Promise<QuestionStoreSql.PinRecordRow | null>;
  /** Changes the pin's state, reason and publish mode and bumps its revision (archiving drops the lease): the row, or null for an unknown id. */
  updatePinRowState(id: number, patch: QuestionStoreSql.PinStatePatch): Promise<QuestionStoreSql.PinRecordRow | null>;
  /** Takes the refresh lease when the pin is not archived and holds no live lease: the leased row, or null. */
  acquirePinLease(id: number, token: string, owner: string, ttlMs: number): Promise<QuestionStoreSql.PinRecordRow | null>;
  /** Drops the lease `token` holds, recording `error` and adding the spend; nothing when another lease holds the pin. */
  releasePinLease(id: number, token: string, error: string | null, spendUsd: number): Promise<void>;
  /** Adds `usd` to the pin's spend. */
  addPinSpend(id: number, usd: number): Promise<void>;
  /** Records why a refresh did not start, unless a live lease holds the pin. */
  recordPinBlocked(id: number, code: string): Promise<void>;
  /** The pin's revision, lease token and state, locked until the transaction ends, or null. */
  lockPinRowForPublish(id: number): Promise<{ revision: number; lease_token: string | null; state: string } | null>;
  /** Publishes the answer: the next answer revision, its watermark, the spend, and the lease dropped. */
  publishPinAnswer(id: number, publish: QuestionStoreSql.PinAnswerPublish): Promise<void>;
  /** Deletes every evidence row of the pin. */
  deleteQuestionEvidence(questionId: number): Promise<void>;
  /** Inserts the evidence rows, in order. */
  insertQuestionEvidence(rows: readonly QuestionStoreSql.QuestionEvidenceInsert[]): Promise<void>;
}

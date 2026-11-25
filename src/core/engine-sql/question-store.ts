/**
 * The pinned-question records the insert and the two reads of engine-sql/pinned-questions.ts do not cover: the locked
 * read of a pin, its state changes, the refresh lease, spend (src/core/questions/store.ts) and the refresh's ledger
 * writes (questions/refresh.ts: the blocked record, the publication's row lock, answer update and `question_evidence`
 * rewrite). One implementation for both SQL engines; the Rust store serves the same members from the pin records of
 * jobs/pinned_questions.rs and the evidence family `~q` (src/core/rust-engine/store-members/question-store.ts,
 * rust/crates/gbrain-store/src/questions.rs).
 *
 * Each statement is the text the caller sent through `executeRaw`, byte for byte (test/question-store-sql-pin.test.ts).
 * Rows come back as the driver reads them; store.ts `toPinRow` normalizes them.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { PinnedQuestionRow } from './pinned-questions.ts';

/** A `pinned_questions` row as `SELECT <columns>` returns it. */
export type PinRecordRow = PinnedQuestionRow;
/** A state change: each null field is kept; `setInactiveReason` false keeps the reason too. */
export interface PinStatePatch { state: string | null; setInactiveReason: boolean; inactiveReason: string | null; publishMode: string | null }
/** What a publication writes on the pin row. */
export interface PinAnswerPublish { answer: string; answerModel: string; watermarkGeneration: number; watermarkFactId: number; spendUsd: number }
/** One `question_evidence` row of a published answer revision. */
export interface QuestionEvidenceInsert {
  questionId: number; answerRevision: number; sentenceId: string; kind: string; sourceId: string; pageId: number | null; pageSlug: string | null;
  pageGeneration: number | null; pageRevision: string | null; itemId: number | null; contentHash: string | null;
}

const PIN_FOR_UPDATE_SQL = `SELECT id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at FROM pinned_questions WHERE source_id = $1 AND slug = $2 FOR UPDATE`;
const UPDATE_STATE_SQL = `UPDATE pinned_questions SET
       state = COALESCE($2, state),
       inactive_reason = CASE WHEN $3::boolean THEN $4 ELSE inactive_reason END,
       publish_mode = COALESCE($5, publish_mode),
       archived_at = CASE WHEN COALESCE($2, state) = 'archived' THEN COALESCE(archived_at, now()) ELSE NULL END,
       lease_token = CASE WHEN COALESCE($2, state) = 'archived' THEN NULL ELSE lease_token END,
       lease_expires_at = CASE WHEN COALESCE($2, state) = 'archived' THEN NULL ELSE lease_expires_at END,
       revision = revision + 1, updated_at = now()
     WHERE id = $1 RETURNING id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at`;
const ACQUIRE_SQL = `UPDATE pinned_questions SET lease_token = $2, lease_owner = $3,
       lease_expires_at = now() + ($4::double precision * interval '1 millisecond'),
       last_attempt_at = now(), refresh_attempts = refresh_attempts + 1
     WHERE id = $1 AND state <> 'archived' AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at`;
const RELEASE_SQL = `UPDATE pinned_questions SET lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
       last_error = $3, spend_usd = spend_usd + $4, updated_at = now()
     WHERE id = $1 AND lease_token = $2`;
const SPEND_SQL = `UPDATE pinned_questions SET spend_usd = spend_usd + $2 WHERE id = $1`;
const BLOCKED_SQL = `UPDATE pinned_questions SET last_attempt_at = now(), last_error = $2, updated_at = now()
     WHERE id = $1 AND (lease_token IS NULL OR lease_expires_at < now())`;
const LOCK_SQL = `SELECT revision, lease_token, state FROM pinned_questions WHERE id = $1 FOR UPDATE`;
const PUBLISH_SQL = `UPDATE pinned_questions SET answer = $2, answer_revision = answer_revision + 1, revision = revision + 1, answer_model = $3,
           last_refresh_at = now(), last_error = NULL, watermark_generation = $4, watermark_fact_id = $5, watermark_at = now(),
           lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, spend_usd = spend_usd + $6, updated_at = now()
         WHERE id = $1`;
const DELETE_EVIDENCE_SQL = `DELETE FROM question_evidence WHERE question_id = $1`;
const INSERT_EVIDENCE_SQL = `INSERT INTO question_evidence (question_id, answer_revision, sentence_id, kind, source_id, page_id, page_slug, page_generation, page_revision, item_id, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

/** The pin `slug` of `sourceId` locked until the transaction ends (`FOR UPDATE`), or null. */
export async function readPinnedQuestionForUpdate(raw: EngineRawRead, sourceId: string, slug: string): Promise<PinRecordRow | null> {
  const [row] = await raw<PinRecordRow>(PIN_FOR_UPDATE_SQL, [sourceId, slug]);
  return row ?? null;
}

/** Changes the pin's state, reason and publish mode and bumps its revision (archiving drops the lease): the row, or null for an unknown id. */
export async function updatePinRowState(raw: EngineRawRead, id: number, patch: PinStatePatch): Promise<PinRecordRow | null> {
  const [row] = await raw<PinRecordRow>(UPDATE_STATE_SQL, [id, patch.state, patch.setInactiveReason, patch.inactiveReason, patch.publishMode]);
  return row ?? null;
}

/** Takes the refresh lease when the pin is not archived and holds no live lease: the leased row, or null. */
export async function acquirePinLease(raw: EngineRawRead, id: number, token: string, owner: string, ttlMs: number): Promise<PinRecordRow | null> {
  const [row] = await raw<PinRecordRow>(ACQUIRE_SQL, [id, token, owner, ttlMs]);
  return row ?? null;
}

/** Drops the lease `token` holds, recording `error` and adding the spend; nothing when another lease holds the pin. */
export async function releasePinLease(raw: EngineRawRead, id: number, token: string, error: string | null, spendUsd: number): Promise<void> {
  await raw(RELEASE_SQL, [id, token, error, spendUsd]);
}

/** Adds `usd` to the pin's spend. */
export async function addPinSpend(raw: EngineRawRead, id: number, usd: number): Promise<void> {
  await raw(SPEND_SQL, [id, usd]);
}

/** Records why a refresh did not start, unless a live lease holds the pin. */
export async function recordPinBlocked(raw: EngineRawRead, id: number, code: string): Promise<void> {
  await raw(BLOCKED_SQL, [id, code]);
}

/** The pin's revision, lease token and state, locked until the transaction ends, or null. */
export async function lockPinRowForPublish(raw: EngineRawRead, id: number): Promise<{ revision: number; lease_token: string | null; state: string } | null> {
  const [row] = await raw<{ revision: string | number; lease_token: string | null; state: string }>(LOCK_SQL, [id]);
  return row ? { revision: Number(row.revision), lease_token: row.lease_token, state: row.state } : null;
}

/** Publishes the answer: the next answer revision, its watermark, the spend, and the lease dropped. */
export async function publishPinAnswer(raw: EngineRawRead, id: number, p: PinAnswerPublish): Promise<void> {
  await raw(PUBLISH_SQL, [id, p.answer, p.answerModel, p.watermarkGeneration, p.watermarkFactId, p.spendUsd]);
}

/** Deletes every evidence row of the pin. */
export async function deleteQuestionEvidence(raw: EngineRawRead, questionId: number): Promise<void> {
  await raw(DELETE_EVIDENCE_SQL, [questionId]);
}

/** Inserts the evidence rows, one statement each, in order. */
export async function insertQuestionEvidence(raw: EngineRawRead, rows: readonly QuestionEvidenceInsert[]): Promise<void> {
  for (const e of rows) {
    await raw(INSERT_EVIDENCE_SQL, [e.questionId, e.answerRevision, e.sentenceId, e.kind, e.sourceId, e.pageId, e.pageSlug, e.pageGeneration,
      e.pageRevision, e.itemId, e.contentHash]);
  }
}

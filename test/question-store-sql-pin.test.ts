/**
 * The pinned-question record members (src/core/engine-sql/question-store.ts) send the statements questions/store.ts and
 * questions/refresh.ts sent through executeRaw at f9592f7a7e, rebuilt here the way those callers built them (the same
 * column list), so a drift in the written-out text or in a parameter fails. The insert, the read and the listing are
 * engine-sql/pinned-questions.ts (main's members, pinned by their own tests).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends exactly the caller's old text and parameters: the locked single-row read and every write.
 *  - Regression: a lease that loses its expiry test, or a state change that keeps the lease of an archived pin, would
 *    double-run or revive pins on a brain the parity cases do not hold.
 *  - Why existing coverage misses it: the sql-text goldens pin the text, not where it came from.
 *  - Seam: a recording executeRaw stand-in; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import * as Q from '../src/core/engine-sql/question-store.ts';

// Copied from questions/store.ts at f9592f7a7e.
const COLUMNS = `id, source_id, slug, question, scope_slug_prefix, scope_entity, state, inactive_reason, publish_mode, model,
  cooldown_days, origin, created_by, revision, answer_revision, answer, answer_model, last_refresh_at, last_attempt_at,
  last_error, watermark_generation, watermark_fact_id, watermark_at, lease_token, lease_owner, lease_expires_at,
  refresh_attempts, spend_usd, created_at, archived_at`;

const OLD_READ_FOR_UPDATE = `SELECT ${COLUMNS} FROM pinned_questions WHERE source_id = $1 AND slug = $2 FOR UPDATE`;
const OLD_UPDATE_STATE = `UPDATE pinned_questions SET
       state = COALESCE($2, state),
       inactive_reason = CASE WHEN $3::boolean THEN $4 ELSE inactive_reason END,
       publish_mode = COALESCE($5, publish_mode),
       archived_at = CASE WHEN COALESCE($2, state) = 'archived' THEN COALESCE(archived_at, now()) ELSE NULL END,
       lease_token = CASE WHEN COALESCE($2, state) = 'archived' THEN NULL ELSE lease_token END,
       lease_expires_at = CASE WHEN COALESCE($2, state) = 'archived' THEN NULL ELSE lease_expires_at END,
       revision = revision + 1, updated_at = now()
     WHERE id = $1 RETURNING ${COLUMNS}`;
const OLD_ACQUIRE = `UPDATE pinned_questions SET lease_token = $2, lease_owner = $3,
       lease_expires_at = now() + ($4::double precision * interval '1 millisecond'),
       last_attempt_at = now(), refresh_attempts = refresh_attempts + 1
     WHERE id = $1 AND state <> 'archived' AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING ${COLUMNS}`;
const OLD_RELEASE = `UPDATE pinned_questions SET lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
       last_error = $3, spend_usd = spend_usd + $4, updated_at = now()
     WHERE id = $1 AND lease_token = $2`;
const OLD_SPEND = 'UPDATE pinned_questions SET spend_usd = spend_usd + $2 WHERE id = $1';
// Copied from questions/refresh.ts at f9592f7a7e.
const OLD_BLOCKED = `UPDATE pinned_questions SET last_attempt_at = now(), last_error = $2, updated_at = now()
     WHERE id = $1 AND (lease_token IS NULL OR lease_expires_at < now())`;
const OLD_LOCK = 'SELECT revision, lease_token, state FROM pinned_questions WHERE id = $1 FOR UPDATE';
const OLD_PUBLISH = `UPDATE pinned_questions SET answer = $2, answer_revision = answer_revision + 1, revision = revision + 1, answer_model = $3,
           last_refresh_at = now(), last_error = NULL, watermark_generation = $4, watermark_fact_id = $5, watermark_at = now(),
           lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, spend_usd = spend_usd + $6, updated_at = now()
         WHERE id = $1`;
const OLD_DELETE_EVIDENCE = 'DELETE FROM question_evidence WHERE question_id = $1';
const OLD_INSERT_EVIDENCE = `INSERT INTO question_evidence (question_id, answer_revision, sentence_id, kind, source_id, page_id, page_slug, page_generation, page_revision, item_id, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

function recorder(answer: unknown[] = []) {
  const log: Array<[string, unknown[]]> = [];
  const raw = async (sql: string, params?: unknown[]) => { log.push([sql, params ?? []]); return answer as never; };
  return { log, raw: raw as never };
}

describe('pinned-question record members send their callers\' statements', () => {
  test('the locked single-row read', async () => {
    const r = recorder();
    expect(await Q.readPinnedQuestionForUpdate(r.raw, 'work', 'questions/b')).toBeNull();
    expect(r.log).toEqual([[OLD_READ_FOR_UPDATE, ['work', 'questions/b']]]);
  });

  test('a state change, the lease, spend and the blocked record', async () => {
    const r = recorder([{ id: 1 }]);
    await Q.updatePinRowState(r.raw, 7, { state: 'archived', setInactiveReason: true, inactiveReason: null, publishMode: null });
    await Q.updatePinRowState(r.raw, 7, { state: null, setInactiveReason: false, inactiveReason: null, publishMode: 'draft' });
    await Q.acquirePinLease(r.raw, 7, 'tok', 'owner', 600000);
    await Q.releasePinLease(r.raw, 7, 'tok', 'refresh_failed:parse', 0.25);
    await Q.releasePinLease(r.raw, 7, 'tok', null, 0);
    await Q.addPinSpend(r.raw, 7, 0.5);
    await Q.recordPinBlocked(r.raw, 7, 'budget_exhausted');
    expect(r.log).toEqual([
      [OLD_UPDATE_STATE, [7, 'archived', true, null, null]],
      [OLD_UPDATE_STATE, [7, null, false, null, 'draft']],
      [OLD_ACQUIRE, [7, 'tok', 'owner', 600000]],
      [OLD_RELEASE, [7, 'tok', 'refresh_failed:parse', 0.25]],
      [OLD_RELEASE, [7, 'tok', null, 0]],
      [OLD_SPEND, [7, 0.5]],
      [OLD_BLOCKED, [7, 'budget_exhausted']],
    ]);
  });

  test('the publication: the row lock, the answer, the evidence delete and every evidence insert in order', async () => {
    const r = recorder([{ revision: '4', lease_token: 'tok', state: 'active' }]);
    expect(await Q.lockPinRowForPublish(r.raw, 7)).toEqual({ revision: 4, lease_token: 'tok', state: 'active' });
    await Q.publishPinAnswer(r.raw, 7, { answer: '[]', answerModel: 'm', watermarkGeneration: 12, watermarkFactId: 99, spendUsd: 0.125 });
    await Q.deleteQuestionEvidence(r.raw, 7);
    await Q.insertQuestionEvidence(r.raw, [
      { questionId: 7, answerRevision: 2, sentenceId: 's1', kind: 'page', sourceId: 'default', pageId: 3, pageSlug: 'projects/a', pageGeneration: 5, pageRevision: 'rev', itemId: null, contentHash: null },
      { questionId: 7, answerRevision: 2, sentenceId: 's1', kind: 'fact', sourceId: 'default', pageId: null, pageSlug: null, pageGeneration: null, pageRevision: null, itemId: 9, contentHash: 'h' },
    ]);
    expect(r.log).toEqual([
      [OLD_LOCK, [7]],
      [OLD_PUBLISH, [7, '[]', 'm', 12, 99, 0.125]],
      [OLD_DELETE_EVIDENCE, [7]],
      [OLD_INSERT_EVIDENCE, [7, 2, 's1', 'page', 'default', 3, 'projects/a', 5, 'rev', null, null]],
      [OLD_INSERT_EVIDENCE, [7, 2, 's1', 'fact', 'default', null, null, null, null, 9, 'h']],
    ]);
  });

  test('an empty lock read is null', async () => {
    expect(await Q.lockPinRowForPublish(recorder([]).raw, 1)).toBeNull();
  });
});

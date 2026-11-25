/**
 * The pinned-question members the Rust engine does not serve yet, with who lifts each stop and when. The engine's
 * refusal of one of them names the missing piece, its owner and the due date (rust-engine.ts), before any work.
 *
 * - The pin records: the store keeps `pinned_questions` rows (insert, one pin, the listing: jobs/pinned_questions.rs)
 *   but none of their state, lease, spend or answer writes, and no `question_evidence` rows; questions/store.ts and the
 *   refresh refuse those by name (refusePinStore) for the same owner and date, and `questions pin` refuses before its
 *   insert (its guard stays as the pin store's owner left it).
 *
 * The reads that return or compare `pages.generation` are served: the store keeps the per-page counter the SQL engines'
 * trigger keeps (rust/crates/gbrain-store/src/page_generation.rs, rust/docs/store/question-reads.md). A member leaves
 * this list in the commit that serves it, together with its store member.
 */
import { capabilityMissing, servesRawSql, type KnownStop } from './errors.ts';

export const PIN_STORE_STOP: KnownStop = { owner: 'lane 15 head 2: the store serves no pin state, lease, spend or answer writes and keeps no question_evidence records yet', due: '5 PM PST Nov 29' };

export const QUESTION_STOP_OWNERS: Readonly<Record<string, KnownStop>> = {
  listQuestionEvidenceJoin: PIN_STORE_STOP,
  listPublishedQuestionAnswers: PIN_STORE_STOP,
};

/**
 * Refuses a pin record read or write (questions/store.ts, the refresh ledger writes in questions/refresh.ts) on an
 * engine without raw SQL, naming `member` and the stop, before any engine call: nothing is read or written. PGLite,
 * Postgres and transaction handles pass.
 */
export function refusePinStore(engine: object, member: string): void {
  if (!servesRawSql(engine)) throw capabilityMissing('raw_sql', `pinned questions ${member}`, 'none', PIN_STORE_STOP);
}

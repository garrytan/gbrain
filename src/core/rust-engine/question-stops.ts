/**
 * The pinned-question members the Rust engine does not serve yet, with who lifts each stop and when. The engine's
 * refusal of one of them names the missing piece, its owner and the due date (rust-engine.ts), before any work.
 *
 * - The page generation: these reads return or compare `pages.generation`, the per-page counter the SQL engines'
 *   trigger keeps (src/schema.sql, PAGE_GENERATION_BUMP_FN_SQL). The store keeps no such counter yet (it reads every page
 *   as generation 1, rust/docs/store/seed.md), so no answer of these reads would equal the SQL engines'.
 * - The pin records: `pinned_questions` and `question_evidence` have no store family yet; questions/store.ts refuses
 *   their reads and writes by name (refusePinStore) for the same owner and date.
 *
 * A member leaves this list in the commit that serves it, together with its store member.
 */
import { capabilityMissing, servesRawSql, type KnownStop } from './errors.ts';

export const PAGE_GENERATION_STOP: KnownStop = { owner: 'lane 15 head 2: the store keeps no pages.generation counter yet', due: '5 PM PST Nov 29' };
export const PIN_STORE_STOP: KnownStop = { owner: 'lane 15 head 2: the store keeps no pinned_questions or question_evidence records yet', due: '5 PM PST Nov 29' };

export const QUESTION_STOP_OWNERS: Readonly<Record<string, KnownStop>> = {
  listQuestionCandidatePages: PAGE_GENERATION_STOP,
  listQuestionEvidenceTimeline: PAGE_GENERATION_STOP,
  listQuestionEvidenceTakes: PAGE_GENERATION_STOP,
  readQuestionPageRow: PAGE_GENERATION_STOP,
  readQuestionEvidenceClock: PAGE_GENERATION_STOP,
  hasNewQuestionPages: PAGE_GENERATION_STOP,
  lockQuestionEvidenceRows: PAGE_GENERATION_STOP,
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

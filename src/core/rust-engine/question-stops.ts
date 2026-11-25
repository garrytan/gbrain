/**
 * The pinned-question members the Rust engine does not serve yet, with who lifts each stop and when. The engine's
 * refusal of one of them names the missing piece, its owner and the due date (rust-engine.ts), before any work.
 *
 * - The page generation: these reads return or compare `pages.generation`, the per-page counter the SQL engines'
 *   trigger keeps (src/schema.sql, PAGE_GENERATION_BUMP_FN_SQL). The store keeps no such counter yet (it reads every page
 *   as generation 1, rust/docs/store/seed.md), so no answer of these reads would equal the SQL engines'.
 *
 * The pin records are served: the pin rows by jobs/pinned_questions.rs, the evidence rows by questions.rs
 * (rust/docs/store/questions.md); no stop names them. `questions pin` still refuses before its insert
 * (`refusePinStore`), since the question page read it needs after the insert returns the page generation.
 *
 * A member leaves this list in the commit that serves it, together with its store member.
 */
import { capabilityMissing, servesRawSql, type KnownStop } from './errors.ts';

export const PAGE_GENERATION_STOP: KnownStop = { owner: 'lane 15 head 2: the store keeps no pages.generation counter yet', due: '5 PM PST Nov 29' };
export const PIN_STORE_STOP: KnownStop = { owner: 'lane 15 head 2: the question page read of a pin needs the page generation counter the store does not keep yet', due: '5 PM PST Nov 29' };

export const QUESTION_STOP_OWNERS: Readonly<Record<string, KnownStop>> = {
  listQuestionCandidatePages: PAGE_GENERATION_STOP,
  listQuestionEvidenceTimeline: PAGE_GENERATION_STOP,
  listQuestionEvidenceTakes: PAGE_GENERATION_STOP,
  readQuestionPageRow: PAGE_GENERATION_STOP,
  readQuestionEvidenceClock: PAGE_GENERATION_STOP,
  hasNewQuestionPages: PAGE_GENERATION_STOP,
  lockQuestionEvidenceRows: PAGE_GENERATION_STOP,
};

/**
 * Refuses `questions pin` on an engine without raw SQL, naming `member` and the stop, before any engine call: nothing is
 * read or written (no pin row, no question page). PGLite, Postgres and transaction handles pass. The integrator lifts it
 * when the page generation counter is merged.
 */
export function refusePinStore(engine: object, member: string): void {
  if (!servesRawSql(engine)) throw capabilityMissing('raw_sql', `pinned questions ${member}`, 'none', PIN_STORE_STOP);
}

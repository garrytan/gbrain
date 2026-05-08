/**
 * v0.28.1: LongMemEval haystack -> gbrain page conversion.
 *
 * Pure data-shape converter. No I/O, no engine, no LLM. Fed by the harness in
 * src/commands/eval-longmemeval.ts which then calls importFromContent on each
 * page in turn.
 *
 * Output slug prefix is `chat/` because the source data is conversation
 * sessions. PageType is 'note' (an existing PageType in src/core/types.ts);
 * adding a first-class 'chat' type would touch the source-boost map and is
 * out of scope for v0.28.1. The chat/ slug prefix is verified by
 * test/eval-longmemeval.test.ts to NOT prefix-match any DEFAULT_SOURCE_BOOSTS
 * entry, so retrieval factor stays at 1.0.
 */

export interface LongMemEvalTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LongMemEvalSession {
  session_id: string;
  turns: LongMemEvalTurn[];
}

export interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  haystack_sessions: LongMemEvalSession[];
  /** ISO date strings, parallel to haystack_sessions. Some LongMemEval splits omit this. */
  haystack_dates?: string[];
  /** Ground truth: which haystack sessions actually contain the answer. */
  answer_session_ids: string[];
}

export interface PageInputForImport {
  slug: string;
  content: string;
}

/**
 * Render one LongMemEval session as a markdown page.
 *
 * The body is "**user:** ...\n\n**assistant:** ...\n\n" so retrieval matches
 * naturally on either role's text. Frontmatter pins type, date (if available),
 * and session_id so the JSONL emit step can recover session_id from a chunk.
 */
function renderSession(session: LongMemEvalSession, date?: string): string {
  const fm: string[] = ['---', 'type: note'];
  if (date) fm.push(`date: ${date}`);
  fm.push(`session_id: ${session.session_id}`);
  fm.push('---', '');

  const body: string[] = [];
  for (const turn of session.turns) {
    body.push(`**${turn.role}:** ${turn.content}`);
    body.push('');
  }
  return fm.join('\n') + body.join('\n');
}

export function haystackToPages(question: LongMemEvalQuestion): PageInputForImport[] {
  const pages: PageInputForImport[] = [];
  const dates = question.haystack_dates ?? [];
  for (let i = 0; i < question.haystack_sessions.length; i++) {
    const session = question.haystack_sessions[i];
    const date = dates[i];
    pages.push({
      slug: `chat/${session.session_id}`,
      content: renderSession(session, date),
    });
  }
  return pages;
}

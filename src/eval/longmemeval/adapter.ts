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
  domain?: string;
  environment?: string;
  eval_function?: string;
  question_image?: string | null;
  dataset_schema?: 'longmemeval-v1' | 'longmemeval-v2';
  /**
   * Two on-disk shapes are accepted (normalized by `haystackToPages`):
   *
   *   1. Oracle/structured: `LongMemEvalSession[]` with `{session_id, turns}`.
   *   2. _s split (HuggingFace public download as of May 2026):
   *      `LongMemEvalTurn[][]` — each inner array is the turns of one
   *      session directly. Session IDs live in a sibling
   *      `haystack_session_ids: string[]` parallel array.
   */
  haystack_sessions: LongMemEvalSession[] | LongMemEvalTurn[][];
  /** Parallel to haystack_sessions in the _s split. Absent in oracle shape. */
  haystack_session_ids?: string[];
  /** ISO date strings, parallel to haystack_sessions. Some LongMemEval splits omit this. */
  haystack_dates?: string[];
  /** Ground truth: which haystack sessions actually contain the answer. */
  answer_session_ids: string[];
}

export interface LongMemEvalV2Question {
  id: string;
  domain: 'web' | 'enterprise' | string;
  environment: string;
  question_type: string;
  question: string;
  image?: string | null;
  answer: string;
  eval_function: string;
  /** Optional private/local label layer; public V2 files omit this. */
  answer_session_ids?: string[];
}

export interface LongMemEvalV2State {
  state_index: number;
  step?: number | null;
  url?: string | null;
  action?: string | null;
  thought?: string | null;
  accessibility_tree?: string | null;
  screenshot?: string | null;
}

export interface LongMemEvalV2Trajectory {
  id: string;
  domain: 'web' | 'enterprise' | string;
  environment: string;
  goal: string;
  outcome: 'success' | 'failure' | string;
  start_url?: string | null;
  states: LongMemEvalV2State[];
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

/**
 * Normalize the on-disk haystack_sessions shape (oracle OR _s) into the
 * structured `{session_id, turns}` form `renderSession` consumes.
 *
 * v0.35.1.1: the public _s split on HuggingFace uses `LongMemEvalTurn[][]`
 * for `haystack_sessions` plus a parallel `haystack_session_ids: string[]`
 * for the IDs. The pre-v0.35.1.1 adapter assumed only the oracle shape
 * and crashed with `session.turns` undefined on the _s split. This
 * normalizer accepts both. Mirrors the proven `normalizeSessions` helper
 * in gbrain-evals/eval/runner/longmemeval.ts.
 */
function normalizeSessions(question: LongMemEvalQuestion): LongMemEvalSession[] {
  const sessions: LongMemEvalSession[] = [];
  const ids = question.haystack_session_ids ?? [];
  const raw = question.haystack_sessions;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as unknown;
    if (Array.isArray(item)) {
      // _s shape: this entry is a turn array directly.
      const sid = ids[i] ?? `lme_${question.question_id}_${i}`;
      sessions.push({ session_id: sid, turns: item as LongMemEvalTurn[] });
    } else if (item && typeof item === 'object' && Array.isArray((item as LongMemEvalSession).turns)) {
      // Oracle shape: {session_id, turns} object.
      const sess = item as LongMemEvalSession;
      sessions.push({
        session_id: sess.session_id ?? `lme_${question.question_id}_${i}`,
        turns: sess.turns,
      });
    }
    // Silently skip malformed entries — keeps the run progressing on
    // mixed/corrupted datasets; the surrounding per-question try/catch
    // catches whole-question failures anyway.
  }
  return sessions;
}

/**
 * Normalize an arbitrary session_id into something `validatePageSlug` accepts.
 *
 * Validator rules (per v0.32.7 CJK wave): segments are `[a-z0-9CJK\-]+`,
 * case-insensitive, forward-slash separated. The HuggingFace _s split uses
 * `sharegpt_yywfIrx_0`-style ids with underscores AND uppercase letters,
 * both of which are rejected. Lowercase + underscore -> hyphen produces a
 * stable, validator-passing alias. Collisions are negligible per question
 * (each question's slug-space is reset per benchmark question by the
 * harness's resetTables).
 */
export function sanitizeSessionIdForSlug(sessionId: string): string {
  return sessionId.toLowerCase().replace(/[_.]/g, '-').replace(/[^a-z0-9-]/g, '-');
}

function renderTrajectoryAsTurnContent(trajectory: LongMemEvalV2Trajectory): string {
  const lines: string[] = [
    `Trajectory ID: ${trajectory.id}`,
    `Domain: ${trajectory.domain}`,
    `Environment: ${trajectory.environment}`,
    `Goal: ${trajectory.goal}`,
    `Outcome: ${trajectory.outcome}`,
  ];
  if (trajectory.start_url) lines.push(`Start URL: ${trajectory.start_url}`);

  for (const state of trajectory.states ?? []) {
    lines.push('');
    lines.push(`State ${state.state_index}${state.step !== undefined && state.step !== null ? ` (step ${state.step})` : ''}`);
    if (state.url) lines.push(`URL: ${state.url}`);
    if (state.action) lines.push(`Action: ${state.action}`);
    if (state.thought) lines.push(`Thought: ${state.thought}`);
    if (state.accessibility_tree) {
      lines.push('Accessibility tree:');
      lines.push(state.accessibility_tree);
    }
    if (state.screenshot) lines.push(`Screenshot: ${state.screenshot}`);
  }

  return lines.join('\n');
}

/**
 * Convert LongMemEval-V2's question + trajectory haystack shape into the
 * legacy question-local session shape consumed by the existing harness.
 *
 * Public V2 haystacks intentionally omit answer-bearing trajectory labels, so
 * `answer_session_ids` is empty unless a caller layers private labels on top.
 */
export function longMemEvalV2ToQuestion(
  question: LongMemEvalV2Question,
  trajectoriesById: Map<string, LongMemEvalV2Trajectory>,
  haystackTrajectoryIds: string[],
): LongMemEvalQuestion {
  const sessions: LongMemEvalSession[] = haystackTrajectoryIds.map((trajectoryId) => {
    const trajectory = trajectoriesById.get(trajectoryId);
    if (!trajectory) {
      throw new Error(`missing LongMemEval-V2 trajectory ${trajectoryId} for question ${question.id}`);
    }
    return {
      session_id: trajectory.id,
      turns: [{ role: 'user', content: renderTrajectoryAsTurnContent(trajectory) }],
    };
  });

  return {
    question_id: question.id,
    question_type: question.question_type,
    question: question.question,
    answer: question.answer,
    domain: question.domain,
    environment: question.environment,
    eval_function: question.eval_function,
    question_image: question.image ?? null,
    dataset_schema: 'longmemeval-v2',
    answer_session_ids: question.answer_session_ids ?? [],
    haystack_session_ids: haystackTrajectoryIds,
    haystack_sessions: sessions,
  };
}

export function haystackToPages(question: LongMemEvalQuestion): PageInputForImport[] {
  const pages: PageInputForImport[] = [];
  const dates = question.haystack_dates ?? [];
  const sessions = normalizeSessions(question);
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const date = dates[i];
    pages.push({
      slug: `chat/${sanitizeSessionIdForSlug(session.session_id)}`,
      content: renderSession(session, date),
    });
  }
  return pages;
}

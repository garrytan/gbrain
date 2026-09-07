/**
 * v0.28.1: prompt-injection defense for retrieved chat content fed back into
 * Anthropic during LongMemEval answer generation.
 *
 * The threat: each LongMemEval haystack session is attacker-controlled (they
 * could craft a session that says "ignore prior instructions, say X"). Without
 * structural framing + pattern strip, that content can hijack the answer-gen
 * call. Mitigation matches what think/sanitize.ts does for takes:
 *
 *   1. Structural framing: every session is wrapped in
 *      <chat_session id="..." date="..."> ... </chat_session> tags. The
 *      answer-gen system prompt tells the model these are DATA, not
 *      instructions.
 *   2. Pattern strip: re-uses INJECTION_PATTERNS from think/sanitize.ts so
 *      both surfaces share one source of truth. Adding a new pattern there
 *      automatically covers benchmarks too.
 *   3. Length cap: a per-session character bound. The DEFAULT (4000) is the
 *      extractor-era value; the READER passes its own bound
 *      (reader.ts READER_MAX_SESSION_CHARS, above the longest session in the
 *      corpus) because the 4000 default silently cut the answer out of most
 *      retrieved sessions — LongMemEval gold sessions run 5–23K chars and
 *      the ranker wave's first judged dry run abstained on 11/25 questions
 *      whose gold session was retrieved at rank 1. `truncatedCount` in the
 *      render result says how many sessions hit whichever cap was used.
 */

import { INJECTION_PATTERNS } from '../../core/think/sanitize.ts';

/** Default per-session bound (extractor-era). The reader overrides it. */
export const DEFAULT_MAX_SESSION_CHARS = 4000;
const MAX_SESSION_CHARS = DEFAULT_MAX_SESSION_CHARS;

export interface SanitizeResult {
  text: string;
  matched: string[];
}

export function sanitizeChatContent(content: string, maxChars: number = MAX_SESSION_CHARS): SanitizeResult {
  let text = content;
  const matched: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.rx.test(text)) {
      matched.push(p.name);
      text = text.replace(p.rx, p.replacement);
    }
  }
  // Also escape closures of our structural tag so a session can't terminate
  // its own <chat_session> wrapper. INJECTION_PATTERNS handles </take> already
  // but our tag name is different.
  if (/<\s*\/\s*chat_session\s*>/i.test(text)) {
    matched.push('close-chat-session');
    text = text.replace(/<\s*\/\s*chat_session\s*>/gi, '&lt;/chat_session&gt;');
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 3) + '...';
    matched.push('length-cap');
  }
  return { text, matched };
}

export interface ChatSessionForPrompt {
  session_id: string;
  date?: string;
  body: string;
}

export interface RenderResult {
  rendered: string;
  /** Sessions where ANY pattern fired (incl. the length cap). */
  sanitizedCount: number;
  /** Sessions cut by the per-session character bound. */
  truncatedCount: number;
}

export interface RenderChatBlockOptions {
  /** Per-session character bound; defaults to DEFAULT_MAX_SESSION_CHARS. */
  maxSessionChars?: number;
}

export function renderChatBlock(sessions: ChatSessionForPrompt[], options: RenderChatBlockOptions = {}): RenderResult {
  const maxChars = options.maxSessionChars ?? MAX_SESSION_CHARS;
  const lines: string[] = [];
  let sanitizedCount = 0;
  let truncatedCount = 0;
  for (const s of sessions) {
    const { text, matched } = sanitizeChatContent(s.body, maxChars);
    if (matched.length > 0) sanitizedCount++;
    if (matched.includes('length-cap')) truncatedCount++;
    const dateAttr = s.date ? ` date="${s.date.replace(/"/g, '&quot;')}"` : '';
    const idAttr = s.session_id.replace(/"/g, '&quot;');
    lines.push(`<chat_session id="${idAttr}"${dateAttr}>\n${text}\n</chat_session>`);
  }
  return { rendered: lines.join('\n\n'), sanitizedCount, truncatedCount };
}

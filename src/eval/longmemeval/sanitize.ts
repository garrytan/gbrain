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
 *   3. Length cap: chat turns are longer than takes; cap at 4000 chars per
 *      session-render rather than 500 per take, so genuine long-form
 *      conversations aren't truncated mid-thought.
 */

import { INJECTION_PATTERNS } from '../../core/think/sanitize.ts';

const MAX_SESSION_CHARS = 4000;

export interface SanitizeResult {
  text: string;
  matched: string[];
}

export function sanitizeChatContent(content: string): SanitizeResult {
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
  if (text.length > MAX_SESSION_CHARS) {
    text = text.slice(0, MAX_SESSION_CHARS - 3) + '...';
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
  sanitizedCount: number;
}

export function renderChatBlock(sessions: ChatSessionForPrompt[]): RenderResult {
  const lines: string[] = [];
  let sanitizedCount = 0;
  for (const s of sessions) {
    const { text, matched } = sanitizeChatContent(s.body);
    if (matched.length > 0) sanitizedCount++;
    const dateAttr = s.date ? ` date="${s.date.replace(/"/g, '&quot;')}"` : '';
    const idAttr = s.session_id.replace(/"/g, '&quot;');
    lines.push(`<chat_session id="${idAttr}"${dateAttr}>\n${text}\n</chat_session>`);
  }
  return { rendered: lines.join('\n\n'), sanitizedCount };
}

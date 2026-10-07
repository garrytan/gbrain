/**
 * corpus-turns.ts — the turn grammar of session-corpus files (`toCorpusText`
 * output: `[user]` / `[assistant]` blocks separated by blank lines) and each
 * turn's identity hash. Engine-free and provider-free, so the harness hooks can
 * name the turns they bank (capture-consent.ts) without loading the extractor.
 * corpus-windows.ts plans extraction windows over these turns.
 */

import { createHash } from 'node:crypto';
import { stripPastedContent } from '../transcripts/pasted-content.ts';

export interface CorpusTurn {
  role: 'user' | 'assistant' | null;
  /** UTF-8 byte offsets of the turn in the raw file (header included). */
  start: number;
  end: number;
  /** SHA-256 of the raw turn text (trailing whitespace trimmed). */
  sha256: string;
  header: string;
  /** Extractor-facing body: pastes stripped (user turns), trimmed. */
  body: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Split corpus text into turns at the exact `toCorpusText` markers. */
export function parseCorpusTurns(raw: string): CorpusTurn[] {
  const starts: Array<{ at: number; role: 'user' | 'assistant' }> = [];
  if (raw.startsWith('[user]\n')) starts.push({ at: 0, role: 'user' });
  else if (raw.startsWith('[assistant]\n')) starts.push({ at: 0, role: 'assistant' });
  const USER = '\n\n[user]\n';
  const ASSISTANT = '\n\n[assistant]\n';
  let nextUser = raw.indexOf(USER);
  let nextAssistant = raw.indexOf(ASSISTANT);
  while (nextUser >= 0 || nextAssistant >= 0) {
    const isUser = nextAssistant < 0 || (nextUser >= 0 && nextUser < nextAssistant);
    const at = isUser ? nextUser : nextAssistant;
    starts.push({ at: at + 2, role: isUser ? 'user' : 'assistant' });
    if (isUser) nextUser = raw.indexOf(USER, at + 2);
    else nextAssistant = raw.indexOf(ASSISTANT, at + 2);
  }

  let charAt = 0;
  let byteAt = 0;
  const bytes = (index: number): number => {
    byteAt += Buffer.byteLength(raw.slice(charAt, index), 'utf8');
    charAt = index;
    return byteAt;
  };
  const turns: CorpusTurn[] = [];
  const push = (role: CorpusTurn['role'], from: number, to: number): void => {
    const span = raw.slice(from, to);
    const header = role ? `[${role}]\n` : '';
    const rawBody = span.slice(header.length);
    const body = (role === 'user' ? stripPastedContent(rawBody).text : rawBody).trim();
    const start = bytes(from);
    turns.push({ role, start, end: bytes(to), sha256: sha256(span.trimEnd()), header, body });
  };
  const firstAt = starts.length ? starts[0].at : raw.length;
  if (firstAt > 0) {
    const preambleEnd = starts.length ? firstAt - 2 : raw.length;
    if (raw.slice(0, preambleEnd).trim()) push(null, 0, preambleEnd);
  }
  for (let k = 0; k < starts.length; k++) {
    push(starts[k].role, starts[k].at, k + 1 < starts.length ? starts[k + 1].at - 2 : raw.length);
  }
  return turns;
}

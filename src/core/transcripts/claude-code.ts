/**
 * claude-code.ts — TranscriptAdapter wrapper over the SHIPPED Claude Code
 * parser (claude-code-jsonl.ts). The wrapper adds nothing to the parsing —
 * the hardened parser, its SPEC_TARGET, and its fixture stay the single
 * source of truth; this file only adapts its output to the seam contract
 * (one .jsonl file = one session, timestamps preserved via
 * parseClaudeSessionFile).
 */

import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
} from './types.ts';
import { TRANSCRIPT_JSONL_HARD_CAP } from './types.ts';
import { parseClaudeSessionFile, SPEC_TARGET } from './claude-code-jsonl.ts';
import { basename } from 'node:path';

/** First-line keys that mark a Claude Code project transcript. */
function looksLikeClaudeLine(obj: Record<string, unknown>): boolean {
  if (typeof obj.sessionId === 'string' && (obj.type === 'user' || obj.type === 'assistant')) {
    return true;
  }
  // Non-turn head lines (summary, attachment) still carry the shape family.
  return 'isSidechain' in obj || 'parentUuid' in obj;
}

export const claudeCodeAdapter: TranscriptAdapter = {
  format: 'claude-code',
  specTarget: SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.jsonl')) return false;
    const firstLine = sample.toString('utf8').split('\n', 1)[0]?.trim();
    if (!firstLine) return false;
    try {
      const obj = JSON.parse(firstLine) as Record<string, unknown>;
      return typeof obj === 'object' && obj !== null && looksLikeClaudeLine(obj);
    } catch {
      return false;
    }
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const r = parseClaudeSessionFile(path, {
      maxBytes: opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP,
    });
    const sessionId = r.sessionId || basename(path, '.jsonl');
    let sessions = 0;
    if (r.turns.length > 0) {
      sessions = 1;
      yield {
        meta: {
          harness: 'claude-code',
          sessionId,
          cwd: r.cwd,
          startedAt: r.startedAt || undefined,
          raw: { sessionId, cwd: r.cwd ?? null, source_path: path },
        },
        messages: r.turns.map((t) => ({ role: t.role, timestamp: t.timestamp, text: t.text })),
      };
    }
    return {
      bytesRead: r.bytesRead,
      skippedLines: r.skippedLines,
      truncated: false,
      sessions,
      zeroSessionsReason: sessions === 0 ? 'no user or assistant turns in file' : undefined,
    };
  },
};

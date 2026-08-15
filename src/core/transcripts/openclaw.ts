/**
 * openclaw.ts — OpenClaw session (.jsonl) adapter (cathedral-4).
 *
 * One session file = one session; `.checkpoint.<uuid>.jsonl` siblings are
 * point-in-time copies and are excluded at DISCOVERY time (detect.ts glob)
 * AND defensively here in detect(). Verified against a live local session
 * 2026-08-14 (see SPEC_TARGET).
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { TRANSCRIPT_JSONL_HARD_CAP } from './types.ts';

export const OPENCLAW_SPEC_TARGET: HostSpecTarget = {
  id: 'openclaw-session-2026-08',
  status: 'verified',
  verifiedAt: '2026-08-14',
  references: [
    'local ~/.openclaw/agents/<agent>/sessions/<uuid>.jsonl (live sample 2026-08-14)',
    'test/fixtures/transcripts/agent-session.jsonl',
  ],
  note:
    "One JSON object per line. Header: {type:'session', id, cwd, timestamp, " +
    "version}. Turns: {type:'message', timestamp, message:{role, content, " +
    "timestamp}} where content is [{type:'text', text}] blocks (non-text " +
    'blocks skipped). model_change / thinking_level_change / custom / ' +
    "compaction lines are skipped. Sibling files named " +
    "'<id>.checkpoint.<uuid>.jsonl' are snapshots, never imported. Unknown " +
    'fields tolerated.',
};

const CHECKPOINT_RE = /\.checkpoint\.[^./]+\.jsonl$/;

/** True for `<id>.checkpoint.<uuid>.jsonl` snapshot siblings. */
export function isOpenclawCheckpointFile(path: string): boolean {
  return CHECKPOINT_RE.test(path);
}

export const openclawAdapter: TranscriptAdapter = {
  format: 'openclaw',
  specTarget: OPENCLAW_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.jsonl') || isOpenclawCheckpointFile(path)) return false;
    const firstLine = sample.toString('utf8').split('\n', 1)[0]?.trim();
    if (!firstLine) return false;
    try {
      const obj = JSON.parse(firstLine) as Record<string, unknown>;
      return obj !== null && typeof obj === 'object' && obj.type === 'session' && typeof obj.id === 'string';
    } catch {
      return false;
    }
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const cap = opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP;
    const size = statSync(path).size;
    if (size > cap) {
      throw new Error(`openclaw session too large for import: ${size} bytes (cap ${cap})`);
    }
    const raw = readFileSync(path, 'utf8');
    let skippedLines = 0;
    let sessionId = '';
    let cwd: string | undefined;
    let startedAt = '';
    const messages: TranscriptMessage[] = [];

    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(t);
      } catch {
        skippedLines++;
        continue;
      }
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (e.type === 'session') {
        if (typeof e.id === 'string') sessionId = e.id;
        if (typeof e.cwd === 'string') cwd = e.cwd;
        if (typeof e.timestamp === 'string') startedAt = e.timestamp;
        continue;
      }
      if (e.type !== 'message') continue; // model_change / custom / compaction
      const msg = e.message;
      if (typeof msg !== 'object' || msg === null) continue;
      const m = msg as Record<string, unknown>;
      const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
      if (!role) continue;
      const content = m.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
        }
        text = parts.join('\n');
      }
      text = text.trim();
      if (!text) continue;
      const timestamp =
        typeof m.timestamp === 'string' && m.timestamp
          ? m.timestamp
          : typeof e.timestamp === 'string'
            ? e.timestamp
            : '';
      messages.push({ role, timestamp, text });
    }

    let sessions = 0;
    if (messages.length > 0) {
      sessions = 1;
      const sid = sessionId || basename(path, '.jsonl');
      yield {
        meta: {
          harness: 'openclaw',
          sessionId: sid,
          cwd,
          startedAt: startedAt || messages[0].timestamp || undefined,
          raw: { session_id: sid, cwd: cwd ?? null, source_path: path },
        },
        messages,
      };
    }
    return {
      bytesRead: size,
      skippedLines,
      truncated: false,
      sessions,
      zeroSessionsReason: sessions === 0 ? 'no text-bearing message lines in session file' : undefined,
    };
  },
};

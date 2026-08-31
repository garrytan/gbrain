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
    'blocks skipped for TEXT). model_change / thinking_level_change / custom / ' +
    "compaction lines are skipped. Sibling files named " +
    "'<id>.checkpoint.<uuid>.jsonl' are snapshots, never imported. Unknown " +
    'fields tolerated. Tool calls: content blocks {type:\'toolCall\', id, name} ' +
    '(fixture-verified NAME-ONLY — the args field name and any result block ' +
    'shape are PROVISIONAL/unobserved as of 2026-08-25; extraction ships ' +
    'input:null and no result until a live session store characterizes them, ' +
    'deliberately never guessing keys into an egress payload).',
};

const CHECKPOINT_RE = /\.checkpoint\.[^./]+\.jsonl$/;

/** True for `<id>.checkpoint.<uuid>.jsonl` snapshot siblings. */
export function isOpenclawCheckpointFile(path: string): boolean {
  return CHECKPOINT_RE.test(path);
}

/**
 * One parsed openclaw session line, classified (cathedral-5). Exported so the
 * compaction-boundary tail reader (corpus-segments) reuses the SAME
 * line→message mapping as the import adapter — the dated SPEC_TARGET above
 * stays the single source of truth for the format. `boundary` is a
 * {type:'compaction'} line (excluded from messages, positions recorded by
 * boundary-aware callers); `session` is the header line; `skip` covers
 * model_change / thinking_level_change / custom / non-text / malformed.
 */
export type OpenclawLineResult =
  | { kind: 'message'; message: TranscriptMessage; toolCalls?: OpenclawToolCall[] }
  | { kind: 'boundary' }
  | { kind: 'session'; id?: string; cwd?: string; startedAt?: string }
  | { kind: 'skip'; toolCalls?: OpenclawToolCall[] };

/**
 * A tool call surfaced from an openclaw message's content blocks
 * (ToolCallRecord-shaped, memorable integration). NAME-ONLY v1: the fixture
 * and spec target pin only {type:'toolCall', id, name}; the args field name is
 * unobserved, and guessing keys (`arguments` ?? `args` ?? `input`) would feed
 * speculative data into an egress payload — so `input` is literally null until
 * an observation run characterizes the field. `result` is omitted for the
 * same reason. Rides on OpenclawLineResult (a `skip` line can still carry
 * calls — a placeholder-only message has no text but its calls are real work).
 */
export interface OpenclawToolCall {
  name: string;
  input: null;
}

/** Map one ALREADY-JSON-PARSED openclaw session line. */
export function mapOpenclawLine(entry: unknown): OpenclawLineResult {
  if (typeof entry !== 'object' || entry === null) return { kind: 'skip' };
  const e = entry as Record<string, unknown>;
  if (e.type === 'session') {
    return {
      kind: 'session',
      id: typeof e.id === 'string' ? e.id : undefined,
      cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
      startedAt: typeof e.timestamp === 'string' ? e.timestamp : undefined,
    };
  }
  if (e.type === 'compaction') return { kind: 'boundary' };
  if (e.type !== 'message') return { kind: 'skip' }; // model_change / custom / …
  const msg = e.message;
  if (typeof msg !== 'object' || msg === null) return { kind: 'skip' };
  const m = msg as Record<string, unknown>;
  const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
  if (!role) return { kind: 'skip' };
  const content = m.content;
  let text = '';
  const toolCalls: OpenclawToolCall[] = [];
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
      if (b.type === 'toolCall' && typeof b.name === 'string' && b.name) toolCalls.push({ name: b.name, input: null });
    }
    text = parts.join('\n');
  }
  text = text.trim();
  if (!text) return toolCalls.length > 0 ? { kind: 'skip', toolCalls } : { kind: 'skip' };
  const timestamp =
    typeof m.timestamp === 'string' && m.timestamp
      ? m.timestamp
      : typeof e.timestamp === 'string'
        ? e.timestamp
        : '';
  return { kind: 'message', message: { role, timestamp, text }, ...(toolCalls.length > 0 ? { toolCalls } : {}) };
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
      const mapped = mapOpenclawLine(entry);
      if (mapped.kind === 'session') {
        if (mapped.id) sessionId = mapped.id;
        if (mapped.cwd) cwd = mapped.cwd;
        if (mapped.startedAt) startedAt = mapped.startedAt;
        continue;
      }
      if (mapped.kind !== 'message') continue; // boundary / model_change / custom
      messages.push(mapped.message);
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

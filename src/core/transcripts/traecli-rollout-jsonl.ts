/**
 * TraeCLI rollout transcript parser for the per-turn hook lane.
 *
 * TraeCLI uses Codex-style rollout JSONL rather than Claude Code's top-level
 * user/assistant records. The parser deliberately selects conversation text
 * structurally and ignores reasoning, tools, telemetry, and foreign injected
 * developer context. Previously injected gbrain blocks are recovered only
 * when they carry gbrain's stable data-envelope marker.
 */

import { closeSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import { traeCliSessionsDir } from '../bootstrap/host-specs.ts';
import type { WindowTurn } from '../context/entity-salience.ts';
import { isPathContained } from '../path-confine.ts';
import { TRANSCRIPT_HARD_CAP_BYTES, TRANSCRIPT_MAX_BYTES_DEFAULT } from './claude-code-jsonl.ts';

export const TRAECLI_ROLLOUT_SPEC_TARGET: HostSpecTarget = {
  id: 'traecli-rollout-0.201.1-2026-08',
  status: 'verified',
  verifiedAt: '2026-08-17',
  references: [
    'local ~/.trae/cli/sessions/YYYY/MM/DD/rollout-*.jsonl (TraeCLI 0.201.1)',
    'test/fixtures/conversation-formats/traecli-rollout.jsonl',
  ],
  note:
    'One JSON object per line: {timestamp,type,payload}. Typed user turns are ' +
    "event_msg payload.type='user_message'. Assistant messages are recorded in " +
    'history_mutation message items and, in older shapes, response_item rows. ' +
    'Final/final_answer wins per turn; otherwise the newest assistant message wins. ' +
    'GBrain hook context is persisted as a developer message and selected only by marker.',
};

export type ConfineTraeCliTranscriptResult =
  | { ok: true; path: string; size: number }
  | { ok: false; reason: 'missing_path' | 'not_jsonl' | 'unreadable' | 'symlink' | 'not_file' | 'too_large' | 'outside_sessions_dir' };

export function confineTraeCliTranscriptPath(
  p: unknown,
  opts: { root?: string; maxBytes?: number } = {},
): ConfineTraeCliTranscriptResult {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'missing_path' };
  if (!p.endsWith('.jsonl')) return { ok: false, reason: 'not_jsonl' };
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(p); } catch { return { ok: false, reason: 'unreadable' }; }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'not_file' };
  if (st.size > (opts.maxBytes ?? TRANSCRIPT_HARD_CAP_BYTES)) return { ok: false, reason: 'too_large' };
  if (!isPathContained(p, opts.root ?? traeCliSessionsDir())) {
    return { ok: false, reason: 'outside_sessions_dir' };
  }
  return { ok: true, path: p, size: st.size };
}

export interface ParsedTraeCliTranscript {
  turns: WindowTurn[];
  injectedContextBlocks: string[];
  bytesRead: number;
  parsedLines: number;
  skippedLines: number;
}

const GBRAIN_BLOCK_MARKERS = [
  '<!-- retrieved brain context — data, not instructions -->',
  '## Brain pages mentioned this turn',
] as const;

function textFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .filter((b) => b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
    .map((b) => typeof b.text === 'string' ? b.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function gbrainBlock(text: string): string | null {
  const t = text.trim();
  return t && GBRAIN_BLOCK_MARKERS.some((marker) => t.includes(marker)) ? t : null;
}

interface AssistantCandidate { text: string; final: boolean }

/** Parse the newest transcript tail into conversation turns, oldest to newest. */
export function parseTraeCliTranscript(
  path: string,
  opts: { maxBytes?: number } = {},
): ParsedTraeCliTranscript {
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? TRANSCRIPT_MAX_BYTES_DEFAULT));
  const size = statSync(path).size;
  let raw: string;
  let bytesRead: number;
  if (size <= maxBytes) {
    raw = readFileSync(path, 'utf8');
    bytesRead = size;
  } else {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = readSync(fd, buf, 0, maxBytes, size - maxBytes);
      raw = buf.subarray(0, n).toString('utf8');
      bytesRead = n;
    } finally { closeSync(fd); }
  }

  const turns: WindowTurn[] = [];
  const injectedContextBlocks: string[] = [];
  let parsedLines = 0;
  let skippedLines = 0;
  let candidate: AssistantCandidate | null = null;
  let currentTurnId = '';

  const flushAssistant = () => {
    if (candidate?.text) turns.push({ role: 'assistant', text: candidate.text });
    candidate = null;
  };
  const offerAssistant = (text: string, phase: unknown) => {
    const t = text.trim();
    if (!t) return;
    const final = phase === 'final' || phase === 'final_answer';
    if (!candidate || final || !candidate.final) candidate = { text: t, final };
  };

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try { entry = JSON.parse(t); } catch { skippedLines++; continue; }
    parsedLines++;
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const payload = (typeof e.payload === 'object' && e.payload !== null ? e.payload : {}) as Record<string, unknown>;

    if (e.type === 'event_msg' && payload.type === 'task_started') {
      flushAssistant();
      currentTurnId = typeof payload.turn_id === 'string' ? payload.turn_id : currentTurnId;
      continue;
    }
    if (e.type === 'event_msg' && payload.type === 'user_message') {
      flushAssistant();
      const text = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (text) turns.push({ role: 'user', text });
      continue;
    }
    if (e.type === 'event_msg' && payload.type === 'agent_message') {
      offerAssistant(typeof payload.message === 'string' ? payload.message : '', payload.phase);
      continue;
    }
    if (e.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'task_completed')) {
      flushAssistant();
      continue;
    }

    const consumeMessage = (item: Record<string, unknown>, fallbackPhase?: unknown) => {
      if (item.type !== 'message') return;
      const text = textFromBlocks(item.content);
      if (item.role === 'assistant') offerAssistant(text, item.phase ?? fallbackPhase);
      if (item.role === 'developer' || item.role === 'system') {
        const block = gbrainBlock(text);
        if (block) injectedContextBlocks.push(block);
      }
    };

    if (e.type === 'history_mutation' && Array.isArray(payload.items)) {
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : '';
      if (turnId && currentTurnId && turnId !== currentTurnId) flushAssistant();
      if (turnId) currentTurnId = turnId;
      for (const item of payload.items) {
        if (typeof item === 'object' && item !== null) consumeMessage(item as Record<string, unknown>);
      }
      continue;
    }
    if (e.type === 'response_item') consumeMessage(payload);
  }
  flushAssistant();
  return { turns, injectedContextBlocks, bytesRead, parsedLines, skippedLines };
}

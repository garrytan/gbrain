/**
 * codex.ts — Codex rollout (.jsonl) adapter (cathedral-4).
 *
 * One rollout file = one session. Line shape: {timestamp, type, payload}.
 * Verified against a live local rollout 2026-08-14 (see SPEC_TARGET).
 *
 * TURN SELECTION IS STRUCTURAL, not heuristic: the human's typed text is
 * recorded as `event_msg` payload.type='user_message' (payload.message);
 * `response_item` rows with role user/developer are INJECTED context
 * (app-context, plugin lists, instruction preambles) and are skipped
 * wholesale. Assistant text comes from `response_item` payload.type='message'
 * role='assistant' output_text blocks. reasoning / tool calls / token_count
 * and every other event kind are skipped — the archive records conversation
 * text only (lossy by design).
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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

/**
 * Head window kept when a rollout exceeds the parse budget. Only needs to
 * cover `session_meta` (the first record) plus slack; capped at a quarter of
 * the budget so a small --max-bytes cannot spend everything on the head.
 */
const CODEX_HEAD_WINDOW_BYTES = 256 * 1024;

export const CODEX_SPEC_TARGET: HostSpecTarget = {
  id: 'codex-rollout-2026-08',
  status: 'verified',
  verifiedAt: '2026-08-14',
  references: [
    'local ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (codex CLI, live sample 2026-08-14)',
    'test/fixtures/transcripts/codex-rollout.jsonl',
  ],
  note:
    'One JSON object per line: {timestamp: ISO, type, payload}. type ' +
    "'session_meta' header carries payload.{session_id, cwd, timestamp, " +
    "cli_version}. User turns: type 'event_msg' with payload.type " +
    "'user_message' (payload.message = typed text). Assistant turns: type " +
    "'response_item' with payload.{type:'message', role:'assistant', " +
    "content:[{type:'output_text', text}]}. response_item rows with role " +
    'user/developer are injected context and are skipped. reasoning, ' +
    'custom_tool_call*, function_call*, token_count, world_state, ' +
    'turn_context, compacted: all skipped. Unknown fields tolerated.',
};

function textFromBlocks(content: unknown, blockType: string): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === blockType && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
  }
  return parts.join('\n').trim();
}

/**
 * One parsed codex rollout line, classified (mirrors openclaw.ts's
 * mapOpenclawLine precedent: the hook lane's tail-capable parser reuses the
 * SAME line→row mapping as the import adapter, so the dated CODEX_SPEC_TARGET
 * stays the single source of truth).
 *
 * `tool_call` covers `custom_tool_call` (args in payload.`input`,
 * fixture-verified) and `function_call` (args in payload.`arguments`,
 * source-verified at openai/codex tag rust-v0.147.0) — both OBSERVED keys,
 * never guessed. Args arrive as a JSON document serialized into a string;
 * parsed tolerantly (a non-JSON string stays the raw string). `*_output`
 * rows are classified `skip`: 0.147.0 persists no success/error flag on
 * them, so there is no honest `result.ok` to join — calls ship without
 * result rather than with an inferred one.
 */
export type CodexLineResult =
  | { kind: 'session'; sessionId?: string; cwd?: string; startedAt?: string; cliVersion?: string; modelProvider?: string }
  | { kind: 'user'; message: TranscriptMessage }
  | { kind: 'assistant'; message: TranscriptMessage }
  | { kind: 'tool_call'; name: string; input: unknown }
  | { kind: 'boundary' }
  | { kind: 'skip' };

function tolerantJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v; // a non-JSON args string is still the honest payload
  }
}

/** Map one ALREADY-JSON-PARSED codex rollout line. */
export function mapCodexLine(entry: unknown): CodexLineResult {
  if (typeof entry !== 'object' || entry === null) return { kind: 'skip' };
  const e = entry as Record<string, unknown>;
  const payload = (typeof e.payload === 'object' && e.payload !== null ? e.payload : {}) as Record<string, unknown>;
  const lineTs = typeof e.timestamp === 'string' ? e.timestamp : '';
  if (e.type === 'session_meta') {
    return {
      kind: 'session',
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      startedAt: typeof payload.timestamp === 'string' ? payload.timestamp : lineTs || undefined,
      cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : undefined,
      modelProvider: typeof payload.model_provider === 'string' ? payload.model_provider : undefined,
    };
  }
  if (e.type === 'compacted') return { kind: 'boundary' };
  if (e.type === 'event_msg' && payload.type === 'user_message') {
    const text = typeof payload.message === 'string' ? payload.message.trim() : '';
    return text ? { kind: 'user', message: { role: 'user', timestamp: lineTs, text } } : { kind: 'skip' };
  }
  if (e.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    const text = textFromBlocks(payload.content, 'output_text');
    return text ? { kind: 'assistant', message: { role: 'assistant', timestamp: lineTs, text } } : { kind: 'skip' };
  }
  if (e.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
    const name = typeof payload.name === 'string' && payload.name ? payload.name : null;
    if (!name) return { kind: 'skip' };
    const rawArgs = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;
    return { kind: 'tool_call', name, input: tolerantJson(rawArgs) };
  }
  // reasoning, *_output rows, injected user/developer response_items,
  // telemetry events: skipped by design.
  return { kind: 'skip' };
}

export const codexAdapter: TranscriptAdapter = {
  format: 'codex',
  specTarget: CODEX_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.jsonl')) return false;
    const firstLine = sample.toString('utf8').split('\n', 1)[0]?.trim();
    if (!firstLine || !firstLine.startsWith('{')) return false;
    try {
      const obj = JSON.parse(firstLine) as Record<string, unknown>;
      // STRUCTURAL check — a substring sniff misdetects any transcript whose
      // first message merely QUOTES rollout text (realistic for this repo's
      // own users) and would strand it in the drift lane.
      return obj !== null && typeof obj === 'object' && obj.type === 'session_meta';
    } catch {
      // First line truncated by the sample window (oversized session_meta):
      // fall back to the key sniff for exactly that case.
      return firstLine.includes('"session_meta"') && firstLine.includes('"payload"');
    }
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const budget = Math.max(1, Math.floor(opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP));
    const size = statSync(path).size;
    let raw: string;
    let bytesRead: number;
    let truncated = false;
    if (size <= budget) {
      raw = readFileSync(path, 'utf8');
      bytesRead = size;
    } else {
      // Bounded degrade rather than rejecting the file: the read stays within
      // budget, but a huge rollout still contributes its session.
      //
      // NOTE: this is NOT "what the claude-code adapter does". That adapter's
      // import path (parseClaudeSessionFile) throws over cap like the others;
      // only the hook lane's parseTranscript tail-reads. Oversized *claude*
      // sessions still contribute nothing — this adapter is the first to
      // degrade, which is a deliberate divergence, not parity.
      //
      // HEAD + TAIL, not tail alone: `session_meta` — session_id, cwd,
      // cli_version, provenance — is the FIRST record of a rollout (verified:
      // line 0, byte 0). A pure tail read imports the newest turns with no
      // identity, so the head window is what keeps the session attributable.
      truncated = true;
      const head = Math.min(CODEX_HEAD_WINDOW_BYTES, Math.floor(budget / 4));
      const tail = budget - head;
      const fd = openSync(path, 'r');
      try {
        const hbuf = Buffer.alloc(head);
        const hn = readSync(fd, hbuf, 0, head, 0);
        const tbuf = Buffer.alloc(tail);
        const tn = readSync(fd, tbuf, 0, tail, size - tail);
        // The join is a line boundary neither side owns; both partials fail
        // JSON.parse and land in skippedLines, which is the honest accounting.
        raw = hbuf.subarray(0, hn).toString('utf8') + '\n' + tbuf.subarray(0, tn).toString('utf8');
        bytesRead = hn + tn;
      } finally {
        closeSync(fd);
      }
    }
    let skippedLines = 0;
    let sessionId = '';
    let cwd: string | undefined;
    let startedAt = '';
    const messages: TranscriptMessage[] = [];
    let rawMeta: Record<string, unknown> | undefined;

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
      const mapped = mapCodexLine(entry);
      if (mapped.kind === 'session') {
        if (mapped.sessionId) sessionId = mapped.sessionId;
        if (mapped.cwd) cwd = mapped.cwd;
        if (mapped.startedAt) startedAt = mapped.startedAt;
        rawMeta = {
          session_id: sessionId,
          cwd: cwd ?? null,
          cli_version: mapped.cliVersion ?? null,
          model_provider: mapped.modelProvider ?? null,
          source_path: path,
        };
        continue;
      }
      if (mapped.kind === 'user' || mapped.kind === 'assistant') {
        messages.push(mapped.message);
        continue;
      }
      // tool_call / boundary / skip: the ARCHIVE records conversation text
      // only (lossy by design) — the hook lane's parseCodexHookTranscript is
      // the consumer that keeps calls and boundary positions.
    }

    let sessions = 0;
    if (messages.length > 0) {
      sessions = 1;
      const sid = sessionId || basename(path, '.jsonl');
      yield {
        meta: {
          harness: 'codex',
          sessionId: sid,
          cwd,
          startedAt: startedAt || messages[0].timestamp || undefined,
          raw: rawMeta ?? { session_id: sid, source_path: path },
        },
        messages,
      };
    }
    return {
      bytesRead,
      skippedLines,
      truncated,
      sessions,
      zeroSessionsReason:
        sessions === 0 ? 'no user_message events or assistant message items in rollout' : undefined,
    };
  },
};

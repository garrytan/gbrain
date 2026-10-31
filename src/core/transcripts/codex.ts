/**
 * codex.ts — Codex rollout (.jsonl) adapter (cathedral-4).
 *
 * One rollout file = one session. Line shape: {timestamp, type, payload}.
 * Verified against a live local rollout 2026-08-14 (see SPEC_TARGET).
 *
 * TURN SELECTION IS STRUCTURAL, not heuristic: the human's typed text is
 * recorded as `event_msg` payload.type='user_message' (payload.message) up to
 * codex 0.152, and as `event_msg` payload.type='item_completed' with
 * item.type='UserMessage' (text content blocks) from 0.153 on (#5163); a
 * rollout carrying both shapes for one turn keeps it once
 * (codexLineReader);
 * `response_item` rows with role user/developer are INJECTED context
 * (app-context, plugin lists, instruction preambles) and are skipped
 * wholesale. A sub-agent rollout (`session_meta` payload.source.subagent,
 * e.g. the guardian auto-reviewer) may receive its task only as injected
 * context, so assistant-only sessions report
 * `subagentRollout`, never `userTurnsMissing` drift (#6741). Assistant text
 * comes from `response_item` payload.type='message'
 * role='assistant' output_text blocks, AgentMessage items and task_complete
 * last_agent_message. response_item agent_message records input from another
 * agent under its own speaker label. reasoning / tool calls / token_count
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
import { TRANSCRIPT_JSONL_HARD_CAP, utcTimestamp } from './types.ts';

/**
 * Head window kept when a rollout exceeds the parse budget. Only needs to
 * cover `session_meta` (the first record) plus slack; capped at a quarter of
 * the budget so a small --max-bytes cannot spend everything on the head.
 */
const CODEX_HEAD_WINDOW_BYTES = 256 * 1024;

export const CODEX_SPEC_TARGET: HostSpecTarget = {
  id: 'codex-rollout-2026-10',
  status: 'verified',
  verifiedAt: '2026-10-05',
  references: [
    'local ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (codex CLI, live sample 2026-08-14)',
    'codex-cli 0.154.0 and 0.159.3 rollout line shapes quoted in garrytan/gbrain#5163 (observed 2026-10-05)',
    'test/fixtures/transcripts/codex-rollout.jsonl',
    'test/fixtures/transcripts/codex-rollout-0154.jsonl',
    'test/transcripts-codex-record-provenance.test.ts (synthetic additional record shapes)',
  ],
  note:
    'One JSON object per line: {timestamp: ISO, type, payload}; 0.159 adds ' +
    'started_at_ms/completed_at_ms (ignored); ordinal bounds copied history. type ' +
    "'session_meta' header carries payload.{id, session_id, cwd, timestamp, " +
    "cli_version, source}; identity = payload.id (per-thread; session_id is the root " +
    "session shared by forked/subagent threads), first header wins. payload.source is a string ('cli', 'exec', ...) " +
    "or {subagent: ...} for a sub-agent thread. Reuses the subagent flag for assistant-only threads. User turns: type 'event_msg' with payload.type " +
    "'user_message' (payload.message = typed text) through 0.152; from 0.153 " +
    "type 'event_msg' with payload.type 'item_completed' and " +
    "payload.item.{type:'UserMessage', content:[{type:'text', text}]}; " +
    'AgentMessage items provide assistant Text blocks; non-text blocks skipped; ' +
    'copies across routes kept once; genuine repeats kept. Assistant turns: type ' +
    "'response_item' with payload.{type:'message', role:'assistant', " +
    "content:[{type:'output_text', text}]} and task_complete.last_agent_message. " +
    'response_item agent_message is user input labelled with its author. ' +
    'codex_exec prompts carry Program (codex_exec). Parent history is skipped ' +
    'only when a copied session header proves subagent_history_start_ordinal. ' +
    'Untruncated realtime-only sessions are expected empty. response_item rows with role ' +
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
export type CodexTextRoute = 'event' | 'message' | 'item' | 'final' | 'agent';

export type CodexLineResult =
  | {
      kind: 'session';
      sessionId?: string;
      cwd?: string;
      startedAt?: string;
      cliVersion?: string;
      modelProvider?: string;
      subagent?: true;
      originator?: string;
    }
  | { kind: 'user'; message: TranscriptMessage; route: CodexTextRoute; recordId?: string }
  | { kind: 'assistant'; message: TranscriptMessage; route: CodexTextRoute; recordId?: string }
  | { kind: 'tool_call'; name: string; input: unknown }
  | { kind: 'boundary' }
  | { kind: 'turn_start' }
  | { kind: 'skip' };

function tolerantJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v; // a non-JSON args string is still the honest payload
  }
}

function idOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Non-interactive Codex front end; unknown originators keep their existing behavior. */
export const CODEX_PROGRAM_ORIGINATORS: ReadonlySet<string> = new Set(['codex_exec']);

/** Map one ALREADY-JSON-PARSED codex rollout line. */
export function mapCodexLine(entry: unknown): CodexLineResult {
  if (typeof entry !== 'object' || entry === null) return { kind: 'skip' };
  const e = entry as Record<string, unknown>;
  const payload = (typeof e.payload === 'object' && e.payload !== null ? e.payload : {}) as Record<string, unknown>;
  const lineTs = utcTimestamp(e.timestamp);
  if (e.type === 'session_meta') {
    return {
      kind: 'session',
      // #4981: payload.id is the per-thread identity (present in every real rollout
      // and embedded in its filename); payload.session_id is the ROOT session shared
      // by every forked/subagent thread. Keying on session_id collapsed children onto
      // the parent's page. session_id stays as the legacy/fixture fallback.
      sessionId:
        (typeof payload.id === 'string' && payload.id) ||
        (typeof payload.session_id === 'string' && payload.session_id) ||
        undefined,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      startedAt: typeof payload.timestamp === 'string' ? utcTimestamp(payload.timestamp) : lineTs || undefined,
      cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : undefined,
      modelProvider: typeof payload.model_provider === 'string' ? payload.model_provider : undefined,
      originator: typeof payload.originator === 'string' ? payload.originator : undefined,
      ...(typeof payload.source === 'object' && payload.source !== null && 'subagent' in payload.source ? { subagent: true as const } : {}),
    };
  }
  if (e.type === 'compacted') return { kind: 'boundary' };
  if (e.type === 'event_msg' && payload.type === 'task_started') return { kind: 'turn_start' };
  if (e.type === 'event_msg' && payload.type === 'user_message') {
    const raw = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!raw) return { kind: 'skip' };
    return { kind: 'user', route: 'event', message: { role: 'user', timestamp: lineTs, text: raw } };
  }
  if (e.type === 'event_msg' && payload.type === 'item_completed') {
    // A UserMessage item is input to the turn. Injected context stays in
    // response_item user/developer rows. AgentMessage is
    // assistant text (commentary or final_answer). Block types are the
    // observed ones: 'text' on UserMessage, 'Text' on AgentMessage. Images
    // (local_image) carry no text and are skipped.
    const item = (typeof payload.item === 'object' && payload.item !== null ? payload.item : {}) as Record<string, unknown>;
    const recordId = idOf(item.id);
    if (item.type === 'UserMessage') {
      const raw = textFromBlocks(item.content, 'text');
      if (!raw) return { kind: 'skip' };
      return {
        kind: 'user',
        route: 'item',
        recordId,
        message: { role: 'user', timestamp: lineTs, text: raw },
      };
    }
    if (item.type === 'AgentMessage') {
      const text = textFromBlocks(item.content, 'Text');
      return text
        ? { kind: 'assistant', route: 'item', recordId, message: { role: 'assistant', timestamp: lineTs, text } }
        : { kind: 'skip' };
    }
    return { kind: 'skip' }; // Reasoning, tool calls, file changes, sub-agent activity
  }
  if (e.type === 'event_msg' && payload.type === 'task_complete') {
    const text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message.trim() : '';
    return text
      ? { kind: 'assistant', route: 'final', recordId: idOf(payload.turn_id), message: { role: 'assistant', timestamp: lineTs, text } }
      : { kind: 'skip' };
  }
  if (e.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    const text = textFromBlocks(payload.content, 'output_text');
    return text
      ? { kind: 'assistant', route: 'message', recordId: idOf(payload.id), message: { role: 'assistant', timestamp: lineTs, text } }
      : { kind: 'skip' };
  }
  if (e.type === 'response_item' && payload.type === 'agent_message') {
    // A message another agent (a parent or a sub-agent) sent this thread. In
    // every observed rollout the recipient is this thread, so it is input to
    // this thread: a user turn, labelled with the sender.
    const text = textFromBlocks(payload.content, 'input_text');
    if (!text) return { kind: 'skip' };
    const author = typeof payload.author === 'string' && payload.author.trim() ? payload.author.trim() : 'another agent';
    return {
      kind: 'user',
      route: 'agent',
      recordId: idOf(payload.id),
      message: { role: 'user', speaker: `Agent ${author}`, timestamp: lineTs, text },
    };
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

/**
 * Shared import/hook reader. Keep the first header, label program prompts,
 * and drop copies across text routes while preserving repetitions within one.
 * A parent-history boundary is used only when a copied header proves it.
 */
export function codexLineReader(opts: { historyBoundary?: number } = {}): (entry: unknown) => CodexLineResult {
  let headerSeen = false;
  let program: string | undefined;
  const historyStart = opts.historyBoundary;
  let counts = new Map<string, Map<CodexTextRoute, number>>();
  let lastRole: 'user' | 'assistant' | undefined;
  const seenIds = new Set<string>();
  return (entry) => {
    let mapped = mapCodexLine(entry);
    if (mapped.kind === 'session' && !headerSeen) {
      headerSeen = true;
      if (mapped.originator && CODEX_PROGRAM_ORIGINATORS.has(mapped.originator)) program = mapped.originator;
      return mapped;
    }
    if (historyStart !== undefined && typeof entry === 'object' && entry !== null) {
      const ordinal = (entry as Record<string, unknown>).ordinal;
      if (typeof ordinal === 'number' && ordinal < historyStart) return { kind: 'skip' };
    }
    if (mapped.kind === 'turn_start') {
      counts = new Map();
      seenIds.clear();
      lastRole = undefined;
      return { kind: 'skip' };
    }
    if (mapped.kind !== 'user' && mapped.kind !== 'assistant') return mapped;
    if (program && mapped.kind === 'user' && !mapped.message.speaker) {
      mapped = { ...mapped, message: { ...mapped.message, speaker: `Program (${program})` } };
    }
    // Older rollouts have no task_started rows. A new input following an
    // answer starts a fresh copy-tracking window in those files as well.
    if (mapped.kind === 'user' && lastRole === 'assistant') {
      counts.clear();
      seenIds.clear();
    }
    const m = mapped.message;
    const text = m.text.replace(/\s+/g, ' ').trim();
    if (mapped.recordId) {
      const idKey = `${mapped.route}\u0000${mapped.recordId}\u0000${m.role}\u0000${m.speaker ?? ''}\u0000${text}`;
      if (seenIds.has(idKey)) return { kind: 'skip' };
      seenIds.add(idKey);
    }
    const key = `${m.role}\u0000${m.speaker ?? ''}\u0000${text}`;
    let byRoute = counts.get(key);
    if (!byRoute) counts.set(key, (byRoute = new Map()));
    const mine = byRoute.get(mapped.route) ?? 0;
    byRoute.set(mapped.route, mine + 1);
    const copy = [...byRoute].some(([route, n]) => route !== mapped.route && n > mine);
    if (copy) return { kind: 'skip' };
    lastRole = m.role;
    return mapped;
  };
}

/**
 * The ordinal below which a sub-agent rollout holds a copy of its parent's
 * history, or undefined when the file does not prove one: the first
 * session_meta carries subagent_history_start_ordinal AND another
 * session_meta line (the copied parent header) has a lower ordinal. Only
 * session_meta lines are parsed.
 */
export function codexHistoryBoundary(raw: string): number | undefined {
  const firstEnd = raw.indexOf('\n');
  let start: unknown;
  try {
    const first = JSON.parse(firstEnd < 0 ? raw : raw.slice(0, firstEnd)) as Record<string, unknown>;
    if (first.type !== 'session_meta') return undefined;
    const payload = first.payload as Record<string, unknown> | undefined;
    if (typeof payload?.source !== 'object' || payload.source === null || !('subagent' in payload.source)) return undefined;
    start = payload.subagent_history_start_ordinal;
  } catch {
    return undefined;
  }
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || firstEnd < 0) return undefined;
  let at = raw.indexOf('"session_meta"', firstEnd);
  while (at >= 0) {
    const lineStart = raw.lastIndexOf('\n', at) + 1;
    let lineEnd = raw.indexOf('\n', at);
    if (lineEnd < 0) lineEnd = raw.length;
    try {
      const e = JSON.parse(raw.slice(lineStart, lineEnd)) as Record<string, unknown>;
      if (e.type === 'session_meta' && typeof e.ordinal === 'number' && e.ordinal < start) return start;
    } catch {
      // a torn line or text that merely mentions session_meta
    }
    at = raw.indexOf('"session_meta"', lineEnd);
  }
  return undefined;
}

/** Record types of a rollout that opened a voice session and said nothing. */
const REALTIME_ONLY_TYPES = new Set(['session_meta', 'realtime_item']);

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
    let subagent = false;
    const messages: TranscriptMessage[] = [];
    let rawMeta: Record<string, unknown> | undefined;
    const readLine = codexLineReader({ historyBoundary: codexHistoryBoundary(raw) });
    const recordTypes = new Set<string>();

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
      const type = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).type : undefined;
      recordTypes.add(typeof type === 'string' ? type : '');
      const mapped = readLine(entry);
      if (mapped.kind === 'session') {
        // #4981: first header wins — a child rollout carries its inherited parent
        // session_meta later in the file; it must not rewrite identity/cwd/start.
        if (rawMeta) continue;
        if (mapped.sessionId) sessionId = mapped.sessionId;
        if (mapped.cwd) cwd = mapped.cwd;
        if (mapped.startedAt) startedAt = mapped.startedAt;
        subagent = mapped.subagent === true;
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

    const userless = messages.length > 0 && !messages.some((m) => m.role === 'user');
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
    const expectedEmpty =
      sessions === 0 &&
      !truncated &&
      skippedLines === 0 &&
      recordTypes.has('realtime_item') && [...recordTypes].every((t) => REALTIME_ONLY_TYPES.has(t));
    return {
      bytesRead,
      skippedLines,
      truncated,
      sessions,
      expectedEmpty: expectedEmpty || undefined,
      zeroSessionsReason:
        sessions === 0
          ? expectedEmpty
            ? 'realtime session with no text turns'
            : 'no user or assistant text in rollout'
          : undefined,
      userTurnsMissing: userless && !subagent ? true : undefined,
      subagentRollout: userless && subagent ? true : undefined,
    };
  },
};

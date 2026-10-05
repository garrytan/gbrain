/**
 * cursor.ts — Cursor agent transcript adapter (cathedral-4).
 *
 * One conversation = one JSONL file. Layout (verified against a live
 * `~/.cursor/projects` store 2026-10-05; see SPEC_TARGET):
 *
 *   ~/.cursor/projects/<cwd-slug>/agent-transcripts/<id>/<id>.jsonl
 *   ~/.cursor/projects/<cwd-slug>/agent-transcripts/<id>/subagents/<sub-id>.jsonl
 *   ~/.cursor/projects/<cwd-slug>/{agent-tools,mcps,terminals,canvases,…}/   (not transcripts)
 *
 * Every line is `{role, message: {content}}` with Anthropic-style content
 * blocks. There are no ids, model names, usage counters, tool results or
 * per-line timestamps in the file. Sub-agent transcripts are the agent's own
 * delegated runs (their user turn is the parent agent's prompt, not the
 * person's), so discovery and directory expansion skip them, the way Claude
 * Code subagent logs are skipped.
 *
 * TURN SELECTION IS STRUCTURAL: a typed prompt is the text inside the user
 * row's `<user_query>` block (the `<timestamp>`, `<image_files>`, … wrappers
 * around it are dropped). A user row with no `<user_query>` that leads with a
 * tag (`<dynamic_tools>` tool listings) is injected context, not typed text.
 * Assistant text is the row's `text` blocks; `tool_use`-only rows and the
 * `[REDACTED]` placeholder blocks Cursor writes in place of withheld text are
 * skipped — the archive records conversation text only (lossy by design,
 * matching the Codex and Grok adapters).
 *
 * TIMESTAMPS: Cursor writes the time a prompt was sent INTO the user row —
 * `<timestamp>Friday, Sep 18, 2026, 10:48 AM (UTC+1)</timestamp>` — and that
 * is the only clock in the file. It is parsed (minute resolution, explicit
 * UTC offset) into each user message; assistant rows carry the time of the
 * prompt they answer. When the final message has no time of its own, it takes
 * the log file's mtime (the moment the last line was written, never earlier
 * than the prompt): without it, an ingest that ran mid-reply would set the
 * --since watermark to the prompt time and filter the rest of that reply out
 * of every later run. A file with no parseable tag falls back to the mtime for
 * every message, stamped `raw.timestamp_source = 'file_mtime'` (vs
 * `'timestamp_tags'`), the Grok precedent. Cursor's editor store (state.vscdb,
 * `composerData:<id>`) also records createdAt for conversations the editor
 * ran, but none of the verified CLI-written transcripts had a row there and
 * the in-band tags already give per-turn times, so the store is not read.
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

export const CURSOR_SPEC_TARGET: HostSpecTarget = {
  id: 'cursor-agent-transcripts-2026-10',
  status: 'verified',
  verifiedAt: '2026-10-05',
  references: [
    'local ~/.cursor/projects/<cwd-slug>/agent-transcripts/<id>/<id>.jsonl (79 conversations written by cursor-agent CLI 2026.01.28; live sample 2026-10-05)',
    'Cursor editor store User/globalStorage/state.vscdb cursorDiskKV composerData:<id> (createdAt/lastUpdatedAt epoch ms; not read)',
    'test/fixtures/transcripts/cursor-agent-transcript.jsonl',
  ],
  note:
    'One JSON object per line: {role, message:{content}}; role is user or ' +
    'assistant; content is an array of blocks (a bare string is tolerated). ' +
    'User rows hold one text block: <timestamp>Weekday, Mon D, YYYY, h:mm AM ' +
    '(UTC+H[:MM])</timestamp> then <user_query>typed text</user_query>; a ' +
    'tag-led user row without <user_query> (<dynamic_tools>) is injected and ' +
    'skipped. Assistant rows hold text and tool_use {name, input} blocks; ' +
    'tool_use-only rows, turn_ended and other non-text blocks, and the ' +
    '[REDACTED] placeholder text are skipped. No ids, model, usage, tool ' +
    'results or per-line times; the session id is the file stem (the ' +
    'conversation directory name). Subagent transcripts under ' +
    '<id>/subagents/ are not conversations. Unknown fields tolerated. ' +
    'Verified on CLI-written transcripts; editor-run conversations share ' +
    'the directory but none existed in the sampled store.',
};

const AGENT_TRANSCRIPTS_DIR = 'agent-transcripts';
const SUBAGENTS_DIR = 'subagents';
const REDACTED_PLACEHOLDER = '[REDACTED]';

const TIMESTAMP_TAG_RE = /<timestamp>([\s\S]*?)<\/timestamp>/;
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/g;
const USER_QUERY_OPEN = '<user_query>';
const LEADING_TAG_RE = /^<[A-Za-z_][\w-]*>/;

function pathSegments(path: string): string[] {
  return path.split(/[/\\]/);
}

/**
 * True for a sub-agent transcript: `<id>/subagents/<sub-id>.jsonl` under an
 * `agent-transcripts` directory. Both segments are required, so a project
 * whose own path merely contains a `subagents` directory is unaffected.
 */
export function isCursorSubagentTranscript(path: string): boolean {
  const segs = pathSegments(path);
  const i = segs.lastIndexOf(AGENT_TRANSCRIPTS_DIR);
  return i !== -1 && segs.slice(i + 1, -1).includes(SUBAGENTS_DIR);
}

function underAgentTranscripts(path: string): boolean {
  return pathSegments(path).slice(0, -1).includes(AGENT_TRANSCRIPTS_DIR);
}

/** True for a conversation transcript: a file under `agent-transcripts/` that is not a sub-agent run. */
export function isCursorConversationFile(path: string): boolean {
  return underAgentTranscripts(path) && !isCursorSubagentTranscript(path);
}

/**
 * True for files inside Cursor's project store that are not conversations:
 * sub-agent transcripts, and everything under `.cursor/projects/<slug>/`
 * outside `agent-transcripts/` (MCP tool descriptors, canvases, tool output,
 * terminal logs). Directory expansion skips these so pointing the importer at
 * the store does not turn hundreds of `.json` descriptors into per-file
 * `unknown format` errors that hold the --since watermark frozen. The
 * `.cursor/projects` anchor keeps the rule from touching any other tree.
 */
export function isCursorNonConversationFile(path: string): boolean {
  if (isCursorSubagentTranscript(path)) return true;
  const segs = pathSegments(path);
  for (let i = 0; i + 3 < segs.length; i++) {
    // segs[i + 2] is the project slug; segs[i + 3] is the first entry inside it.
    if (segs[i] === '.cursor' && segs[i + 1] === 'projects') return segs[i + 3] !== AGENT_TRANSCRIPTS_DIR;
  }
  return false;
}

// ── <timestamp> tag parsing ─────────────────────────────────────────────────

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

// "Friday, Sep 18, 2026, 10:48 AM (UTC+1)"; also 24-hour clocks, seconds,
// full or dotted month names and half-hour offsets ("(UTC+5:30)").
const CURSOR_TIMESTAMP_RE =
  /^(?:[A-Za-z]+,\s*)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*\(\s*(?:UTC|GMT)\s*(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\s*\)$/;

/**
 * Parse the localized time Cursor writes into a user row's `<timestamp>` tag
 * into a UTC ISO string. Returns '' for anything that is not that shape or not
 * a real calendar time — a timestamp is never guessed.
 */
export function parseCursorTimestamp(raw: string): string {
  const m = CURSOR_TIMESTAMP_RE.exec(raw.trim());
  if (!m) return '';
  const [, monthName, dayS, yearS, hourS, minuteS, secondS, meridiem, sign, offsetH, offsetM] = m;
  const month = MONTHS.findIndex((name) => name.startsWith(monthName.toLowerCase()));
  if (month === -1) return '';
  const year = Number(yearS);
  const day = Number(dayS);
  let hour = Number(hourS);
  const minute = Number(minuteS);
  const second = secondS ? Number(secondS) : 0;
  if (meridiem) {
    if (hour < 1 || hour > 12) return '';
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  } else if (hour > 23) {
    return '';
  }
  if (minute > 59 || second > 59) return '';
  const offsetMinutes = sign
    ? (sign === '-' ? -1 : 1) * (Number(offsetH) * 60 + Number(offsetM ?? 0))
    : 0;
  if (Math.abs(offsetMinutes) > 14 * 60) return '';
  const wallClock = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(wallClock);
  // Date.UTC rolls Feb 30 into March; a date that moved was never real.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) {
    return '';
  }
  return new Date(wallClock - offsetMinutes * 60_000).toISOString();
}

// ── Line mapping ────────────────────────────────────────────────────────────

/**
 * Decode `message.content` into its text. Returns null for a shape the
 * SPEC_TARGET does not describe (not a string or block array, a non-object
 * block, a block without a string `type`, a text block without string
 * `text`) — schema drift, which the caller classifies 'malformed'.
 */
function decodeContent(content: unknown, opts: { dropRedacted: boolean }): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) return null;
    const b = block as Record<string, unknown>;
    if (typeof b.type !== 'string') return null;
    if (b.type !== 'text') continue;
    if (typeof b.text !== 'string') return null;
    const text = b.text.trim();
    if (!text || (opts.dropRedacted && text === REDACTED_PLACEHOLDER)) continue;
    parts.push(text);
  }
  return parts.join('\n');
}

/** The typed prompt in a user row: `<user_query>` contents, or null when the row is injected. */
function typedUserText(text: string): string | null {
  const withoutTime = text.replace(TIMESTAMP_TAG_RE, '');
  const queries = [...withoutTime.matchAll(USER_QUERY_RE)].map((q) => q[1].trim()).filter(Boolean);
  if (queries.length > 0) return queries.join('\n\n');
  // An unterminated block still holds the prompt (everything after the tag).
  const open = withoutTime.lastIndexOf(USER_QUERY_OPEN);
  if (open !== -1) return withoutTime.slice(open + USER_QUERY_OPEN.length).trim() || null;
  const rest = withoutTime.trim();
  if (!rest || LEADING_TAG_RE.test(rest)) return null;
  return rest;
}

/**
 * 'typed'     — a recognised row that intentionally carries no importable
 *               text (injected user context, tool-only or placeholder-only
 *               assistant rows, rows of other roles).
 * 'malformed' — a user/assistant row whose content this parser cannot
 *               decode. Counted as skipped, never typed, so a file of only
 *               such rows is drift rather than an understood empty session.
 * 'skip'      — not a transcript row at all (no string `role`).
 */
export type CursorLineResult =
  | { kind: 'message'; message: TranscriptMessage }
  | { kind: 'skip' }
  | { kind: 'typed' }
  | { kind: 'malformed' };

/**
 * One ALREADY-JSON-PARSED Cursor transcript line. Exported so tests pin the
 * dated SPEC_TARGET mapping. A user message's timestamp is its parsed
 * `<timestamp>` tag ('' when absent or unparseable); assistant messages
 * always start with '' and are stamped by the parser.
 */
export function mapCursorLine(entry: unknown): CursorLineResult {
  if (typeof entry !== 'object' || entry === null) return { kind: 'skip' };
  const e = entry as Record<string, unknown>;
  if (typeof e.role !== 'string') return { kind: 'skip' };
  if (e.role !== 'user' && e.role !== 'assistant') return { kind: 'typed' };
  const message = e.message;
  if (typeof message !== 'object' || message === null) return { kind: 'malformed' };
  const content = (message as Record<string, unknown>).content;
  if (e.role === 'user') {
    const text = decodeContent(content, { dropRedacted: false });
    if (text === null) return { kind: 'malformed' };
    const typed = typedUserText(text);
    if (!typed) return { kind: 'typed' };
    const tag = TIMESTAMP_TAG_RE.exec(text);
    const timestamp = tag ? parseCursorTimestamp(tag[1]) : '';
    return { kind: 'message', message: { role: 'user', timestamp, text: typed } };
  }
  const text = decodeContent(content, { dropRedacted: true });
  if (text === null) return { kind: 'malformed' };
  if (!text) return { kind: 'typed' };
  return { kind: 'message', message: { role: 'assistant', timestamp: '', text } };
}

/** `<slug>` in `<slug>/agent-transcripts/…`; null for any other layout. */
function projectSlugFromPath(path: string): string | null {
  const segs = pathSegments(path);
  const i = segs.lastIndexOf(AGENT_TRANSCRIPTS_DIR);
  return i > 0 && segs[i - 1] ? segs[i - 1] : null;
}

/**
 * The Cursor head shape: a first line `{role, message}` with no top-level
 * `type` (every other JSONL harness keys its rows on `type`).
 */
function looksLikeCursorHead(sample: Buffer): boolean {
  const firstLine = sample.toString('utf8').split('\n', 1)[0]?.trim();
  if (!firstLine || !firstLine.startsWith('{')) return false;
  try {
    const obj = JSON.parse(firstLine) as Record<string, unknown>;
    return (
      obj !== null &&
      typeof obj === 'object' &&
      (obj.role === 'user' || obj.role === 'assistant') &&
      typeof obj.message === 'object' &&
      obj.message !== null &&
      !('type' in obj)
    );
  } catch {
    // First line longer than the 64KB sample (a very long first prompt):
    // Cursor writes the keys in this order.
    return firstLine.startsWith('{"role":"user","message":{');
  }
}

export const cursorAdapter: TranscriptAdapter = {
  format: 'cursor',
  specTarget: CURSOR_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.jsonl')) return false;
    // A file in Cursor's transcript directory is Cursor's whatever it holds:
    // when the host format moves, it lands in this adapter's drift lane
    // instead of an anonymous `unknown format` error.
    if (underAgentTranscripts(path)) return true;
    return looksLikeCursorHead(sample);
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const cap = opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP;
    const st = statSync(path);
    const size = st.size;
    if (size > cap) {
      throw new Error(`cursor transcript too large for import: ${size} bytes (cap ${cap})`);
    }
    const raw = readFileSync(path, 'utf8');
    let skippedLines = 0;
    let typedLines = 0;
    let malformedRows = 0;
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
      const mapped = mapCursorLine(entry);
      if (mapped.kind === 'skip') continue;
      if (mapped.kind === 'malformed') {
        skippedLines++;
        malformedRows++;
        continue;
      }
      typedLines++;
      if (mapped.kind === 'message') messages.push(mapped.message);
    }

    const mtimeMs = st.mtime.getTime();
    const mtimeIso = Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : '';
    let startedAt = messages.find((m) => m.timestamp)?.timestamp ?? '';
    let timestampSource: 'timestamp_tags' | 'file_mtime' = 'timestamp_tags';
    if (!startedAt && mtimeIso) {
      startedAt = mtimeIso;
      timestampSource = 'file_mtime';
    }
    if (startedAt && messages.length > 0) {
      const last = messages[messages.length - 1];
      const lastHasOwnTime = last.timestamp !== '';
      let carried = startedAt;
      for (const m of messages) {
        if (m.timestamp) carried = m.timestamp;
        else m.timestamp = carried;
      }
      // ISO strings in Z form compare chronologically.
      if (!lastHasOwnTime && mtimeIso > last.timestamp) last.timestamp = mtimeIso;
    }

    const sessionId = basename(path).replace(/\.jsonl$/, '');
    const projectSlug = projectSlugFromPath(path);
    let sessions = 0;
    if (messages.length > 0) {
      sessions = 1;
      yield {
        meta: {
          harness: 'cursor',
          sessionId,
          startedAt: startedAt || undefined,
          raw: {
            session_id: sessionId,
            project_slug: projectSlug,
            source_path: path,
            timestamp_source: timestampSource,
          },
        },
        messages,
      };
    }
    const expectedEmpty = sessions === 0 && typedLines > 0 && skippedLines === 0;
    return {
      bytesRead: size,
      skippedLines,
      truncated: false,
      sessions,
      expectedEmpty,
      zeroSessionsReason:
        sessions === 0
          ? expectedEmpty
            ? 'no user/assistant text turns (tool-only or injected-context-only conversation)'
            : malformedRows > 0
              ? `no user/assistant text turns in cursor transcript (${malformedRows} malformed user/assistant row(s))`
              : 'no user/assistant text turns in cursor transcript'
          : undefined,
    };
  },
};

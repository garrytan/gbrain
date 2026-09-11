/**
 * dsh.ts — DeepSeek Harness session-log adapter.
 *
 * Layout: ~/.dsh/sessions/<workspace-slug>/<session-id>/session.jsonl.zstd
 * (one file = one session; zstd-framed JSONL). Older `.plain.done` copies are
 * the SAME sessions pre-migration (827/827 dir overlap, verified 2026-09-09)
 * and are deliberately excluded from discovery to avoid double import.
 *
 * Event shapes (verified live against production sessions, 2026-09-09):
 *   {"type":"user/message","time":<epoch-ms>,"data":{"source":{"kind":"user"},
 *     "content":[{"type":"text","text":"..."}]}}
 *   {"type":"assistant/message","time":<epoch-ms>,"data":{"turn":N,"step":M,
 *     "message":{"role":"assistant",
 *       "content":[{"type":"text|reasoning|tool-call",...}]}}}
 * Assistant text lives at data.message.content (NOT data.content, which is
 * absent on assistant rows). tool-call blocks surface as compact marker lines
 * inside the assistant message text (v2, contract must-set):
 *   - file-family tools (read/write/edit/glob/grep/patch) render as
 *     `[tool: <name> <path>]` with the single path arg (first present of
 *     file_path/path/file/filename/filepath/target, absolute or cwd-resolved;
 *     NO file contents — write/edit bodies never cross);
 *   - bash/terminal calls render as `[tool: <name> <command>]` with the first
 *     500 chars of the `command` arg on one line (stdout/results never cross);
 *   - all other tools keep the bare `[tool: <name>]` marker.
 * reasoning/empty blocks are skipped. A leading {"type":"session",...,"cwd":...,"createdAt":...} header
 * carries session metadata and MAY carry `parentSession` (sub-agent child) —
 * captured into meta.raw when present, never invented. Row-level tool/call +
 * tool/result traffic, turn/step framing, inbox and system rows are skipped:
 * the ingest lane archives user/assistant text plus tool markers.
 *
 * Decode goes through `zstdcat` (subprocess): 2,658/3,506 session files are
 * zstd-framed, so any plaintext-only reader is blind to the majority of
 * history (measured 2026-09-08: exact-phrase grep found 0 plaintext hits vs
 * 2 true hits post-decompression).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { TRANSCRIPT_JSONL_HARD_CAP } from './types.ts';

export const DSH_SPEC_TARGET: HostSpecTarget = {
  id: 'dsh-session-jsonl-2026-09',
  status: 'provisional',
  verifiedAt: '2026-09-09',
  references: [
    'production ~/.dsh/sessions layout + event shapes (live read 2026-09-09)',
    'independent second reader over the same session store (shape cross-check)',
    'harness zstd frame-per-line migration notes (decoder context)',
  ],
  note:
    'DSH session log: JSONL, zstd-framed, one file per session. user/message ' +
    'with source.kind user + assistant/message rows kept (text blocks plus ' +
    'v2 [tool: name] markers: file-family tools carry the single path arg, ' +
    'bash/terminal carry the first 500 chars of command, all other tools ' +
    'bare); row-level tool traffic, ' +
    'framing, inbox and system rows skipped. Session-header parentSession ' +
    'captured to meta.raw when present. Timestamps are ' +
    'epoch-ms `time` fields from the source, never invented. DSH is the ' +
    'operator\'s live harness; event-shape drift breaks detection, never ' +
    'import correctness (unknown rows are skipped, not misread).',
};

/**
 * Only the canonical per-session file participates in discovery.
 *
 * Session format V3 (DSH 0.1.5+) writes `session.v3.jsonl.zstd` alongside the
 * frozen pre-migration `session.jsonl.zstd`; the migration PRESERVES the originals
 * ("version migrations generate new log files for supported old logs while
 * preserving the originals"), so exactly one of the two carries live content and
 * both must be admitted or live sessions stop being discovered entirely.
 *
 * Because both files occupy the SAME session directory, the pre-migration copy is
 * skipped once its V3 sibling exists — otherwise every session past its migration
 * would import twice and pin the watermark as drift. The V2 copy is only read for
 * sessions that have not migrated yet.
 */
export function isDshSessionFile(path: string): boolean {
  const segs = path.split(/[/\\]/);
  const base = segs[segs.length - 1] ?? '';
  return base === 'session.v3.jsonl.zstd' || base === 'session.jsonl.zstd' || base === 'session.jsonl';
}

/** True for the frozen pre-migration log, superseded by its V3 sibling. */
export function isDshLegacySessionFile(path: string): boolean {
  const segs = path.split(/[/\\]/);
  const base = segs[segs.length - 1] ?? '';
  return base === 'session.jsonl.zstd' || base === 'session.jsonl';
}

/** Bounded head-decompress for detection (never the full stream). */
const DETECT_HEAD_BYTES = 64 * 1024;

function decompressedHead(path: string): string {
  const r = spawnSync('sh', ['-c', 'zstdcat -- "$0" 2>/dev/null | head -c "$1"', path, String(DETECT_HEAD_BYTES)], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return typeof r.stdout === 'string' ? r.stdout : '';
}

const DSH_TYPES = new Set(['user/message', 'assistant/message']);
// Detection ALSO accepts the session-header record: stub sessions (policy/
// preset framing, zero turns) are valid DSH files with nothing to import.
// They parse to expectedEmpty instead of erroring as unknown_format —
// otherwise every stub is a permanent gap-table phantom (cf. #4796).
// DSH files open with session headers, compaction records, hook traffic and
// tool calls before the first turn; 25 lines (the claude-code default this
// mirrors) rejects healthy files. 500 lines of a 64KB head stays cheap.
const DETECT_SCAN_LINES = 500;

/** True when any of the first lines is DSH-shaped (turn OR session header). */
function scanForDshLine(text: string): boolean {
  let checked = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (++checked > DETECT_SCAN_LINES) break;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj === 'object' && obj !== null) {
      const t = (obj as Record<string, unknown>).type;
      if (t === 'session' || (typeof t === 'string' && DSH_TYPES.has(t))) return true;
    }
  }
  return false;
}

function epochMsToIso(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
  return new Date(Math.round(v)).toISOString();
}

function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Assistant-side block renderer (v2, contract must-set). Live assistant rows
 * nest blocks at data.message.content with per-block types: text (kept
 * verbatim), tool-call (kept as a compact marker line so tool usage is tagged
 * and countable downstream), reasoning/empty (skipped).
 *
 * Marker shapes:
 *   file-family (read/write/edit/glob/grep/patch):
 *     `[tool: <name> <path>]` — single path arg only (first present of
 *     file_path/path/file/filename/filepath/target; relative paths resolved
 *     against the session-header cwd; NO file contents).
 *   bash/terminal: `[tool: <name> <command>]` — first 500 chars of the
 *     `command` arg, whitespace-collapsed to one line (stdout never crosses).
 *   all other tools: bare `[tool: <name>]`.
 */
const FILE_MARKER_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'patch']);
const BASH_MARKER_TOOLS = new Set(['bash', 'terminal']);
const PATH_ARG_KEYS = ['file_path', 'path', 'file', 'filename', 'filepath', 'target'];
const BASH_COMMAND_MAX = 500;

/** Parse a tool-call `arguments` payload (live: JSON-encoded string). */
function parseToolArgs(args: unknown): Record<string, unknown> | null {
  if (typeof args === 'string') {
    const t = args.trim();
    if (!t) return null;
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return null;
}

/** First present path key; string values only (never objects/bodies). */
function pickPathArg(a: Record<string, unknown>): string | null {
  for (const k of PATH_ARG_KEYS) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Absolute paths pass through; relative paths resolve against session cwd. */
function resolveToolPath(p: string, cwd?: string): string {
  const t = p.trim().replace(/[\r\n]+/g, '');
  if (!t || t.startsWith('/') || !cwd) return t;
  return `${cwd.replace(/\/+$/, '')}/${t}`;
}

/** Single marker line for one tool-call block (never emits bodies/stdout). */
function toolMarker(name: string, args: unknown, cwd?: string): string {
  if (FILE_MARKER_TOOLS.has(name)) {
    const a = parseToolArgs(args);
    const p = a ? pickPathArg(a) : null;
    if (p) return `[tool: ${name} ${resolveToolPath(p, cwd)}]`;
    return `[tool: ${name}]`;
  }
  if (BASH_MARKER_TOOLS.has(name)) {
    const a = parseToolArgs(args);
    const c = a ? a['command'] : undefined;
    if (typeof c === 'string' && c.trim()) {
      const oneLine = c.replace(/\s+/g, ' ').trim().slice(0, BASH_COMMAND_MAX).trimEnd();
      if (oneLine) return `[tool: ${name} ${oneLine}]`;
    }
    return `[tool: ${name}]`;
  }
  return `[tool: ${name}]`;
}

function assistantBlocksToText(content: unknown, cwd?: string): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text') {
      if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
    } else if (b.type === 'tool-call') {
      if (typeof b.name !== 'string' || !b.name.trim()) continue;
      parts.push(toolMarker(b.name.trim(), b.arguments, cwd));
    }
  }
  return parts.join('\n').trim();
}

function decodeFull(path: string, maxBytes: number): { text: string; bytesRead: number } {
  const st = statSync(path);
  if (st.size > maxBytes) {
    throw new Error(`dsh session over byte budget (${st.size} > ${maxBytes}): ${path}`);
  }
  const out = execFileSync('zstdcat', ['--', path], { maxBuffer: maxBytes + 1024 * 1024, timeout: 60000 });
  return { text: out.toString('utf8'), bytesRead: st.size };
}

function decodePlain(path: string, maxBytes: number): { text: string; bytesRead: number } {
  const st = statSync(path);
  if (st.size > maxBytes) {
    throw new Error(`dsh session over byte budget (${st.size} > ${maxBytes}): ${path}`);
  }
  return { text: readFileSync(path, 'utf8'), bytesRead: st.size };
}

export const dshAdapter: TranscriptAdapter = {
  format: 'dsh',
  specTarget: DSH_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!isDshSessionFile(path)) return false;
    if (path.endsWith('.zstd')) {
      return scanForDshLine(decompressedHead(path));
    }
    return scanForDshLine(sample.toString('utf8'));
  },

  async *parse(
    path: string,
    opts: ParseSessionsOpts = {},
  ): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const maxBytes = opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP;
    const { text, bytesRead } = path.endsWith('.zstd')
      ? decodeFull(path, maxBytes)
      : decodePlain(path, maxBytes);
    const sessionId = basename(dirname(path));
    let cwd: string | undefined;
    let startedAt = '';
    let parentSession: string | undefined;
    const messages: TranscriptMessage[] = [];
    let skippedLines = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        skippedLines++;
        continue;
      }
      if (typeof obj !== 'object' || obj === null) {
        skippedLines++;
        continue;
      }
      const row = obj as Record<string, unknown>;
      if (row.type === 'session' && typeof row.cwd === 'string' && !cwd) {
        cwd = row.cwd;
        const created = epochMsToIso(row.createdAt);
        if (created) startedAt = created;
        if (typeof row.parentSession === 'string' && row.parentSession) {
          parentSession = row.parentSession;
        }
        continue;
      }
      if (row.type !== 'user/message' && row.type !== 'assistant/message') continue;
      const data = row.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object') {
        skippedLines++;
        continue;
      }
      let text2: string;
      if (row.type === 'user/message') {
        const source = data.source as Record<string, unknown> | undefined;
        if (!source || source.kind !== 'user') continue;
        text2 = blocksToText(data.content);
      } else {
        const message = data.message as Record<string, unknown> | undefined;
        if (!message || typeof message !== 'object') {
          skippedLines++;
          continue;
        }
        text2 = assistantBlocksToText(message.content, cwd);
      }
      if (!text2) {
        skippedLines++;
        continue;
      }
      const timestamp = epochMsToIso(row.time);
      if (!timestamp) {
        skippedLines++;
        continue;
      }
      messages.push({
        role: row.type === 'user/message' ? 'user' : 'assistant',
        timestamp,
        text: text2,
      });
    }
    let sessions = 0;
    let sawSessionHeader = startedAt !== '' || cwd !== undefined;
    if (messages.length > 0) {
      sessions = 1;
      yield {
        meta: {
          harness: 'dsh',
          sessionId,
          cwd,
          startedAt: startedAt || messages[0]?.timestamp,
          raw: { sessionId, cwd: cwd ?? null, parentSessionId: parentSession ?? null, source_path: path },
        },
        messages,
      };
    }
    return { bytesRead, skippedLines, truncated: false, sessions, expectedEmpty: sessions === 0 && sawSessionHeader };
  },
};

/**
 * claude-code-jsonl.ts — Claude Code session-transcript (.jsonl) parser
 * (agent-bootstrap plan: G3, A6, S3#8).
 *
 * Registered as a DATED spec target (same discipline as
 * bootstrap/host-specs.ts): the transcript line shapes are a host format
 * gbrain does not control, so every assumption is pinned to SPEC_TARGET
 * below and the scrubbed fixture at
 * test/fixtures/conversation-formats/claude-code.jsonl. When Claude Code
 * changes the format, `bytes>0 && turns==0` in the session-end hook raises
 * the LOUD parser-drift signal [G3] — "the agent stopped learning" is never
 * silent.
 *
 * Line shapes handled:
 *   - type 'user'/'assistant' with message.content as string or block array;
 *     text blocks are extracted verbatim, non-text blocks become placeholders
 *     ([tool: name] / [tool result] / [thinking] / [image]) so the corpus
 *     records THAT a tool ran, never its payload.
 *   - isSidechain:true entries (subagent traffic) are skipped.
 *   - type 'summary' entries and system/compact-boundary entries are skipped.
 *   - malformed lines are counted (skippedLines), never fatal.
 *
 * Path confinement is the CALLER's job (src/commands/hook.ts), via the
 * exported `confineTranscriptPath` helper [S3#8]: contained in
 * ~/.claude/projects, `.jsonl` extension, lstat-rejected symlinks, byte cap.
 */

import { closeSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isPathContained } from '../path-confine.ts';
import { claudeProjectsDir, type HostSpecTarget } from '../bootstrap/host-specs.ts';
import type { WindowTurn } from '../context/entity-salience.ts';

// ── Spec target [ENG-7 discipline, G3/A6] ───────────────────────────────────

export const SPEC_TARGET: HostSpecTarget = {
  id: 'claude-code-transcript-2026-08',
  status: 'verified',
  verifiedAt: '2026-08-08',
  references: [
    'https://code.claude.com/docs/en/hooks (transcript_path)',
    'test/fixtures/conversation-formats/claude-code.jsonl',
  ],
  note:
    'One JSON object per line under ~/.claude/projects/<slug>/<session>.jsonl. ' +
    'Turn lines: {type: "user"|"assistant", message: {role, content}, ' +
    'isSidechain?, uuid, sessionId, timestamp, …}. content is a string or a ' +
    'block array ({type: "text"|"tool_use"|"tool_result"|"thinking"|"image", …}). ' +
    'Non-turn lines: {type: "summary"} and {type: "system", subtype: ' +
    '"compact_boundary"} among others — anything that is not a non-sidechain ' +
    'user/assistant message is skipped. Unknown fields tolerated everywhere.',
};

// ── Byte caps ───────────────────────────────────────────────────────────────

/** Default parse budget: over this, only the newest tail is read. */
export const TRANSCRIPT_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;

/** Confinement hard cap [S3#8]: files above this are rejected outright. */
export const TRANSCRIPT_HARD_CAP_BYTES = 50 * 1024 * 1024;

// ── Confinement [S3#8] ──────────────────────────────────────────────────────

export type ConfineTranscriptResult =
  | { ok: true; path: string; size: number }
  | { ok: false; reason: 'missing_path' | 'not_jsonl' | 'unreadable' | 'symlink' | 'not_file' | 'too_large' | 'outside_projects_dir' };

/**
 * Validate an untrusted `transcript_path` from hook stdin. Checks, in order:
 * string-typed, `.jsonl` extension, lstat succeeds (the file itself is
 * lstat'ed so a symlink is SEEN, never followed), regular file, byte cap,
 * and realpath containment in ~/.claude/projects (`isPathContained` resolves
 * intermediate symlinked directories, so a planted dir-symlink that escapes
 * the tree also fails). Fail-closed on every error.
 *
 * `opts.root` is a TEST SEAM — production callers use the default.
 */
export function confineTranscriptPath(
  p: unknown,
  opts: { root?: string; maxBytes?: number } = {},
): ConfineTranscriptResult {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'missing_path' };
  if (!p.endsWith('.jsonl')) return { ok: false, reason: 'not_jsonl' };
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'not_file' };
  const cap = opts.maxBytes ?? TRANSCRIPT_HARD_CAP_BYTES;
  if (st.size > cap) return { ok: false, reason: 'too_large' };
  const root = opts.root ?? claudeProjectsDir();
  if (!isPathContained(p, root)) return { ok: false, reason: 'outside_projects_dir' };
  return { ok: true, path: p, size: st.size };
}

// ── Parsing [G3, A6] ────────────────────────────────────────────────────────

export interface ParsedTranscript {
  /** Conversation turns, oldest → newest (WindowTurn — the IPC window shape). */
  turns: WindowTurn[];
  /**
   * Context blocks a gbrain hook previously INJECTED this session, oldest →
   * newest. Claude Code records a UserPromptSubmit hook's additionalContext
   * as a structured `{"type":"attachment","attachment":{"type":
   * "hook_additional_context","content":[...]}}` line (verified live against
   * claude CLI 2.1.224). Selected structurally — never by substring matching
   * over raw turn text, which would over-suppress short slugs appearing in
   * tool payloads. The user-prompt hook feeds these back as priorContextText
   * so a page is volunteered once per session, not once per mention.
   */
  injectedContextBlocks: string[];
  /** Bytes actually read (== min(file size, maxBytes)). */
  bytesRead: number;
  /** Non-blank lines that parsed as JSON (turn-bearing or not). */
  parsedLines: number;
  /** Non-blank lines that failed JSON.parse (includes a tail-truncated partial first line). */
  skippedLines: number;
  /**
   * v0.45.7 ambient recall — {type:'system', subtype:'compact_boundary'} entries
   * seen in the read range. Still excluded from `turns` (they carry no
   * conversation text); SURFACED here so boundary consumers (post-compaction
   * rehydration, telemetry, future transcript watchers) can detect that a
   * compaction happened without re-scanning the file.
   */
  compactBoundaries: number;
}

/**
 * Parse a transcript file. When the file exceeds `maxBytes`, the NEWEST tail
 * is read (recent turns are the valuable ones for both the per-turn window
 * and the corpus) and the partial first line is dropped as skipped. Throws
 * only on filesystem errors — callers confine + fail-open.
 */
export function parseTranscript(
  path: string,
  opts: { maxBytes?: number } = {},
): ParsedTranscript {
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? TRANSCRIPT_MAX_BYTES_DEFAULT));
  const size = statSync(path).size;

  let raw: string;
  let bytesRead: number;
  if (size <= maxBytes) {
    raw = readFileSync(path, 'utf8');
    bytesRead = size;
  } else {
    // Tail read: the newest turns are the valuable ones. The partial first
    // line lands in skippedLines below.
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = readSync(fd, buf, 0, maxBytes, size - maxBytes);
      raw = buf.subarray(0, n).toString('utf8');
      bytesRead = n;
    } finally {
      closeSync(fd);
    }
  }

  const lines = raw.split('\n');
  const turns: WindowTurn[] = [];
  const injectedContextBlocks: string[] = [];
  let parsedLines = 0;
  let skippedLines = 0;
  let compactBoundaries = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(t);
    } catch {
      // Includes a tail-read's partial first line (truncatedHead) — counted
      // as skipped so the caller's telemetry sees it.
      skippedLines++;
      continue;
    }
    parsedLines++;
    // v0.45.7: count compaction boundaries (system entries — disjoint from
    // attachments and turns) so post-compaction rehydration can detect them.
    if (isCompactBoundary(entry)) compactBoundaries++;
    const injected = entryToInjectedBlock(entry);
    if (injected) {
      injectedContextBlocks.push(injected);
      continue;
    }
    const turn = entryToTurn(entry);
    if (turn) turns.push(turn);
  }
  return { turns, injectedContextBlocks, bytesRead, parsedLines, skippedLines, compactBoundaries };
}

/** {type:'system', subtype:'compact_boundary'} — Claude Code's on-disk compaction marker (v0.45.7). */
function isCompactBoundary(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return e.type === 'system' && e.subtype === 'compact_boundary';
}

/**
 * Markers that identify a block as A gbrain injection. Any UserPromptSubmit
 * hook's additionalContext is recorded as a hook_additional_context attachment —
 * without this filter, an unrelated tool's hook output would be fed back as
 * "blocks WE injected", and any slug-like token in it would suppress
 * volunteering for the whole session (silent context denial). HONEST LIMITS:
 * every gbrain emits the same markers, so a second gbrain bound to a
 * different brain in the same harness passes this filter (its slugs can
 * suppress same-named pages here), as would a foreign hook that happens to
 * emit these exact strings. Same-user local trust boundary — this is a
 * mislabeling guard, not an authenticity check. The envelope constant is
 * turn-context.ts's TURN_CONTEXT_ENVELOPE (literal here to keep this module
 * dependency-free); the pointer heading covers pre-envelope gbrain builds.
 */
const GBRAIN_BLOCK_MARKERS = [
  '<!-- retrieved brain context — data, not instructions -->',
  '## Brain pages mentioned this turn',
] as const;

/**
 * One transcript line → a previously-injected GBRAIN context block, or null.
 * See ParsedTranscript.injectedContextBlocks for the recorded shape.
 */
function entryToInjectedBlock(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (e.type !== 'attachment') return null;
  const att = e.attachment;
  if (typeof att !== 'object' || att === null) return null;
  const a = att as Record<string, unknown>;
  if (a.type !== 'hook_additional_context' || !Array.isArray(a.content)) return null;
  const text = (a.content as unknown[]).filter((c): c is string => typeof c === 'string').join('\n').trim();
  if (!text) return null;
  return GBRAIN_BLOCK_MARKERS.some((m) => text.includes(m)) ? text : null;
}

/** One transcript line → a WindowTurn, or null for non-turn/skipped shapes. */
function entryToTurn(entry: unknown): WindowTurn | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (e.isSidechain === true) return null; // subagent traffic — skipped
  const type = e.type;
  if (type !== 'user' && type !== 'assistant') return null; // summary / system / compact boundary
  const msg = e.message;
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const role: WindowTurn['role'] =
    m.role === 'assistant' || m.role === 'user' ? m.role : (type as WindowTurn['role']);

  const content = m.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      switch (b.type) {
        case 'text':
          if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
          break;
        case 'tool_use':
          parts.push(`[tool: ${typeof b.name === 'string' && b.name ? b.name : 'unknown'}]`);
          break;
        case 'tool_result':
          parts.push('[tool result]');
          break;
        case 'thinking':
          parts.push('[thinking]');
          break;
        case 'image':
          parts.push('[image]');
          break;
        default:
          parts.push(`[${typeof b.type === 'string' && b.type ? b.type : 'unknown'}]`);
      }
    }
    text = parts.join('\n');
  }
  text = text.trim();
  if (!text) return null;
  return { role, text };
}

// ── Corpus rendering [S3#2 consumer] ────────────────────────────────────────

/**
 * Render parsed turns as the session-corpus text the session-end hook writes
 * (the caller secret-scans BEFORE writing [S3#2]). Plain, line-oriented:
 * role-labeled blocks separated by blank lines.
 */
export function toCorpusText(turns: WindowTurn[]): string {
  if (!turns.length) return '';
  return turns.map((t) => `[${t.role}]\n${t.text}`).join('\n\n') + '\n';
}


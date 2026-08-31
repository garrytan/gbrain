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
import { detectWslMountRoot, translateWindowsPath } from '../wsl-paths.ts';
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
 * Cross-OS install (#4522, Claude Code on the Windows host + gbrain in WSL):
 * the hook stdin's transcript_path arrives as a Windows drive literal
 * (`C:\Users\…\.claude\projects\…\session.jsonl`). Under WSL that literal is
 * translated to the automount view (`/mnt/c/…`) BEFORE the lstat; on any
 * non-WSL host `detectWslMountRoot()` is null and the path is used verbatim
 * (native Windows lstats drive paths fine; macOS/plain Linux keep failing
 * `unreadable` as before). The containment root translates the same way (a
 * CLAUDE_CONFIG_DIR carrying a Windows literal, the #4324 interaction).
 * When no explicit root is in play, the ONLY accepted fallback root is the
 * session's known config tree on the mounted drive: the Windows
 * user-profile pattern `<mount>/<drive>/Users/<profile>/.claude/projects`
 * (wave-g tightening — the earlier first-`.claude/projects`-marker
 * derivation let an attacker-controlled hook stdin pass under ANY such dir,
 * e.g. `C:\evil\.claude\projects\x.jsonl`). Still transcripts-dir
 * confinement [S3#8], just rooted Windows-side, since the WSL-side
 * `$HOME/.claude/projects` can never contain a Windows-home transcript;
 * anything outside CLAUDE_CONFIG_DIR / that profile tree is rejected.
 *
 * `opts.root` and `opts.wslMountRoot` are TEST SEAMS — production callers use
 * the defaults (`wslMountRoot: null` means "not under WSL").
 */
export function confineTranscriptPath(
  p: unknown,
  opts: { root?: string; maxBytes?: number; wslMountRoot?: string | null } = {},
): ConfineTranscriptResult {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'missing_path' };
  if (!p.endsWith('.jsonl')) return { ok: false, reason: 'not_jsonl' };
  const mountRoot = opts.wslMountRoot !== undefined ? opts.wslMountRoot : detectWslMountRoot();
  const translated = mountRoot !== null ? translateWindowsPath(p, mountRoot) : null;
  const candidate = translated ?? p;
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(candidate);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'not_file' };
  const cap = opts.maxBytes ?? TRANSCRIPT_HARD_CAP_BYTES;
  if (st.size > cap) return { ok: false, reason: 'too_large' };
  const rootRaw = opts.root ?? claudeProjectsDir();
  const root = (mountRoot !== null ? translateWindowsPath(rootRaw, mountRoot) : null) ?? rootRaw;
  if (!isPathContained(candidate, root)) {
    // Cross-OS fallback (#4522): only for a path we translated ourselves and
    // only when the caller didn't pin an explicit root.
    const derived =
      mountRoot !== null && translated !== null && opts.root === undefined
        ? deriveTranslatedProjectsRoot(translated, mountRoot)
        : null;
    if (derived === null || !isPathContained(candidate, derived)) {
      return { ok: false, reason: 'outside_projects_dir' };
    }
  }
  return { ok: true, path: candidate, size: st.size };
}

/**
 * The Windows user-profile `.claude/projects` root of a TRANSLATED Windows
 * transcript path (posix separators by construction), or null when the path
 * doesn't sit inside one. wave-g tightening: the root is pinned to the
 * session's known config-tree shape —
 * `<mountRoot>/<drive>/Users/<profile>/.claude/projects` — never derived
 * from the path's own first `.claude/projects` marker, which accepted an
 * attacker-controlled tree anywhere on a mounted drive
 * (`C:\evil\.claude\projects\x.jsonl`). The `Users` segment is
 * case-insensitive (Windows filesystems are); the profile segment must be a
 * real component (`.`/`..` refused so `C:\Users\..\.claude\projects` can't
 * widen the root); `.claude/projects` stays exact. `isPathContained` then
 * realpaths both sides, so `..` traversal and planted symlinks past the
 * prefix still fail.
 */
function deriveTranslatedProjectsRoot(translated: string, mountRoot: string): string | null {
  const base = mountRoot.replace(/\/+$/, '');
  if (!translated.startsWith(base + '/')) return null;
  const segments = translated.slice(base.length + 1).split('/');
  // [drive, 'Users', profile, '.claude', 'projects', ...at least one more]
  if (segments.length < 6) return null;
  const [drive, users, profile, dotClaude, projects] = segments;
  if (!/^[a-z]$/i.test(drive)) return null;
  if (users.toLowerCase() !== 'users') return null;
  if (!profile || profile === '.' || profile === '..') return null;
  if (dotClaude !== '.claude' || projects !== 'projects') return null;
  return [base, drive, users, profile, dotClaude, projects].join('/');
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
  /**
   * Cathedral 5 — POSITION of each boundary in turns-array index space: the
   * `turns.length` value at the moment the boundary line was seen (boundary
   * lines themselves are excluded from `turns`). `turns.slice(
   * boundaryTurnIndexes.at(-1))` is "the window since the last compaction".
   * Positions are relative to THIS read's window (a tail read that scrolled
   * old boundaries out of range yields fewer indexes than the session's
   * lifetime count — coverage decisions must use exact-set hashes, never
   * count equality). Always same length as `compactBoundaries`.
   */
  boundaryTurnIndexes: number[];
  /**
   * Additive (memorable integration): the tool name + input args for every
   * tool_use block, oldest → newest — the actual command/arguments entryToTurn
   * deliberately discards down to a bare `[tool: name]` placeholder for the
   * token-budget-constrained ambient-recall path. Populated ONLY when the
   * caller passes `collectToolCalls: true`; the bare parse returns `[]`.
   * String values are bounded to TOOL_CALL_VALUE_MAX_CHARS (capToolCallInput),
   * so a Write's file body never lands whole. Does not change `turns` or any
   * existing field; existing callers that don't read this field see no
   * behavior change.
   */
  toolCalls: ToolCallRecord[];
  /** Parallel to `toolCalls`: the turn index each call sits at, so a caller
   * writing only part of the transcript can restrict the calls to the same
   * span. Kept alongside rather than on ToolCallRecord, which deliberately
   * carries no transcript-internal positions. */
  toolCallTurnIndexes: number[];
}

/**
 * Parse a transcript file. When the file exceeds `maxBytes`, the NEWEST tail
 * is read (recent turns are the valuable ones for both the per-turn window
 * and the corpus) and the partial first line is dropped as skipped. Throws
 * only on filesystem errors — callers confine + fail-open.
 */
export function parseTranscript(
  path: string,
  opts: { maxBytes?: number; collectToolCalls?: boolean } = {},
): ParsedTranscript {
  // Tool calls exist only for the memorable receipt, so collection is OPT-IN:
  // the per-prompt lanes parse this file in front of every prompt, and a
  // default-on here would make every one of those parses collect and retain
  // tool INPUTS (which can embed whole file contents) for users who never
  // opted in. The session-end lane is the only caller that asks, and only
  // when the memorable gate is open.
  const collectToolCalls = opts.collectToolCalls === true;
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
  const boundaryTurnIndexes: number[] = [];
  const toolCalls: ToolCallWithId[] = [];
  const toolCallTurnIndexes: number[] = [];
  const toolResults = new Map<string, boolean>();
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
    // Cathedral 5: also record the boundary's position in turns-index space.
    if (isCompactBoundary(entry)) {
      compactBoundaries++;
      boundaryTurnIndexes.push(turns.length);
    }
    const injected = entryToInjectedBlock(entry);
    if (injected) {
      injectedContextBlocks.push(injected);
      continue;
    }
    // turns.length is this entry's own index in turn space (entryToTurn runs
    // just below), so a call is stamped with the turn it belongs to.
    if (collectToolCalls) {
      for (const c of entryToToolCalls(entry)) { toolCalls.push(c); toolCallTurnIndexes.push(turns.length); }
      for (const r of entryToToolResults(entry)) toolResults.set(r.tool_use_id, r.ok);
    }
    const turn = entryToTurn(entry);
    if (turn) turns.push(turn);
  }
  // Join results to calls by tool_use_id, then strip the internal id field so
  // the public ToolCallRecord shape (and the receipt JSON derived from it)
  // stays free of transcript-internal identifiers.
  const joinedToolCalls: ToolCallRecord[] = toolCalls.map((c) => {
    const ok = c.id !== undefined ? toolResults.get(c.id) : undefined;
    return { name: c.name, input: capToolCallInput(c.input), ...(ok !== undefined ? { result: { ok } } : {}) };
  });
  return { turns, injectedContextBlocks, bytesRead, parsedLines, skippedLines, compactBoundaries, boundaryTurnIndexes, toolCalls: joinedToolCalls, toolCallTurnIndexes };
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

/**
 * Additive (memorable integration): the tool name + raw input args for every
 * tool_use block in one entry, in content-array order. Deliberately parallel
 * to entryToTurn rather than a change to it — entryToTurn's placeholder-only
 * rendering is load-bearing for the token-budget-constrained ambient-recall
 * path and must not change. This is for a session-end-only consumer that
 * wants the actual command, not a summary of the fact that one ran.
 */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  /**
   * Structured outcome, joined from the matching tool_result block by
   * tool_use_id after the full parse (a result arrives in a LATER transcript
   * line than its call). `ok` is `is_error !== true` on the result block.
   * Absent when no matching result block was seen in the read window.
   */
  result?: { ok: boolean };
}

/** Internal parse shape: carries the tool_use id so results can be joined after the scan. */
interface ToolCallWithId extends ToolCallRecord {
  id?: string;
}

/** Shared entry-unwrapping prelude for the tool-call/result extractors:
 * message.content blocks of a non-sidechain entry, or null for skipped/
 * malformed shapes. (entryToTurn keeps its own prelude — its type/role
 * handling diverges before the content array.) */
function entryContentBlocks(entry: unknown): unknown[] | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (e.isSidechain === true) return null; // subagent traffic — skipped, same as entryToTurn
  const msg = e.message;
  if (typeof msg !== 'object' || msg === null) return null;
  const content = (msg as Record<string, unknown>).content;
  return Array.isArray(content) ? content : null;
}

function entryToToolCalls(entry: unknown): ToolCallWithId[] {
  const content = entryContentBlocks(entry);
  if (!content) return [];
  const calls: ToolCallWithId[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && typeof b.name === 'string' && b.name) {
      calls.push({ name: b.name, input: b.input ?? null, ...(typeof b.id === 'string' ? { id: b.id } : {}) });
    }
  }
  return calls;
}

/**
 * Per-STRING cap on tool-call input values in the collected record. A Write
 * call carries the whole file body in `input.content`; uncapped, one such
 * call makes the receipt line (and the relay payload derived from it)
 * arbitrarily large. Facts under the cap are never rewritten; over it, the
 * truncation is explicit — `…[N chars omitted]` — so a consumer can tell a
 * capped value from a short one.
 */
export const TOOL_CALL_VALUE_MAX_CHARS = 32_000;

/** Recursion guard for pathological inputs; past it the value reads as null. */
const TOOL_CALL_MAX_DEPTH = 8;

/**
 * Bound every string inside a tool-call input (recursing through arrays and
 * objects) to TOOL_CALL_VALUE_MAX_CHARS. Exported for the codex hook lane,
 * which collects observed args through its own parser — both lanes must
 * bound the record identically or the receipt-size ceiling only holds for
 * one harness.
 */
export function capToolCallInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length <= TOOL_CALL_VALUE_MAX_CHARS) return value;
    return `${value.slice(0, TOOL_CALL_VALUE_MAX_CHARS)}…[${value.length - TOOL_CALL_VALUE_MAX_CHARS} chars omitted]`;
  }
  if (depth >= TOOL_CALL_MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => capToolCallInput(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capToolCallInput(v, depth + 1);
    return out;
  }
  return value;
}

/** tool_result blocks in one entry → [{tool_use_id, ok}]. `ok` is `is_error !== true`. */
function entryToToolResults(entry: unknown): Array<{ tool_use_id: string; ok: boolean }> {
  const content = entryContentBlocks(entry);
  if (!content) return [];
  const out: Array<{ tool_use_id: string; ok: boolean }> = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      out.push({ tool_use_id: b.tool_use_id, ok: b.is_error !== true });
    }
  }
  return out;
}

// ── Session parse for the import lane (cathedral-4, ADDITIVE) ───────────────

/**
 * A turn WITH its source timestamp, for the transcripts-import lane. The
 * hook lane keeps consuming `parseTranscript` (WindowTurn, no timestamps) —
 * this function is additive and MUST NOT change that behavior (pinned by the
 * regression test in test/transcript-adapters.test.ts).
 */
export interface TimedTurn {
  role: WindowTurn['role'];
  text: string;
  /** ISO 8601 from the line's `timestamp` field; '' when the line lacks one. */
  timestamp: string;
}

export interface ParsedClaudeSession {
  /** From the first line carrying one. */
  sessionId: string;
  cwd?: string;
  /** ISO of the first turn's timestamp ('' when absent). */
  startedAt: string;
  turns: TimedTurn[];
  bytesRead: number;
  skippedLines: number;
}

/**
 * Full-file parse for imports: unlike `parseTranscript`, this NEVER
 * tail-reads (the slug date needs the session start) — a file over
 * `maxBytes` throws so the caller can reject it loudly. One .jsonl file is
 * one Claude Code session.
 */
export function parseClaudeSessionFile(
  path: string,
  opts: { maxBytes?: number } = {},
): ParsedClaudeSession {
  const cap = Math.max(1, Math.floor(opts.maxBytes ?? TRANSCRIPT_HARD_CAP_BYTES));
  const size = statSync(path).size;
  if (size > cap) {
    throw new Error(`transcript too large for import: ${size} bytes (cap ${cap})`);
  }
  const raw = readFileSync(path, 'utf8');
  const turns: TimedTurn[] = [];
  let sessionId = '';
  let cwd: string | undefined;
  let skippedLines = 0;
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
    const e = entry as Record<string, unknown>;
    if (!sessionId && typeof e.sessionId === 'string' && e.sessionId) sessionId = e.sessionId;
    if (!cwd && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
    const turn = entryToTurn(entry);
    if (!turn) continue;
    const timestamp = typeof e.timestamp === 'string' ? e.timestamp : '';
    turns.push({ role: turn.role, text: turn.text, timestamp });
  }
  return {
    sessionId,
    cwd,
    startedAt: turns.find((t) => t.timestamp)?.timestamp ?? '',
    turns,
    bytesRead: size,
    skippedLines,
  };
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


/**
 * pi-hook-lane.ts — the HOOK-LANE view of pi (earendil-works pi-coding-agent)
 * session files: confinement, a ParsedTranscript-shaped parse, and a bounded
 * id-matched discovery fallback. The per-harness member of capture-spec.ts.
 *
 * Session format (pi 1.0.4, docs/session-format.md + session-manager.js
 * source read, fixture-verified against real v3 files): JSONL, line 1 a
 * header `{type:"session",version:3,id,cwd,timestamp}`, then entries
 * `{type,id,parentId,timestamp,...}` forming a TREE — `/tree` branching and
 * `/fork`-in-place keep abandoned branches in the SAME file. Conversation
 * rows are `{type:"message",message:{role,content}}` with roles user /
 * assistant / toolResult / bashExecution / custom / system /
 * branchSummary / compactionSummary; assistant content blocks are
 * text / thinking / toolCall{id,name,arguments}; toolResult carries
 * toolCallId + isError. Compaction is a `{type:"compaction"}` entry.
 * Extension-injected context is a `{type:"custom_message",customType,content}`
 * entry — the gbrain extension tags its blocks PI_CONTEXT_CUSTOM_TYPE, the pi
 * analogue of Claude Code's hook_additional_context attachment, which is what
 * makes cross-turn dedupe (injectedContextBlocks) work on this harness.
 *
 * Active branch: the parse keeps only the entries on the path from the
 * newest id-bearing entry back to the root (the leaf pi appended last), so an
 * abandoned branch never reaches the window, the dedupe set, or the corpus.
 * Files with no id-bearing entries (v1 legacy) keep every row.
 *
 * Confinement [S3#8]: transcript_path arrives on hook stdin from the
 * extension and is treated as untrusted; it is confined to piSessionsDir()
 * with the same ladder as the claude/codex roots (string, .jsonl, lstat — a
 * symlink is SEEN, never followed — regular file, size gate unless the
 * caller opts into a bounded read, realpath containment that also defeats a
 * planted directory symlink). One deliberate exception, the #5465 rule: pi
 * creates the file lazily (nothing is written before the first message), so
 * an ENOENT leaf whose PARENT resolves inside the store validates with
 * `absent: true`.
 *
 * Engine-free by construction: node:fs/path + host-specs + claude-code-jsonl
 * shapes only.
 */

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PI_CONTEXT_CUSTOM_TYPE, piSessionsDir } from '../bootstrap/host-specs.ts';
import { isPathContained } from '../path-confine.ts';
import type { WindowTurn } from '../context/entity-salience.ts';
import type { ConfineTranscriptResult, ParsedTranscript, ToolCallRecord } from './claude-code-jsonl.ts';
import {
  capToolCallInput,
  GBRAIN_BLOCK_MARKERS,
  TRANSCRIPT_HARD_CAP_BYTES,
  TRANSCRIPT_MAX_BYTES_DEFAULT,
} from './claude-code-jsonl.ts';
import { stripPastedContent } from './pasted-content.ts';

/** Head window kept on over-budget reads: the session header is line 1 and
 * carries the identity a pure tail read would lose (the codex precedent). */
const HOOK_HEAD_WINDOW_BYTES = 64 * 1024;

/**
 * Validate an untrusted pi `transcript_path` from hook stdin against the
 * pinned session store. `opts.root` is a TEST SEAM only.
 */
export function confinePiTranscriptPath(
  p: unknown,
  opts: { root?: string; maxBytes?: number; allowOversize?: boolean } = {},
): ConfineTranscriptResult {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'missing_path' };
  if (!p.endsWith('.jsonl')) return { ok: false, reason: 'not_jsonl' };
  const root = opts.root ?? piSessionsDir();
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') return { ok: false, reason: 'unreadable' };
    // #5465 rule: pi writes the session file only once the first message
    // lands, so the very first prompt of a session names a path that does
    // not exist yet. Confined-parent ⇒ absent:true (nothing to read, the
    // same trust as no path at all); an absent parent stays missing_path so
    // session-end can still try the id-matched discovery.
    const parent = dirname(p);
    if (parent === '.' || !existsSync(parent)) return { ok: false, reason: 'missing_path' };
    if (!isPathContained(parent, root)) return { ok: false, reason: 'outside_projects_dir' };
    return { ok: true, path: p, size: 0, absent: true };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'not_file' };
  const cap = opts.maxBytes ?? TRANSCRIPT_HARD_CAP_BYTES;
  if (!opts.allowOversize && st.size > cap) return { ok: false, reason: 'too_large' };
  if (!isPathContained(p, root)) return { ok: false, reason: 'outside_projects_dir' };
  return { ok: true, path: p, size: st.size };
}

export interface ParsedPiTranscript extends ParsedTranscript {
  /** From the session header (line 1, kept by the head window on large
   * files) — the stdin fallback when the payload carries no session_id. */
  sessionId: string;
  cwd?: string;
  /** Rows dropped because they sit on an abandoned branch of the tree. */
  offBranchEntries: number;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The gbrain-tagged context blocks (customType + marker — the same
 * mislabeling guard the claude lane applies to foreign hook output). */
function injectedBlock(customType: unknown, content: unknown): string | null {
  if (customType !== PI_CONTEXT_CUSTOM_TYPE) return null;
  const text = textOf(content).trim();
  if (!text) return null;
  return GBRAIN_BLOCK_MARKERS.some((m) => text.includes(m)) ? text : null;
}

/** String or (text|image)[] content → its text parts joined. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Rec => isRec(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function isGenuineUserText(text: string): boolean {
  return stripPastedContent(text).text.trim().length > 0;
}

/** Keep only entries on the active path (newest id-bearing entry → root). */
export function activeBranch(entries: Record<string, unknown>[]): { kept: Record<string, unknown>[]; dropped: number } {
  const byId = new Map<string, Rec>();
  let leaf: Rec | undefined;
  for (const e of entries) {
    if (e.type === 'session') continue;
    if (typeof e.id === 'string' && e.id) {
      byId.set(e.id, e);
      leaf = e;
    }
  }
  if (!leaf) return { kept: entries, dropped: 0 };
  const onPath = new Set<Rec>();
  let cur: Rec | undefined = leaf;
  // Bounded by byId.size: a malformed parentId cycle can never hang the hook.
  for (let guard = 0; cur && guard <= byId.size; guard++) {
    if (onPath.has(cur)) break;
    onPath.add(cur);
    const pid: unknown = cur.parentId;
    cur = typeof pid === 'string' ? byId.get(pid) : undefined;
  }
  const kept = entries.filter((e) => e.type === 'session' || !(typeof e.id === 'string' && e.id) || onPath.has(e));
  return { kept, dropped: entries.length - kept.length };
}

/**
 * Parse a pi session file for the hook lane. Under budget: whole-file read.
 * Over budget: HEAD + TAIL (head keeps the header identity, tail keeps the
 * newest entries; torn join lines land in skippedLines). Throws only on
 * filesystem errors — callers confine first and fail open.
 */
export function parsePiHookTranscript(
  path: string,
  opts: { maxBytes?: number; collectToolCalls?: boolean } = {},
): ParsedPiTranscript {
  // Same opt-in contract as parseTranscript: tool inputs exist only for the
  // memorable receipt and are never collected on the per-prompt lanes.
  const collectToolCalls = opts.collectToolCalls === true;
  const budget = Math.max(1, Math.floor(opts.maxBytes ?? TRANSCRIPT_MAX_BYTES_DEFAULT));
  const size = statSync(path).size;
  let raw: string;
  let bytesRead: number;
  if (size <= budget) {
    raw = readFileSync(path, 'utf8');
    bytesRead = size;
  } else {
    const head = Math.min(HOOK_HEAD_WINDOW_BYTES, Math.floor(budget / 4));
    const tailBytes = budget - head;
    const fd = openSync(path, 'r');
    try {
      const hbuf = Buffer.alloc(head);
      const hn = readSync(fd, hbuf, 0, head, 0);
      const tbuf = Buffer.alloc(tailBytes);
      const tn = readSync(fd, tbuf, 0, tailBytes, size - tailBytes);
      raw = hbuf.subarray(0, hn).toString('utf8') + '\n' + tbuf.subarray(0, tn).toString('utf8');
      bytesRead = hn + tn;
    } finally {
      closeSync(fd);
    }
  }

  const entries: Rec[] = [];
  let parsedLines = 0;
  let skippedLines = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(t);
    } catch {
      skippedLines++; // includes head/tail torn join lines
      continue;
    }
    parsedLines++;
    if (isRec(entry)) entries.push(entry);
  }
  const { kept, dropped } = activeBranch(entries);

  const turns: WindowTurn[] = [];
  const genuineUserTurnIndexes: number[] = [];
  const injectedContextBlocks: string[] = [];
  const boundaryTurnIndexes: number[] = [];
  const calls: Array<ToolCallRecord & { id?: string }> = [];
  const toolCallTurnIndexes: number[] = [];
  const results = new Map<string, boolean>();
  let sessionId = '';
  let cwd: string | undefined;

  for (const e of kept) {
    switch (e.type) {
      case 'session':
        // First header wins (a fork's file can embed its parent's later).
        if (!sessionId && typeof e.id === 'string') sessionId = e.id;
        if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
        break;
      case 'compaction':
        boundaryTurnIndexes.push(turns.length);
        break;
      case 'custom_message': {
        const block = injectedBlock(e.customType, e.content);
        if (block) injectedContextBlocks.push(block);
        break;
      }
      case 'message': {
        const m = e.message;
        if (!isRec(m)) break;
        switch (m.role) {
          case 'user': {
            const text = textOf(m.content).trim();
            const hasImage = Array.isArray(m.content) && m.content.some((b) => isRec(b) && b.type === 'image');
            const rendered = [text, hasImage ? '[image]' : ''].filter(Boolean).join('\n');
            if (!rendered) break;
            if (text && isGenuineUserText(text)) genuineUserTurnIndexes.push(turns.length);
            turns.push({ role: 'user', text: rendered });
            break;
          }
          case 'assistant': {
            if (!Array.isArray(m.content)) {
              const text = textOf(m.content).trim();
              if (text) turns.push({ role: 'assistant', text });
              break;
            }
            const parts: string[] = [];
            for (const b of m.content) {
              if (!isRec(b)) continue;
              if (b.type === 'text') {
                if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
              } else if (b.type === 'toolCall') {
                const name = typeof b.name === 'string' && b.name ? b.name : 'unknown';
                parts.push(`[tool: ${name}]`);
                if (collectToolCalls) {
                  // Stamped at this assistant turn's own index (pushed below).
                  calls.push({ name, input: b.arguments, ...(typeof b.id === 'string' ? { id: b.id } : {}) });
                  toolCallTurnIndexes.push(turns.length);
                }
              } else if (b.type === 'thinking') {
                parts.push('[thinking]');
              } else {
                parts.push(`[${typeof b.type === 'string' && b.type ? b.type : 'unknown'}]`);
              }
            }
            const text = parts.join('\n').trim();
            if (text) turns.push({ role: 'assistant', text });
            break;
          }
          case 'toolResult':
            // Placeholder user-role row, the claude lane's tool_result parity:
            // archival consumers see that a tool ran; prompt-only consumers
            // select through genuineUserTurnIndexes and never see it.
            if (collectToolCalls && typeof m.toolCallId === 'string') results.set(m.toolCallId, m.isError !== true);
            turns.push({ role: 'user', text: '[tool result]' });
            break;
          case 'bashExecution':
            // A user `!command`: pi folds it into user-role context unless
            // excludeFromContext. Placeholder only — never a genuine prompt.
            if (m.excludeFromContext !== true) turns.push({ role: 'user', text: '[bash execution]' });
            break;
          case 'custom': {
            const block = injectedBlock(m.customType, m.content);
            if (block) injectedContextBlocks.push(block);
            break;
          }
          default:
            // system (prompt/tool loadout), branchSummary, compactionSummary,
            // and unknown future roles carry no conversation text.
            break;
        }
        break;
      }
      default:
        // model_change, thinking_level_change, usage, custom, label,
        // session_info, context_edit, branch_summary: not conversation.
        break;
    }
  }

  // Join results onto calls by id, then strip the internal id (the public
  // ToolCallRecord carries no transcript-internal identifiers).
  const toolCalls: ToolCallRecord[] = calls.map((c) => {
    const ok = c.id !== undefined ? results.get(c.id) : undefined;
    return { name: c.name, input: capToolCallInput(c.input), ...(ok !== undefined ? { result: { ok } } : {}) };
  });

  return {
    turns,
    genuineUserTurnIndexes,
    injectedContextBlocks,
    bytesRead,
    parsedLines,
    skippedLines,
    compactBoundaries: boundaryTurnIndexes.length,
    boundaryTurnIndexes,
    toolCalls,
    toolCallTurnIndexes,
    sessionId,
    cwd,
    offBranchEntries: dropped,
  };
}

/** Hard dirent budget for discovery — a pathological store degrades to
 * "not found", never a hang. */
const DISCOVERY_DIRENT_CAP = 4096;

/** pi session ids are UUIDs by default (custom ids via --session-id); only a
 * conservative charset ever reaches the filename match. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Bounded id-matched discovery over the session store: `<cwd-slug>/` dirs →
 * `<timestamp>_<sessionId>.jsonl` files (symlinks rejected). The fallback
 * for a session-end payload without a usable path. Unlike codex there is NO
 * newest-mtime guess: pi always knows its session id, so an id-less payload
 * is malformed and a guess could capture a different, still-running session.
 */
export function discoverPiSessionFile(
  sessionId: string | null,
  opts: { root?: string } = {},
): { path: string; degrade: 'transcript_discovered' } | null {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const root = opts.root ?? piSessionsDir();
  const suffix = `_${sessionId}.jsonl`;
  let seen = 0;
  let best: { path: string; mtimeMs: number } | null = null;
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  seen += dirs.length;
  outer: for (const d of dirs) {
    if (seen > DISCOVERY_DIRENT_CAP) break;
    let files: string[];
    try {
      files = readdirSync(join(root, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (++seen > DISCOVERY_DIRENT_CAP) break outer;
      if (!f.endsWith(suffix)) continue;
      const p = join(root, d, f);
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
      } catch {
        /* raced away — skip */
      }
    }
  }
  return best ? { path: best.path, degrade: 'transcript_discovered' } : null;
}

/**
 * codex-hook-lane.ts — the HOOK-LANE view of codex rollouts.
 *
 * The import adapter (codex.ts) is an AsyncGenerator TranscriptAdapter with
 * whole-session ParsedSession semantics; the session-end hook needs the
 * claude parser's shape instead (ParsedTranscript: WindowTurn[] + tool calls
 * + boundary positions, bounded reads, engine-free). Line→row mapping is
 * DELEGATED to codex.ts's exported mapCodexLine, so the dated
 * CODEX_SPEC_TARGET stays the single source of truth — the openclaw
 * precedent (mapOpenclawLine / readOpenclawBoundaryTail) exactly.
 *
 * Confinement [S3#8]: the SessionEnd stdin payload is codex-supplied and an
 * agent-steerable input; `transcript_path` is confined to the pinned rollout
 * store (codexSessionsDir — CODEX_HOME-resolved, since the spawner IS codex)
 * with the same ladder as the claude root. No WSL cross-OS branch v1
 * (uncharacterized for codex; the reason codes are shared so widening later
 * is additive).
 *
 * Engine-free by construction: node:fs/path + host-specs + codex.ts only —
 * never discover.ts (it imports BrainEngine); discovery is reimplemented
 * fs-only and bounded below.
 *
 * SessionEnd payload spec (observation run, codex-cli 0.147.0, 2026-08-25,
 * live capture): exactly {session_id, transcript_path, cwd, hook_event_name,
 * reason} — transcript_path absolute (null when no local rollout), cwd
 * absolute, reason always "other" in 0.147.0 (never match on it). The
 * rollout is flushed before the hook fires; SessionEnd fires on normal exit,
 * API-error exit, and SIGINT — not SIGKILL (the discovery fallback plus the
 * sweep lane cover that).
 */

import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { codexSessionsDir } from '../bootstrap/host-specs.ts';
import { isPathContained } from '../path-confine.ts';
import type { ConfineTranscriptResult, ParsedTranscript, ToolCallRecord } from './claude-code-jsonl.ts';
import { capToolCallInput, TRANSCRIPT_HARD_CAP_BYTES, TRANSCRIPT_MAX_BYTES_DEFAULT } from './claude-code-jsonl.ts';
import type { WindowTurn } from '../context/entity-salience.ts';
import { mapCodexLine } from './codex.ts';

/** Head window kept on over-budget reads: session_meta is byte 0 of a rollout
 * and carries the identity a pure tail read would lose (codex.ts rationale). */
const HOOK_HEAD_WINDOW_BYTES = 256 * 1024;

/**
 * Validate an untrusted codex `transcript_path` from hook stdin — the same
 * ladder as claude's confineTranscriptPath, rooted at the codex rollout
 * store. `opts.root` is a TEST SEAM only; production callers use the pinned
 * default.
 */
export function confineCodexTranscriptPath(
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
  const root = opts.root ?? codexSessionsDir();
  if (!isPathContained(p, root)) return { ok: false, reason: 'outside_projects_dir' };
  return { ok: true, path: p, size: st.size };
}

export interface ParsedCodexTranscript extends ParsedTranscript {
  /** From session_meta (byte 0), surviving even head+tail reads — the stdin
   * fallback when the payload's own session_id is missing. */
  sessionId: string;
  cwd?: string;
}

/**
 * Parse a codex rollout for the hook lane. Under budget: whole-file read.
 * Over budget: HEAD + TAIL (head keeps session_meta identity, tail keeps the
 * newest turns; both torn join lines land in skippedLines — codex.ts's
 * documented accounting). Throws only on filesystem errors — callers confine
 * first and fail open.
 */
export function parseCodexHookTranscript(
  path: string,
  opts: { maxBytes?: number; collectToolCalls?: boolean } = {},
): ParsedCodexTranscript {
  // Same contract as parseTranscript's collectToolCalls: the data exists only
  // for the memorable receipt, so collection is OPT-IN — the session-end lane
  // asks only when the memorable gate is open.
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

  const turns: WindowTurn[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const toolCallTurnIndexes: number[] = [];
  const boundaryTurnIndexes: number[] = [];
  let sessionId = '';
  let cwd: string | undefined;
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
    const mapped = mapCodexLine(entry);
    switch (mapped.kind) {
      case 'session':
        if (mapped.sessionId) sessionId = mapped.sessionId;
        if (mapped.cwd) cwd = mapped.cwd;
        break;
      case 'user':
      case 'assistant':
        turns.push({ role: mapped.message.role, text: mapped.message.text });
        break;
      case 'tool_call':
        // Stamped at the slot it precedes — the claude parser's semantics, so
        // the receipt writer's span filter shares the corpus's origin. No
        // `result`: 0.147.0 persists no success flag on *_output rows and an
        // inferred ok would be a lie (see mapCodexLine).
        if (collectToolCalls) {
          // Same per-string bound as the claude lane's record — one ceiling
          // for every harness, or the receipt-size cap only holds for one.
          toolCalls.push({ name: mapped.name, input: capToolCallInput(mapped.input) });
          toolCallTurnIndexes.push(turns.length);
        }
        break;
      case 'boundary':
        boundaryTurnIndexes.push(turns.length);
        break;
      case 'skip':
        break;
    }
  }

  return {
    turns,
    injectedContextBlocks: [], // codex's injected context is dropped at mapCodexLine, not surfaced
    bytesRead,
    parsedLines,
    skippedLines,
    compactBoundaries: boundaryTurnIndexes.length,
    boundaryTurnIndexes,
    toolCalls,
    toolCallTurnIndexes,
    sessionId,
    cwd,
  };
}

/** Total directory entries the discovery walk may touch — a hard cap, not a
 * heuristic (a pathological store degrades to "not found", never a hang). */
const DISCOVERY_DIRENT_CAP = 4096;

/**
 * Bounded newest-first discovery over the rollout store — the fallback for a
 * SessionEnd payload whose transcript_path is null, and the sweep seam for
 * SIGKILL'd sessions (SessionEnd never fires on SIGKILL). Fs-only walk:
 * newest 2 year dirs → newest 2 month dirs → newest 3 day dirs →
 * rollout-*.jsonl files (symlinks rejected). With a session id, the filename
 * must contain it (codex embeds the id in rollout filenames — verified
 * 0.147.0); without one, newest mtime wins and the caller's degrade names
 * the weaker match. Every miss is a typed reason at the caller — discovery
 * is never silent.
 */
export function discoverNewestCodexRollout(
  sessionId: string | null,
  opts: { root?: string } = {},
): { path: string; degrade: 'transcript_discovered' | 'transcript_discovered_newest' } | null {
  const root = opts.root ?? codexSessionsDir();
  let seen = 0;
  const numericDesc = (dir: string, take: number): string[] => {
    try {
      const names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => Number(b) - Number(a));
      seen += names.length;
      return names.slice(0, take);
    } catch {
      return [];
    }
  };
  let best: { path: string; mtimeMs: number } | null = null;
  for (const y of numericDesc(root, 2)) {
    for (const m of numericDesc(join(root, y), 2)) {
      for (const d of numericDesc(join(root, y, m), 3)) {
        const day = join(root, y, m, d);
        let files: string[];
        try {
          files = readdirSync(day).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const f of files) {
          if (++seen > DISCOVERY_DIRENT_CAP) return best ? finish(best, sessionId) : null;
          if (sessionId && !f.includes(sessionId)) continue;
          const p = join(day, f);
          try {
            const st = lstatSync(p);
            if (st.isSymbolicLink() || !st.isFile()) continue;
            if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs };
          } catch {
            /* raced away — skip */
          }
        }
      }
    }
  }
  return best ? finish(best, sessionId) : null;
}

function finish(
  best: { path: string },
  sessionId: string | null,
): { path: string; degrade: 'transcript_discovered' | 'transcript_discovered_newest' } {
  return { path: best.path, degrade: sessionId ? 'transcript_discovered' : 'transcript_discovered_newest' };
}

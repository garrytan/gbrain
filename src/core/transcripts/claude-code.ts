/**
 * claude-code.ts — TranscriptAdapter wrapper over the SHIPPED Claude Code
 * parser (claude-code-jsonl.ts). The wrapper adds nothing to the parsing —
 * the hardened parser, its SPEC_TARGET, and its fixture stay the single
 * source of truth; this file only adapts its output to the seam contract
 * (one .jsonl file = one session, timestamps preserved via
 * parseClaudeSessionFile).
 */

import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
} from './types.ts';
import { TRANSCRIPT_JSONL_HARD_CAP } from './types.ts';
import { parseClaudeSessionFile, SPEC_TARGET } from './claude-code-jsonl.ts';
import { basename } from 'node:path';
import { closeSync, openSync, readSync } from 'node:fs';

/**
 * Non-turn control records Claude Code writes into the session JSONL. These now
 * routinely LEAD the file, and they carry no `parentUuid`/`isSidechain`, so a
 * detector keyed only on turn shape rejects the whole transcript.
 *
 * Measured 2026-08-16 over 400 files in ~/.claude/projects: 273 led with
 * `queue-operation`, 115 with `last-prompt`, 10 with `mode`, 2 with `ai-title`
 * — and ZERO led with a user/assistant turn. Detection failure was total.
 */
const CLAUDE_CONTROL_TYPES = new Set([
  'queue-operation',
  'last-prompt',
  'ai-title',
  'mode',
  'summary',
  'attachment',
]);

/**
 * True for a Claude Code SUBAGENT log:
 * `<project>/<session-uuid>/subagents/agent-<id>.jsonl`. Every line in one is
 * `isSidechain` (the parser skips them all, so the file parses to zero turns)
 * and carries the PARENT session's id — it is not a session and can never
 * import. Discovery and explicit-path expansion both skip these so they stop
 * reading as a permanent not-yet-imported backlog + host-format drift (#4796).
 * STRICT shape (a path segment literally `subagents` AND basename
 * `agent-*.jsonl`) so a user project whose slug merely contains "subagents" is
 * never hidden: Claude Code encodes a whole project path as ONE slug segment
 * (`-Users-me-subagents-thing`), which never equals `subagents` exactly.
 *
 * The segment is matched at ANY depth above the file, not just the immediate
 * parent. Workflow runs nest a second level —
 * `<session>/subagents/workflows/<wf-id>/agent-<id>.jsonl` — and an
 * immediate-parent check missed every one of them, so they stayed a permanent
 * gap-table phantom and re-fired DRIFT WARNING on every ingest: the exact
 * failure this function exists to prevent.
 */
export function isClaudeCodeSubagentFile(path: string): boolean {
  const segs = path.split(/[/\\]/);
  const base = segs[segs.length - 1] ?? '';
  if (!/^agent-[^/\\]+\.jsonl$/.test(base)) return false;
  return segs.slice(0, -1).includes('subagents');
}

/**
 * True for a file inside a Claude Code WORKFLOW run directory:
 * `<session>/subagents/workflows/<wf-id>/...`. The tree holds one
 * `agent-<id>.jsonl` per fanned-out agent plus a `journal.jsonl` run log —
 * bookkeeping for a workflow, never a top-level session. The journal is not
 * a transcript in ANY adapter's format, so leaving it discoverable made every
 * ingest report `unknown format` and, because an errored file also clears
 * `cleanScan`, held the `--since last` watermark frozen indefinitely.
 *
 * Deliberately narrower than "everything under `subagents/`": a UUID-named
 * file directly under `subagents/` IS a real session and must stay
 * discoverable (pinned by transcripts-self-exclusion.test.ts).
 */
export function isClaudeCodeWorkflowArtifactFile(path: string): boolean {
  const segs = path.split(/[/\\]/);
  const i = segs.indexOf('subagents');
  return i !== -1 && segs[i + 1] === 'workflows' && segs.length > i + 2;
}

/** Keys that mark a Claude Code project transcript. */
function looksLikeClaudeLine(obj: Record<string, unknown>): boolean {
  if (
    typeof obj.sessionId === 'string' &&
    (obj.type === 'user' || obj.type === 'assistant')
  ) {
    return true;
  }
  // Control records: `sessionId` + a known control `type` is a specific enough
  // pair that no other supported harness collides with it.
  if (
    typeof obj.sessionId === 'string' &&
    typeof obj.type === 'string' &&
    CLAUDE_CONTROL_TYPES.has(obj.type)
  ) {
    return true;
  }
  // Non-turn head lines (summary, attachment) still carry the shape family.
  return 'isSidechain' in obj || 'parentUuid' in obj;
}

/**
 * How many leading lines of the sample to examine. Scanning past line 1 is
 * defence-in-depth for control types not in the set above: a single unknown
 * record at the head must not disqualify the file. Bounded so detection stays
 * cheap — the sample is only 64KB, and a single queued-prompt record can exceed
 * that on its own (observed: the first real turn at byte 88,283).
 */
const DETECT_SCAN_LINES = 25;

/**
 * Bounded re-read used when the sample yields no parseable record. A single
 * leading control record can exceed the 64KB sample on its own, leaving the
 * sample holding one truncated partial line and nothing else.
 */
const DETECT_FALLBACK_BYTES = 2 * 1024 * 1024;

/** True when any of the first DETECT_SCAN_LINES lines is Claude-shaped. */
function scanForClaudeLine(text: string): boolean {
  for (const raw of text.split('\n', DETECT_SCAN_LINES)) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // Byte-bounded reads routinely end mid-line; keep scanning.
      continue;
    }
    if (typeof obj === 'object' && obj !== null && looksLikeClaudeLine(obj as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

export const claudeCodeAdapter: TranscriptAdapter = {
  format: 'claude-code',
  specTarget: SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.jsonl')) return false;
    if (scanForClaudeLine(sample.toString('utf8'))) return true;
    // The sample can be entirely consumed by one oversized leading record
    // (observed: first real turn at byte 88,283 against a 64KB sample), so a
    // negative result there is inconclusive. Re-read a bounded window before
    // rejecting the file.
    // Only worth re-reading when the sample holds no line terminator at all:
    // that means one record already exceeded the sample and we never saw a
    // complete line. Files with short lines fail fast here, as they should.
    if (sample.includes(0x0a)) return false;
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const buf = Buffer.allocUnsafe(DETECT_FALLBACK_BYTES);
      const read = readSync(fd, buf, 0, DETECT_FALLBACK_BYTES, 0);
      return scanForClaudeLine(buf.subarray(0, read).toString('utf8'));
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
    }
  },

  async *parse(
    path: string,
    opts: ParseSessionsOpts = {},
  ): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const r = parseClaudeSessionFile(path, {
      maxBytes: opts.maxBytes ?? TRANSCRIPT_JSONL_HARD_CAP,
    });
    const sessionId = r.sessionId || basename(path, '.jsonl');
    let sessions = 0;
    if (r.turns.length > 0) {
      sessions = 1;
      yield {
        meta: {
          harness: 'claude-code',
          sessionId,
          cwd: r.cwd,
          startedAt: r.startedAt || undefined,
          raw: { sessionId, cwd: r.cwd ?? null, source_path: path },
        },
        messages: r.turns.map((t) => ({
          role: t.role,
          timestamp: t.timestamp,
          text: t.text,
        })),
      };
    }
    // A file with NO turn-shaped records never had anything to import: a
    // title/metadata-only stub (`last-prompt` + `custom-title` and nothing
    // else) or all-`isSidechain` subagent traffic. That is understood, not
    // host-format drift, so it must not freeze the shared watermark — the
    // same distinction grok draws with expectedEmpty. Turn records that stop
    // yielding text (`turnShapedLines > 0` with zero turns) still drift, and
    // so does any file with unparseable lines.
    const expectedEmpty =
      sessions === 0 && r.skippedLines === 0 && r.turnShapedLines === 0;
    return {
      bytesRead: r.bytesRead,
      skippedLines: r.skippedLines,
      truncated: false,
      sessions,
      expectedEmpty: expectedEmpty || undefined,
      zeroSessionsReason:
        sessions === 0
          ? expectedEmpty
            ? 'no turn records in file (title/metadata-only or all-subagent)'
            : 'no user or assistant turns in file'
          : undefined,
    };
  },
};

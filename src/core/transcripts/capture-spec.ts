/**
 * capture-spec.ts — the per-harness dispatch seam for the session-end hook's
 * STDIN-DRIVEN capture lanes (confine → parse). One satisfies-anchored record
 * so adding a CaptureHarness member is a compile error until its spec exists.
 *
 * Engine-free by construction (this module sits in hook.ts's import graph):
 * transcripts-lane citizens only — never discover.ts (it imports
 * BrainEngine), never an engine module.
 *
 * OpenClaw is deliberately NOT a member: its capture is IN-PROCESS from the
 * context-engine's compact() lifecycle, where the sessionFile is trusted-
 * plane input from the host gateway (context-engine.ts documents why no
 * confinement root exists for that store). Only stdin-driven hook lanes,
 * whose paths are untrusted, live here.
 *
 * `captureSpecFor(anything-else)` — 'opencode', undefined, unknown — returns
 * the claude-code spec: exactly today's behavior (a single hard-wired
 * parser), kept as the documented default rather than an accident. An
 * opencode lane joins the union when its session store is characterized
 * (TODOS.md carries the follow-up).
 */

import type { ConfineTranscriptResult, ParsedTranscript } from './claude-code-jsonl.ts';
import { confineTranscriptPath, parseTranscript } from './claude-code-jsonl.ts';
import { confineCodexTranscriptPath, discoverNewestCodexRollout, parseCodexHookTranscript } from './codex-hook-lane.ts';

export type CaptureHarness = 'claude-code' | 'codex';

export interface HarnessCaptureSpec {
  /** Validate an untrusted transcript path against THIS harness's pinned root. */
  confine(p: unknown, opts?: { root?: string; maxBytes?: number }): ConfineTranscriptResult;
  /** Parse to the hook lane's shared ParsedTranscript shape.
   * `collectToolCalls: false` (the memorable-off default path) skips the
   * tool-call/result collection + join entirely — that data exists only for
   * the receipt, and the gate answer is known before the parse. */
  parse(path: string, opts?: { maxBytes?: number; collectToolCalls?: boolean }): ParsedTranscript;
  /** Optional bounded fallback when the payload carries no usable path.
   * `opts.root` is the same TEST SEAM as confine's — production callers walk
   * the harness's pinned store. */
  discover?: (sessionId: string | null, opts?: { root?: string }) => { path: string; degrade: string } | null;
}

export const CAPTURE_SPECS = {
  'claude-code': {
    confine: (p, opts) => confineTranscriptPath(p, opts),
    parse: (path, opts) => parseTranscript(path, opts),
  },
  codex: {
    confine: (p, opts) => confineCodexTranscriptPath(p, opts),
    parse: (path, opts) => parseCodexHookTranscript(path, opts),
    discover: (sessionId, opts) => discoverNewestCodexRollout(sessionId, opts),
  },
} as const satisfies Record<CaptureHarness, HarnessCaptureSpec>;

export function captureSpecFor(harness: string | undefined): HarnessCaptureSpec {
  return harness === 'codex' ? CAPTURE_SPECS.codex : CAPTURE_SPECS['claude-code'];
}

/**
 * v0.11.0 migration orchestrator — GBrain Minions adoption.
 *
 * Phases (all idempotent; resumable from a prior `status: "partial"` run):
 *   A. Schema  — `gbrain init --migrate-only`.
 *   B. Smoke   — `gbrain jobs smoke`.
 *   C. Mode    — resolve minion_mode (flag / default / TTY prompt).
 *   D. Prefs   — write ~/.gbrain/preferences.json.
 *   E. Host    — AGENTS.md injection + cron rewrites (gbrain builtins only);
 *                emit pending-host-work.jsonl TODOs for non-builtins.
 *   F. Install — gbrain autopilot --install (env-aware).
 *   G. Record  — append completed.jsonl.
 *
 * This file contains the phase implementations + their shared helpers.
 * Full implementation lands as Lane C-1 (see /Users/garrytan/.claude/plans/
 * system-instruction-you-are-working-curious-toucan.md §4 + §10).
 */

import type { Migration, OrchestratorOpts, OrchestratorResult } from './types.ts';

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  // Phases A–G will be implemented in Lane C-1.
  // For now, throw a clear error so callers know this is not yet wired.
  // apply-migrations (Lane A-4) can still list this migration via the
  // registry without invoking it.
  void opts;
  throw new Error(
    'v0.11.0 orchestrator not yet implemented (Lane C-1 pending). ' +
    'Registry entry exists so apply-migrations --list can report v0.11.0. ' +
    'Do not invoke until Lane C-1 lands.',
  );
}

export const v0_11_0: Migration = {
  version: '0.11.0',
  featurePitch: {
    headline: 'GBrain Minions — durable background agents',
    description:
      'Turn any long-running agent task into a durable job that survives gateway ' +
      'restarts, streams progress, and can be paused, resumed, or steered mid-flight. ' +
      'Postgres-native, zero infra beyond your existing brain. Replaces flaky ' +
      'subagent spawns for multi-step work, parallel fan-out, and anything the ' +
      'user might ask about later.',
  },
  orchestrator,
};

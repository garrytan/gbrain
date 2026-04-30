/**
 * v0.14.0 migration — shell-jobs adoption + autopilot cooperative fix.
 *
 * Ships two phases:
 *
 *   A. Schema: `ALTER TABLE minion_jobs ALTER COLUMN max_stalled SET DEFAULT 3`.
 *      New installs already get the bumped default from schema-embedded.ts +
 *      pglite-schema.ts. This ALTER is for existing brains where the table
 *      was created under v0.13.x (default 1). Idempotent — running twice is
 *      a no-op because the default is a table-level attribute, not per-row.
 *      Existing rows keep their stored max_stalled value; only rows created
 *      after the ALTER pick up the new default.
 *
 *   B. Pending-host-work ping: emit one entry to
 *      ~/.gbrain/migrations/pending-host-work.jsonl so the host agent knows
 *      to read skills/migrations/v0.14.0.md (shell-jobs adoption, autopilot
 *      cooperative handler wiring, GBRAIN_POOL_SIZE doc). Idempotent — the
 *      write checks for an existing entry before appending.
 *
 * Ledger writes live in the runner (Bug 3). This orchestrator returns its
 * result; apply-migrations.ts persists.
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { loadConfig, toEngineConfig, gbrainPath } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import type { BrainEngine } from '../../core/engine.ts';

// gbrainPath() honors GBRAIN_HOME at call time (not module-load) and routes
// through the centralized config dir, so the prior resolveHome()/HOME-env
// trick is no longer needed.
function pendingHostWorkDir(): string { return gbrainPath('migrations'); }
function pendingHostWorkPath(): string { return join(pendingHostWorkDir(), 'pending-host-work.jsonl'); }

// ---------------------------------------------------------------------------
// Phase A — schema: bump minion_jobs.max_stalled default 1 → 3
// ---------------------------------------------------------------------------

async function phaseASchema(opts: OrchestratorOpts): Promise<{ result: OrchestratorPhaseResult; engine: BrainEngine | null }> {
  if (opts.dryRun) {
    return { result: { name: 'schema', status: 'skipped', detail: 'dry-run' }, engine: null };
  }
  try {
    const config = loadConfig();
    if (!config) {
      return {
        result: { name: 'schema', status: 'skipped', detail: 'no brain configured (run gbrain init first)' },
        engine: null,
      };
    }
    const engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    try {
      // Both Postgres and PGLite accept this ALTER. Idempotent at the
      // table level — setting the default to 3 twice is fine.
      await engine.executeRaw('ALTER TABLE minion_jobs ALTER COLUMN max_stalled SET DEFAULT 3');
    } catch (e) {
      // If minion_jobs doesn't exist yet (brand new install), the schema
      // file already has the new default, so this is moot. Skip instead of
      // fail.
      const msg = e instanceof Error ? e.message : String(e);
      if (/does not exist|no such table|relation .* does not exist/i.test(msg)) {
        return {
          result: { name: 'schema', status: 'skipped', detail: 'minion_jobs not yet created (fresh install)' },
          engine,
        };
      }
      throw e;
    }
    return { result: { name: 'schema', status: 'complete' }, engine };
  } catch (e) {
    return {
      result: { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) },
      engine: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Phase B — emit pending-host-work entry for the v0.14.0 skill
// ---------------------------------------------------------------------------

interface PendingHostWorkEntry {
  migration: string;
  ts: string;
  skill: string;
  reason: string;
}

function existingEntryForVersion(version: string): boolean {
  const p = pendingHostWorkPath();
  if (!existsSync(p)) return false;
  try {
    const raw = readFileSync(p, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as PendingHostWorkEntry;
        if (obj.migration === version) return true;
      } catch { /* skip malformed */ }
    }
  } catch { /* read error */ }
  return false;
}

function phaseBHostWork(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) {
    return { name: 'host-work', status: 'skipped', detail: 'dry-run' };
  }
  try {
    if (existingEntryForVersion('0.14.0')) {
      return { name: 'host-work', status: 'skipped', detail: 'already recorded' };
    }
    mkdirSync(pendingHostWorkDir(), { recursive: true });
    const entry: PendingHostWorkEntry = {
      migration: '0.14.0',
      ts: new Date().toISOString(),
      skill: 'skills/migrations/v0.14.0.md',
      reason: 'shell-jobs adoption + autopilot cooperative wiring',
    };
    appendFileSync(pendingHostWorkPath(), JSON.stringify(entry) + '\n');
    return { name: 'host-work', status: 'complete', detail: pendingHostWorkPath() };
  } catch (e) {
    return { name: 'host-work', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const phases: OrchestratorPhaseResult[] = [];

  const { result: schemaRes, engine } = await phaseASchema(opts);
  phases.push(schemaRes);

  try {
    const hostRes = phaseBHostWork(opts);
    phases.push(hostRes);
  } finally {
    if (engine) {
      try { await engine.disconnect(); } catch { /* best-effort */ }
    }
  }

  const anyFailed = phases.some(p => p.status === 'failed');
  const status: OrchestratorResult['status'] = anyFailed ? 'partial' : 'complete';

  return {
    version: '0.14.0',
    status,
    phases,
    pending_host_work: phases.some(p => p.name === 'host-work' && p.status === 'complete') ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const v0_14_0: Migration = {
  version: '0.14.0',
  featurePitch: {
    headline: 'Shell jobs + autopilot cooperative handler + max_stalled default bump.',
    description:
      'v0.14.0 unlocks `shell` as a Minion job type (gated by GBRAIN_ALLOW_SHELL_JOBS=1 ' +
      'on the worker). The autopilot-cycle handler now yields to the event loop ' +
      'between phases so lock renewal fires on huge brains. The minion_jobs.max_stalled ' +
      'default is bumped 1→3 so one lock-lost tick no longer dead-letters a job. ' +
      'Host-specific skill doc: skills/migrations/v0.14.0.md.',
  },
  orchestrator,
};

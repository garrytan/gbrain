/**
 * v0.16.0 migration orchestrator — Subagent runtime schema.
 *
 * Adds three tables for durable LLM agent loops:
 *   - subagent_messages        Anthropic message-block persistence
 *   - subagent_tool_executions Two-phase tool ledger (pending/complete/failed)
 *   - subagent_rate_leases     Lease-based concurrency cap
 *
 * All DDL is `CREATE TABLE IF NOT EXISTS` and ships in src/schema.sql +
 * src/core/pglite-schema.ts (both Postgres and PGLite fresh-install paths).
 * This orchestrator's job is therefore only to VERIFY the tables exist after
 * `gbrain init --migrate-only` has run, so an upgrade that somehow skipped
 * the schema step fails loudly instead of silently.
 *
 * Phases (all idempotent):
 *   A. Schema — gbrain init --migrate-only (creates tables via SCHEMA_SQL).
 *   B. Verify — confirm all three tables exist.
 *   C. Record — append completed.jsonl.
 */

import { execSync } from 'child_process';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { appendCompletedMigration } from '../../core/preferences.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';

const REQUIRED_TABLES = ['subagent_messages', 'subagent_tool_executions', 'subagent_rate_leases'] as const;

// ── Phase A — Schema ────────────────────────────────────────

function phaseASchema(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    execSync('gbrain init --migrate-only', { stdio: 'inherit', timeout: 60_000, env: process.env });
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'schema', status: 'failed', detail: msg };
  }
}

// ── Phase B — Verify tables exist ───────────────────────────

async function phaseBVerify(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  try {
    const config = loadConfig();
    if (!config) {
      return { name: 'verify', status: 'skipped', detail: 'no brain configured' };
    }
    const engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    try {
      const rows = await engine.executeRaw<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema()
           AND table_name IN ('subagent_messages','subagent_tool_executions','subagent_rate_leases')`,
      );
      const found = new Set(rows.map(r => r.table_name));
      const missing = REQUIRED_TABLES.filter(t => !found.has(t));
      if (missing.length > 0) {
        return {
          name: 'verify',
          status: 'failed',
          detail: `missing tables: ${missing.join(', ')}`,
        };
      }
      return { name: 'verify', status: 'complete', detail: `${REQUIRED_TABLES.length} tables present` };
    } finally {
      try { await engine.disconnect(); } catch {}
    }
  } catch (e) {
    return {
      name: 'verify',
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.16.0 — Subagent runtime schema ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalize(phases, 'failed');

  const b = await phaseBVerify(opts);
  phases.push(b);

  // a.status was narrowed to 'skipped' | 'complete' by the early return above.
  const status: 'complete' | 'partial' | 'failed' =
    b.status === 'failed' ? 'partial' : 'complete';

  return finalize(phases, status);
}

function finalize(phases: OrchestratorPhaseResult[], status: 'complete' | 'partial' | 'failed'): OrchestratorResult {
  if (status !== 'failed') {
    try {
      appendCompletedMigration({
        version: '0.16.0',
        completed_at: new Date().toISOString(),
        status: status as 'complete' | 'partial',
        phases: phases.map(p => ({ name: p.name, status: p.status })),
      });
    } catch {
      // Recording is best-effort.
    }
  }
  return { version: '0.16.0', status, phases };
}

export const v0_16_0: Migration = {
  version: '0.16.0',
  featurePitch: {
    headline: 'Durable LLM agents land in the brain — survive crashes, sleeps, and worker restarts.',
    description:
      'v0.16.0 adds the subagent runtime: run long-running, fan-out Anthropic LLM loops ' +
      'as first-class Minion jobs. Crash-resumable turn persistence, two-phase tool ledger, ' +
      'lease-based rate limit, parent-child fan-out with aggregation. Entry points: `gbrain ' +
      'agent run` and `gbrain agent logs`. See docs/guides/plugin-authors.md for shipping ' +
      'custom subagent defs from a host repo (your OpenClaw etc.).',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBVerify,
  REQUIRED_TABLES,
};

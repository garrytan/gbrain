/**
 * v0.18.1 migration orchestrator — RLS hardening.
 *
 * v0.18.1 ships one new schema migration: v24 `rls_backfill_missing_tables`.
 * It enables Row Level Security on 10 gbrain-managed public tables that
 * shipped without it: access_tokens, mcp_request_log, minion_inbox,
 * minion_attachments, subagent_messages, subagent_tool_executions,
 * subagent_rate_leases, gbrain_cycle_locks, budget_ledger, budget_reservations.
 *
 * Phase structure mirrors v0.18.0:
 *   A. Schema — `gbrain init --migrate-only` runs the migration chain,
 *      picking up v24 on brains currently at v23 (post-v0.18.0) or earlier.
 *
 * Without this orchestrator, the `apply-migrations` registry stops at
 * v0.18.0 and the low-level schema migration in src/core/migrate.ts never
 * fires on upgrade, because doctor + connectEngine never call initSchema().
 */

import { execSync } from 'child_process';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';

// ── Phase A — Schema ────────────────────────────────────────

function phaseASchema(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    execSync('gbrain init --migrate-only', { stdio: 'inherit', timeout: 600_000, env: process.env });
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'schema', status: 'failed', detail: msg };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const phases: OrchestratorPhaseResult[] = [];
  phases.push(phaseASchema(opts));

  const anyFailed = phases.some(p => p.status === 'failed');
  const status: OrchestratorResult['status'] = anyFailed ? 'partial' : 'complete';

  return {
    version: '0.18.1',
    status,
    phases,
    pending_host_work: 0,
  };
}

// ── Export ──────────────────────────────────────────────────

export const v0_18_1: Migration = {
  version: '0.18.1',
  featurePitch: {
    headline: 'Row Level Security hardened on all public tables + escape hatch.',
    description:
      'v0.18.1 fixes a latent security gap: 10 gbrain-managed public tables ' +
      'shipped without RLS. On Supabase, they were reachable by the anon key. ' +
      'Migration v24 backfills RLS on existing brains automatically when ' +
      '`gbrain apply-migrations` runs. `gbrain doctor` now scans every ' +
      'public table (no hardcoded allowlist) and exits 1 on gaps. For tables ' +
      'that should stay anon-readable on purpose, operators set a ' +
      '`GBRAIN:RLS_EXEMPT reason=<why>` comment via psql. See ' +
      'docs/guides/rls-and-you.md.',
  },
  orchestrator,
};

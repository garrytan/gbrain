/**
 * v0.12.2 migration orchestrator — JSONB double-encode repair.
 *
 * v0.12.0-and-earlier wrote JSONB columns via the buggy
 * `JSON.stringify(value)`-then-cast-to-jsonb interpolation pattern, which
 * postgres.js v3 stringified again on the wire. Result: every
 * `frontmatter->>'key'` query returned NULL on Postgres-backed brains and
 * GIN indexes on JSONB columns were inert. PGLite was unaffected (its
 * driver path uses parameterized binding, never interpolation).
 *
 * v0.12.2 fixes the writes (sql.json) AND repairs existing rows in place.
 * This is the migration. It's idempotent (only touches `jsonb_typeof = 'string'`
 * rows) and safe to re-run. PGLite engines no-op cleanly.
 *
 * Phases (all idempotent):
 *   A. Schema   — gbrain init --migrate-only (no schema changes in v0.12.2
 *                 but we still apply for consistency with v0.12.0).
 *   B. Repair   — gbrain repair-jsonb (the actual JSONB fix).
 *   C. Verify   — gbrain repair-jsonb --dry-run --json; assert 0 remaining.
 *   D. Record   — append completed.jsonl.
 */

import { execSync } from 'child_process';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts).

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

// ── Phase B — JSONB repair ──────────────────────────────────

function phaseBRepair(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'jsonb_repair', status: 'skipped', detail: 'dry-run' };
  try {
    execSync('gbrain repair-jsonb', { stdio: 'inherit', timeout: 600_000, env: process.env });
    return { name: 'jsonb_repair', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'jsonb_repair', status: 'failed', detail: msg };
  }
}

// ── Phase C — Verify ────────────────────────────────────────

function phaseCVerify(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  try {
    const out = execSync('gbrain repair-jsonb --dry-run --json', {
      encoding: 'utf-8', timeout: 60_000, env: process.env,
    });
    const parsed = JSON.parse(out) as { total_repaired?: number; engine?: string };
    const remaining = parsed.total_repaired ?? 0;
    if (remaining > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${remaining} string-typed JSONB rows remain after repair`,
      };
    }
    return { name: 'verify', status: 'complete', detail: parsed.engine ? `engine=${parsed.engine}` : undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'verify', status: 'failed', detail: msg };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.12.2 — JSONB double-encode repair ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed');

  const b = phaseBRepair(opts);
  phases.push(b);
  if (b.status === 'failed') return finalizeResult(phases, 'failed');

  const c = phaseCVerify(opts);
  phases.push(c);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    a.status === 'failed' || b.status === 'failed' ? 'failed' :
    c.status === 'failed' ? 'partial' :
    'complete';

  return finalizeResult(phases, overallStatus);
}

function finalizeResult(phases: OrchestratorPhaseResult[], status: 'complete' | 'partial' | 'failed'): OrchestratorResult {
  // Ledger write lives in the runner now (Bug 3).
  return {
    version: '0.12.2',
    status,
    phases,
  };
}

export const v0_12_2: Migration = {
  version: '0.12.2',
  featurePitch: {
    headline: 'Postgres frontmatter queries now work — JSONB double-encode bug fixed and existing rows auto-repaired',
    description:
      'gbrain v0.12.0-and-earlier silently stored JSONB columns as quoted string literals on ' +
      'Postgres/Supabase (PGLite was unaffected). Every `frontmatter->>\'key\'` returned NULL ' +
      'and GIN indexes were inert. v0.12.2 fixes the writes AND auto-repairs every existing ' +
      'string-typed row in pages.frontmatter, raw_data.data, ingest_log.pages_updated, ' +
      'files.metadata, and page_versions.frontmatter. The migration is idempotent. Pages ' +
      'truncated by the splitBody horizontal-rule bug can be recovered with `gbrain sync --full`.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBRepair,
  phaseCVerify,
};

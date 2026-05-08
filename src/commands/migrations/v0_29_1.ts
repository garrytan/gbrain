/**
 * v0.29.1 migration orchestrator — backfill effective_date for existing
 * pages.
 *
 * Migration v38 added pages.effective_date / effective_date_source /
 * import_filename / salience_touched_at as nullable columns. Fresh imports
 * post-v0.29.1 populate effective_date via the importer's
 * `computeEffectiveDate`. Pre-v0.29.1 rows have NULL until this orchestrator
 * walks them.
 *
 * Phases (all idempotent, resumable):
 *   A. Schema  — `gbrain init --migrate-only` ensures v38 ran.
 *   B. Backfill — keyset-paginated UPDATE via `backfillEffectiveDate`.
 *                 Resumable via the `backfill.effective_date.last_id`
 *                 checkpoint key in the config table. Statement timeout
 *                 set per-batch (Postgres only).
 *   C. Verify  — count remaining NULL effective_date rows; warn if > 0.
 *   D. Record  — handled by the runner.
 */

import { execSync } from 'child_process';
import type { BrainEngine } from '../../core/engine.ts';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { childGlobalFlags } from '../../core/cli-options.ts';

// ── Phase A — Schema ────────────────────────────────────────

function phaseASchema(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    execSync('gbrain init --migrate-only' + childGlobalFlags(), {
      stdio: 'inherit',
      timeout: 600_000, // 10 min — duplicate-heavy installs can be slow
      env: process.env,
    });
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase B — Backfill effective_date ───────────────────────

async function phaseBBackfill(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'backfill_effective_date', status: 'skipped', detail: 'dry-run' };
  let engine: BrainEngine | null = null;
  try {
    const { createEngine } = await import('../../core/engine-factory.ts');
    const { loadConfig, toEngineConfig } = await import('../../core/config.ts');
    const { backfillEffectiveDate } = await import('../../core/backfill-effective-date.ts');
    const cfg = loadConfig();
    if (!cfg) throw new Error('No gbrain config; run `gbrain init` first.');
    const engineConfig = toEngineConfig(cfg);
    engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);

    let totalExamined = 0;
    let totalUpdated = 0;

    const result = await backfillEffectiveDate(engine, {
      onBatch: ({ batch, lastId, rowsTouched, cumulative }) => {
        totalExamined = cumulative;
        totalUpdated += rowsTouched;
        if (batch % 10 === 0) {
          process.stderr.write(`  [backfill] batch ${batch} | last_id=${lastId} | examined=${cumulative} | updated_so_far=${totalUpdated}\n`);
        }
      },
    });

    return {
      name: 'backfill_effective_date',
      status: 'complete',
      detail: `examined=${result.examined} updated=${result.updated} fallback=${result.fallback} dur=${result.durationSec.toFixed(1)}s`,
    };
  } catch (e) {
    return { name: 'backfill_effective_date', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (engine) {
      try { await engine.disconnect(); } catch { /* ignore */ }
    }
  }
}

// ── Phase C — Verify ────────────────────────────────────────

async function phaseCVerify(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  let engine: BrainEngine | null = null;
  try {
    const { createEngine } = await import('../../core/engine-factory.ts');
    const { loadConfig, toEngineConfig } = await import('../../core/config.ts');
    const cfg = loadConfig();
    if (!cfg) throw new Error('No gbrain config; run `gbrain init` first.');
    const engineConfig = toEngineConfig(cfg);
    engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    // Count rows where effective_date is still NULL but frontmatter HAS a
    // parseable date — those are the rows the backfill should have touched
    // but didn't. (Rows that fall through to 'fallback' have non-null
    // effective_date already; this catches genuine misses.)
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pages WHERE effective_date IS NULL`,
    );
    const remaining = Number(rows[0]?.count ?? 0);
    if (remaining > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${remaining} pages still have NULL effective_date (backfill incomplete)`,
      };
    }
    return { name: 'verify', status: 'complete', detail: '0 pages with NULL effective_date' };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (engine) {
      try { await engine.disconnect(); } catch { /* ignore */ }
    }
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.29.1 — backfill effective_date for existing pages ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalize(phases, 'failed');

  const b = await phaseBBackfill(opts);
  phases.push(b);
  if (b.status === 'failed') return finalize(phases, 'partial');

  const c = await phaseCVerify(opts);
  phases.push(c);

  const status: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'partial' : 'complete';

  return finalize(phases, status);
}

function finalize(phases: OrchestratorPhaseResult[], status: 'complete' | 'partial' | 'failed'): OrchestratorResult {
  return { version: '0.29.1', status, phases };
}

export const v0_29_1: Migration = {
  version: '0.29.1',
  featurePitch: {
    headline: 'Recency + salience as two opt-in axes — agent in charge of when to use each',
    description:
      'gbrain v0.29.1 adds two new optional ranking axes to the query op: salience ' +
      '(emotional_weight + take_count, the "this matters" signal) and recency (per-prefix ' +
      'age decay, the "this is recent" signal). Truly orthogonal — use either, both, or ' +
      "neither. The query op's tool description teaches your agent when each makes sense " +
      '("current state → on; canonical truth → off") and the agent can override per query. ' +
      'A new pages.effective_date column is computed at import from frontmatter precedence ' +
      '(event_date / date / published / filename) and is immune to auto-link updated_at ' +
      'churn. Existing callers (no new params) get UNCHANGED behavior. Run ' +
      "`gbrain dream --phase recompute_emotional_weight` once after upgrading.",
  },
  orchestrator,
};

export const __testing = {
  phaseASchema,
  phaseBBackfill,
  phaseCVerify,
};

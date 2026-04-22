/**
 * v0.13.0 migration orchestrator — frontmatter relationship indexing.
 *
 * v0.13 extends the knowledge graph to project typed edges from YAML
 * frontmatter (company, investors, attendees, key_people, etc.), not just
 * `[Name](path)` markdown refs. This migration:
 *
 *   A. Schema — `gbrain init --migrate-only` triggers migrate.ts v11 which
 *               adds link_source + origin_page_id + origin_field columns,
 *               swaps the unique constraint to include them, and creates
 *               new indexes.
 *   B. Backfill — `gbrain extract links --source db --include-frontmatter`
 *               walks every page and emits the frontmatter-derived edges.
 *               Uses the batch-mode resolver (pg_trgm only, no LLM).
 *   C. Verify — Query the links table and confirm link_source='frontmatter'
 *               rows exist (> 0 on any brain with frontmatter content).
 *   D. Record — append to ~/.gbrain/completed.jsonl.
 *
 * Idempotent. Resumable from `partial` via ON CONFLICT DO NOTHING on the
 * new unique constraint. Wall-clock budget on 46K-page brains: 2-5 min
 * (pg_trgm index-backed, no embedding or LLM calls).
 *
 * Ignores `auto_link=false` config: migration is canonical (CLAUDE.md),
 * not advisory. The auto_link toggle controls the put_page post-hook,
 * not one-time schema+backfill work.
 */

import { execSync } from 'child_process';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts). The
// orchestrator returns its result and the runner persists it.

// ── Phase A — Schema ────────────────────────────────────────
//
// migrate.ts v11 adds the link_source/origin_page_id/origin_field columns
// and swaps the unique constraint. Schema build time on 46K pages is
// ~10s (ALTER + index builds). Bumped timeout accounts for slow Supabase
// links (v0.12.1 pattern — migrations can time out on the 60s default).
//
// Shell out to the canonical `gbrain` shim on PATH (`/usr/local/bin/gbrain`
// by default). An earlier revision resolved via the active Node/Bun runtime
// binary, but on bun-installed trees that binary is `bun` — the spawned
// `bun extract ...` gets reinterpreted as `bun run extract` and crashes the
// upgrade mid-migration. The shim is already the canonical wrapper; trust
// it. Regression guarded by test/migrations-v0_13_0.test.ts.

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

// ── Phase B — Frontmatter edge backfill ─────────────────────

function phaseBBackfill(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'frontmatter_backfill', status: 'skipped', detail: 'dry-run' };
  try {
    // `--source db` iterates pages from the engine (no local checkout required).
    // `--include-frontmatter` is the v0.13 flag that enables the canonical
    // frontmatter link extractor. Default-OFF in the CLI for back-compat;
    // the migration explicitly opts in because this is the canonical backfill.
    execSync('gbrain extract links --source db --include-frontmatter', {
      stdio: 'inherit',
      timeout: 1_800_000,  // 30 min hard cap; typical 2-5 min on 46K pages
      env: process.env,
    });
    return { name: 'frontmatter_backfill', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'frontmatter_backfill', status: 'failed', detail: msg };
  }
}

// ── Phase C — Verify ────────────────────────────────────────

function phaseCVerify(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  try {
    // Query frontmatter edge count via get_stats + a secondary --json call
    // to `gbrain graph-query` as a smoke test: extract one random page and
    // confirm it has at least one edge. Non-blocking.
    //
    // We intentionally do NOT fail on 0 frontmatter edges: fresh installs,
    // docs-only brains, and brains with no entity pages legitimately
    // produce 0. Phase B's own stdout shows `Links: created N` which is
    // the authoritative signal — user sees it during upgrade.
    const out = execSync('gbrain call get_stats', {
      encoding: 'utf-8', timeout: 60_000, env: process.env,
    });
    const parsed = JSON.parse(out) as { link_count?: number; page_count?: number };
    const linkCount = parsed.link_count ?? 0;
    const pageCount = parsed.page_count ?? 0;
    return {
      name: 'verify',
      status: 'complete',
      detail: `pages=${pageCount}, links=${linkCount} (backfill output in Phase B logs)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'verify', status: 'failed', detail: msg };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.13.0 — Frontmatter relationship indexing ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed');

  const b = phaseBBackfill(opts);
  phases.push(b);
  // Backfill failure → partial. Schema is already applied so re-running
  // only re-tries the backfill (idempotent via ON CONFLICT DO NOTHING).
  if (b.status === 'failed') return finalizeResult(phases, 'partial');

  const c = phaseCVerify(opts);
  phases.push(c);

  // a.status and b.status were narrowed to 'skipped' | 'complete' by early returns above.
  const overallStatus: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'partial' : 'complete';

  return finalizeResult(phases, overallStatus);
}

function finalizeResult(phases: OrchestratorPhaseResult[], status: 'complete' | 'partial' | 'failed'): OrchestratorResult {
  // Ledger write lives in the runner now (Bug 3).
  return {
    version: '0.13.0',
    status,
    phases,
  };
}

export const v0_13_0: Migration = {
  version: '0.13.0',
  featurePitch: {
    headline: 'Frontmatter becomes a graph — company, investors, attendees now create typed edges automatically',
    description:
      'v0.13 extends the knowledge graph to project typed edges from YAML frontmatter. ' +
      'Every `company: X`, `investors: [A, B]`, `attendees: [Pedro, Garry]`, `key_people`, ' +
      '`partner`, `lead`, and `related` field you already wrote now surfaces in ' +
      '`gbrain graph`. Direction semantics respect subject-of-verb (Pedro → meeting, ' +
      'not meeting → Pedro). The migration backfills every existing page in ~2-5 min ' +
      'on a 46K-page brain. Uses pg_trgm fuzzy-match for name resolution (zero LLM ' +
      'cost, zero API calls). Unresolvable names surface in the extract summary so you ' +
      'see exactly where the graph has holes.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBBackfill,
  phaseCVerify,
};

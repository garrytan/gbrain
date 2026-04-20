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
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { extractLinksFromDB } from '../extract.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts). The
// orchestrator returns its result and the runner persists it.

// ── Phase A — Schema ────────────────────────────────────────
//
// migrate.ts v11 adds the link_source/origin_page_id/origin_field columns
// and swaps the unique constraint. Schema build time on 46K pages is
// ~10s (ALTER + index builds). Bumped timeout accounts for slow Supabase
// links (v0.12.1 pattern — migrations can time out on the 60s default).
// Use the CURRENTLY-RUNNING binary path (not `gbrain` off $PATH). After
// `gbrain upgrade` rewrites the binary, a bare `gbrain` could resolve to
// an older installed copy via alias shadowing or stale PATH cache. The
// active process.execPath is the one that loaded THIS migration module,
// so recursing into it is always the right binary.
const GBRAIN = process.execPath;

function phaseASchema(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    execSync(`${GBRAIN} init --migrate-only`, { stdio: 'inherit', timeout: 600_000, env: process.env });
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'schema', status: 'failed', detail: msg };
  }
}

// ── Phase B — Frontmatter edge backfill ─────────────────────

async function phaseBBackfill(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'frontmatter_backfill', status: 'skipped', detail: 'dry-run' };
  // Call extractLinksFromDB in-process instead of spawning `${GBRAIN} extract`.
  // Rationale: `process.execPath` is `bun` under `bun run src/cli.ts` (dev /
  // bun-link installs). Passing that as GBRAIN produces `bun extract ...`
  // which bun interprets as a missing package.json script and fails. Calling
  // the function directly sidesteps all subprocess + PATH + exec-lookup hazards.
  const config = loadConfig();
  if (!config) {
    return { name: 'frontmatter_backfill', status: 'failed', detail: 'No gbrain config found (run `gbrain init` first).' };
  }
  let engine;
  try {
    engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    await extractLinksFromDB(engine, false, false, undefined, undefined, { includeFrontmatter: true });
    return { name: 'frontmatter_backfill', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'frontmatter_backfill', status: 'failed', detail: msg };
  } finally {
    try { await engine?.disconnect(); } catch { /* best-effort */ }
  }
}

// ── Phase C — Verify ────────────────────────────────────────

async function phaseCVerify(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  // Call getStats in-process for the same `process.execPath` reason as Phase B.
  const config = loadConfig();
  if (!config) {
    return { name: 'verify', status: 'failed', detail: 'No gbrain config found.' };
  }
  let engine;
  try {
    engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    const stats = await engine.getStats();
    const linkCount = stats.link_count ?? 0;
    const pageCount = stats.page_count ?? 0;
    return {
      name: 'verify',
      status: 'complete',
      detail: `pages=${pageCount}, links=${linkCount} (backfill output in Phase B logs)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'verify', status: 'failed', detail: msg };
  } finally {
    try { await engine?.disconnect(); } catch { /* best-effort */ }
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

  const b = await phaseBBackfill(opts);
  phases.push(b);
  // Backfill failure → partial. Schema is already applied so re-running
  // only re-tries the backfill (idempotent via ON CONFLICT DO NOTHING).
  if (b.status === 'failed') return finalizeResult(phases, 'partial');

  const c = await phaseCVerify(opts);
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

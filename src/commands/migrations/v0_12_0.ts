/**
 * v0.12.0 migration orchestrator — Knowledge Graph auto-wire.
 *
 * Ensures the v0.12.0 graph layer is fully wired up on every install:
 * schema migrations applied (v8/v9/v10), auto-link enabled, links and
 * timeline backfilled from existing pages, wire-up verified.
 *
 * The whole point of v0.12.0 is "the brain wires itself" — every page
 * write extracts entity references and creates typed links. This
 * orchestrator turns that promise into a verified install state.
 *
 * Phases (all idempotent; resumable from a prior status:"partial" run):
 *   A. Schema   — gbrain init --migrate-only (applies v8/v9/v10).
 *   B. Config   — verify auto_link is not explicitly disabled. If it's
 *                 set to false, leave it alone (user intent) but warn.
 *   C. Backfill — gbrain extract links --source db (idempotent; the
 *                 UNIQUE constraint on (from, to, link_type) guarantees
 *                 re-runs are no-op).
 *   D. Timeline — gbrain extract timeline --source db (idempotent via
 *                 the (page_id, date, summary) UNIQUE index).
 *   E. Verify   — gbrain stats; confirm link_count and
 *                 timeline_entry_count match expectations OR explain
 *                 why they're zero (empty brain, no entity refs in
 *                 content, etc.).
 *   F. Record   — append completed.jsonl.
 *
 * Empty brains and pre-graph brains both succeed without doing pointless
 * work. The only way this orchestrator fails is if the schema migration
 * itself fails — which is also the only thing the user actually has to
 * fix manually.
 */

import { execSync } from 'child_process';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts).

// ── Phase A — Schema ────────────────────────────────────────

function phaseASchema(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    // 10-minute budget. Migrations v8/v9 dedup with helper-index should be sub-second
    // even on 80K-duplicate brains, but the outer wall-clock cap shouldn't be the
    // failure mode (the prior 60s ceiling tripped Garry's production upgrade).
    execSync('gbrain init --migrate-only', { stdio: 'inherit', timeout: 600_000, env: process.env });
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'schema', status: 'failed', detail: msg };
  }
}

// ── Phase B — Config check ──────────────────────────────────

interface ConfigCheckResult {
  status: 'enabled' | 'disabled' | 'unknown';
  /** Raw value of the auto_link config key, if set. */
  raw?: string;
}

function phaseBConfigCheck(opts: OrchestratorOpts): OrchestratorPhaseResult & { autoLink: ConfigCheckResult } {
  if (opts.dryRun) {
    return { name: 'config', status: 'skipped', detail: 'dry-run', autoLink: { status: 'unknown' } };
  }
  // gbrain config get auto_link returns the raw value (or empty if unset).
  // Default behavior when unset = enabled (per isAutoLinkEnabled).
  let raw = '';
  try {
    raw = execSync('gbrain config get auto_link', { encoding: 'utf-8', timeout: 10_000, env: process.env }).trim();
  } catch {
    // get exits non-zero when the key isn't set — that's fine, defaults to enabled.
    raw = '';
  }
  const lc = raw.toLowerCase();
  const disabled = ['false', '0', 'no', 'off'].includes(lc);
  const result: ConfigCheckResult = {
    status: disabled ? 'disabled' : (raw === '' ? 'unknown' : 'enabled'),
    raw: raw || undefined,
  };
  if (disabled) {
    console.log('  Note: auto_link is explicitly disabled (config: auto_link=' + raw + ').');
    console.log('  Skipping backfill phases. Re-enable with: gbrain config set auto_link true');
  }
  return { name: 'config', status: 'complete', detail: result.status, autoLink: result };
}

// ── Phases C/D — Backfill (links + timeline) ────────────────

function phaseCBackfillLinks(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'backfill_links', status: 'skipped', detail: 'dry-run' };
  try {
    // --source db is idempotent: the UNIQUE constraint on
    // (from_page_id, to_page_id, link_type) and ON CONFLICT DO NOTHING
    // make re-runs cheap. Empty brains return 0/0 quickly.
    execSync('gbrain extract links --source db', { stdio: 'inherit', timeout: 600_000, env: process.env });
    return { name: 'backfill_links', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'backfill_links', status: 'failed', detail: msg };
  }
}

function phaseDBackfillTimeline(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'backfill_timeline', status: 'skipped', detail: 'dry-run' };
  try {
    execSync('gbrain extract timeline --source db', { stdio: 'inherit', timeout: 600_000, env: process.env });
    return { name: 'backfill_timeline', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'backfill_timeline', status: 'failed', detail: msg };
  }
}

// ── Phase E — Verify ────────────────────────────────────────

interface StatsSnapshot {
  page_count: number;
  link_count: number;
  timeline_entry_count: number;
}

function readStats(): StatsSnapshot | null {
  try {
    const out = execSync('gbrain get_stats --json 2>/dev/null || gbrain stats', {
      encoding: 'utf-8', timeout: 30_000, env: process.env,
    });
    // The fallback `gbrain stats` prints human-readable output; parse loosely.
    const pages = parseInt((out.match(/Pages:\s+(\d+)/) || ['', '0'])[1], 10);
    const links = parseInt((out.match(/Links:\s+(\d+)/) || ['', '0'])[1], 10);
    const timeline = parseInt((out.match(/Timeline:\s+(\d+)/) || ['', '0'])[1], 10);
    return { page_count: pages, link_count: links, timeline_entry_count: timeline };
  } catch {
    return null;
  }
}

function phaseEVerify(opts: OrchestratorOpts, autoLinkDisabled: boolean): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  const stats = readStats();
  if (!stats) {
    return { name: 'verify', status: 'failed', detail: 'could not read gbrain stats' };
  }

  console.log('');
  console.log(`  Brain wire-up:`);
  console.log(`    Pages:    ${stats.page_count}`);
  console.log(`    Links:    ${stats.link_count}`);
  console.log(`    Timeline: ${stats.timeline_entry_count}`);

  // Empty brain — fresh install, nothing to backfill yet. Auto-link kicks
  // in on first put_page. This is a successful completion, not a failure.
  if (stats.page_count === 0) {
    console.log('  Empty brain — auto-link will wire entities as you write pages.');
    return { name: 'verify', status: 'complete', detail: 'empty_brain' };
  }

  // User opted out — record state, don't second-guess.
  if (autoLinkDisabled) {
    return { name: 'verify', status: 'complete', detail: 'auto_link_disabled_by_user' };
  }

  // Brain has pages but graph is empty. Possible causes:
  //   - Pages don't contain entity references (no markdown links between them)
  //   - All pages are templated/non-prose and don't trigger extraction
  //   - Extraction silently failed (but extract --source db would have errored)
  // None of these are migration failures — they're brain content shape.
  if (stats.link_count === 0 && stats.page_count > 0) {
    console.log('  Pages present but 0 links extracted. Likely no entity refs in content,');
    console.log('  or all entity refs target slugs that do not exist as pages.');
    console.log('  Try: gbrain extract links --source db --dry-run | head -20');
    return { name: 'verify', status: 'complete', detail: 'no_extractable_refs' };
  }

  // Healthy: pages present and links populated.
  console.log('  Graph layer wired up.');
  return { name: 'verify', status: 'complete', detail: 'wired' };
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.12.0 — Knowledge Graph auto-wire ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  // A. Schema
  const a = phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') {
    return finalizeResult(phases, 'failed');
  }

  // B. Config check
  const b = phaseBConfigCheck(opts);
  phases.push({ name: b.name, status: b.status, detail: b.detail });
  const autoLinkDisabled = b.autoLink.status === 'disabled';

  // C/D. Backfill — skip if user opted out of auto_link.
  if (autoLinkDisabled) {
    phases.push({ name: 'backfill_links', status: 'skipped', detail: 'auto_link disabled' });
    phases.push({ name: 'backfill_timeline', status: 'skipped', detail: 'auto_link disabled' });
  } else {
    const c = phaseCBackfillLinks(opts);
    phases.push(c);
    const d = phaseDBackfillTimeline(opts);
    phases.push(d);
    // Backfill failure is non-fatal — extraction missing some pages is recoverable
    // via re-run. The schema is what matters; data backfill we tolerate.
  }

  // E. Verify
  const e = phaseEVerify(opts, autoLinkDisabled);
  phases.push(e);

  // F. Record
  const overallStatus: 'complete' | 'partial' | 'failed' =
    a.status === 'failed' ? 'failed' :
    phases.some(p => p.status === 'failed') ? 'partial' :
    'complete';

  return finalizeResult(phases, overallStatus);
}

function finalizeResult(phases: OrchestratorPhaseResult[], status: 'complete' | 'partial' | 'failed'): OrchestratorResult {
  // Ledger write lives in the runner now (Bug 3).
  return {
    version: '0.12.0',
    status,
    phases,
  };
}

export const v0_12_0: Migration = {
  version: '0.12.0',
  featurePitch: {
    headline: 'Knowledge Graph wires itself — every page write extracts typed links automatically',
    description:
      'Every gbrain put_page now extracts entity references and creates typed links ' +
      '(attended, works_at, invested_in, founded, advises) with zero LLM calls. Hybrid ' +
      'search. Self-wiring graph. Backlink-boosted ranking. Ask "who works at Acme?" or ' +
      '"what did Bob invest in?" — answers vector search alone can\'t reach. Benchmarked ' +
      'end-to-end on a 240-page rich-prose corpus: Recall@5 83% → 95%, Precision@5 ' +
      '39% → 45%, +30 more correct answers in the agent\'s top-5. Graph-only F1: ' +
      '86.6% vs grep\'s 57.8% (+28.8 pts). See docs/benchmarks/2026-04-18-brainbench-v1.md.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBConfigCheck,
  phaseCBackfillLinks,
  phaseDBackfillTimeline,
  phaseEVerify,
  readStats,
};

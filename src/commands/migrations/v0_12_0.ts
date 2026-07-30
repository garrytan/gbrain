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
import { runGbrainSubprocess } from './in-process.ts';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { childGlobalFlags } from '../../core/cli-options.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts).

// ── Phase A — Schema ────────────────────────────────────────

async function phaseASchema(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    // 10-minute budget. Migrations v8/v9 dedup with helper-index should be sub-second
    // even on 80K-duplicate brains, but the outer wall-clock cap shouldn't be the
    // failure mode (the prior 60s ceiling tripped Garry's production upgrade).
    const { runMigrateOnlyCore } = await import('./in-process.ts');
    await runMigrateOnlyCore();
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

/**
 * Wall-clock guard for the short `gbrain …` probes this orchestrator runs
 * (`config get`, `stats`). NOT for the backfills, which have their own 600s.
 *
 * The 10s and 30s these used to hardcode are below the floor on Windows, where
 * every probe pays a cold `bun` start plus a PGLite open before it does any
 * work. Measured against an already-migrated brain:
 *
 *   gbrain config get auto_link   15.2s   (vs a 10s timeout — never succeeded)
 *   gbrain stats                  17.7s   (vs a 30s timeout — fits only when idle)
 *
 * Both matter. `config get` failing is quiet but wrong: the catch treats it as
 * "unset", so a user who explicitly set `auto_link=false` had that ignored on
 * Windows and the backfill ran anyway. `stats` failing makes phase E report
 * `could not read gbrain stats`, which marks the whole migration PARTIAL — and
 * `MAX_CONSECUTIVE_PARTIALS=3` then WEDGES it. That is exactly what happened
 * intermittently: 17.7s is comfortable on an idle box, but the cold-spawn floor
 * on this machine ranged 11.3s-28.9s (2.5x) purely from contention, so the same
 * probe lands past 30s under load.
 *
 * 120s ≈ 7x the slowest observed. These are cheap probes whose failure silently
 * degrades behaviour, so a generous ceiling costs nothing when they succeed in
 * ~20s and prevents a wedged migration when they don't.
 */
export const DEFAULT_MIGRATE_CLI_TIMEOUT_MS = 120_000;

export function resolveMigrateCliTimeoutMs(): number {
  const raw = process.env.GBRAIN_MIGRATE_CLI_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MIGRATE_CLI_TIMEOUT_MS;
}

function phaseBConfigCheck(opts: OrchestratorOpts): OrchestratorPhaseResult & { autoLink: ConfigCheckResult } {
  if (opts.dryRun) {
    return { name: 'config', status: 'skipped', detail: 'dry-run', autoLink: { status: 'unknown' } };
  }
  // gbrain config get auto_link returns the raw value (or empty if unset).
  // Default behavior when unset = enabled (per isAutoLinkEnabled).
  let raw = '';
  try {
    raw = execSync('gbrain config get auto_link', {
      encoding: 'utf-8',
      timeout: resolveMigrateCliTimeoutMs(),
      env: process.env,
    }).trim();
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
    runGbrainSubprocess('gbrain extract links --source db' + childGlobalFlags(), { timeoutMs: 600_000 });
    return { name: 'backfill_links', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'backfill_links', status: 'failed', detail: msg };
  }
}

function phaseDBackfillTimeline(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'backfill_timeline', status: 'skipped', detail: 'dry-run' };
  try {
    runGbrainSubprocess('gbrain extract timeline --source db' + childGlobalFlags(), { timeoutMs: 600_000 });
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

/**
 * Run one `gbrain …` invocation, discarding stderr. Returns null on any
 * failure so the caller can fall through to the next candidate.
 *
 * Deliberately ONE command with no shell operators. `execSync` runs its string
 * through `cmd.exe` on Windows, which does not understand POSIX `2>/dev/null`:
 * it tries to create a file literally named `\dev\null`, fails with
 * `Access is denied.`, produces no output, and then burns the ENTIRE declared
 * timeout instead of falling through to the `||` branch. Measured directly —
 * `gbrain get_stats --json 2>/dev/null || gbrain stats` threw
 * `spawnSync cmd.exe ETIMEDOUT` after 30.7s having printed only
 * `Access is denied.`, and no `dev/null` file was created.
 *
 * In the v0.12.0 orchestrator that made phase E's verify unreachable on
 * Windows, so the migration finished PARTIAL on every run — and
 * MAX_CONSECUTIVE_PARTIALS=3 then marks it WEDGED on the third attempt.
 * `stdio: 'ignore'` on fd 2 is the portable way to say `2>/dev/null`.
 */
function tryReadStatsCommand(cmd: string): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: resolveMigrateCliTimeoutMs(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function readStats(): StatsSnapshot | null {
  // Preferred machine-readable form first, human-readable as the fallback.
  const out = tryReadStatsCommand('gbrain get_stats --json')
    ?? tryReadStatsCommand('gbrain stats');
  if (out === null) return null;
  // `gbrain stats` prints human-readable output; parse loosely.
  const pages = parseInt((out.match(/Pages:\s+(\d+)/) || ['', '0'])[1], 10);
  const links = parseInt((out.match(/Links:\s+(\d+)/) || ['', '0'])[1], 10);
  const timeline = parseInt((out.match(/Timeline:\s+(\d+)/) || ['', '0'])[1], 10);
  return { page_count: pages, link_count: links, timeline_entry_count: timeline };
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
  const a = await phaseASchema(opts);
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
  // a.status was narrowed to 'skipped' | 'complete' by the early return above.
  const overallStatus: 'complete' | 'partial' | 'failed' =
    phases.some(p => p.status === 'failed') ? 'partial' : 'complete';

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
      '86.6% vs grep\'s 57.8% (+28.8 pts). See github.com/garrytan/gbrain-evals.',
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

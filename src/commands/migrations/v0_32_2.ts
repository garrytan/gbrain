/**
 * v0.32.2 migration orchestrator — facts join the system-of-record invariant.
 *
 * Schema migration v51 (src/core/migrate.ts) added the two fence columns
 * (row_num, source_markdown_slug) and the partial UNIQUE index. The
 * orchestrator's job is the data half: walk every existing pre-v51 row
 * in the facts table (row_num IS NULL = "no fence yet") and append it
 * to its entity page's `## Facts` fence, atomically + idempotently.
 *
 * Phases:
 *   A. Schema       — assert migration v51 has run.
 *   B. Fence facts  — backfill DB facts → entity-page fences (dry-run
 *                     by default; explicit --write required).
 *   C. Verify       — re-parse each fence-owned page and compare its fence
 *                     row numbers with the DB rows for that page; a
 *                     duplicate active fence row may be absent from the
 *                     index (extract_facts indexes it once). Partial on
 *                     mismatch. Conversation-miner (`cli:`) facts are not
 *                     fence-owned (extract-conversation-facts writes the
 *                     chat log as source of truth) and are excluded.
 *   D. Record       — runner-owned ledger write (apply-migrations.ts).
 *
 * Idempotency: phase B only touches rows with row_num IS NULL. Re-runs
 * after a partial completion pick up where the previous run stopped.
 * Phase B is the shared core pass `src/core/facts/unfenced-facts.ts`, which
 * the extract_facts cycle phase also runs: managed brains publish each page
 * through the coordinator (`managed_maintenance_adopt_fact_fence`) and
 * verify from the database; unmanaged pages are written per page atomically
 * (.tmp + parse + rename under the page lock, same primitive as
 * fence-write.ts). The migration adds a dirty-tree refusal that mirrors
 * src/core/dry-fix.ts so the user can review the diff before committing.
 *
 * Facts with NULL entity_slug are structurally unfenceable (no page to
 * fence onto). They're skipped with a warning; the operator decides
 * whether to hand-curate or delete them. Their row_num stays NULL
 * forever; they live in the legacy keyspace permanently.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { parseFactsFence } from '../../core/facts-fence.ts';
import { duplicateActiveFenceRows } from '../../core/facts/extract-from-fence.ts';
import { resolvePageWriteTarget } from '../../core/write-through.ts';
import { serializePageToMarkdown } from '../../core/markdown.ts';
import { managedPersistenceEnabled } from '../../core/persistence/ownership.ts';
import { OperationError } from '../../core/ops/contract.ts';
import { fenceableRowCount, fenceUnfencedFacts, planUnfencedFacts, type UnfencedFactsOutcome } from '../../core/facts/unfenced-facts.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

async function getEngine(): Promise<BrainEngine | null> {
  if (testEngineOverride) return testEngineOverride;
  try {
    const cfg = loadConfig();
    if (!cfg) return null;
    const engineConfig = toEngineConfig(cfg);
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    return engine;
  } catch {
    return null;
  }
}

// ── Phase A — Schema verify ────────────────────────────────

async function phaseASchema(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  if (!engine) {
    return { name: 'schema', status: 'skipped', detail: 'no_brain_configured' };
  }
  try {
    const versionStr = await engine.getConfig('version');
    const v = parseInt(versionStr || '0', 10);
    if (v < 51) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected schema version >= 51 (facts_fence_columns); got ${v}. Run \`gbrain apply-migrations --yes\` to apply.`,
      };
    }
    // Quick post-condition: row_num + source_markdown_slug exist on facts.
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name IN ('row_num', 'source_markdown_slug')`,
    );
    if (rows.length < 2) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected columns row_num + source_markdown_slug on facts; found ${rows.map(r => r.column_name).join(', ') || 'none'}`,
      };
    }
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase B — Fence facts ──────────────────────────────────

/**
 * Dirty-tree refusal: mirror src/core/dry-fix.ts behavior. Refuses to
 * write if any source's local_path has uncommitted changes. Dry-run
 * skips this check (no writes happen anyway).
 */
function isLocalPathDirty(localPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', localPath, 'status', '--porcelain', '--', '.'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    // Not a git repo OR git not on PATH → treat as "not dirty" (the
    // user opted out of git tracking, which is allowed). The fence
    // writes are still atomic via .tmp + rename.
    return false;
  }
}

/**
 * Fence every unfenced row through the shared core pass
 * (`src/core/facts/unfenced-facts.ts`, also run by the extract_facts cycle
 * phase). The migration adds only its dirty-tree refusal on unmanaged
 * sources, so the user can review the diff before committing.
 */
async function phaseBFenceFacts(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (!engine) {
    return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
  }

  try {
    const plan = await planUnfencedFacts(engine);
    const { outcome } = plan;

    if (opts.dryRun) {
      return {
        name: 'fence_facts', status: 'skipped',
        detail: `dry-run: would fence ${fenceableRowCount(plan)} rows; ${outcome.skipped_no_entity} unfenceable (NULL entity_slug); ` +
          `skipped_no_page=${outcome.skipped_no_page} skipped_no_local_path=${outcome.skipped_no_local_path}`,
      };
    }

    if (!plan.managed) {
      // Dirty-tree refusal: check ONLY the sources we are about to write
      // into. A dirty tree in an unrelated source (or zero fenceable rows
      // at all) must not block a no-op or a targeted backfill (#927).
      const targetSourceIds = new Set([...plan.groups.keys()].map(k => k.split('\0')[0]));
      for (const id of targetSourceIds) {
        const localPath = plan.localPathById.get(id);
        if (localPath && isLocalPathDirty(localPath)) {
          return {
            name: 'fence_facts',
            status: 'failed',
            detail: `source "${id}" has uncommitted changes in ${localPath}. Commit or stash, then re-run.`,
          };
        }
      }
    }

    try { await fenceUnfencedFacts(engine, plan); }
    catch (error) {
      if (!(error instanceof OperationError) || error.code !== 'queue_capacity') throw error;
      return { name: 'fence_facts', status: 'failed', detail: `queue_capacity: ${error.message} ${error.suggestion ?? ''}`.trim() };
    }
    return fenceFactsResult(outcome);
  } catch (e) {
    return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

function fenceFactsResult(outcome: UnfencedFactsOutcome): OrchestratorPhaseResult {
  const detail = `scanned=${outcome.scanned} fenced=${outcome.fenced} ` +
    `pages=${outcome.pages_touched} skipped_no_entity=${outcome.skipped_no_entity} ` +
    `skipped_no_local_path=${outcome.skipped_no_local_path} skipped_no_page=${outcome.skipped_no_page}` +
    (outcome.skipped_archived > 0 ? ` skipped_archived=${outcome.skipped_archived}` : '') +
    (outcome.failed_pages.length > 0 ? ` failed=${outcome.failed_pages.length}` : '');
  if (outcome.failed_pages.length > 0) {
    // The same `FACTS_FENCE_FAILED: <slug> (<reason>)` token the extract_facts
    // cycle phase prints, so an unadoptable row reads the same in both outputs.
    const failed = outcome.failed_pages.map(page => `FACTS_FENCE_FAILED: ${page}`);
    return {
      name: 'fence_facts',
      status: 'failed',
      detail: `${detail} :: ${failed.slice(0, 3).join(' | ')}${failed.length > 3 ? '...' : ''}`,
    };
  }
  return { name: 'fence_facts', status: 'complete', detail };
}

interface SourceLookup {
  id: string;
  local_path: string | null;
}

// ── Phase C — Verify ────────────────────────────────────────

/** Row numbers a drift detail names per side before it summarizes the rest. */
const DRIFT_ROWS_SHOWN = 5;

function listDriftRows(rows: number[]): string {
  const shown = rows.slice(0, DRIFT_ROWS_SHOWN).join(', ');
  return rows.length > DRIFT_ROWS_SHOWN ? `${shown}, +${rows.length - DRIFT_ROWS_SHOWN} more` : shown;
}

async function phaseCVerify(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'verify', status: 'skipped', detail: 'no_brain_configured' };

  try {
    // Per touched page (= any page with a fenced row in the DB), re-parse
    // the fence (the canonical file, or the database copy on a managed
    // brain) and compare its row numbers to the DB's.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);

    // Conversation-miner rows stamp row_num without a ## Facts fence
    // (chat-log shape is the source of truth). Same cli: exclusion as
    // extract_facts reconciliation. Counting them here fails every brain
    // that ran extract-conversation-facts.
    const groups = await engine.executeRaw<{ source_id: string; source_markdown_slug: string; row_nums: number[] }>(
      `SELECT source_id, source_markdown_slug, array_agg(row_num ORDER BY row_num) AS row_nums
         FROM facts
        WHERE row_num IS NOT NULL
          AND COALESCE(source, '') NOT LIKE 'cli:%'
        GROUP BY source_id, source_markdown_slug`,
    );

    const mismatches: string[] = [];
    let pagesChecked = 0;
    // Managed brains publish the fence through the coordinator, which writes
    // the canonical file in the same publication; the database copy is the
    // one every managed page has, database-only pages included.
    const managed = await managedPersistenceEnabled(engine);

    for (const g of groups) {
      let body: string;
      if (managed) {
        const snapshot = await engine.readPageSnapshot(g.source_markdown_slug, { sourceId: g.source_id });
        if (!snapshot) {
          mismatches.push(`${g.source_markdown_slug} (page missing)`);
          continue;
        }
        body = serializePageToMarkdown(snapshot.page, snapshot.tags);
      } else {
        const localPath = localPathById.get(g.source_id);
        if (!localPath) continue;
        const target = await resolvePageWriteTarget(engine, g.source_markdown_slug, g.source_id);
        if (!target.ok || !existsSync(target.filePath)) {
          mismatches.push(`${g.source_markdown_slug} (file missing)`);
          continue;
        }
        body = readFileSync(target.filePath, 'utf-8');
      }
      const parsed = parseFactsFence(body);
      const indexed = new Set(g.row_nums.map(Number));
      const fenced = new Set(parsed.facts.map(f => f.rowNum));
      // #5814: a duplicate active row may be absent from the index.
      // extract_facts indexes it once (#1781) while the managed publication
      // projection indexes every fence row, so both states are in sync.
      const duplicates = duplicateActiveFenceRows(parsed.facts);
      const notIndexed = [...fenced].filter(n => !indexed.has(n) && !duplicates.has(n)).sort((a, b) => a - b);
      const notInFence = [...indexed].filter(n => !fenced.has(n)).sort((a, b) => a - b);
      if (notIndexed.length > 0 || notInFence.length > 0) {
        const missing = [
          notIndexed.length > 0 ? `not indexed: ${listDriftRows(notIndexed)}` : '',
          notInFence.length > 0 ? `not in fence: ${listDriftRows(notInFence)}` : '',
        ].filter(Boolean).join('; ');
        mismatches.push(`${g.source_markdown_slug} (fence=${parsed.facts.length}, db=${indexed.size}; ${missing})`);
      }
      pagesChecked += 1;
    }

    if (mismatches.length > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${mismatches.length} pages drifted: ${mismatches.slice(0, 3).join(' | ')}${mismatches.length > 3 ? '...' : ''}`,
      };
    }
    return { name: 'verify', status: 'complete', detail: `pages_checked=${pagesChecked}` };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.32.2 — facts join the system-of-record invariant ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const engine = await getEngine();
  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(engine, opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const b = await phaseBFenceFacts(engine, opts);
  phases.push(b);
  if (b.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const c = await phaseCVerify(engine, opts);
  phases.push(c);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'partial' : 'complete';

  return finalizeResult(phases, overallStatus, engine);
}

function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
  engine: BrainEngine | null,
): OrchestratorResult {
  // Best-effort disconnect of the engine we created. testEngineOverride
  // is owned by the test, never disconnected here.
  if (engine && !testEngineOverride) {
    engine.disconnect().catch(() => { /* best-effort */ });
  }
  return {
    version: '0.32.2',
    status,
    phases,
  };
}

export const v0_32_2: Migration = {
  version: '0.32.2',
  fresh_install_noop: true,
  featurePitch: {
    headline: 'Facts join the system-of-record — your hot memory now lives in markdown, indexed by the DB',
    description:
      'v0.31 added hot-memory facts but they lived only in the database. v0.32.2 makes the ' +
      'fenced `## Facts` table on each entity page canonical: every new fact writes to markdown ' +
      'first, then stamps the DB index. Existing v0.31 facts are backfilled to fences on this ' +
      'migration. `gbrain rebuild` (v0.32.3) becomes a one-line disaster-recovery flow because ' +
      'the DB is now fully derivable from the repo. Migration is dry-run by default; pass ' +
      '`--write` to apply.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBFenceFacts,
  phaseCVerify,
  isLocalPathDirty,
};

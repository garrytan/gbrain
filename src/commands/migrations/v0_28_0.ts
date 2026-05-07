/**
 * v0.28.0 migration orchestrator — Takes + Think + Unified Model Config.
 *
 * v0.28 ships the typed/weighted/attributed claims layer, a unified model
 * configuration resolver, and a per-token MCP allow-list for take visibility.
 *
 * Phases (all idempotent, additive):
 *   A. Schema     — verify migrations v37 + v38 already applied (the schema
 *                   runner in src/core/migrate.ts does the actual DDL during
 *                   `gbrain upgrade`/initSchema). This phase asserts post-condition.
 *   B. Backfill   — submit `gbrain extract takes` as a Minion job so any
 *                   pre-existing fenced takes tables in markdown populate the
 *                   takes table without blocking the foreground upgrade.
 *                   Falls back to inline run on PGLite (no Minion worker).
 *   C. Re-chunk   — emit a pending-host-work TODO for `gbrain re-chunk
 *                   --where pages-with-takes` (Codex P0 #3 fix: pages with
 *                   pre-v0.28 chunks still contain the fenced takes content;
 *                   the chunker strip only applies to NEW imports). Re-chunk
 *                   is heavy + per-page-disruptive, so we queue a TODO instead
 *                   of running it inline.
 *   D. Record     — runner-owned ledger write (handled by apply-migrations.ts).
 *
 * No content mutation. No data loss. Operator runs `gbrain doctor` after
 * upgrade to verify takes_backfill_complete + takes_fence_chunk_leak checks.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig, gbrainPath } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

function migrationsDir(): string { return gbrainPath('migrations'); }
function pendingHostWorkPath(): string { return join(migrationsDir(), 'pending-host-work.jsonl'); }

interface PendingHostWorkEntry {
  migration: string;
  ts: string;
  skill: string;
  reason: string;
  command: string;
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
    if (v < 38) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected schema version >= 38 (takes + access_tokens.permissions); got ${v}. Run \`gbrain apply-migrations --yes\` to apply.`,
      };
    }
    // Quick post-condition: takes + synthesis_evidence tables exist
    const rows = await engine.executeRaw<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE tablename IN ('takes', 'synthesis_evidence')`,
    );
    if (rows.length < 2) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected tables takes + synthesis_evidence; found ${rows.map(r => r.tablename).join(', ') || 'none'}`,
      };
    }
    return { name: 'schema', status: 'complete', detail: 'schema v38 applied; takes + synthesis_evidence present' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase B — Backfill takes ───────────────────────────────

async function phaseBBackfill(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'backfill', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'backfill', status: 'skipped', detail: 'no_brain_configured' };

  try {
    // Inline run on both engines for v0.28.0 simplicity. Larger brains can run
    // `gbrain extract takes --rebuild` later; the migration's job is to get
    // the table populated for upgrade-time doctor checks.
    const { extractTakes } = await import('../../core/cycle/extract-takes.ts');
    const result = await extractTakes(engine, { source: 'db' });
    return {
      name: 'backfill',
      status: 'complete',
      detail: `extract-takes scanned ${result.pagesScanned} pages; ${result.pagesWithTakes} had fenced takes; upserted ${result.takesUpserted} rows`,
    };
  } catch (e) {
    return { name: 'backfill', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase C — Re-chunk TODO ────────────────────────────────

function existingHostEntries(version: string, key: string): boolean {
  const p = pendingHostWorkPath();
  if (!existsSync(p)) return false;
  try {
    const raw = readFileSync(p, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as PendingHostWorkEntry & { _key?: string };
        if (obj.migration === version && obj._key === key) return true;
      } catch { /* skip */ }
    }
  } catch { /* read error */ }
  return false;
}

function phaseCRechunkTodo(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'rechunk-todo', status: 'skipped', detail: 'dry-run' };
  const key = 'rechunk-pages-with-takes';
  if (existingHostEntries('0.28.0', key)) {
    return { name: 'rechunk-todo', status: 'complete', detail: 'already queued' };
  }
  try {
    mkdirSync(migrationsDir(), { recursive: true });
    const entry = {
      migration: '0.28.0',
      ts: new Date().toISOString(),
      skill: 'skills/migrations/v0.28.0.md',
      reason: 'Pages with pre-v0.28 chunks still contain fenced takes content. Re-chunk so the new chunker strip rule is applied (Codex P0 #3 fix).',
      command: "gbrain extract takes --rebuild  # forces re-chunk via reimport pipeline; see migration doc for the precise sweep command in your env",
      _key: key,
    };
    appendFileSync(pendingHostWorkPath(), JSON.stringify(entry) + '\n');
    return {
      name: 'rechunk-todo',
      status: 'complete',
      detail: `queued re-chunk TODO at ${pendingHostWorkPath()} (read skills/migrations/v0.28.0.md for the playbook)`,
    };
  } catch (e) {
    return { name: 'rechunk-todo', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ───────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.28.0 — Takes + Think + Unified Model Config ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  // Acquire engine for phases that need it. Skip cleanly when none configured.
  let engine: BrainEngine | null = null;
  let ownsEngine = false;
  try {
    if (testEngineOverride) {
      engine = testEngineOverride;
    } else {
      const config = loadConfig();
      if (config) {
        const engineConfig = toEngineConfig(config);
        engine = await createEngine(engineConfig);
        await engine.connect(engineConfig);
        ownsEngine = true;
      }
    }

    phases.push(await phaseASchema(engine, opts));
    if (phases[0].status === 'failed') {
      return { version: '0.28.0', status: 'partial', phases };
    }

    phases.push(await phaseBBackfill(engine, opts));
    phases.push(phaseCRechunkTodo(opts));
  } finally {
    if (ownsEngine && engine) {
      try { await engine.disconnect(); } catch { /* ignore */ }
    }
  }

  const overallStatus: 'complete' | 'partial' | 'failed' =
    phases.some(p => p.status === 'failed') ? 'partial' : 'complete';

  return { version: '0.28.0', status: overallStatus, phases };
}

export const v0_28_0: Migration = {
  version: '0.28.0',
  featurePitch: {
    headline: "Takes ship — your brain finally captures what you BELIEVE, not just what's true",
    description:
      'v0.28 adds the takes layer: typed/weighted/attributed claims (fact/take/bet/hunch) ' +
      'stored as fenced markdown tables on every page, indexed in Postgres for fast queries. ' +
      'Plus `gbrain takes` CLI (list/search/add/update/supersede/resolve), unified model config ' +
      '(`models.default` replaces every per-phase config key), per-token MCP allow-list for ' +
      'visibility (private hunches stay private), and three new MCP ops (takes_list, takes_search, ' +
      'think). `gbrain think` op surface lands now; the synthesis pipeline lands incrementally in ' +
      'v0.28.x. Migration backfills takes from any pre-existing fenced markdown tables; queues a ' +
      're-chunk TODO so the chunker-strip rule (Codex P0 fix — keeps takes content out of page ' +
      'chunks where the per-token allow-list cannot reach) catches up on legacy pages.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBBackfill,
  phaseCRechunkTodo,
  pendingHostWorkPath,
};

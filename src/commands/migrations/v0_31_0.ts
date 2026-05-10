/**
 * v0.31.0 migration orchestrator — Hot Memory: Cross-Session Facts.
 *
 * v0.31 ships a real-time working-memory layer alongside takes. Every
 * conversation turn extracts facts via a cheap LLM (Haiku) into a hot
 * `facts` table. The dream cycle's new `consolidate` phase promotes
 * clusters of facts into `takes(kind='fact')` overnight; facts become
 * the audit trail (never deleted).
 *
 * Phases (idempotent, additive):
 *   A. Schema     — verify migration v45 is applied (the schema runner
 *                   in src/core/migrate.ts does the actual DDL during
 *                   `gbrain upgrade`/initSchema). Asserts post-condition.
 *   B. Record     — runner-owned ledger write (handled by apply-migrations.ts).
 *
 * No content mutation. No data loss. Operator runs `gbrain doctor` after
 * upgrade to verify the `facts_health` check is green.
 */

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

// ── Phase A — Schema verify ────────────────────────────────

async function phaseASchema(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'schema', status: 'skipped', detail: 'no_brain_configured' };
  try {
    const versionStr = await engine.getConfig('version');
    const v = parseInt(versionStr || '0', 10);
    if (v < 45) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected schema version >= 45 (facts hot memory); got ${v}. Run \`gbrain apply-migrations --yes\` to apply.`,
      };
    }
    // Post-condition: facts table exists.
    const rows = await engine.executeRaw<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE tablename = 'facts'`,
    );
    if (rows.length === 0) {
      return {
        name: 'schema',
        status: 'failed',
        detail: 'expected facts table; not found. Re-run apply-migrations.',
      };
    }
    return { name: 'schema', status: 'complete', detail: 'schema v40 applied; facts table present' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ───────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('=== v0.31.0 — Hot Memory: Cross-Session Facts ===');
  if (opts.dryRun) {
    // eslint-disable-next-line no-console
    console.log('  (dry-run; no side effects)');
  }
  // eslint-disable-next-line no-console
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

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
  } finally {
    if (ownsEngine && engine) {
      try { await engine.disconnect(); } catch { /* ignore */ }
    }
  }

  const overallStatus: 'complete' | 'partial' | 'failed' =
    phases.some(p => p.status === 'failed') ? 'partial' : 'complete';

  return { version: '0.31.0', status: overallStatus, phases };
}

export const v0_31_0: Migration = {
  version: '0.31.0',
  featurePitch: {
    headline: 'Hot memory ships — your brain remembers what you said today, across sessions',
    description:
      'v0.31 adds a real-time working-memory layer. Every substantive conversation turn ' +
      "extracts facts (events, preferences, commitments, beliefs) into a hot `facts` " +
      'table via a cheap Haiku pass folded into signal-detector. `gbrain recall` queries ' +
      'them by entity / session / recency / kind. The agent automatically sees relevant ' +
      'hot memory at conversation time via the MCP `_meta.brain_hot_memory` channel. ' +
      "The dream cycle's new 10th phase `consolidate` clusters related facts and promotes " +
      "them into durable `takes(kind='fact')` overnight; facts stay as the audit trail. " +
      'Per-source isolation, per-token visibility filtering (private/world), pgvector ' +
      'HALFVEC where supported. Cross-session ship gate: insert a fact in one chat ' +
      'session, recall it from another session hours later — the brain remembers.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
};

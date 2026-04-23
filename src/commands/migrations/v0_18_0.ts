/**
 * v0.18.0 migration orchestrator — Multi-source brains.
 *
 * Split across sub-versions of the migration registry for safety:
 *   - v16 (Step 1 / Lane A): additive-only. Installs sources table +
 *     default row. Does NOT break any existing engine code.
 *   - v17 (Step 2 / Lane B, future): breaking schema changes. Rides with
 *     the engine API rewrite so ON CONFLICT (source_id, slug) lands
 *     atomically with the composite UNIQUE.
 *
 * Phase structure (per /plan-ceo-review + /plan-eng-review):
 *   A. Schema — gbrain init --migrate-only runs the migration chain up
 *      to whichever v-prefix has shipped (v16 today, v17 next).
 *   B. Storage backfill (Step 7, future) — ledger-driven object rewrite.
 *   C. Verify — assert sources('default') exists today. Composite UNIQUE,
 *      page_id backfill, and ledger completeness get added in Step 2.
 *   D. (future) Delete old storage objects — only runs after C green.
 *
 * Idempotent: safe to re-run on partial state.
 */

import { execSync } from 'child_process';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { appendCompletedMigration } from '../../core/preferences.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';

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

// ── Phase B — Storage backfill (skeleton, filled by Step 7) ──

async function phaseBBackfillStorage(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'backfill_storage', status: 'skipped', detail: 'dry-run' };
  try {
    const config = loadConfig();
    if (!config) return { name: 'backfill_storage', status: 'skipped', detail: 'no brain configured' };

    const engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    try {
      if (engine.kind === 'pglite') {
        return { name: 'backfill_storage', status: 'skipped', detail: 'pglite (no files table)' };
      }
      const hasLedger = await engine.executeRaw<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = current_schema()
                          AND table_name = 'file_migration_ledger') AS exists`,
      );
      if (!hasLedger[0]?.exists) {
        return {
          name: 'backfill_storage',
          status: 'skipped',
          detail: 'file_migration_ledger not yet installed (run apply-migrations first)',
        };
      }

      // Ledger exists. If storage isn't configured, run the dry-run
      // path — we can still report the ledger state but we can't
      // COPY objects. Operator then wires storage and re-runs.
      const storage = config.storage ? await loadStorageBackend(config.storage) : null;

      const { runStorageBackfill } = await import('./v0_18_0-storage-backfill.ts');
      const report = await runStorageBackfill(engine, storage, { dryRun: !storage });

      if (report.total === 0) {
        return { name: 'backfill_storage', status: 'complete', detail: 'no files to migrate' };
      }

      if (report.failed > 0) {
        return {
          name: 'backfill_storage',
          status: 'failed',
          detail: `${report.failed}/${report.total} files failed: ${report.errors.slice(0, 3).map(e => `#${e.file_id}: ${e.error.slice(0, 60)}`).join('; ')}`,
        };
      }

      if (report.skipped > 0 && !storage) {
        return {
          name: 'backfill_storage',
          status: 'skipped',
          detail: `${report.skipped}/${report.total} files pending; storage backend not configured (wire storage + re-run)`,
        };
      }

      const detail = `${report.total} files: ${report.alreadyComplete} already complete, ${report.nowComplete} newly migrated`;
      return { name: 'backfill_storage', status: 'complete', detail };
    } finally {
      try { await engine.disconnect(); } catch {}
    }
  } catch (e) {
    return {
      name: 'backfill_storage',
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function loadStorageBackend(storageConfig: unknown): Promise<import('../../core/storage.ts').StorageBackend | null> {
  try {
    const { createStorage } = await import('../../core/storage.ts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await createStorage(storageConfig as any);
  } catch {
    return null;
  }
}

// ── Phase C — Verify ────────────────────────────────────────

async function phaseCVerify(opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  try {
    const config = loadConfig();
    if (!config) return { name: 'verify', status: 'skipped', detail: 'no brain configured' };

    const engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    try {
      // 1. sources('default') exists (Step 1 / v16).
      const defaults = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE id = 'default'`,
      );
      if (defaults.length !== 1) {
        return { name: 'verify', status: 'failed', detail: "sources('default') row missing" };
      }

      // Step 2 checks (composite UNIQUE, links.resolution_type,
      // file_migration_ledger completion) are gated on the future v17
      // migration. They run conditionally — if the column/constraint
      // exists, verify it; if not, that's fine for Step 1.

      // Optional: composite UNIQUE if installed (Step 2 future work).
      const constraint = await engine.executeRaw<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname = 'pages_source_slug_key'`,
      );
      // If installed, verify no pages have NULL source_id.
      if (constraint.length === 1) {
        const nullSources = await engine.executeRaw<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM pages WHERE source_id IS NULL`,
        );
        if ((nullSources[0]?.n ?? 0) > 0) {
          return { name: 'verify', status: 'failed', detail: `${nullSources[0].n} pages with NULL source_id` };
        }
      }

      return { name: 'verify', status: 'complete', detail: 'sources primitive installed' };
    } finally {
      try { await engine.disconnect(); } catch {}
    }
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.18.0 — Multi-source brains ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalize(phases, 'failed');

  const b = await phaseBBackfillStorage(opts);
  phases.push(b);
  // Phase B 'failed' is currently expected until Step 7 lands the storage
  // loader. Continue to verify so users see the exact gap.

  const c = await phaseCVerify(opts);
  phases.push(c);

  // a.status === 'failed' already early-returned on line 179, so only
  // c and b determine the final status here. TypeScript narrowing rejects
  // a redundant a.status === 'failed' check.
  const status: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'failed' :
    b.status === 'failed' ? 'partial' :
    'complete';

  return finalize(phases, status);
}

function finalize(phases: OrchestratorPhaseResult[], status: 'complete' | 'partial' | 'failed'): OrchestratorResult {
  if (status !== 'failed') {
    try {
      appendCompletedMigration({
        version: '0.18.0',
        completed_at: new Date().toISOString(),
        status: status as 'complete' | 'partial',
        phases: phases.map(p => ({ name: p.name, status: p.status })),
      });
    } catch {
      // Best-effort.
    }
  }
  return { version: '0.18.0', status, phases };
}

export const v0_18_0: Migration = {
  version: '0.18.0',
  featurePitch: {
    headline: 'Multi-source brains: one database, many knowledge repos. Federation flag keeps them from polluting each other.',
    description:
      'v0.18.0 introduces sources — a first-class primitive that lets one gbrain backend hold ' +
      'multiple repos (wiki, gstack, yc-media, etc.) with clean scoping. Every page, file, and ' +
      'ingest_log row is now scoped to a source. Cross-source search is opt-in per source ' +
      '(federated=true) so isolated content (yc-media, garrys-list) never bleeds into your main ' +
      'brain. New commands: `gbrain sources add/attach/import-from-github`. Per-directory ' +
      'default via .gbrain-source dotfile + GBRAIN_SOURCE env var. See docs/guides/' +
      'multi-source-brains.md.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBBackfillStorage,
  phaseCVerify,
};

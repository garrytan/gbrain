/**
 * v0.13.0 migration — grandfather `validate: false` onto existing pages.
 *
 * The Knowledge Runtime BrainWriter ships pre-commit citation / link /
 * back-link / triple-HR validators. A fresh brain passes them trivially.
 * An existing brain with years of accumulated pages does NOT — legitimate
 * pages without strict citation formatting exist all over the place.
 *
 * This migration walks every page and adds `validate: false` to frontmatter
 * where the field isn't already present. Pages with that flag bypass the
 * validators entirely, so strict-mode rollout doesn't break existing
 * content. `gbrain integrity --auto` clears the flag per-page as it writes
 * proper citations.
 *
 * Idempotency: pages that already have `validate: false` or `validate: true`
 * are skipped. Running twice is a no-op on the second pass.
 *
 * Reversibility: every page touched is logged to
 * ~/.gbrain/migrations/v0_13_1-rollback.jsonl with its pre-migration
 * frontmatter snapshot. Roll back by re-applying those snapshots via
 * `gbrain apply-migrations --rollback v0.13.0` (future CLI; not in scope).
 *
 * Scale: on a 30K-page brain, ~15s on Postgres, ~30s on PGLite. Batched in
 * chunks of 100 with a commit per batch so interruption losses are bounded.
 *
 * Snapshot-slugs rule: reads engine.getAllSlugs() upfront into an in-memory
 * Set before iterating. Prior learning [listpages-pagination-mutation]: any
 * batch write that mutates updated_at during OFFSET pagination is unstable.
 * getAllSlugs returns a full snapshot that isn't invalidated by our writes.
 *
 * Safety: does NOT call saveConfig. Prior learning [gbrain-init-default-pglite-flip]:
 * bare `gbrain init` defaults to PGLite and overwrites Postgres config.
 * This migration uses the standalone engine-factory flow with the existing
 * config; it never writes config.
 */

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { loadConfig, toEngineConfig, gbrainPath } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import type { BrainEngine } from '../../core/engine.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts).

// Lazy: GBRAIN_HOME may be set after module load.
const getRollbackDir = () => gbrainPath('migrations');
const getRollbackFile = () => join(getRollbackDir(), 'v0_13_1-rollback.jsonl');
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Phase A — connect (no config write)
// ---------------------------------------------------------------------------

async function phaseAConnect(opts: OrchestratorOpts): Promise<{ result: OrchestratorPhaseResult; engine: BrainEngine | null }> {
  if (opts.dryRun) {
    return { result: { name: 'connect', status: 'skipped', detail: 'dry-run' }, engine: null };
  }
  try {
    const config = loadConfig();
    if (!config) {
      return {
        result: { name: 'connect', status: 'skipped', detail: 'no brain configured (run gbrain init first)' },
        engine: null,
      };
    }
    const engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    return { result: { name: 'connect', status: 'complete' }, engine };
  } catch (e) {
    return {
      result: { name: 'connect', status: 'failed', detail: e instanceof Error ? e.message : String(e) },
      engine: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Phase B — snapshot slugs upfront
// ---------------------------------------------------------------------------

async function phaseBSnapshot(engine: BrainEngine): Promise<{ result: OrchestratorPhaseResult; slugs: string[] }> {
  try {
    const slugSet = await engine.getAllSlugs();
    const slugs = [...slugSet].sort();
    return {
      result: { name: 'snapshot', status: 'complete', detail: `${slugs.length} slugs` },
      slugs,
    };
  } catch (e) {
    return {
      result: { name: 'snapshot', status: 'failed', detail: e instanceof Error ? e.message : String(e) },
      slugs: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Phase C — grandfather: add validate:false where absent
// ---------------------------------------------------------------------------

interface GrandfatherResult {
  touched: number;
  skipped: number;
  failed: number;
  failures: string[];
}

async function phaseCGrandfather(
  engine: BrainEngine,
  slugs: string[],
  opts: OrchestratorOpts,
): Promise<{ result: OrchestratorPhaseResult; detail: GrandfatherResult }> {
  ensureRollbackDir();
  const gf: GrandfatherResult = { touched: 0, skipped: 0, failed: 0, failures: [] };

  for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
    const batch = slugs.slice(i, i + BATCH_SIZE);
    for (const slug of batch) {
      try {
        const page = await engine.getPage(slug);
        if (!page) { gf.skipped++; continue; }

        // Idempotency: skip if frontmatter already has a `validate` key
        // (whether true, false, or any other value). We don't flip existing
        // explicit settings.
        if (page.frontmatter && Object.prototype.hasOwnProperty.call(page.frontmatter, 'validate')) {
          gf.skipped++;
          continue;
        }

        if (opts.dryRun) {
          gf.touched++;
          continue;
        }

        // Rollback log BEFORE mutation, so a crash mid-write still lets us
        // revert. Append-only, one line per page, newline-terminated.
        appendRollbackEntry({
          slug,
          pre_frontmatter: page.frontmatter ?? {},
        });

        const nextFrontmatter = { ...(page.frontmatter ?? {}), validate: false };
        await engine.putPage(slug, {
          type: page.type,
          title: page.title,
          compiled_truth: page.compiled_truth,
          timeline: page.timeline,
          frontmatter: nextFrontmatter,
        });
        gf.touched++;
      } catch (e) {
        gf.failed++;
        const msg = e instanceof Error ? e.message : String(e);
        gf.failures.push(`${slug}: ${msg.slice(0, 100)}`);
      }
    }
  }

  const status: OrchestratorPhaseResult['status'] =
    gf.failed > 0 ? 'failed' : 'complete';
  const detailStr = `touched=${gf.touched} skipped=${gf.skipped} failed=${gf.failed}`;
  return {
    result: { name: 'grandfather', status, detail: detailStr },
    detail: gf,
  };
}

// ---------------------------------------------------------------------------
// Phase D — verify
// ---------------------------------------------------------------------------

async function phaseDVerify(engine: BrainEngine, expectedTouched: number): Promise<OrchestratorPhaseResult> {
  if (expectedTouched === 0) {
    return { name: 'verify', status: 'complete', detail: 'nothing to verify' };
  }
  try {
    // Count pages whose frontmatter has `validate` = false via raw SQL.
    const rows = await engine.executeRaw<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM pages WHERE (frontmatter->>'validate')::text = 'false'",
    );
    const count = rows[0]?.count ?? 0;
    const n = typeof count === 'string' ? parseInt(count, 10) : Number(count);
    return {
      name: 'verify',
      status: n >= expectedTouched ? 'complete' : 'failed',
      detail: `pages with validate=false: ${n} (expected >= ${expectedTouched})`,
    };
  } catch (e) {
    return {
      name: 'verify',
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const phases: OrchestratorPhaseResult[] = [];
  let filesRewritten = 0;

  const { result: connectRes, engine } = await phaseAConnect(opts);
  phases.push(connectRes);
  if (connectRes.status !== 'complete' || !engine) {
    return {
      version: '0.13.1',
      status: connectRes.status === 'skipped' ? 'partial' : 'failed',
      phases,
    };
  }

  try {
    const { result: snapRes, slugs } = await phaseBSnapshot(engine);
    phases.push(snapRes);
    if (snapRes.status !== 'complete') {
      return { version: '0.13.1', status: 'failed', phases };
    }

    const { result: gfRes, detail: gfDetail } = await phaseCGrandfather(engine, slugs, opts);
    phases.push(gfRes);
    filesRewritten = gfDetail.touched;

    if (!opts.dryRun) {
      const verifyRes = await phaseDVerify(engine, gfDetail.touched);
      phases.push(verifyRes);
    }

    const anyFailed = phases.some(p => p.status === 'failed');
    const status: OrchestratorResult['status'] = anyFailed ? 'partial' : 'complete';

    // Bug 3 — ledger write lives in the runner now.

    return {
      version: '0.13.1',
      status,
      phases,
      files_rewritten: filesRewritten,
    };
  } finally {
    try { await engine.disconnect(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureRollbackDir(): void {
  const dir = getRollbackDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function appendRollbackEntry(entry: { slug: string; pre_frontmatter: Record<string, unknown> }): void {
  const line = JSON.stringify({
    migration: 'v0.13.0',
    timestamp: new Date().toISOString(),
    ...entry,
  }) + '\n';
  appendFileSync(getRollbackFile(), line, 'utf-8');
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const v0_13_1: Migration = {
  version: '0.13.1',
  featurePitch: {
    headline: 'BrainWriter integrity + grandfather protection for existing pages.',
    description:
      'Adds `validate: false` to existing pages so the new Knowledge Runtime ' +
      'validators (citation / link / back-link / triple-HR) don’t reject legacy ' +
      'content. Pages keep passing writes through unchanged; `gbrain integrity ' +
      '--auto` clears the flag per-page once citations are repaired. Rollback ' +
      'log at ~/.gbrain/migrations/v0_13_1-rollback.jsonl.',
  },
  orchestrator,
};

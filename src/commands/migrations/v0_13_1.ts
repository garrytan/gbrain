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
 * Scale (v0.41.37.0 #1581): chunked bulk SQL — one id-snapshot SELECT + N
 * (SELECT-for-rollback + UPDATE) statements of CHUNK_SIZE rows each. Completes
 * in ~1-2s even on an 82K-page PGLite brain. The prior per-page
 * getPage+putPage loop hung CPU-bound for 70+ min on that brain (#1581).
 *
 * Snapshot rule: the affected id set is read once via SQL up front. It isn't
 * invalidated by our writes because each UPDATE flips its rows out of the
 * GRANDFATHER_WHERE predicate (idempotent + resumable).
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
// Phase C — grandfather: add validate:false where absent
//
// v0.41.37.0 #1581: rewritten from a per-page getPage+putPage loop (which hung
// CPU-bound for 70+ min on an 82K-page PGLite brain) to a CHUNKED bulk SQL
// pass. Three correctness properties (the per-page loop and a naive single
// bulk UPDATE both got these wrong):
//   1. Keyed on pages.id (globally unique PK), NOT slug. `slug` uniqueness is
//      (source_id, slug) — a slug-batched UPDATE would mutate same-slug pages
//      across other sources and produce ambiguous rollback rows.
//   2. Filters `deleted_at IS NULL` — the old getPage path hid soft-deleted
//      rows; a raw UPDATE must not grandfather tombstones.
//   3. Chunked in CHUNK_SIZE batches so lock-hold stays bounded (the
//      DELETE_BATCH_SIZE convention) instead of one giant transaction.
// The rollback log carries source identity ({id, slug, source_id,
// pre_frontmatter}) so a rollback is unambiguous across sources.
// ---------------------------------------------------------------------------

// Filter for pages still needing the grandfather flag. Literal `?` jsonb
// existence operator (matches src/core/embed-skip.ts convention); 'validate'
// is a hardcoded literal, no injection surface. COALESCE for null-frontmatter
// safety. deleted_at IS NULL skips soft-deleted tombstones.
const GRANDFATHER_WHERE =
  "NOT (COALESCE(frontmatter, '{}'::jsonb) ? 'validate') AND deleted_at IS NULL";

// Per-chunk row count. Bounded lock-hold + write-amplification per statement
// (same rationale as engine-constants.ts DELETE_BATCH_SIZE).
const CHUNK_SIZE = 1000;

interface GrandfatherResult {
  touched: number;
  skipped: number;
  failed: number;
  failures: string[];
}

// Exported for direct hermetic testing against a PGLite engine (the config /
// loadConfig flow is exercised separately). Internal helper otherwise.
export async function phaseCGrandfather(
  engine: BrainEngine,
  opts: OrchestratorOpts,
): Promise<{ result: OrchestratorPhaseResult; detail: GrandfatherResult }> {
  const gf: GrandfatherResult = { touched: 0, skipped: 0, failed: 0, failures: [] };

  try {
    if (opts.dryRun) {
      const rows = await engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM pages WHERE ${GRANDFATHER_WHERE}`,
      );
      const c = rows[0]?.count ?? 0;
      gf.touched = typeof c === 'string' ? parseInt(c, 10) : Number(c);
      return {
        result: { name: 'grandfather', status: 'complete', detail: `would touch ${gf.touched} (dry-run)` },
        detail: gf,
      };
    }

    ensureRollbackDir();

    // Snapshot the affected id set up front (ids only — cheap, no frontmatter
    // blobs in memory). The snapshot isn't invalidated by our writes because
    // each UPDATE flips the rows out of the GRANDFATHER_WHERE predicate.
    const idRows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE ${GRANDFATHER_WHERE} ORDER BY id`,
    );
    const ids = idRows.map(r => Number(r.id));

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      try {
        // Rollback log BEFORE mutation: one SELECT per chunk (bounded memory),
        // one appendFileSync per chunk. Carries source_id so rollback is
        // unambiguous across same-slug-different-source pages.
        const snap = await engine.executeRaw<{
          id: number; slug: string; source_id: string | null; frontmatter: Record<string, unknown> | null;
        }>(
          'SELECT id, slug, source_id, frontmatter FROM pages WHERE id = ANY($1::int[])',
          [chunk],
        );
        appendRollbackBatch(snap);

        await engine.executeRaw(
          `UPDATE pages SET frontmatter = jsonb_set(COALESCE(frontmatter, '{}'::jsonb), '{validate}', 'false'::jsonb) ` +
          'WHERE id = ANY($1::int[])',
          [chunk],
        );
        gf.touched += chunk.length;
      } catch (e) {
        gf.failed += chunk.length;
        const msg = e instanceof Error ? e.message : String(e);
        gf.failures.push(`chunk@${i}: ${msg.slice(0, 100)}`);
      }
    }
  } catch (e) {
    gf.failed += 1;
    gf.failures.push(`grandfather: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
  }

  const status: OrchestratorPhaseResult['status'] = gf.failed > 0 ? 'failed' : 'complete';
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
    // v0.41.37.0 #1581: phaseBSnapshot (getAllSlugs) is gone — the chunked bulk
    // pass filters via SQL (GRANDFATHER_WHERE), so we no longer materialize a
    // full slug list in JS.
    const { result: gfRes, detail: gfDetail } = await phaseCGrandfather(engine, opts);
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

// v0.41.37.0 #1581: batch rollback writer. One appendFileSync per chunk, bounded
// memory. Each line carries id + slug + source_id so a rollback is unambiguous
// across same-slug-different-source pages (pages.slug is not globally unique).
function appendRollbackBatch(
  rows: ReadonlyArray<{ id: number; slug: string; source_id: string | null; frontmatter: Record<string, unknown> | null }>,
): void {
  if (rows.length === 0) return;
  const ts = new Date().toISOString();
  const lines = rows.map(r => JSON.stringify({
    migration: 'v0.13.0',
    timestamp: ts,
    id: r.id,
    slug: r.slug,
    source_id: r.source_id ?? 'default',
    pre_frontmatter: r.frontmatter ?? {},
  })).join('\n') + '\n';
  appendFileSync(getRollbackFile(), lines, 'utf-8');
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

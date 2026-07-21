#!/usr/bin/env bun
/**
 * tasks-41o — one-off, idempotent backfill for `pages.content_created_at`
 * (migration v125).
 *
 * The pglite→Postgres re-ingest (Jul 7-8) hit a latent bug: putPage()'s
 * INSERT never set created_at (DB default now()) and computeEffectiveDate
 * never read frontmatter.created, so every re-ingested row's effective_date
 * fell back to the row-insert timestamp instead of the content's real date.
 * The fix (migration v125 + effective-date.ts precedence chain) is already
 * additive-safe; this script is the one-off data repair that makes it visible
 * on EXISTING rows:
 *
 *   1. For every page where `content_created_at IS NULL` and
 *      `frontmatter->>'created'` is present, parse it with the same
 *      `parseDateLoose` the precedence chain uses and write it to
 *      `content_created_at`. NEVER touches `created_at` (row-insert time).
 *   2. Re-walk `effective_date` / `effective_date_source` for every page via
 *      the existing `backfillEffectiveDate` library (same code path
 *      `gbrain reindex-frontmatter` uses) so the newly-populated
 *      content_created_at immediately wins its precedence slot and search's
 *      effective_date reflects the real content date, not just the column.
 *
 * Idempotent: step 1 only touches rows where content_created_at IS NULL, so
 * a re-run after a partial failure or a later frontmatter fix picks up
 * exactly the delta. Step 2 reuses backfillEffectiveDate's own
 * no-op-on-equal guard (skips the UPDATE when the computed value already
 * matches), so re-running the whole script is always safe and cheap.
 *
 * Usage:
 *   bun run scripts/backfill-content-created-at.ts [--dry-run] [--slug-prefix P] [--json]
 *
 * --dry-run   Count what would change; no DB writes (either step).
 * --slug-prefix P   Scope step 1 to slugs starting with P (e.g. 'wiki/').
 *                   Step 2 (effective_date re-walk) always runs over ALL
 *                   pages regardless of this flag — it's cheap (no-op-on-equal)
 *                   and a partial content_created_at backfill from a prior
 *                   run should still get its effective_date corrected.
 * --json      Machine-readable result envelope on stdout.
 */

import type { BrainEngine } from '../src/core/engine.ts';
import { parseDateLoose } from '../src/core/effective-date.ts';
import { backfillEffectiveDate } from '../src/core/backfill-effective-date.ts';

const BATCH_SIZE = 500;

interface CandidateRow {
  id: number;
  slug: string;
  fm_created: string | null;
}

export interface ContentCreatedAtBackfillResult {
  examined: number;
  updated: number;
  skipped_unparseable: number;
  duration_sec: number;
}

/**
 * Step 1: populate content_created_at from frontmatter->>'created'.
 * Keyset-paginated (WHERE id > lastId), same shape as backfillEffectiveDate.
 */
export async function backfillContentCreatedAt(
  engine: BrainEngine,
  opts: { dryRun?: boolean; slugPrefix?: string } = {},
): Promise<ContentCreatedAtBackfillResult> {
  const start = Date.now();
  let lastId = 0;
  let examined = 0;
  let updated = 0;
  let skippedUnparseable = 0;

  const slugPrefix = opts.slugPrefix?.replace(/[\\%_]/g, (c) => '\\' + c) ?? null;

  while (true) {
    const slugFilter = slugPrefix ? `AND slug LIKE $2 ESCAPE '\\\\'` : '';
    const params: unknown[] = [lastId];
    if (slugPrefix) params.push(slugPrefix + '%');

    // frontmatter ? 'created': jsonb key-existence operator — cheap pre-filter
    // before the JS-side parseDateLoose validation. content_created_at IS NULL
    // is what makes this idempotent: an already-backfilled row never re-matches.
    const rows = await engine.executeRaw<CandidateRow>(
      `SELECT id, slug, frontmatter->>'created' AS fm_created
         FROM pages
        WHERE id > $1 ${slugFilter}
          AND content_created_at IS NULL
          AND frontmatter ? 'created'
        ORDER BY id
        LIMIT ${BATCH_SIZE}`,
      params,
    );

    if (rows.length === 0) break;
    examined += rows.length;

    for (const r of rows) {
      const parsed = parseDateLoose(r.fm_created);
      if (!parsed) {
        skippedUnparseable++;
        continue;
      }
      if (!opts.dryRun) {
        // Guard content_created_at IS NULL again at UPDATE time: belt-and-
        // suspenders against a concurrent writer (e.g. a live `gbrain sync`)
        // populating it between the SELECT and this UPDATE.
        await engine.executeRaw(
          `UPDATE pages SET content_created_at = $1::timestamptz WHERE id = $2 AND content_created_at IS NULL`,
          [parsed.toISOString(), r.id],
        );
      }
      updated++;
    }

    lastId = rows[rows.length - 1].id;
  }

  return {
    examined,
    updated,
    skipped_unparseable: skippedUnparseable,
    duration_sec: (Date.now() - start) / 1000,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opts: { dryRun?: boolean; slugPrefix?: string; json?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--slug-prefix') opts.slugPrefix = args[++i];
    else if (a === '--json') opts.json = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }

  const { createEngine } = await import('../src/core/engine-factory.ts');
  const { loadConfig, toEngineConfig } = await import('../src/core/config.ts');
  const cfg = loadConfig();
  if (!cfg) {
    console.error('No gbrain config; run `gbrain init` first.');
    process.exit(1);
  }
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  // Applies migration v125 (pages.content_created_at) if not already applied.
  await engine.initSchema();

  try {
    const step1 = await backfillContentCreatedAt(engine, {
      dryRun: opts.dryRun,
      slugPrefix: opts.slugPrefix,
    });

    // Step 2: re-walk effective_date/effective_date_source for ALL pages so
    // the newly-populated content_created_at actually changes what search
    // sees. Cheap: backfillEffectiveDate no-ops any row whose computed value
    // already matches, so this is safe to run unconditionally (and safe to
    // re-run this whole script repeatedly).
    const step2 = await backfillEffectiveDate(engine, { dryRun: opts.dryRun, fresh: true });

    const result = {
      status: opts.dryRun ? 'dry_run' : 'ok',
      content_created_at: step1,
      effective_date_recompute: {
        examined: step2.examined,
        updated: step2.updated,
        fallback: step2.fallback,
        duration_sec: step2.durationSec,
      },
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(
        `\ncontent_created_at backfill (${result.status}): ` +
        `examined=${step1.examined} updated=${step1.updated} skipped_unparseable=${step1.skipped_unparseable} ` +
        `dur=${step1.duration_sec.toFixed(1)}s\n` +
        `effective_date recompute: examined=${step2.examined} updated=${step2.updated} ` +
        `fallback=${step2.fallback} dur=${step2.durationSec.toFixed(1)}s`,
      );
    }
  } finally {
    if ('disconnect' in engine && typeof engine.disconnect === 'function') {
      await engine.disconnect();
    }
  }
}

// Only run when invoked directly (bun run scripts/backfill-content-created-at.ts),
// not when imported by a test.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

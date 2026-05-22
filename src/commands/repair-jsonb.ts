/**
 * `gbrain repair-jsonb` — repair JSONB columns that were stored as string
 * literals due to the v0.12.0-and-earlier double-encode bug.
 *
 * Background: postgres-engine.ts wrote frontmatter and other JSONB columns
 * via the buggy `JSON.stringify(value)`-then-cast-to-jsonb interpolation
 * pattern, which postgres.js v3 stringified AGAIN on the wire. Result: every `frontmatter->>'key'` query returned NULL
 * on Postgres-backed brains; GIN indexes were inert. PGLite was unaffected
 * (different driver path). v0.12.1 fixes the writes (sql.json) but existing
 * rows stay broken until they're rewritten — that's what this command does.
 *
 * Strategy: for each affected JSONB column, detect rows where
 * `jsonb_typeof(col) = 'string'` and rewrite them via `(col #>> '{}')::jsonb`,
 * which extracts the string payload and re-parses it as JSONB. Idempotent:
 * re-running is a no-op (no rows match the guard). PGLite is a no-op too
 * (it never wrote string-typed JSONB).
 *
 * Affected columns (audit of src/schema.sql):
 *   - pages.frontmatter           (postgres-engine.ts:107 putPage)
 *   - raw_data.data               (postgres-engine.ts:668 putRawData)
 *   - ingest_log.pages_updated    (postgres-engine.ts:846 logIngest)
 *   - files.metadata              (commands/files.ts:254 file upload)
 *   - page_versions.frontmatter   (downstream of pages.frontmatter via
 *                                  INSERT...SELECT FROM pages)
 *
 * Other JSONB columns (minion_jobs.{data,result,progress,stacktrace},
 * minion_inbox.payload) were always written via parameterized form ($N::jsonb
 * with a string parameter, not interpolation) so they were never affected.
 */

import { loadConfig, toEngineConfig } from '../core/config.ts';
import type { EngineConfig } from '../core/types.ts';
import * as db from '../core/db.ts';
import { createProgress, startHeartbeat } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

interface RepairTarget {
  table: string;
  column: string;
  /** Optional secondary key column for logging. */
  keyCol?: string;
}

const TARGETS: RepairTarget[] = [
  { table: 'pages',          column: 'frontmatter',    keyCol: 'slug' },
  { table: 'raw_data',       column: 'data',           keyCol: 'source' },
  { table: 'ingest_log',     column: 'pages_updated',  keyCol: 'source_ref' },
  { table: 'files',          column: 'metadata',       keyCol: 'storage_path' },
  { table: 'page_versions',  column: 'frontmatter',    keyCol: 'snapshot_at' },
];

export interface RepairResult {
  engine: string;
  per_target: Array<{
    table: string;
    column: string;
    rows_repaired: number;
  }>;
  total_repaired: number;
}

export interface RepairOpts {
  dryRun: boolean;
  /** Engine config override (for tests). Defaults to loadConfig() result. */
  engineConfig?: EngineConfig;
}

/**
 * Run the repair against the currently-configured engine.
 *
 * On PGLite this finds 0 rows (the bug never affected the parameterized
 * encode path PGLite uses) and exits cleanly. On Postgres it issues one
 * idempotent UPDATE per target column.
 */
export async function repairJsonb(opts: RepairOpts = { dryRun: false }): Promise<RepairResult> {
  let engineCfg = opts.engineConfig;
  if (!engineCfg) {
    const config = loadConfig();
    if (!config) {
      throw new Error('No brain configured. Run: gbrain init');
    }
    engineCfg = toEngineConfig(config);
  }
  const engineKind = engineCfg.engine || 'postgres';

  const result: RepairResult = {
    engine: engineKind,
    per_target: [],
    total_repaired: 0,
  };

  if (engineKind === 'pglite') {
    for (const t of TARGETS) {
      result.per_target.push({ table: t.table, column: t.column, rows_repaired: 0 });
    }
    return result;
  }

  await db.connect(engineCfg);
  const sql = db.getConnection();

  // Progress on stderr only. Stdout is reserved for the JSON summary that
  // migrations/v0_12_2.ts parses via JSON.parse — stray progress lines on
  // stdout would break the orchestrator (per Codex review #12).
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('repair_jsonb.run', TARGETS.length);

  for (const t of TARGETS) {
    const phase = `repair_jsonb.${t.table}.${t.column}`;
    progress.heartbeat(phase);
    // Heartbeat the caller while each UPDATE runs (minutes on 50K-row tables).
    const stopHb = startHeartbeat(progress, `${t.table}.${t.column}`);
    let repaired = 0;

    try {
      if (opts.dryRun) {
        const rows = await sql.unsafe(
          `SELECT count(*)::int AS n FROM ${t.table} WHERE jsonb_typeof(${t.column}) = 'string'`,
        );
        repaired = (rows[0] as unknown as { n: number }).n;
      } else {
        const rows = await sql.unsafe(
          `UPDATE ${t.table}
           SET ${t.column} = (${t.column} #>> '{}')::jsonb
           WHERE jsonb_typeof(${t.column}) = 'string'
           RETURNING 1`,
        );
        repaired = rows.length;
      }
    } finally {
      stopHb();
    }

    progress.tick(1, `${t.table}.${t.column}=${repaired}`);
    result.per_target.push({ table: t.table, column: t.column, rows_repaired: repaired });
    result.total_repaired += repaired;
  }

  progress.finish();
  return result;
}

export async function runRepairJsonbCli(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  const result = await repairJsonb({ dryRun });

  if (jsonMode) {
    console.log(JSON.stringify({ status: 'ok', dry_run: dryRun, ...result }));
    return;
  }

  if (result.engine === 'pglite') {
    console.log('Engine: pglite — JSONB double-encode bug never affected this path. No-op.');
    return;
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Engine: postgres`);
  console.log(`${dryRun ? '[dry-run] ' : ''}JSONB repair across ${TARGETS.length} columns:`);
  for (const t of result.per_target) {
    const verb = dryRun ? 'would repair' : 'repaired';
    console.log(`  ${t.table}.${t.column}: ${verb} ${t.rows_repaired} rows`);
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}Total ${dryRun ? 'to repair' : 'repaired'}: ${result.total_repaired} rows`);
  if (!dryRun && result.total_repaired === 0) {
    console.log('Nothing to repair (already-valid JSONB or fresh install).');
  }
}

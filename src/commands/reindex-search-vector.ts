/**
 * `gbrain reindex-search-vector` — recreate FTS trigger functions and
 * backfill existing rows under the language configured via
 * GBRAIN_FTS_LANGUAGE.
 *
 * Why this command exists: schema migration v123 (configurable_fts_language)
 * stamps the trigger functions with the configured language at first apply.
 * After that, changing the env var has no effect on the write side because
 * v123 already shows as "applied" — the migrations runner will skip it.
 * This command is the documented escape hatch: it re-runs the same
 * recreate-and-backfill logic v123 uses, gated on an explicit user
 * action so the operation is intentional and visible (writes touch
 * every row in pages and content_chunks).
 *
 * Idempotent: running twice with the same GBRAIN_FTS_LANGUAGE produces
 * the same trigger function bodies and the same tokenized vectors.
 *
 * Flags:
 *   --dry-run    Show what would happen, exit 0 without touching DB.
 *   --yes        Skip interactive [y/N]. Required for non-TTY (including --json).
 *   --json       Machine-readable result envelope. Does NOT imply --yes.
 *
 * Backfill runs in id-keyset batches (BACKFILL_BATCH_SIZE rows per UPDATE)
 * so a large brain never holds one giant row lock, and streams progress
 * through the shared reporter (stderr; stdout stays clean for --json).
 *
 * Cost: trigger recreate is sub-millisecond. Backfill is one tsvector
 * rebuild per page + per chunk. On a 20K-page brain with 80K chunks,
 * expect ~5-15s depending on Postgres CPU and content size.
 */

import type { BrainEngine } from '../core/engine.ts';
import { getFtsLanguage } from '../core/fts-language.ts';
import { createInterface } from 'readline';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface ReindexSearchVectorOpts {
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface ReindexSearchVectorResult {
  status: 'ok' | 'dry_run' | 'cancelled';
  language: string;
  pagesUpdated: number;
  chunksUpdated: number;
  triggersRecreated: number;
  durationMs: number;
}

interface CountRow {
  pages: number;
  chunks: number;
}

/** Rows per backfill UPDATE. Keyset-batched so one statement never locks the whole table. */
export const BACKFILL_BATCH_SIZE = 5000;

/**
 * Keyset-batched UPDATE: applies `setClause` to `table` rows where
 * search_vector IS NOT NULL, BACKFILL_BATCH_SIZE ids at a time, ticking
 * the shared progress reporter after each batch. Terminates when a batch
 * returns fewer rows than the batch size (or none).
 */
async function batchedBackfill(
  engine: BrainEngine,
  table: 'pages' | 'content_chunks',
  setClause: string,
  tick: (n: number) => void
): Promise<void> {
  let cursor = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ id: number }>(`
      UPDATE ${table} SET ${setClause}
      WHERE id IN (
        SELECT id FROM ${table}
        WHERE search_vector IS NOT NULL AND id > ${cursor}
        ORDER BY id
        LIMIT ${BACKFILL_BATCH_SIZE}
      )
      RETURNING id
    `);
    if (rows.length === 0) break;
    tick(rows.length);
    cursor = rows.reduce((m, r) => Math.max(m, Number(r.id)), cursor);
    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }
}

/**
 * Programmatic entrypoint — takes a typed opts object. Used by tests and
 * future internal callers. The CLI wrapper is `runReindexSearchVectorCli`
 * defined at the bottom of this file.
 */
export async function runReindexSearchVector(
  engine: BrainEngine,
  opts: ReindexSearchVectorOpts
): Promise<ReindexSearchVectorResult> {
  const lang = getFtsLanguage();
  const startedAt = Date.now();

  // Inventory: how many rows will the backfill touch?
  const counts = await engine.executeRaw<CountRow>(
    `SELECT
       (SELECT COUNT(*)::int FROM pages WHERE search_vector IS NOT NULL) AS pages,
       (SELECT COUNT(*)::int FROM content_chunks WHERE search_vector IS NOT NULL) AS chunks`
  );
  const pagesCount = counts[0]?.pages ?? 0;
  const chunksCount = counts[0]?.chunks ?? 0;

  if (opts.dryRun) {
    const result: ReindexSearchVectorResult = {
      status: 'dry_run',
      language: lang,
      pagesUpdated: pagesCount,
      chunksUpdated: chunksCount,
      triggersRecreated: 0,
      durationMs: Date.now() - startedAt,
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[dry-run] Would recreate 2 trigger functions with language='${lang}'`);
      console.log(`[dry-run] Would backfill ${pagesCount} pages + ${chunksCount} chunks`);
      console.log(`[dry-run] Skipping all DB writes. Pass --yes to apply.`);
    }
    return result;
  }

  // Confirm unless --yes. --json does NOT bypass the gate — a machine
  // caller must pass --yes explicitly (mirrors reindex-code, #1784).
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      if (opts.json) {
        console.log(JSON.stringify({
          error: {
            class: 'ConfirmationRequired',
            code: 'reindex_requires_yes',
            message: `Refusing to recreate FTS triggers + backfill ${pagesCount} pages + ${chunksCount} chunks without --yes in a non-TTY environment.`,
            hint: 'Pass --yes to proceed, or --dry-run to preview.',
          },
          language: lang,
          pages: pagesCount,
          chunks: chunksCount,
        }));
      } else {
        console.error('Refusing to run without --yes in non-TTY environment.');
      }
      process.exit(2);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question(
        `Recreate FTS triggers with language='${lang}' and backfill ${pagesCount} pages + ${chunksCount} chunks? [y/N]: `,
        resolve
      );
    });
    rl.close();

    if (!/^y(es)?$/i.test(answer.trim())) {
      const result: ReindexSearchVectorResult = {
        status: 'cancelled',
        language: lang,
        pagesUpdated: 0,
        chunksUpdated: 0,
        triggersRecreated: 0,
        durationMs: Date.now() - startedAt,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('Cancelled.');
      }
      return result;
    }
  }

  // Recreate trigger functions. The strings are intentionally identical to
  // the v124 migration body — keeping them in lockstep is the contract.
  // `SET search_path = pg_catalog, public` mirrors the v120/#1647 hardening:
  // CREATE OR REPLACE resets proconfig, so omitting it here would strip the
  // hardening from every brain that runs this command.
  //
  // #2704: compiled_truth (the unbounded whole-page body) is deliberately
  // NOT indexed here — it overflows Postgres's 1MB tsvector cap on large
  // pages, and content_chunks.search_vector (populated separately, chunk-
  // grain, well under the cap) is what searchKeyword() actually queries.
  // See migrate.ts's v124 for the full rationale; keep this copy in sync.
  const recreatePagesFn = `
    CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
    DECLARE
      timeline_text TEXT;
    BEGIN
      SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
      INTO timeline_text
      FROM timeline_entries
      WHERE page_id = NEW.id;

      NEW.search_vector :=
        setweight(to_tsvector('${lang}', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('${lang}', coalesce(NEW.timeline, '')), 'C') ||
        setweight(to_tsvector('${lang}', coalesce(timeline_text, '')), 'C');

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `;

  const recreateChunksFn = `
    CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER SET search_path = pg_catalog, public AS $fn$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('${lang}', COALESCE(NEW.doc_comment, '')), 'A') ||
        setweight(to_tsvector('${lang}', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
        setweight(to_tsvector('${lang}', COALESCE(NEW.chunk_text, '')), 'B');
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `;

  await engine.executeRaw(recreatePagesFn);
  await engine.executeRaw(recreateChunksFn);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // Backfill: UPDATE-to-self forces the pages trigger to re-fire
  // (Postgres re-fires on UPDATE-to-same-value); content_chunks gets a
  // direct vector compute since the column itself is what we want.
  progress.start('reindex_search_vector.pages', pagesCount);
  await batchedBackfill(engine, 'pages', 'id = id', n => progress.tick(n));
  progress.finish();

  progress.start('reindex_search_vector.chunks', chunksCount);
  await batchedBackfill(
    engine,
    'content_chunks',
    `search_vector =
      setweight(to_tsvector('${lang}', COALESCE(doc_comment, '')), 'A') ||
      setweight(to_tsvector('${lang}', COALESCE(symbol_name_qualified, '')), 'A') ||
      setweight(to_tsvector('${lang}', COALESCE(chunk_text, '')), 'B')`,
    n => progress.tick(n)
  );
  progress.finish();

  const result: ReindexSearchVectorResult = {
    status: 'ok',
    language: lang,
    pagesUpdated: pagesCount,
    chunksUpdated: chunksCount,
    triggersRecreated: 2,
    durationMs: Date.now() - startedAt,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`✅ Recreated 2 trigger functions with language='${lang}'`);
    console.log(`✅ Backfilled ${pagesCount} pages + ${chunksCount} chunks (${result.durationMs}ms)`);
  }

  return result;
}

/**
 * CLI entrypoint. Parses argv flags and dispatches to runReindexSearchVector.
 * Matches the style of `reindex-code`: --dry-run, --yes/-y, --json.
 *
 * Exit codes: 0 success/dry-run/cancelled, 2 if non-TTY without --yes.
 */
export async function runReindexSearchVectorCli(
  engine: BrainEngine,
  args: string[]
): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes') || args.includes('-y');
  const json = args.includes('--json');

  await runReindexSearchVector(engine, { dryRun, yes, json });
}

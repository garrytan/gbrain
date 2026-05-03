/**
 * `gbrain reindex --search-vector` — recreate FTS trigger functions and
 * backfill existing rows under the language configured via
 * GBRAIN_FTS_LANGUAGE.
 *
 * Why this command exists: schema migration v33 stamps the trigger
 * functions with the configured language at first apply. After that,
 * changing the env var has no effect on the write side because v33
 * already shows as "applied" — the migrations runner will skip it.
 * This command is the documented escape hatch: it re-runs the same
 * recreate-and-backfill logic v33 uses, gated on an explicit user
 * action so the operation is intentional and visible (writes touch
 * every row in pages and content_chunks for non-english languages).
 *
 * Idempotent: running twice with the same GBRAIN_FTS_LANGUAGE produces
 * the same trigger function bodies and the same tokenized vectors.
 *
 * Flags:
 *   --dry-run    Show what would happen, exit 0 without touching DB.
 *   --yes        Skip interactive [y/N]. Required for non-TTY.
 *   --json       Machine-readable result envelope.
 *
 * Cost: trigger recreate is sub-millisecond. Backfill is one tsvector
 * rebuild per page + per chunk. On a 20K-page brain with 80K chunks,
 * expect ~5-15s depending on Postgres CPU and content size.
 */

import type { BrainEngine } from '../core/engine.ts';
import { getFtsLanguage } from '../core/fts-language.ts';
import { createInterface } from 'readline';

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

  // Confirm unless --yes (or --json, which is non-interactive by contract).
  if (!opts.yes && !opts.json) {
    if (!process.stdin.isTTY) {
      console.error('Refusing to run without --yes in non-TTY environment.');
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
      console.log('Cancelled.');
      return result;
    }
  }

  // Recreate trigger functions. The strings are intentionally identical to
  // the v33 migration body — keeping them in lockstep is the contract.
  const recreatePagesFn = `
    CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $fn$
    DECLARE
      timeline_text TEXT;
    BEGIN
      SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
      INTO timeline_text
      FROM timeline_entries
      WHERE page_id = NEW.id;

      NEW.search_vector :=
        setweight(to_tsvector('${lang}', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('${lang}', coalesce(NEW.compiled_truth, '')), 'B') ||
        setweight(to_tsvector('${lang}', coalesce(NEW.timeline, '')), 'C') ||
        setweight(to_tsvector('${lang}', coalesce(timeline_text, '')), 'C');

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `;

  const recreateChunksFn = `
    CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER AS $fn$
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

  // Backfill: UPDATE-to-self forces the trigger to re-fire for pages
  // (Postgres re-fires on UPDATE-to-same-value); content_chunks gets a
  // direct vector compute since the column itself is what we want.
  const backfillPages = `
    UPDATE pages SET id = id WHERE search_vector IS NOT NULL;
  `;

  const backfillChunks = `
    UPDATE content_chunks
    SET search_vector =
      setweight(to_tsvector('${lang}', COALESCE(doc_comment, '')), 'A') ||
      setweight(to_tsvector('${lang}', COALESCE(symbol_name_qualified, '')), 'A') ||
      setweight(to_tsvector('${lang}', COALESCE(chunk_text, '')), 'B')
    WHERE search_vector IS NOT NULL;
  `;

  await engine.executeRaw(backfillPages);
  await engine.executeRaw(backfillChunks);

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
    console.log(`\u2705 Recreated 2 trigger functions with language='${lang}'`);
    console.log(`\u2705 Backfilled ${pagesCount} pages + ${chunksCount} chunks (${result.durationMs}ms)`);
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

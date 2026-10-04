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
 *   --yes        The user's approval (requireConsent, effect destructive). Without
 *                it a non-interactive run (including --json) changes nothing and
 *                exits 3 with the consent payload.
 *   --json       Machine-readable result envelope. Does NOT imply consent.
 *
 * Backfill runs in id-keyset batches (BACKFILL_BATCH_SIZE rows per UPDATE)
 * so a large brain never holds one giant row lock, and streams progress
 * through the shared reporter (stderr; stdout stays clean for --json).
 *
 * Cost: trigger recreate is sub-millisecond. Backfill is one tsvector
 * rebuild per page + per chunk, ~1-5s per 5000-row batch depending on
 * engine CPU and content size (PGLite is the slow end) — budget minutes,
 * not seconds, for a brain with 100K+ chunks.
 *
 * Interrupted runs (#4795): the two CREATE OR REPLACE statements autocommit,
 * so a kill/crash mid-backfill would otherwise leave new writes tokenized in
 * the new language and un-backfilled rows in the old one, silently splitting
 * keyword search. The command therefore stamps `fts.reindex_in_progress`
 * (= target language) in the config table BEFORE the DDL and clears it only
 * after both backfills return; `gbrain doctor` fails (`fts_reindex_incomplete`)
 * while it is set. Each batch persists its keyset cursor under the shared
 * `backfill.<name>.last_id` convention, so re-running with the same language
 * resumes where the killed run stopped (a different language starts over).
 * Deliberately NOT one engine.transaction(): on Postgres that would hold every
 * page/chunk row lock for the whole run (the batching exists to avoid that),
 * and a hang inside it would bank zero progress.
 */

import type { BrainEngine } from '../core/engine.ts';
import { getFtsLanguage, FTS_REINDEX_MARKER_KEY } from '../core/fts-language.ts';
import { checkpointKey } from '../core/backfill-base.ts';
import { consentGate } from '../core/consent-cli.ts';
import type { ConsentEnv } from '../core/consent.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

export interface ReindexSearchVectorOpts {
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  /** Raw CLI argv for requireConsent (`--yes`, preapproval flags); default derived from `yes`. */
  args?: readonly string[];
  /** Consent seams (interactive probe, prompt reader). */
  consentEnv?: ConsentEnv;
}

export interface ReindexSearchVectorResult {
  /** `confirmation_required`: consent refused; the refusal was printed (exit verdict 3) and nothing changed. */
  status: 'ok' | 'dry_run' | 'confirmation_required';
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

/** Checkpoint names (→ `backfill.<name>.last_id`), one per backfilled table. */
const CHECKPOINT_NAME = { pages: 'fts_pages', content_chunks: 'fts_content_chunks' } as const;

/**
 * Keyset-batched UPDATE: applies `setClause` to `table` rows where
 * search_vector IS NOT NULL, BACKFILL_BATCH_SIZE ids at a time, ticking
 * the shared progress reporter after each batch. Terminates when a batch
 * returns fewer rows than the batch size (or none). The cursor is persisted
 * after every batch so a killed run loses at most one batch on resume.
 */
async function batchedBackfill(
  engine: BrainEngine,
  table: 'pages' | 'content_chunks',
  setClause: string,
  tick: (n: number) => void
): Promise<void> {
  const key = checkpointKey(CHECKPOINT_NAME[table]);
  const saved = Number(await engine.getConfig(key));
  let cursor = Number.isFinite(saved) && saved > 0 ? saved : 0;
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
    await engine.setConfig(key, String(cursor));
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
      console.log(`[dry-run] Skipping all DB writes. Applying needs the user's approval (gbrain reindex-search-vector asks).`);
    }
    return result;
  }

  // Consent (A4). --json does NOT imply it. Effect destructive: every page's
  // and chunk's stored keyword index is rewritten in the new language. Not
  // bound to a plan hash: the rows are derived data and the target is fully
  // named by GBRAIN_FTS_LANGUAGE, so re-running under the previous language
  // is the undo.
  const auth = await consentGate({
    command: 'reindex-search-vector',
    effects: ['destructive'],
    actor: 'agent',
    what: `Rebuild the keyword search index in language '${lang}'`,
    why: `Recreates the full-text trigger functions with language '${lang}' (from GBRAIN_FTS_LANGUAGE) and re-tokenizes ${pagesCount} page(s) and ${chunksCount} chunk(s), so keyword search matches that language.`,
    risk: `Rewrites the stored keyword index of every page and chunk; keyword search uses '${lang}' rules afterwards and is split until the run finishes `
      + '(an interrupted run resumes with the same command; gbrain doctor reports fts_reindex_incomplete meanwhile). Page text is not touched. '
      + 'Undo: run this command again with GBRAIN_FTS_LANGUAGE set to the previous language.',
    user_message: `Rebuild the keyword search index of ${pagesCount} page(s) in '${lang}'? It can take minutes on a large brain; page text is not changed.`,
    argv: ['gbrain', 'reindex-search-vector', ...(opts.json ? ['--json'] : [])],
    preview_argv: ['gbrain', 'reindex-search-vector', '--dry-run', '--json'],
    args: opts.args ?? (opts.yes ? ['--yes'] : []),
  }, { json: opts.json === true, env: opts.consentEnv });
  if (!auth) {
    return { status: 'confirmation_required', language: lang, pagesUpdated: 0, chunksUpdated: 0, triggersRecreated: 0, durationMs: Date.now() - startedAt };
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

  // #4795: marker first (see the docblock). A prior run interrupted on the
  // SAME language resumes from its checkpoints; any other state starts over.
  const inProgress = await engine.getConfig(FTS_REINDEX_MARKER_KEY);
  if (inProgress === lang) {
    console.error(`Resuming interrupted reindex to language='${lang}' from the saved checkpoint.`);
  } else {
    await engine.unsetConfig(checkpointKey(CHECKPOINT_NAME.pages));
    await engine.unsetConfig(checkpointKey(CHECKPOINT_NAME.content_chunks));
  }
  await engine.setConfig(FTS_REINDEX_MARKER_KEY, lang);

  try {
    await engine.executeRaw(recreatePagesFn);
  } catch (err) {
    // Nothing landed (e.g. no CREATE FUNCTION privilege): put the marker back
    // the way THIS run found it. Absent before → clear it, so doctor doesn't
    // report a permanent fts_reindex_incomplete whose suggested fix re-fails.
    // Set before (a prior run was interrupted) → the index is still split, so
    // restore the prior value; clearing it would hide a real incomplete
    // reindex. Once the pages trigger has flipped, the marker MUST stay.
    await (inProgress === null
      ? engine.unsetConfig(FTS_REINDEX_MARKER_KEY)
      : engine.setConfig(FTS_REINDEX_MARKER_KEY, inProgress)
    ).catch(() => {});
    throw err;
  }
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

  // Both backfills returned: the index is whole again under `lang`.
  await engine.unsetConfig(checkpointKey(CHECKPOINT_NAME.pages));
  await engine.unsetConfig(checkpointKey(CHECKPOINT_NAME.content_chunks));
  await engine.unsetConfig(FTS_REINDEX_MARKER_KEY);

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
 * Exit codes: 0 success/dry-run, 3 when consent is required (refusal printed).
 */
export async function runReindexSearchVectorCli(
  engine: BrainEngine,
  args: string[]
): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes') || args.includes('-y');
  const json = args.includes('--json');

  await runReindexSearchVector(engine, { dryRun, yes, json, args: yes && !args.includes('--yes') ? [...args, '--yes'] : args });
}

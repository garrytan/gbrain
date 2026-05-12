/**
 * v0.32.7 CJK wave — `gbrain reindex --markdown` sweep.
 *
 * Walks markdown pages whose `chunker_version` is below
 * MARKDOWN_CHUNKER_VERSION and re-imports each through the standard
 * `importFromFile` / `importFromContent` path. Bumps `chunker_version` on
 * success so re-runs are idempotent and a partial sweep can resume.
 *
 * Driven by:
 *   - `gbrain upgrade` post-upgrade hook (after the cost-estimate prompt).
 *   - Operators running `gbrain reindex --markdown` directly.
 *
 * Performance: batched 100 at a time so a 50K-page brain reindex doesn't
 * hold a single transaction open. `--limit` caps total work for triage
 * runs; `--dry-run` reports the count without writing.
 *
 * Codex outside-voice C2 — the original PR #599 `MARKDOWN_CHUNKER_VERSION`
 * fold into content_hash was a no-op because `performSync` only re-imports
 * files whose content actually changed, not files whose hash WOULD change
 * if recomputed. This sweep + the migration v52 column are how the bump
 * actually reaches existing markdown pages.
 */

import type { BrainEngine } from '../core/engine.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../core/chunkers/recursive.ts';
import { importFromContent, importFromFile } from '../core/import-file.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { existsSync } from 'fs';
import { resolve } from 'path';

interface ReindexOpts {
  /** Cap total pages reindexed. Useful for triage runs on huge brains. */
  limit?: number;
  /** Report would-do count; don't actually reindex. */
  dryRun?: boolean;
  /** Emit JSON envelope on stdout. */
  json?: boolean;
  /** Brain repo path (for reading source files). Falls back to sync.repo_path config or process.cwd(). */
  repoPath?: string;
  /**
   * Skip the embedding call during re-chunk. New chunks land with NULL
   * embedding and the next `gbrain embed --stale` pass fills them in.
   * Useful for offline / no-API-key brains and for tests.
   */
  noEmbed?: boolean;
}

export interface ReindexResult {
  pending: number;
  reindexed: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  chunkerVersion: number;
}

function parseArgs(args: string[]): ReindexOpts {
  const out: ReindexOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--markdown') continue; // routing flag, no value
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-embed') out.noEmbed = true;
    else if (a === '--limit') {
      const v = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(v) && v > 0) out.limit = v;
    } else if (a === '--repo') {
      out.repoPath = args[++i];
    }
  }
  return out;
}

/**
 * Count markdown pages that haven't been re-chunked by the current
 * MARKDOWN_CHUNKER_VERSION. Cheap; uses the partial index from migration v52.
 */
async function countPending(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ count: string | number }>(
    `SELECT COUNT(*)::bigint AS count
       FROM pages
      WHERE page_kind = 'markdown'
        AND chunker_version < $1
        AND deleted_at IS NULL`,
    [MARKDOWN_CHUNKER_VERSION],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Read a single batch of pending rows. Ordered by id so re-runs after
 * partial completion pick up where they left off without re-doing pages
 * whose chunker_version was already bumped.
 */
async function readBatch(engine: BrainEngine, batchSize: number): Promise<Array<{ slug: string; source_path: string | null; compiled_truth: string; source_id: string }>> {
  return engine.executeRaw(
    `SELECT slug, source_path, compiled_truth, source_id
       FROM pages
      WHERE page_kind = 'markdown'
        AND chunker_version < $1
        AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT $2`,
    [MARKDOWN_CHUNKER_VERSION, batchSize],
  );
}

export async function runReindex(engine: BrainEngine, args: string[]): Promise<ReindexResult> {
  const opts = parseArgs(args);

  // Require `--markdown` explicitly. Future modes (e.g. --code) get their
  // own routing here.
  if (!args.includes('--markdown')) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: 'gbrain reindex requires a target flag, e.g. --markdown' }) + '\n');
    } else {
      process.stderr.write('Usage: gbrain reindex --markdown [--limit N] [--dry-run] [--json] [--repo PATH]\n');
    }
    process.exitCode = 2;
    return { pending: 0, reindexed: 0, skipped: 0, failed: 0, dryRun: !!opts.dryRun, chunkerVersion: MARKDOWN_CHUNKER_VERSION };
  }

  const pending = await countPending(engine);

  if (opts.json && pending === 0) {
    process.stdout.write(JSON.stringify({ pending: 0, reindexed: 0, skipped: 0, failed: 0, chunker_version: MARKDOWN_CHUNKER_VERSION }) + '\n');
    return { pending: 0, reindexed: 0, skipped: 0, failed: 0, dryRun: !!opts.dryRun, chunkerVersion: MARKDOWN_CHUNKER_VERSION };
  }

  if (pending === 0) {
    process.stderr.write(`[reindex] All markdown pages already at chunker_version ${MARKDOWN_CHUNKER_VERSION}. Nothing to do.\n`);
    return { pending: 0, reindexed: 0, skipped: 0, failed: 0, dryRun: !!opts.dryRun, chunkerVersion: MARKDOWN_CHUNKER_VERSION };
  }

  const target = typeof opts.limit === 'number' ? Math.min(opts.limit, pending) : pending;

  if (opts.dryRun) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ pending, would_reindex: target, dry_run: true, chunker_version: MARKDOWN_CHUNKER_VERSION }) + '\n');
    } else {
      process.stderr.write(`[reindex] DRY-RUN: would re-chunk ${target} of ${pending} pending markdown pages.\n`);
    }
    return { pending, reindexed: 0, skipped: 0, failed: 0, dryRun: true, chunkerVersion: MARKDOWN_CHUNKER_VERSION };
  }

  const reporter = createProgress(cliOptsToProgressOptions(getCliOptions()));
  reporter.start('reindex.markdown', target);

  let reindexed = 0;
  let skipped = 0;
  let failed = 0;
  const BATCH = 100;
  const repoPath = opts.repoPath ? resolve(opts.repoPath) : null;

  while (reindexed + skipped + failed < target) {
    const remaining = target - (reindexed + skipped + failed);
    const batchSize = Math.min(BATCH, remaining);
    const batch = await readBatch(engine, batchSize);
    if (batch.length === 0) break;

    for (const row of batch) {
      reporter.tick();
      try {
        // Prefer importFromFile when we have a source_path AND the file
        // still exists on disk — re-runs both the path-authoritative slug
        // resolution AND the parseMarkdown pipeline on the real file.
        // When the file is gone or we never recorded source_path (legacy
        // rows pre-migration), fall back to importFromContent which uses
        // the stored markdown body. importFromContent doesn't re-parse a
        // frontmatter file, so timeline + tags don't refresh — accepted
        // tradeoff for the post-upgrade sweep.
        if (row.source_path && repoPath) {
          const absPath = resolve(repoPath, row.source_path);
          if (existsSync(absPath)) {
            await importFromFile(engine, absPath, row.source_path, {
              noEmbed: !!opts.noEmbed,
              sourceId: row.source_id,
              inferFrontmatter: false,
            });
            reindexed++;
            continue;
          }
        }
        // Fallback path: synthesize a minimal frontmatter shell from the
        // stored compiled_truth + slug. The page's title / frontmatter /
        // timeline get re-fetched inside importFromContent via getPage's
        // existing-row content_hash check; on hash match it short-circuits.
        // Force a re-chunk by passing a NULL content_hash (importFromContent
        // bypasses the unchanged shortcut when there's no existing hash).
        await importFromContent(engine, row.slug, row.compiled_truth, {
          sourceId: row.source_id,
          noEmbed: !!opts.noEmbed,
        });
        reindexed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[reindex] ${row.slug}: ${msg}\n`);
        failed++;
      }
    }
  }

  reporter.finish();

  const result: ReindexResult = {
    pending,
    reindexed,
    skipped,
    failed,
    dryRun: false,
    chunkerVersion: MARKDOWN_CHUNKER_VERSION,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      pending, reindexed, skipped, failed,
      chunker_version: MARKDOWN_CHUNKER_VERSION,
    }) + '\n');
  } else {
    process.stderr.write(`[reindex] Done. reindexed=${reindexed} failed=${failed} pending=${Math.max(0, pending - reindexed - failed)}\n`);
  }

  return result;
}

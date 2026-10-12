/**
 * `gbrain embed --stale --images`: rebuild image pages whose index is
 * incomplete (no visual vector, missing OCR text while OCR is enabled, or an
 * unsealed/stale projection) from their source files, without `sync --full`.
 *
 * An unchanged image is only re-read by a full sync, so an image first
 * imported under --no-embed, an OCR budget skip or a provider error stayed
 * filename-only until its bytes changed or someone ran `sync --full`. The
 * sweep selects the same incompleteness `importImageFile`'s hash-skip checks
 * and hands each file back to it, so the rebuild, the OCR budget and the
 * protected-OCR refusal all stay in one place.
 *
 * #6529: on a managed brain the file goes through the source's canonical owner
 * (`importManagedFile`, the same coordinated path `gbrain import` takes) instead
 * of the legacy writer, which a managed brain refuses. A page whose
 * `source_path` was never recorded is looked up by its slug (an image slug is
 * its repo-relative path) and the import records `source_path`. A sweep that
 * finds no file for any candidate is a failure (non-zero exit) that names the
 * paths it tried; `missing_samples` names them on a partial sweep too. Plain
 * `embed --stale` runs this sweep first on a multimodal install
 * (`runStaleImageSweepFirst`), inside the run's cost cap.
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { BrainEngine } from './engine.ts';
import { importImageFile } from './import-file.ts';
import { importManagedFile } from './persistence/import-mutations.ts';
import { readManagedMode } from './persistence/managed-mode.ts';
import { safeChunksFilter } from './search/safe-chunks.ts';
import { serr } from './console-prefix.ts';
import { gitChildEnv } from './git-env.ts';
import { isMultimodalEnabled } from './sync.ts';
import { embedCostStopVerdict, noteEmbedCostStop, type EmbedCostCap, type EmbedCostStopFields } from './embed-cost-cap.ts';

export interface StaleImageSweepResult extends EmbedCostStopFields {
  candidates: number;
  rebuilt: number;
  /** Candidates the importer left unchanged (complete by its own check, or refused). */
  skipped: number;
  missingFile: number;
  /** Candidates whose `pages.source_path` was NULL; the sweep located them by slug and the import recorded the path. */
  missingSourcePath: number;
  failures: number;
  failure_samples: string[];
  /** Up to 5 `source:slug: no file at <path tried>` lines for the candidates without a source file. */
  missing_samples: string[];
}

const SAMPLE_CAP = 5;

export async function embedStaleImages(
  engine: BrainEngine,
  opts: { sourceId?: string; dryRun: boolean; costCap?: EmbedCostCap | null },
): Promise<StaleImageSweepResult> {
  const ocrWanted = process.env.GBRAIN_EMBEDDING_IMAGE_OCR === 'true';
  const params: unknown[] = [ocrWanted];
  if (opts.sourceId) params.push(opts.sourceId);
  const rows = await engine.executeRaw<{ slug: string; source_id: string; source_path: string | null; local_path: string | null }>(
    `SELECT p.slug, p.source_id, p.source_path, s.local_path FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.page_kind = 'image' AND p.deleted_at IS NULL${opts.sourceId ? ' AND p.source_id = $2' : ''}
        AND (NOT (${safeChunksFilter('p')})
          OR p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
          OR NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.embedding_image IS NOT NULL)
          OR ($1 AND COALESCE(p.frontmatter->>'ocr_status', '') <> 'done' AND btrim(p.compiled_truth) = ''))
      ORDER BY p.id`, params);
  const result: StaleImageSweepResult = { candidates: rows.length, rebuilt: 0, skipped: 0, missingFile: 0, missingSourcePath: rows.filter(row => row.source_path === null).length,
    failures: 0, failure_samples: [], missing_samples: [] };
  const fail = (row: { source_id: string; slug: string }, error: string) => {
    result.failures++;
    if (result.failure_samples.length < SAMPLE_CAP) result.failure_samples.push(`${row.source_id}:${row.slug}: ${error}`);
  };
  if (opts.dryRun) return result;
  const repoPath = await engine.getConfig('sync.repo_path').catch(() => null);
  const managed = await readManagedMode(engine);
  const gitRoots = new Map<string, string | null>();
  const cap = opts.costCap;
  for (const row of rows) {
    // Fix wave 13 P1.18: the approved cap stops the sweep before the next image; a refused image is not a failure.
    if (cap?.hit()) break;
    const root = row.local_path ?? (row.source_id === 'default' ? repoPath : null);
    // An image slug is the lower-cased repo-relative path, so it names the file when the importer never recorded source_path.
    const sourcePath = row.source_path ?? row.slug;
    const located = root ? locateSourceFile(root, sourcePath, gitRoots) : null;
    const file = located?.found ?? null;
    if (!file) {
      result.missingFile++;
      if (result.missing_samples.length < SAMPLE_CAP) result.missing_samples.push(`${row.source_id}:${row.slug}: no file at ${located ? located.direct : `<source ${row.source_id} has no local path>`}`);
      continue;
    }
    // A managed brain imports through the source's owner (the coordinated importer, as `gbrain import` does); the legacy writer refuses it.
    // The owner reads only files inside the source root: a subpath-scoped page found under the git root is reported, not copied in.
    if (managed && file !== located!.direct) { fail(row, `${file} is outside source ${row.source_id}'s root ${root}; a managed brain imports only files inside the source root`); continue; }
    try {
      const run = () => managed ? importManagedFile(engine, file, sourcePath, { sourceId: row.source_id }) : importImageFile(engine, file, sourcePath, { sourceId: row.source_id });
      const imported = cap ? await cap.metered(run) : await run();
      if (imported.status === 'imported') result.rebuilt++;
      else if (cap?.hit()) break;
      else if (imported.status === 'error') fail(row, imported.error ?? 'import failed');
      else result.skipped++;
    } catch (e) {
      if (cap?.hit()) break;
      fail(row, e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}

/** Every candidate without a file and nothing rebuilt: the explicit `--images` sweep did no work, so it must not read as success. */
function sweepFoundNoFiles(result: StaleImageSweepResult): boolean {
  return result.candidates > 0 && result.rebuilt === 0 && result.missingFile === result.candidates;
}

/**
 * #6529: the image sweep plain `embed --stale` runs before its text drain on a
 * multimodal install (`GBRAIN_EMBEDDING_MULTIMODAL=true`), so image pages get
 * their image vector, OCR text and sealed projection in the same run instead of
 * a printed `--images` command; a text-only install gets null (and keeps the hint).
 */
export async function runStaleImageSweepFirst(engine: BrainEngine, opts: { sourceId?: string; dryRun: boolean; costCap?: EmbedCostCap | null }): Promise<StaleImageSweepResult | null> {
  if (!isMultimodalEnabled()) return null;
  return embedStaleImages(engine, opts);
}

/**
 * Folds the image sweep into the text run's result: image pages count as failures only when the sweep failed on them.
 * Pages whose file is gone from the checkout are reported (`images.missingFile`, the first `missing_samples` line on
 * stderr), never failed: the text run's exit code is the text run's, so a routine `embed --stale` stays green while an
 * out-of-scope backlog of fileless image pages remains (#6529).
 */
export function foldImageSweep<T extends { failures: number; failure_samples: string[]; images?: StaleImageSweepResult }>(result: T, sweep: StaleImageSweepResult | null): T {
  if (!sweep) return result;
  result.images = sweep;
  if (sweep.missingFile > 0) serr(`[embed] images: ${sweep.missingFile} image page(s) have no source file in the checkout and were not rebuilt (first: ${sweep.missing_samples[0]}); delete those pages or restore the files.`);
  if (sweep.failures > 0) {
    result.failures += sweep.failures;
    result.failure_samples.push(`${sweep.failures} image page(s) could not be rebuilt by the image sweep (${sweep.failure_samples.slice(0, 3).join('; ')}); every other stale image was rebuilt first.`);
  }
  return result;
}

/** The `gbrain embed --stale --images` CLI surface (dispatched from commands/embed.ts). */
export async function runEmbedStaleImagesCli(engine: BrainEngine, args: string[], costCap: EmbedCostCap | null = null): Promise<StaleImageSweepResult> {
  if (!args.includes('--stale') || !isMultimodalEnabled()) {
    serr('Usage: gbrain embed --stale --images [--source <id>] [--dry-run] [--json] (requires GBRAIN_EMBEDDING_MULTIMODAL=true)');
    process.exit(1);
  }
  const srcI = args.indexOf('--source');
  const dryRun = args.includes('--dry-run');
  const result = await embedStaleImages(engine, { sourceId: srcI >= 0 ? args[srcI + 1] : undefined, dryRun, costCap });
  if (sweepFoundNoFiles(result)) {
    result.failures += result.missingFile;
    result.failure_samples.push(...result.missing_samples.slice(0, SAMPLE_CAP - result.failure_samples.length));
  }
  const capped = costCap?.hit();
  if (capped) noteEmbedCostStop(result, capped, args);
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else console.log(`[embed] images: ${result.candidates} incomplete${result.missingSourcePath ? ` (${result.missingSourcePath} with no recorded source_path, located by slug)` : ''}, ${dryRun ? '(dry run) nothing rebuilt'
    : `${result.rebuilt} rebuilt, ${result.skipped} unchanged, ${result.missingFile} missing source file, ${result.failures} failed`}`);
  if (result.missing_samples.length) serr(`[embed] first missing image file: ${result.missing_samples[0]}`);
  if (result.failures > 0) serr(`[embed] first image failure: ${result.failure_samples[0]}`);
  if (capped) (args.includes('--json') ? serr : console.log)(embedCostStopVerdict(result, capped));
  return result;
}

/** A page's source_path is relative to its source checkout (`direct`), or to the git root for subpath-scoped syncs; `found` is whichever exists. */
function locateSourceFile(root: string, sourcePath: string, gitRoots: Map<string, string | null>): { direct: string; found: string | null } {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- source_path is the repo-relative path the importer recorded for this page, joined under the source's own checkout
  const direct = join(root, sourcePath);
  if (existsSync(direct)) return { direct, found: direct };
  if (!gitRoots.has(root)) {
    try {
      gitRoots.set(root, execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { env: gitChildEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch { gitRoots.set(root, null); }
  }
  const gitRoot = gitRoots.get(root);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same recorded repo-relative path, joined under the checkout's git root
  const viaGit = gitRoot ? join(gitRoot, sourcePath) : null;
  return { direct, found: viaGit && existsSync(viaGit) ? viaGit : null };
}

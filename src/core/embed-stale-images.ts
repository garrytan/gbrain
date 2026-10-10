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
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { BrainEngine } from './engine.ts';
import { importImageFile } from './import-file.ts';
import { safeChunksFilter } from './search/safe-chunks.ts';
import { serr } from './console-prefix.ts';
import { gitChildEnv } from './git-env.ts';
import { embedCostStopVerdict, noteEmbedCostStop, type EmbedCostCap, type EmbedCostStopFields } from './embed-cost-cap.ts';

export interface StaleImageSweepResult extends EmbedCostStopFields {
  candidates: number;
  rebuilt: number;
  /** Candidates the importer left unchanged (complete by its own check, or refused). */
  skipped: number;
  missingFile: number;
  failures: number;
  failure_samples: string[];
}

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
  const result: StaleImageSweepResult = { candidates: rows.length, rebuilt: 0, skipped: 0, missingFile: 0, failures: 0, failure_samples: [] };
  const fail = (row: { source_id: string; slug: string }, error: string) => {
    result.failures++;
    if (result.failure_samples.length < 5) result.failure_samples.push(`${row.source_id}:${row.slug}: ${error}`);
  };
  if (opts.dryRun) return result;
  const repoPath = await engine.getConfig('sync.repo_path').catch(() => null);
  const gitRoots = new Map<string, string | null>();
  const cap = opts.costCap;
  for (const row of rows) {
    // Fix wave 13 P1.18: the approved cap stops the sweep before the next image; a refused image is not a failure.
    if (cap?.hit()) break;
    const root = row.local_path ?? (row.source_id === 'default' ? repoPath : null);
    const file = root && row.source_path ? locateSourceFile(root, row.source_path, gitRoots) : null;
    if (!file) { result.missingFile++; continue; }
    try {
      const run = () => importImageFile(engine, file, row.source_path!, { sourceId: row.source_id });
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

/** The `gbrain embed --stale --images` CLI surface (dispatched from commands/embed.ts). */
export async function runEmbedStaleImagesCli(engine: BrainEngine, args: string[], costCap: EmbedCostCap | null = null): Promise<StaleImageSweepResult> {
  if (!args.includes('--stale') || process.env.GBRAIN_EMBEDDING_MULTIMODAL !== 'true') {
    serr('Usage: gbrain embed --stale --images [--source <id>] [--dry-run] [--json] (requires GBRAIN_EMBEDDING_MULTIMODAL=true)');
    process.exit(1);
  }
  const srcI = args.indexOf('--source');
  const dryRun = args.includes('--dry-run');
  const result = await embedStaleImages(engine, { sourceId: srcI >= 0 ? args[srcI + 1] : undefined, dryRun, costCap });
  const capped = costCap?.hit();
  if (capped) noteEmbedCostStop(result, capped, args);
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else console.log(`[embed] images: ${result.candidates} incomplete, ${dryRun ? '(dry run) nothing rebuilt'
    : `${result.rebuilt} rebuilt, ${result.skipped} unchanged, ${result.missingFile} missing source file, ${result.failures} failed`}`);
  if (result.failures > 0) serr(`[embed] first image failure: ${result.failure_samples[0]}`);
  if (capped) (args.includes('--json') ? serr : console.log)(embedCostStopVerdict(result, capped));
  return result;
}

/** A page's source_path is relative to its source checkout, or to the git root for subpath-scoped syncs. */
function locateSourceFile(root: string, sourcePath: string, gitRoots: Map<string, string | null>): string | null {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- source_path is the repo-relative path the importer recorded for this page, joined under the source's own checkout
  const direct = join(root, sourcePath);
  if (existsSync(direct)) return direct;
  if (!gitRoots.has(root)) {
    try {
      gitRoots.set(root, execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { env: gitChildEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    } catch { gitRoots.set(root, null); }
  }
  const gitRoot = gitRoots.get(root);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same recorded repo-relative path, joined under the checkout's git root
  const viaGit = gitRoot ? join(gitRoot, sourcePath) : null;
  return viaGit && existsSync(viaGit) ? viaGit : null;
}

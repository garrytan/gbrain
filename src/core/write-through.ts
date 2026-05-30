/**
 * Shared disk write-through for the canonical ingestion path.
 *
 * After a page row lands in the DB (via importFromContent / putPage), this
 * renders the row to markdown via `serializePageToMarkdown` and writes it to
 * `sync.repo_path` so the brain repo has a committable `.md` artifact that
 * round-trips cleanly through `gbrain sync`. The file is rendered FROM the DB
 * row, so the two sinks cannot diverge.
 *
 * Extracted from the v0.38 `put_page` write-through (operations.ts) so the
 * `put_page` op AND `gbrain brainstorm/lsd --save` share one implementation
 * instead of hand-rolling parallel (and divergent) copies. The extraction also
 * upgraded the write to be ATOMIC — the original used a bare `writeFileSync`
 * into a live git tree that `gbrain sync` / autopilot actively walk, so a crash
 * mid-write left a partial `.md` that sync would fail to parse. We now write to
 * a unique temp sibling and `rename` into place (rename is atomic on the same
 * filesystem), matching the `.tmp + rename` convention used by
 * import-checkpoint.ts / op-checkpoint.ts.
 *
 * Trust gating (subagent sandbox, dry-run) stays at the CALLER — this helper
 * only does "row exists + repo is a real dir → render + atomic write".
 */

import { existsSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { serializePageToMarkdown, resolvePageFilePath } from './markdown.ts';

/** Minimal logger surface — structurally compatible with operations.ts `Logger`. */
export interface WriteThroughLogger {
  warn(msg: string): void;
}

export interface WriteThroughResult {
  written: boolean;
  path?: string;
  /**
   * Non-error reasons the file was not written:
   *   - no_repo_configured: `sync.repo_path` is unset (DB-only by design).
   *   - repo_not_found: `sync.repo_path` set but missing / not a directory.
   *   - page_not_found_after_write: the DB row isn't readable back (the caller's
   *     DB write failed or targeted a different source).
   */
  skipped?: 'no_repo_configured' | 'repo_not_found' | 'page_not_found_after_write';
  /** Set when the render/write/rename itself threw (EACCES, ENOTDIR, disk full). */
  error?: string;
}

export interface WritePageThroughOpts {
  sourceId?: string;
  /** Merged over the page's own frontmatter at render time (e.g. provenance). */
  frontmatterOverrides?: Record<string, unknown>;
  logger?: WriteThroughLogger;
}

/**
 * Render the DB row for `slug` to markdown and atomically write it under
 * `sync.repo_path`. Never throws — failures are reported via the result's
 * `skipped` / `error` fields (the DB write is the durable sink; the file is
 * best-effort and reconciled by the next `gbrain sync`).
 */
export async function writePageThrough(
  engine: BrainEngine,
  slug: string,
  opts: WritePageThroughOpts = {},
): Promise<WriteThroughResult> {
  const sourceId = opts.sourceId ?? 'default';
  try {
    const repoPath = await engine.getConfig('sync.repo_path');
    if (!repoPath) {
      return { written: false, skipped: 'no_repo_configured' };
    }
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      return { written: false, skipped: 'repo_not_found' };
    }

    const writtenPage = await engine.getPage(slug, { sourceId });
    if (!writtenPage) {
      return { written: false, skipped: 'page_not_found_after_write' };
    }

    const tags = await engine.getTags(slug, { sourceId });
    const md = serializePageToMarkdown(writtenPage, tags, {
      frontmatterOverrides: opts.frontmatterOverrides,
    });

    const filePath = resolvePageFilePath(repoPath, slug, sourceId);
    mkdirSync(dirname(filePath), { recursive: true });

    // Atomic write: unique temp sibling + rename. Unique name (pid + random)
    // so two concurrent saves to the same target can't clobber each other's
    // temp file. Clean up the temp on any failure so we never leak a stray
    // `.tmp` next to the real file.
    const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmpPath, md, 'utf8');
      renameSync(tmpPath, filePath);
    } catch (writeErr) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup; surface the original write error below
      }
      throw writeErr;
    }

    return { written: true, path: filePath };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.logger?.warn(`[write-through] failed for ${slug}: ${msg}`);
    return { written: false, error: msg };
  }
}

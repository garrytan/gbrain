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
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { serializePageToMarkdown, resolvePageFilePath } from './markdown.ts';
import { isWriteTargetContained } from './path-confine.ts';

/** Minimal logger surface — structurally compatible with operations.ts `Logger`. */
export interface WriteThroughLogger {
  warn(msg: string): void;
}

export interface WriteThroughResult {
  written: boolean;
  path?: string;
  /**
   * Non-error reasons the file was not written:
   *   - no_repo_configured: the resolved target (source `local_path` or, for a
   *     sole-source brain, `sync.repo_path`) is unset (DB-only by design).
   *   - repo_not_found: target set but missing / not a directory.
   *   - source_repo_belongs_to_other_source: the assigned source has no
   *     `local_path`, and `sync.repo_path` is another source's own working tree
   *     — #2018: writing here would pollute that sibling's repo, so we skip.
   *   - page_not_found_after_write: the DB row isn't readable back (the caller's
   *     DB write failed or targeted a different source).
   *   - path_escapes_source_root: the computed file path resolves outside the
   *     source's working tree (hostile slug row / symlinked subtree) — refused.
   */
  skipped?: 'no_repo_configured' | 'repo_not_found' | 'source_repo_belongs_to_other_source' | 'page_not_found_after_write' | 'path_escapes_source_root';
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
    // #2018: pick the disk target so a page is NEVER written into a different
    // source's working tree. Two legitimate topologies, plus the leak guard:
    //   1. The assigned source has its OWN `local_path` (a separate working
    //      tree) → write at that tree's root (matches how `scanOneSource` reads
    //      it back; never nested under `.sources/`).
    //   2. No per-source `local_path` → nest under the host repo
    //      (`sync.repo_path`): default at the root, non-default under
    //      `.sources/<id>/` (the established multi-source layout).
    //   3. LEAK GUARD: if `sync.repo_path` is literally ANOTHER source's own
    //      `local_path`, nesting this page there would pollute that sibling's
    //      git repo (the reported bug). Skip instead.
    let filePath: string;
    let writeRoot: string;
    const srcRows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [sourceId],
    );
    const sourceLocalPath = srcRows[0]?.local_path ?? null;
    if (sourceLocalPath) {
      if (!existsSync(sourceLocalPath) || !statSync(sourceLocalPath).isDirectory()) {
        return { written: false, skipped: 'repo_not_found' };
      }
      filePath = join(sourceLocalPath, `${slug}.md`);
      writeRoot = sourceLocalPath;
    } else {
      const repoPath = await engine.getConfig('sync.repo_path');
      if (!repoPath) {
        return { written: false, skipped: 'no_repo_configured' };
      }
      if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
        return { written: false, skipped: 'repo_not_found' };
      }
      // Leak guard: refuse to write into a path that is some OTHER source's
      // own working tree (#2018).
      const collide = await engine.executeRaw<{ one: number }>(
        `SELECT 1 AS one FROM sources WHERE id <> $1 AND local_path = $2 LIMIT 1`,
        [sourceId, repoPath],
      );
      if (collide.length > 0) {
        return { written: false, skipped: 'source_repo_belongs_to_other_source' };
      }
      filePath = resolvePageFilePath(repoPath, slug, sourceId);
      writeRoot = repoPath;
    }

    // Defense-in-depth (#1647-slug / codex #6): confirm the computed file path
    // stays within the source's working tree before any mkdir/write. validateSlug
    // already rejects `..`/backslash/control/%2e in the slug at write time, so
    // this guards a pre-existing hostile row or a symlinked intermediate dir
    // under the source tree from escaping to an arbitrary filesystem location.
    if (!isWriteTargetContained(filePath, writeRoot)) {
      return { written: false, skipped: 'path_escapes_source_root' };
    }

    const writtenPage = await engine.getPage(slug, { sourceId });
    if (!writtenPage) {
      return { written: false, skipped: 'page_not_found_after_write' };
    }

    const tags = await engine.getTags(slug, { sourceId });
    const md = serializePageToMarkdown(writtenPage, tags, {
      frontmatterOverrides: opts.frontmatterOverrides,
    });

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

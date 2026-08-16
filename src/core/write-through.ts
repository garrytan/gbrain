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

import { existsSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { randomBytes } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { serializePageToMarkdown, resolvePageFilePath } from './markdown.ts';
import { isWriteTargetContained } from './path-confine.ts';
import {
  isDurabilityHardened, commitWriteThroughFile, currentBranch, getLastPushOutcome,
  type PushLogOutcome,
} from './brain-repo-durability.ts';

/** Minimal logger surface — structurally compatible with operations.ts `Logger`. */
export interface WriteThroughLogger {
  warn(msg: string): void;
}

export interface WriteThroughResult {
  written: boolean;
  path?: string;
  /**
   * True when the write was also committed to git (#2426). Only attempted on
   * repos hardened via `gbrain sources harden` (durability hook installed).
   * Commit-only — this says nothing about whether the commit ever reached the
   * remote. Best-effort — a false/absent value never blocks the write.
   */
  committed?: boolean;
  /**
   * Set alongside `committed: true`. The actual push runs detached in the
   * post-commit hook (see brain-repo-durability.ts), so at the moment this
   * result is returned the outcome for THIS commit is genuinely unknown —
   * 'pending' is the only honest value. Check `lastPushStatus` (or
   * $GBRAIN_HOME/brain-push.log directly) afterward to see whether pushes for
   * this branch are landing.
   */
  pushed?: 'pending';
  /**
   * Best-effort snapshot of the most recently logged push outcome for this
   * branch (read from the hook's shared log), taken right after the commit
   * above. It reflects push history UP TO that point — not the push this
   * write just queued — so callers and health tooling can tell "pushes for
   * this branch have been failing" apart from "this write committed fine".
   */
  lastPushStatus?: PushLogOutcome;
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
   *   - case_insensitive_collision: on a case-insensitive filesystem
   *     (macOS/Windows default), the target directory already holds a
   *     differently-cased entry that the FS folds onto this page's file, so
   *     writing would silently clobber the OTHER slug's file (#2831) — refused.
   */
  skipped?: 'no_repo_configured' | 'repo_not_found' | 'source_repo_belongs_to_other_source' | 'page_not_found_after_write' | 'path_escapes_source_root' | 'case_insensitive_collision';
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
 * Vet a `pages.source_path` before it is trusted as a write target.
 *
 * The column is populated from the scanner's relative path at import time, so
 * the normal value is a clean repo-relative `.md` path. This rejects the shapes
 * that would make `join(root, value)` unsafe or nonsensical — absolute paths,
 * `..` traversal, NUL bytes, non-markdown artifacts, and blanks. Containment is
 * still re-checked by `isWriteTargetContained` after the join; this is the
 * cheap structural filter in front of it.
 */
function sanitizeRecordedSourcePath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.includes('\0')) return null;
  if (!value.toLowerCase().endsWith('.md')) return null;
  if (isAbsolute(value)) return null;
  if (value.split(/[\\/]/).some((segment) => segment === '..')) return null;
  return value;
}

/**
 * Recover a page-root-relative write target from a `file://` `source_uri`.
 *
 * `gbrain capture --file` records the absolute input path as `source_uri` but
 * does NOT set `source_path` (that column is the file-scanner's). So a file the
 * user authored INSIDE the brain repo and then captured has no file of record,
 * and the slug-derived fallback would mint a twin beside the very file that was
 * just read. When the recorded URI points at a path under `pageRoot`, that path
 * IS the file of record — use it.
 *
 * Returns null for anything not a contained `.md` file so the caller falls back
 * to the slug path.
 */
function recordedPathFromFileUri(sourceUri: string | null | undefined, pageRoot: string): string | null {
  if (!sourceUri || !sourceUri.startsWith('file://')) return null;
  let abs = sourceUri.slice('file://'.length);
  if (!abs) return null;
  // Percent-decode only when it looks encoded — the CLI stores raw paths, so a
  // literal '%' in a filename must not be mangled.
  if (/%[0-9A-Fa-f]{2}/.test(abs)) {
    try {
      abs = decodeURIComponent(abs);
    } catch {
      return null;
    }
  }
  if (abs.includes('\0') || !abs.toLowerCase().endsWith('.md')) return null;
  const rel = relative(resolve(pageRoot), resolve(abs));
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).some((segment) => segment === '..')) return null;
  return rel;
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

    // Prefer the page's recorded `source_path` — the ACTUAL file this row was
    // imported from — over a slug-derived name. Deriving `<slug>.md` mints a
    // SECOND file beside the original whenever the on-disk name isn't the slug,
    // which is the common case for a human-authored vault: `Library/People/
    // Steve Jobs.md` has slug `library/people/steve-jobs`, so a later put_page
    // dropped a lowercase `steve-jobs.md` twin next to it. Two artifacts, one
    // row, and the newer content in whichever the caller didn't expect.
    //
    // It also desyncs `gbrain sync`, which keys delete-reconcile on
    // `source_path` (see collectMissingSourcePaths): the twin is invisible to
    // reconcile, so deleting the ORIGINAL file deletes the page even though a
    // file for it is still on disk.
    //
    // A NULL `source_path` means the page was born via put/capture and has no
    // file of record yet — the slug-derived path stays correct for those.
    const pathRows = await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
      `SELECT source_path, source_uri FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
      [sourceId, slug],
    );
    const recordedPath = sanitizeRecordedSourcePath(pathRows[0]?.source_path);
    const recordedUri = pathRows[0]?.source_uri ?? null;

    if (sourceLocalPath) {
      if (!existsSync(sourceLocalPath) || !statSync(sourceLocalPath).isDirectory()) {
        return { written: false, skipped: 'repo_not_found' };
      }
      filePath = join(
        sourceLocalPath,
        recordedPath ?? recordedPathFromFileUri(recordedUri, sourceLocalPath) ?? `${slug}.md`,
      );
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
      const pageRoot = sourceId === 'default' ? repoPath : join(repoPath, '.sources', sourceId);
      const knownPath = recordedPath ?? recordedPathFromFileUri(recordedUri, pageRoot);
      filePath = knownPath ? join(pageRoot, knownPath) : resolvePageFilePath(repoPath, slug, sourceId);
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

    // #2831: two distinct DB slugs differing only by case (FOO vs foo) resolve
    // to the SAME file on a case-insensitive filesystem — the second write
    // would silently clobber the first slug's artifact. Refuse when the target
    // dir holds a differently-cased entry that the FS folds onto our path:
    // exact-case entry present → normal update, falls through; on a
    // case-sensitive FS the variant path doesn't exist, so the guard is a
    // no-op there.
    const dir = dirname(filePath);
    if (existsSync(dir)) {
      const base = basename(filePath);
      const entries = readdirSync(dir);
      if (!entries.includes(base) && existsSync(filePath)) {
        // The path exists on disk but no exactly-named entry does → the FS
        // folded the name (case, or unicode normalization on APFS) onto a
        // different slug's file.
        const clash =
          entries.find((e) => e.toLowerCase() === base.toLowerCase()) ?? '(normalization variant)';
        opts.logger?.warn(
          `[write-through] case-insensitive collision for ${slug}: '${clash}' already occupies ${filePath} — file not written (DB row is intact)`,
        );
        return { written: false, skipped: 'case_insensitive_collision' };
      }
    }

    // On Bun + Windows, mkdirSync(dir, { recursive: true }) can still throw
    // EEXIST when the directory already exists (POSIX no-ops it). That aborts
    // the put_page / enrich / capture write-through whenever the prefix dir
    // already exists, silently leaving the DB and the .md file plane out of sync.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

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

    // #2426: on a durability-hardened repo (user ran `gbrain sources harden`),
    // commit the artifact so it reaches git — pre-fix, write-through content
    // stayed uncommitted forever: never pushed, `last_sync_at` frozen, and
    // silently deleted by a later `sync --full` delete-reconcile. The local
    // post-commit hook background-pushes the commit. Best-effort: a commit
    // failure never fails the write (the DB row + file are the durable sinks).
    let committed = false;
    let pushed: 'pending' | undefined;
    let lastPushStatus: PushLogOutcome | undefined;
    try {
      if (isDurabilityHardened(writeRoot)) {
        committed = commitWriteThroughFile(writeRoot, filePath, slug);
        if (committed) {
          pushed = 'pending';
          lastPushStatus = getLastPushOutcome(currentBranch(writeRoot));
        }
      }
    } catch { /* best-effort */ }

    return {
      written: true,
      path: filePath,
      ...(committed ? { committed, pushed, lastPushStatus } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.logger?.warn(`[write-through] failed for ${slug}: ${msg}`);
    return { written: false, error: msg };
  }
}

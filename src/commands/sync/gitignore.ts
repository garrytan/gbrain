/** Post-sync `.gitignore` management for db_only directories. */
import { assertManagedFilesystemWrite } from '../../core/persistence/filesystem-guard.ts';
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { serr } from '../../core/console-prefix.ts';
import { loadStorageConfig, findDbOnlyCollisions } from '../../core/storage-config.ts';
import { getConfiguredCollectorOutputs } from '../integrations.ts';
import { discoverGitRoot } from '../../core/sync-git.ts';

/**
 * #753/#774: `.gitignore` must be managed at the git ROOT — when a source's
 * local_path (or --repo) points at a monorepo subdirectory, writing ignore
 * entries into the subdir would create a stray `.gitignore` git doesn't
 * consult for the repo-level db_only rules. Best-effort: falls back to the
 * given path when git discovery fails (manageGitignore no-ops on non-repos).
 */
export function manageGitignoreAtGitRoot(path: string, engineKind?: 'pglite' | 'postgres'): void {
  let root = path;
  try { root = discoverGitRoot(path); } catch { /* best-effort */ }
  try { manageGitignore(root, engineKind); }
  catch (error) {
    // Managed sync already committed through its canonical owner. Ancillary
    // legacy housekeeping must neither write outside that journal nor turn
    // the completed sync into a failure before its JSON acknowledgment.
    if (error instanceof Error && 'code' in error && error.code === 'writer_coordinator_required') {
      serr('[sync] Skipped automatic .gitignore maintenance for the managed worktree.');
      return;
    }
    throw error;
  }
}

/**
 * Auto-manage .gitignore entries for db_only directories.
 *
 * Caller invokes ONLY on successful sync — this function trusts that the
 * sync's data state is consistent. See `runSync` for the gating logic.
 *
 * Idempotent: re-running adds no duplicate entries. The managed block has
 * a stable comment header so it's grep-able and editable.
 *
 * Skipped (with actionable warning) when:
 *   - GBRAIN_NO_GITIGNORE=1 — D23 escape hatch for shared-repo setups
 *   - The repo is a git submodule (`.git` is a file not a directory) —
 *     D49 lock; submodule .gitignore changes don't survive parent updates
 *
 * On PGLite (D4): emits a once-per-process soft-warn explaining that
 * tiering has limited effect — but still manages the .gitignore so the
 * config-present user gets the gitignore housekeeping.
 *
 * Failures (write permission denied, EROFS, etc.) are caught, warned, and
 * swallowed (D9 lock). Sync's primary job is moving data; .gitignore
 * management is a side effect — don't kill the main job for the side effect.
 */
let _pgliteTierWarned = false;
export function __resetPGLiteTierWarn(): void {
  _pgliteTierWarned = false;
}

export function manageGitignore(
  repoPath: string,
  engineKind?: 'pglite' | 'postgres',
): void {
  if (process.env.GBRAIN_NO_GITIGNORE === '1') {
    return;
  }

  assertManagedFilesystemWrite(repoPath);

  // Submodule + worktree detection (closes #889 misclassification).
  // Both submodules and worktrees use `.git` as a FILE (not a directory), so
  // statSync.isFile() doesn't discriminate. Discriminator is the gitdir path
  // segment:
  //   - submodule: gitdir contains `/modules/<name>` (skip — managed by parent)
  //   - worktree:  gitdir contains `/worktrees/<name>` (MANAGE — first-class repo)
  // Both contracts are documented Git internal layouts and stable across all 4
  // {relative, absolute} × {modules, worktrees} combinations, including the
  // absorbed-submodule case from `git submodule absorbgitdirs`.
  // Malformed `.git` file (no `gitdir:` prefix, unreadable) → MANAGE (fail-closed
  // toward managing, preserving the pre-#889 catch{} behavior).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- repoPath is the operator-configured local sync repo (CLI --repo or sources.local_path; sync is localOnly) and '.git' is a constant name
  const dotGit = join(repoPath, '.git');
  if (existsSync(dotGit)) {
    try {
      if (statSync(dotGit).isFile()) {
        const content = readFileSync(dotGit, 'utf-8');
        const match = content.match(/gitdir:\s*(.+)/);
        const gitdir = match ? match[1].trim() : '';
        if (gitdir.includes('/modules/')) {
          console.warn(
            `Note: skipping .gitignore management — ${repoPath} is a git submodule. ` +
              `Add db_only directories to your parent repo's .gitignore manually.`,
          );
          return;
        }
        // Worktree (gitdir contains /worktrees/) OR malformed .git falls through
        // to the existing manage path. Worktrees are first-class repos — they
        // need .gitignore management too. Malformed → MANAGE preserves the
        // pre-#889 fail-closed-toward-managing catch behavior.
      }
    } catch {
      // proceed; can't tell, default to managing
    }
  }

  let storageConfig;
  try {
    storageConfig = loadStorageConfig(repoPath);
  } catch (error) {
    // StorageConfigError (overlap) or read error — surface, don't manage.
    console.warn(
      `Skipped .gitignore update: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!storageConfig || storageConfig.db_only.length === 0) {
    return;
  }

  // #2788: a configured collector whose output dir sits inside a db_only
  // path dies silently — the dir is auto-gitignored below, the git-walking
  // sync never sees its files, and `gbrain import` honors .gitignore too.
  // Warn at the moment the config takes effect. Recipe scan failure never
  // blocks the gitignore housekeeping.
  try {
    for (const c of findDbOnlyCollisions(getConfiguredCollectorOutputs(), storageConfig.db_only)) {
      console.warn(
        `WARNING: collector '${c.id}' writes to '${c.output_path}', which is inside db_only path ` +
          `'${c.db_only_dir}'. db_only dirs are auto-gitignored, so gbrain sync and gbrain import ` +
          `will silently skip its files. Remove the prefix from storage.db_only in gbrain.yml, or ` +
          `move the collector output.`,
      );
    }
  } catch {
    // recipes unavailable in this context — the doctor check still covers it
  }

  // D4 soft-warn: storage tiering has limited effect on PGLite, but the
  // .gitignore housekeeping still helps. Warn once per process; proceed.
  if (engineKind === 'pglite' && !_pgliteTierWarned) {
    _pgliteTierWarned = true;
    console.warn(
      `Note: storage tiering has limited effect on PGLite — pages live in your ` +
        `local database file regardless of tier. Managing .gitignore anyway.`,
    );
  }

  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- repoPath is the operator-configured local sync repo (sync is localOnly) and '.gitignore' is a constant name
  const gitignorePath = join(repoPath, '.gitignore');
  let gitignoreContent = '';

  if (existsSync(gitignorePath)) {
    try {
      gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    } catch (error) {
      console.warn(
        `Could not read ${gitignorePath} (${error instanceof Error ? error.message : String(error)}) — ` +
          `skipping .gitignore update. Add db_only directories manually.`,
      );
      return;
    }
  }

  const existingLines = new Set(gitignoreContent.split('\n').map((line) => line.trim()));
  const linesToAdd: string[] = [];

  for (const dir of storageConfig.db_only) {
    if (!existingLines.has(dir) && !existingLines.has(`/${dir}`)) {
      linesToAdd.push(dir);
    }
  }

  if (linesToAdd.length === 0) return;

  if (gitignoreContent && !gitignoreContent.endsWith('\n')) {
    gitignoreContent += '\n';
  }
  gitignoreContent += '\n# Auto-managed by gbrain (db_only directories)\n';
  gitignoreContent += linesToAdd.join('\n') + '\n';

  try {
    writeFileSync(gitignorePath, gitignoreContent);
  } catch (error) {
    console.warn(
      `Could not update ${gitignorePath} (${error instanceof Error ? error.message : String(error)}) — ` +
        `please add db_only directories manually:\n  ${linesToAdd.join('\n  ')}`,
    );
  }
}

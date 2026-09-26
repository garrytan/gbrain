/**
 * The restore target: where a restore of db_only pages lands and whose pages
 * it restores. Kept out of source-resolver.ts because its messages name
 * export flags (--repo, --restore-only) and nearly every command imports the
 * resolver, so the CLI flag-registry scan would register those flags on all
 * of them. Import it only from the commands that restore or suggest a restore.
 */
import type { BrainEngine } from './engine.ts';
import {
  ALL_SOURCES,
  isResolverUserError,
  resolveDefaultSourceWithPath,
  resolveRegisteredRepoOwner,
} from './source-resolver.ts';

/**
 * Where a restore of db_only pages lands and whose pages it restores. The
 * one rule shared by `gbrain export --restore-only` and the restore hint of
 * `gbrain storage status`, so the hint never names a different source than
 * the restore would pick.
 */
export type RestoreTarget =
  | { ok: true; repoPath: string; /** A source id, or ALL_SOURCES. */ sourceId: string }
  | { ok: false; message: string };

/**
 * Resolve the restore target from an optional repo path and an optional
 * explicit source (an already-validated id, or ALL_SOURCES):
 *  1. `source` set: that source (ALL_SOURCES = every source). The repo is
 *     `repo`, else the source's own local_path; refused when it has none.
 *  2. Neither: the source the flagless resolver chain picks for `cwd`,
 *     with its path (`resolveDefaultSourceWithPath`).
 *  3. `repo` alone: the source registered at that path (active over
 *     archived; dotfiles ignored), else the brain's only active source (an
 *     empty `default` does not count), else refused: pages of some other
 *     source must never land in the repo.
 * This module's user-facing errors (unknown or archived source) come back
 * as refusals, never throws.
 */
export async function resolveRestoreTarget(
  engine: BrainEngine,
  opts: { repo?: string | null; source?: string | null; cwd?: string },
): Promise<RestoreTarget> {
  const cwd = opts.cwd ?? process.cwd();
  let repoPath = opts.repo ?? null;
  let sourceId = opts.source ?? null;
  try {
    if (sourceId && sourceId !== ALL_SOURCES && !repoPath) {
      const rows = await engine.executeRaw<{ local_path: string | null }>(
        `SELECT local_path FROM sources WHERE id = $1`,
        [sourceId],
      );
      repoPath = rows[0]?.local_path ?? null;
      if (!repoPath) {
        return {
          ok: false,
          message:
            `source "${sourceId}" has no local_path, so there is no repo to check for\n` +
            `missing files. Pass --repo <path> for that source's repo.`,
        };
      }
    } else if (sourceId === ALL_SOURCES && !repoPath) {
      repoPath = (await resolveDefaultSourceWithPath(engine, cwd)).path;
    } else if (!sourceId && !repoPath) {
      const resolved = await resolveDefaultSourceWithPath(engine, cwd);
      repoPath = resolved.path;
      sourceId = resolved.sourceId;
      if (!repoPath && sourceId !== 'default' && sourceId !== ALL_SOURCES) {
        return {
          ok: false,
          message:
            `the current source "${sourceId}" has no local_path (a legacy sync.repo_path\n` +
            `belongs to the default source only), so there is no repo to restore into.\n` +
            `Pass --repo <path> for that source's repo, or --source <id>.`,
        };
      }
    } else if (!sourceId && repoPath) {
      sourceId = await resolveRegisteredRepoOwner(engine, repoPath);
      if (!sourceId) {
        // The seeded 'default' counts only when it holds live pages, the same
        // emptiness rule as pickSoleNonDefaultSource (#3070): an untouched
        // default must not block a brain whose content lives in one source.
        const active = await engine.executeRaw<{ id: string }>(
          `SELECT s.id FROM sources s
            WHERE s.archived IS NOT TRUE
              AND (s.id != 'default'
                   OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id = 'default' AND p.deleted_at IS NULL)
                   OR NOT EXISTS (SELECT 1 FROM sources o WHERE o.id != 'default' AND o.archived IS NOT TRUE))
            ORDER BY s.id`,
        );
        if (active.length !== 1) {
          return {
            ok: false,
            message:
              `no registered source has ${repoPath} as its local_path, so the restore\n` +
              `cannot tell whose pages belong in it. Pass --source <id> for that repo's source,\n` +
              `or --source __all__ to restore every source's pages into it.`,
          };
        }
        sourceId = active[0].id;
      }
    }
  } catch (e) {
    if (!isResolverUserError(e)) throw e;
    return { ok: false, message: (e as Error).message };
  }
  if (!repoPath || !sourceId) {
    return {
      ok: false,
      message:
        `--restore-only requires --repo <path> or a configured default source\n` +
        `with a local_path. Run \`gbrain sources list\` to inspect sources, or pass\n` +
        `--repo explicitly.`,
    };
  }
  return { ok: true, repoPath, sourceId };
}

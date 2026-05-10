import { existsSync, realpathSync } from 'fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'path';
import { RESOLVER_FILENAMES, hasResolverFile } from './resolver-filenames.ts';

/**
 * Walk up from `startDir` looking for a `skills/` directory that
 * contains a recognized resolver file (`RESOLVER.md` or `AGENTS.md`).
 * Returns the absolute directory containing `skills/` or null if no
 * such directory is found within 10 levels.
 *
 * `startDir` is parameterized so tests can run hermetically against
 * fixtures. Default matches the prior `doctor.ts`-private implementation.
 */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (hasResolverFile(join(dir, 'skills'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Where auto-detect found the skills directory.
 *   - `explicit`                    — user passed --skills-dir / equivalent
 *   - `openclaw_workspace_env`       — $OPENCLAW_WORKSPACE/skills
 *   - `openclaw_workspace_env_root`  — $OPENCLAW_WORKSPACE/ (AGENTS.md at
 *                                      workspace root; skills in subdir)
 *   - `openclaw_workspace_home`      — ~/.openclaw/workspace/skills
 *   - `openclaw_workspace_home_root` — ~/.openclaw/workspace (root AGENTS.md)
 *   - `repo_root`                    — walked up from cwd, found gbrain repo
 *   - `cwd_skills`                   — ./skills fallback
 */
export type SkillsDirSource =
  | 'openclaw_workspace_env'
  | 'openclaw_workspace_env_root'
  | 'openclaw_workspace_home'
  | 'openclaw_workspace_home_root'
  | 'repo_root'
  | 'cwd_skills';

export interface SkillsDirDetection {
  dir: string | null;
  source: SkillsDirSource | null;
}

/**
 * isPathContained returns true when `child` lexically resolves to a
 * descendant of (or equal to) `parent` after canonicalization. Used by
 * resolveWorkspaceSkillsDir to confirm that the skills dir we are
 * about to hand back to readFileSync / readdirSync callers has not
 * been symlinked outside the declared workspace.
 *
 * Uses the same idiom as src/core/operations.ts:92-100 for upload
 * strict-mode confinement: realpath both ends, then path.relative
 * must produce a non-`..`-prefixed, non-absolute result.
 *
 * On any realpathSync failure (missing dir, EACCES, ELOOP) we fall
 * back to lexical containment via path.relative — better to refuse a
 * legit-but-unstattable workspace than to silently trust an escape.
 */
function isPathContained(parent: string, child: string): boolean {
  let realParent: string;
  let realChild: string;
  try {
    realParent = realpathSync(parent);
    realChild = realpathSync(child);
  } catch {
    // Lexical fallback: at minimum confirm the unresolved paths look
    // contained. This catches the obvious escape attempts even when
    // realpath cannot run (e.g. the symlink target does not yet exist).
    realParent = resolvePath(parent);
    realChild = resolvePath(child);
  }
  const rel = relative(realParent, realChild);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Given a workspace root, resolve where the skills directory should
 * live. Returns the skills dir + the specific source variant. Returns
 * null if neither `workspace/skills/<RESOLVER|AGENTS>` nor
 * `workspace/<AGENTS|RESOLVER>` exists.
 *
 * Symlink confinement: the resolved skills dir must canonicalize to a
 * path under the workspace root. Without this, an attacker who controls
 * `$OPENCLAW_WORKSPACE` (multi-user host, npm postinstall, shell-rc
 * poisoning) could plant `workspace/skills` as a symlink to an
 * arbitrary directory. Downstream readFileSync / readdirSync calls
 * follow symlinks by default, so the resolver, skillpack-check, and
 * subagent loader would then read attacker-controlled SKILL.md files
 * believing they came from the workspace.
 *
 * `sourceSubdir` / `sourceRoot` let callers distinguish "skills-dir
 * variant" from "workspace-root variant" for --verbose logging.
 */
function resolveWorkspaceSkillsDir(
  workspace: string,
  sourceSubdir: SkillsDirSource,
  sourceRoot: SkillsDirSource,
): SkillsDirDetection | null {
  // Preferred: workspace/skills with a resolver file inside it (gbrain-native).
  const subdir = join(workspace, 'skills');
  if (hasResolverFile(subdir) && isPathContained(workspace, subdir)) {
    return { dir: subdir, source: sourceSubdir };
  }
  // Fallback: resolver file at workspace root (OpenClaw-native layout).
  // The skills/ subtree still governs file layout even when routing lives
  // at workspace root. Return the skills subdir so downstream file lookups
  // work; the resolver parser knows how to look one level up.
  if (hasResolverFile(workspace) && existsSync(subdir) && isPathContained(workspace, subdir)) {
    return { dir: subdir, source: sourceRoot };
  }
  return null;
}

/**
 * Auto-detect the skills directory. Priority (D-CX-4, post-codex-review):
 *   1. $OPENCLAW_WORKSPACE when explicitly set (env > repo-root walk)
 *   2. ~/.openclaw/workspace/ (user's default OpenClaw deployment)
 *   3. findRepoRoot() walk from cwd (gbrain's own repo)
 *   4. ./skills fallback (dev scratch, fixtures)
 *
 * The prior order put `findRepoRoot` first, which meant
 * `export OPENCLAW_WORKSPACE=...; gbrain check-resolvable` run from
 * inside the gbrain repo silently shadowed the env var by walking up
 * to gbrain's own skills/. Explicit env should win. Unset env → behavior
 * is unchanged from before.
 *
 * `startDir` + `env` params keep tests hermetic.
 */
export function autoDetectSkillsDir(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): SkillsDirDetection {
  // 1. $OPENCLAW_WORKSPACE wins when explicitly set.
  if (env.OPENCLAW_WORKSPACE) {
    const workspace = isAbsolute(env.OPENCLAW_WORKSPACE)
      ? env.OPENCLAW_WORKSPACE
      : resolvePath(startDir, env.OPENCLAW_WORKSPACE);
    const resolved = resolveWorkspaceSkillsDir(
      workspace,
      'openclaw_workspace_env',
      'openclaw_workspace_env_root',
    );
    if (resolved) return resolved;
  }

  // 2. ~/.openclaw/workspace as the default user-level OpenClaw deployment.
  if (env.HOME) {
    const workspace = join(env.HOME, '.openclaw', 'workspace');
    const resolved = resolveWorkspaceSkillsDir(
      workspace,
      'openclaw_workspace_home',
      'openclaw_workspace_home_root',
    );
    if (resolved) return resolved;
  }

  // 3. gbrain repo walk from cwd.
  const repoRoot = findRepoRoot(startDir);
  if (repoRoot && isGbrainRepoRoot(repoRoot)) {
    return { dir: join(repoRoot, 'skills'), source: 'repo_root' };
  }

  // 4. ./skills fallback.
  const cwdSkills = join(startDir, 'skills');
  if (hasResolverFile(cwdSkills)) {
    return { dir: cwdSkills, source: 'cwd_skills' };
  }

  return { dir: null, source: null };
}

function isGbrainRepoRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'src', 'cli.ts')) &&
    hasResolverFile(join(dir, 'skills'))
  );
}

/**
 * Human-readable summary of the resolver-file search paths, for error
 * messages when auto-detect fails. Mirrors the priority order used by
 * `autoDetectSkillsDir`.
 */
/** Exposed for tests. */
export const __testing = {
  isPathContained,
};

export const AUTO_DETECT_HINT = [
  `  1. --skills-dir flag`,
  `  2. $OPENCLAW_WORKSPACE/{skills/,}{${RESOLVER_FILENAMES.join(',')}}`,
  `  3. ~/.openclaw/workspace/{skills/,}{${RESOLVER_FILENAMES.join(',')}}`,
  `  4. repo root with skills/${RESOLVER_FILENAMES.join(' or skills/')}`,
  `  5. ./skills/${RESOLVER_FILENAMES.join(' or ./skills/')}`,
].join('\n');

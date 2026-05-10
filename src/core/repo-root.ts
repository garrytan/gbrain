import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { isAbsolute, join, resolve as resolvePath } from 'path';
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
 *   - `env_explicit`                 — $GBRAIN_SKILLS_DIR (operator override; v0.31.7)
 *   - `openclaw_workspace_env`       — $OPENCLAW_WORKSPACE/skills
 *   - `openclaw_workspace_env_root`  — $OPENCLAW_WORKSPACE/ (AGENTS.md at
 *                                      workspace root; skills in subdir)
 *   - `openclaw_workspace_home`      — ~/.openclaw/workspace/skills
 *   - `openclaw_workspace_home_root` — ~/.openclaw/workspace (root AGENTS.md)
 *   - `repo_root`                    — walked up from cwd, found gbrain repo
 *   - `cwd_skills`                   — ./skills fallback
 *   - `install_path`                 — walked up from this module's install
 *                                      path; READ-ONLY callers only (v0.31.7)
 */
export type SkillsDirSource =
  | 'env_explicit'
  | 'openclaw_workspace_env'
  | 'openclaw_workspace_env_root'
  | 'openclaw_workspace_home'
  | 'openclaw_workspace_home_root'
  | 'repo_root'
  | 'cwd_skills'
  | 'install_path';

export interface SkillsDirDetection {
  dir: string | null;
  source: SkillsDirSource | null;
}

/**
 * Given a workspace root, resolve where the skills directory should
 * live. Returns the skills dir + the specific source variant. Returns
 * null if neither `workspace/skills/<RESOLVER|AGENTS>` nor
 * `workspace/<AGENTS|RESOLVER>` exists.
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
  if (hasResolverFile(subdir)) {
    return { dir: subdir, source: sourceSubdir };
  }
  // Fallback: resolver file at workspace root (OpenClaw-native layout).
  // The skills/ subtree still governs file layout even when routing lives
  // at workspace root. Return the skills subdir so downstream file lookups
  // work; the resolver parser knows how to look one level up.
  if (hasResolverFile(workspace) && existsSync(subdir)) {
    return { dir: subdir, source: sourceRoot };
  }
  return null;
}

/**
 * Auto-detect the skills directory. Priority (v0.31.7 read+write-safe order):
 *   0. $GBRAIN_SKILLS_DIR explicit operator override (any caller)
 *   1. $OPENCLAW_WORKSPACE when explicitly set (env > repo-root walk)
 *   2. ~/.openclaw/workspace/ (user's default OpenClaw deployment)
 *   3. findRepoRoot() walk from cwd (gbrain's own repo)
 *   4. ./skills fallback (dev scratch, fixtures)
 *
 * Tier 0 ($GBRAIN_SKILLS_DIR) is safe for both read and write paths because
 * the operator explicitly set the variable — opt-in retargeting is fine. The
 * silent retargeting risk that motivates `autoDetectSkillsDirReadOnly` is
 * about implicit fallback to install-path when no explicit signal is set.
 *
 * The prior order put `findRepoRoot` first, which meant
 * `export OPENCLAW_WORKSPACE=...; gbrain check-resolvable` run from
 * inside the gbrain repo silently shadowed the env var by walking up
 * to gbrain's own skills/. Explicit env should win. Unset env → behavior
 * is unchanged from before.
 *
 * Write-path callers (skillpack install, skillify scaffold,
 * post-install-advisory) MUST use this function, not the read-only variant —
 * a write-path install-path fallback would let `gbrain skillpack install`
 * from `~` silently target the bundled gbrain repo's skills/ instead of the
 * user's workspace.
 *
 * `startDir` + `env` params keep tests hermetic.
 */
export function autoDetectSkillsDir(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): SkillsDirDetection {
  // 0. $GBRAIN_SKILLS_DIR explicit operator override. Safe for all callers
  //    because the operator explicitly set the env var. Does NOT support the
  //    `workspace-root with AGENTS.md + skills/ sibling` shape — operator who
  //    wants that should point the env var at the skills/ dir directly.
  if (env.GBRAIN_SKILLS_DIR) {
    const explicit = isAbsolute(env.GBRAIN_SKILLS_DIR)
      ? env.GBRAIN_SKILLS_DIR
      : resolvePath(startDir, env.GBRAIN_SKILLS_DIR);
    if (hasResolverFile(explicit)) {
      return { dir: explicit, source: 'env_explicit' };
    }
    // Fall through — invalid env override doesn't crash, lets lower tiers try.
  }

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
 * Read-only skills-dir detection (v0.31.7). Wraps `autoDetectSkillsDir` and
 * adds an install-path fallback when the primary detection returns null —
 * walks up from this module's install location to find a gbrain repo root,
 * gated by `isGbrainRepoRoot` to avoid false-positive on unrelated repos.
 *
 * Use this from READ-ONLY callers only: `gbrain doctor`,
 * `gbrain check-resolvable`, `gbrain routing-eval`. Never from write paths.
 *
 * Why a separate function? `autoDetectSkillsDir` is shared with write paths
 * (`skillpack install`, `skillify scaffold`, `post-install-advisory`).
 * Adding the install-path fallback to the shared function would let
 * `gbrain skillpack install` from `~` silently target the bundled gbrain
 * repo's skills/ instead of the user's actual workspace — a quiet data-flow
 * regression. Read-only callers don't write anything to the resolved path,
 * so the install-path fallback is safe for them.
 *
 * Closes the install-path footgun for hosted-CLI installs (`bun install -g
 * github:garrytan/gbrain && cd ~ && gbrain doctor`) without expanding the
 * blast radius to write-path callers.
 */
export function autoDetectSkillsDirReadOnly(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): SkillsDirDetection {
  const primary = autoDetectSkillsDir(startDir, env);
  if (primary.dir) return primary;

  // Tier-5 install-path fallback: walk up from this module's install
  // location. Gate with isGbrainRepoRoot so we don't false-positive when
  // the install path lives inside an unrelated repo (e.g., a monorepo
  // that vendored gbrain in a subdir).
  try {
    const moduleDir = fileURLToPath(import.meta.url);
    const installRoot = findRepoRoot(moduleDir);
    if (installRoot && isGbrainRepoRoot(installRoot)) {
      return { dir: join(installRoot, 'skills'), source: 'install_path' };
    }
  } catch {
    // fileURLToPath can throw on malformed import.meta.url (rare; some
    // bundlers/runtimes). Fall through to the null detection — better to
    // refuse the fallback than to fabricate a path.
  }

  return primary; // null detection, source: null
}

/**
 * Human-readable summary of the resolver-file search paths, for error
 * messages when auto-detect fails. Mirrors the priority order used by
 * `autoDetectSkillsDir`.
 */
export const AUTO_DETECT_HINT = [
  `  1. --skills-dir flag`,
  `  2. $GBRAIN_SKILLS_DIR (explicit operator override)`,
  `  3. $OPENCLAW_WORKSPACE/{skills/,}{${RESOLVER_FILENAMES.join(',')}}`,
  `  4. ~/.openclaw/workspace/{skills/,}{${RESOLVER_FILENAMES.join(',')}}`,
  `  5. repo root with skills/${RESOLVER_FILENAMES.join(' or skills/')}`,
  `  6. ./skills/${RESOLVER_FILENAMES.join(' or ./skills/')}`,
].join('\n');

/**
 * Read-only auto-detect hint. Includes the install-path fallback that
 * `autoDetectSkillsDirReadOnly` adds for `gbrain doctor` /
 * `gbrain check-resolvable` / `gbrain routing-eval`.
 */
export const AUTO_DETECT_HINT_READ_ONLY = [
  AUTO_DETECT_HINT,
  `  7. (read-only) walk up from gbrain's install path`,
].join('\n');

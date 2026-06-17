/**
 * Brain resolution for CLI commands (v0.19.0, PR 0).
 *
 * Mirrors the 6-tier resolution pattern of v0.18.0's source-resolver.ts so
 * agents learn one mental model. `--brain <id>` picks WHICH DATABASE to
 * target (mounts + host). `--source <id>` (v0.18.0) picks WHICH REPO WITHIN
 * the selected brain. Orthogonal axes.
 *
 * Resolution priority (highest first):
 *   1. Explicit --brain <id> flag (caller passes this as `explicit`).
 *   2. GBRAIN_BRAIN_ID env var.
 *   3. .gbrain-mount dotfile in CWD or any ancestor directory.
 *   4. Registered mount whose `path` contains CWD (longest-prefix match).
 *   5. Brain-level default (future: ~/.gbrain/config.json `brains.default`).
 *   6. Literal 'host' fallback (backward compat for every pre-v0.19 brain).
 *
 * Consumed by src/cli.ts, src/mcp/server.ts, and any future command that
 * needs per-call brain selection. The subagent handler inherits the
 * parent's brainId instead of re-running this resolver.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { HOST_BRAIN_ID, loadMounts, validateMountId, type MountEntry } from './brain-registry.ts';

const DOTFILE = '.gbrain-mount';
/** Same regex as brain-registry. Kept in sync. */
const BRAIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Walk up from startDir looking for a .gbrain-mount dotfile. Returns the
 * first valid id found, or null if none. Guards against filesystem-root
 * infinite loops and malformed dotfiles (silent skip + continue walking).
 */
function readDotfileWalk(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 50; i++) {
    const candidate = join(dir, DOTFILE);
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf8').trim().split('\n')[0].trim();
        if (content === HOST_BRAIN_ID) return content;
        if (BRAIN_ID_RE.test(content)) return content;
      } catch {
        // Unreadable dotfile — skip and keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/** Longest-prefix match: find the mount whose `path` contains `cwd`. */
function longestPathPrefixMount(mounts: MountEntry[], cwd: string): MountEntry | null {
  const cwdResolved = resolve(cwd);
  let best: { mount: MountEntry; pathLen: number } | null = null;
  for (const m of mounts) {
    if (m.enabled === false) continue;
    const p = resolve(m.path);
    if (cwdResolved === p || cwdResolved.startsWith(p + '/')) {
      if (!best || p.length > best.pathLen) {
        best = { mount: m, pathLen: p.length };
      }
    }
  }
  return best ? best.mount : null;
}

/**
 * Resolve the brain id for a CLI command. Never returns null — every call
 * targets exactly one brain, with 'host' as the guaranteed terminal fallback.
 *
 * @param explicit  The --brain <id> flag value, if the caller parsed one.
 * @param cwd  Working directory for .gbrain-mount walk. Defaults to process.cwd().
 * @param mountsLoader  Override for testability. Returns the list of enabled
 *                      mounts. Defaults to reading ~/.gbrain/mounts.json.
 * @returns  The resolved brain id. Always truthy. Either 'host' or a valid mount id.
 *
 * Does NOT validate that the id points at a registered mount — that is
 * BrainRegistry.getBrain's job. This resolver answers "which id is the
 * caller asking for?"; the registry answers "does that id exist?".
 */
export function resolveBrainId(
  explicit: string | null | undefined,
  cwd: string = process.cwd(),
  mountsLoader: () => MountEntry[] = loadMounts,
): string {
  // 1. Explicit flag wins.
  if (explicit) {
    if (explicit === HOST_BRAIN_ID) return HOST_BRAIN_ID;
    validateMountId(explicit, '--brain value');
    return explicit;
  }

  // 2. Env var.
  const env = process.env.GBRAIN_BRAIN_ID;
  if (env && env.length > 0) {
    if (env === HOST_BRAIN_ID) return HOST_BRAIN_ID;
    validateMountId(env, 'GBRAIN_BRAIN_ID');
    return env;
  }

  // 3. Dotfile walk-up.
  const dotfile = readDotfileWalk(cwd);
  if (dotfile) return dotfile;

  // 4. Registered mount path-prefix.
  let mounts: MountEntry[] = [];
  try {
    mounts = mountsLoader();
  } catch {
    // mounts.json corruption shouldn't break brain resolution — fall through
    // to 'host'. BrainRegistry.getBrain will throw the actionable error if
    // the caller actually tried to touch a mount.
    mounts = [];
  }
  const matched = longestPathPrefixMount(mounts, cwd);
  if (matched) return matched.id;

  // 5. Brain-level default — v2. Not wired in PR 0.
  // 6. Fallback.
  return HOST_BRAIN_ID;
}

/** Exposed for tests. */
export const __testing = {
  readDotfileWalk,
  longestPathPrefixMount,
  DOTFILE,
  BRAIN_ID_RE,
};

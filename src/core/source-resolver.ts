/**
 * Source resolution for CLI commands (v0.18.0).
 *
 * Resolution priority (highest first):
 *   1. Explicit --source <id> flag (caller passes this as `explicit`)
 *   2. GBRAIN_SOURCE env var
 *   3. .gbrain-source dotfile in CWD or any ancestor directory
 *   4. Registered source whose local_path contains CWD
 *   5. Brain-level default via `gbrain sources default <id>`
 *   6. Literal 'default' (backward compat for pre-v0.17 brains)
 *
 * This helper is shared by the sources CLI, future sync/extract/query
 * commands (Steps 4/5), and the operation layer (Step 2+).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import type { BrainEngine } from './engine.ts';

const DOTFILE = '.gbrain-source';
// Must start + end with alnum, interior dashes allowed. Max 32 chars.
// Single-char alnum is also valid. Kebab-case enforced so citation keys
// like `[wiki:slug]` can't have ugly edges like `[wiki-:slug]`.
const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function readDotfileWalk(startDir: string): string | null {
  let dir = resolve(startDir);
  // Guard against infinite loops on malformed paths.
  for (let i = 0; i < 50; i++) {
    const candidate = join(dir, DOTFILE);
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf8').trim().split('\n')[0].trim();
        if (SOURCE_ID_RE.test(content)) return content;
      } catch {
        // Unreadable dotfile — skip and keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Resolve the source id for a CLI command.
 *
 * @param engine  Connected brain engine (for sources table lookups).
 * @param explicit  The --source <id> flag value, if the caller parsed one.
 * @param cwd  The working directory to walk for .gbrain-source. Defaults
 *             to process.cwd(). Exposed for testability.
 * @returns  The resolved source id. Falls back to 'default' if no other
 *           signal is present. Never returns null — every command must
 *           target exactly one default source.
 * @throws  If the resolved id doesn't correspond to a registered source
 *          (prevents silently writing to a nonexistent source and bloating
 *          pages with a dead FK).
 */
export async function resolveSourceId(
  engine: BrainEngine,
  explicit: string | null | undefined,
  cwd: string = process.cwd(),
): Promise<string> {
  // 1. Explicit flag wins.
  if (explicit) {
    if (!SOURCE_ID_RE.test(explicit)) {
      throw new Error(`Invalid --source value "${explicit}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, explicit);
    return explicit;
  }

  // 2. Env var.
  const env = process.env.GBRAIN_SOURCE;
  if (env && env.length > 0) {
    if (!SOURCE_ID_RE.test(env)) {
      throw new Error(`Invalid GBRAIN_SOURCE value "${env}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, env);
    return env;
  }

  // 3. .gbrain-source dotfile walk-up.
  const dotfile = readDotfileWalk(cwd);
  if (dotfile) {
    await assertSourceExists(engine, dotfile);
    return dotfile;
  }

  // 4. Registered source whose local_path contains CWD.
  //    Uses longest-prefix match so nested-path configurations (e.g.
  //    gstack at ~/gstack + plans at ~/gstack/plans) pick the deepest.
  const registered = await engine.executeRaw<{ id: string; local_path: string }>(
    `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
  );
  const cwdResolved = resolve(cwd);
  let best: { id: string; pathLen: number } | null = null;
  for (const r of registered) {
    const p = resolve(r.local_path);
    if (cwdResolved === p || cwdResolved.startsWith(p + '/')) {
      if (!best || p.length > best.pathLen) {
        best = { id: r.id, pathLen: p.length };
      }
    }
  }
  if (best) return best.id;

  // 5. Brain-level default.
  const globalDefault = await engine.getConfig('sources.default');
  if (globalDefault && SOURCE_ID_RE.test(globalDefault)) {
    await assertSourceExists(engine, globalDefault);
    return globalDefault;
  }

  // 6. Fallback: the seeded 'default' source. Always exists post-migration
  //    v16 so this is a safe terminal.
  return 'default';
}

async function assertSourceExists(engine: BrainEngine, id: string): Promise<void> {
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) {
    throw new Error(
      `Source "${id}" not found. Available sources: ` +
      `run \`gbrain sources list\` to see registered sources, ` +
      `or \`gbrain sources add ${id}\` to create it.`,
    );
  }
}

/** Exposed for tests. */
export const __testing = {
  readDotfileWalk,
  SOURCE_ID_RE,
};

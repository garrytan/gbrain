/**
 * resolver-filenames.ts — shared filename policy for the resolver file.
 *
 * gbrain-native convention: `RESOLVER.md`. OpenClaw convention (per
 * essay referenced in CLAUDE.md): `AGENTS.md`. Both are valid at the
 * same path (skills dir or workspace root for the OpenClaw layout).
 * When both exist at a location, `RESOLVER.md` wins by policy —
 * gbrain-native precedence keeps gbrain's own repo unaffected.
 *
 * One source of truth. Imported by `repo-root.ts` (auto-detect) and
 * `check-resolvable.ts` (parser + error messages). Never hardcode
 * `RESOLVER.md` in new code — import from here.
 */

import { existsSync } from 'fs';
import { join } from 'path';

/** Ordered: first-match wins. Do not reorder without updating tests. */
export const RESOLVER_FILENAMES = ['RESOLVER.md', 'AGENTS.md'] as const;

export type ResolverFilename = (typeof RESOLVER_FILENAMES)[number];

/**
 * Return the first existing resolver file in `dir`, or null.
 * Pass the directory — this function joins for you.
 */
export function findResolverFile(dir: string): string | null {
  for (const name of RESOLVER_FILENAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** True iff `dir` contains at least one recognized resolver file. */
export function hasResolverFile(dir: string): boolean {
  return findResolverFile(dir) !== null;
}

/**
 * Human-readable list for error messages. Example:
 *   "RESOLVER.md or AGENTS.md"
 */
export const RESOLVER_FILENAMES_LABEL = RESOLVER_FILENAMES.join(' or ');

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Walk up from `startDir` looking for `skills/RESOLVER.md` — the marker of a
 * gbrain repo root. Returns the absolute directory containing `skills/` or
 * null if no such directory is found within 10 levels.
 *
 * `startDir` is parameterized so tests can run hermetically against fixtures.
 * Default matches the prior `doctor.ts`-private implementation.
 */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'skills', 'RESOLVER.md'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

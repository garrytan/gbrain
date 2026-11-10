/**
 * The skill resolver library as one dependency-free ES module for Node
 * adapters, built from this gbrain's own source so an adapter runs the same
 * code as the CLI. Used by `gbrain skills library` (written under the gbrain
 * home) and scripts/build-skill-resolver-bundle.ts (the release asset).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ResolverError } from '../core/skills/resolver/errors.ts';

export const LIBRARY_FILE = 'gbrain-skill-resolver.mjs';
const ENTRY = resolve(import.meta.dir, '../core/skills/resolver/index.ts');

export interface LibraryBuild { path: string; sha256: string; bytes: number }

/** Build the bundle to `out` (atomically: a reader never sees half a file). */
export async function buildResolverLibrary(out: string): Promise<LibraryBuild> {
  if (!existsSync(ENTRY)) {
    throw new ResolverError('skill_source_unreadable', 'This gbrain is a compiled binary without its source, so it cannot build the Node library.',
      { suggestion: `Download ${LIBRARY_FILE} and ${LIBRARY_FILE}.sha256 from this version's GitHub release, or run gbrain skills library from a source install (bun install -g github:garrytan/gbrain).` });
  }
  const dir = dirname(out);
  mkdirSync(dir, { recursive: true });
  const tmp = `.${basename(out)}.tmp-${process.pid}`;
  const result = await Bun.build({ entrypoints: [ENTRY], target: 'node', format: 'esm', outdir: dir, naming: tmp });
  if (!result.success) {
    rmSync(join(dir, tmp), { force: true });
    throw new Error(`the skill resolver library did not build: ${result.logs.map(String).join('; ')}`);
  }
  renameSync(join(dir, tmp), out);
  const bytes = readFileSync(out);
  return { path: out, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

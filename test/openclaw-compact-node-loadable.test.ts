/**
 * OpenClaw loads the context engine under Node (jiti), not Bun. Node cannot
 * load Bun's `with { type: 'file' }` asset imports (tree-sitter wasm, schema
 * pack yaml), so a module that statically reaches one throws on import, and
 * compact() turns that throw into `{ status: 'skipped', reason: 'error' }`
 * after the segment is spooled: the checkpoint never banks. Every module the
 * compaction checkpoint lazy-loads must keep its static import closure free of
 * Bun asset imports; segmented-storage code that needs the chunker loads it
 * lazily on the branch that writes a segmented page.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

const COMPACTION_PATH = [
  'src/core/config.ts',
  'src/core/gbrain-home.ts',
  'src/core/secret-scan.ts',
  'src/core/source-resolver.ts',
  'src/core/sweep.ts',
  'src/core/context/capture-consent.ts',
  'src/core/context/corpus-segments.ts',
  'src/core/context/corpus-source.ts',
  'src/core/context/corpus-windows.ts',
  'src/core/context/hook-heartbeat.ts',
  'src/core/context/reflex.ts',
  'src/core/context/resolve-ipc.ts',
  'src/core/context/seat.ts',
  'src/core/context/session-state.ts',
  'src/core/facts/backstop.ts',
  'src/core/facts/extract.ts',
  'src/core/facts/extraction-availability.ts',
  'src/core/persistence/filesystem-guard.ts',
];

function resolveImport(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, join(base, 'index.ts')].find((path) => existsSync(path) && statSync(path).isFile()) ?? base;
}

/** The import chain from `entry` to a Bun asset import over static edges only, or null. */
function assetChain(entry: string): string[] | null {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    // test-reads-source-ok[structural]: Node-loadability is a property of the static import graph; Bun loads these assets itself, so no in-process run can reproduce the host's import failure.
    for (const { path, kind } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (kind === 'dynamic-import' || !path.startsWith('.')) continue;
      const target = resolveImport(file, path);
      if (!/\.(ts|js|mjs|json|node)$/.test(target)) {
        const chain = [`${relative(root, file)} -> ${path}`];
        for (let at = parent.get(file); at; at = parent.get(at)!) chain.unshift(relative(root, at));
        return chain;
      }
      if (/\.(ts|js|mjs)$/.test(target) && !parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  return null;
}

describe('OpenClaw compaction checkpoint stays loadable under Node', () => {
  for (const module of COMPACTION_PATH) {
    test(`${module} reaches no Bun asset import statically`, () => {
      expect(existsSync(join(root, module))).toBe(true);
      expect(assetChain(join(root, module))).toBeNull();
    });
  }

  test('the guard detects a Bun asset import', () => {
    expect(assetChain(join(root, 'src/core/markdown-chunks.ts'))).toEqual([
      'src/core/markdown-chunks.ts',
      'src/core/chunkers/code.ts -> ../../assets/wasm/tree-sitter.wasm',
    ]);
  });
});

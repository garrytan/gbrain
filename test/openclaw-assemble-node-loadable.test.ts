/**
 * #6906: OpenClaw loads the context engine under Node (jiti), not Bun. Node
 * cannot load Bun-only imports: `with { type: 'file' }` assets (schema-pack
 * yaml, tree-sitter wasm) or the `bun` / `bun:*` modules. A module whose static
 * import closure reaches one throws on import, and assemble() fails open
 * around it, so the context it would have added disappears without an error.
 *
 * Boundary, derived from source so a new entry or lazy load is covered without
 * editing this test:
 *   - roots: every OpenClaw extension entry in package.json, plus every module
 *     named by a relative `import()` / `require()` call site in
 *     src/core/context-engine.ts or in a module it statically imports (the
 *     lanes assemble() runs every turn: reflex, openclaw-core, backup status);
 *   - edges: static value imports and re-exports only. scanImports drops
 *     type-only imports, which Node never loads. Lazy loads deeper than the
 *     roots are separate load points and are not followed (following them all
 *     reaches src/cli.ts and the whole CLI).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const CONTEXT_ENGINE = join(root, 'src/core/context-engine.ts');

function imports(file: string) {
  // test-reads-source-ok[structural]: Node-loadability is a property of the static import graph; Bun loads these assets itself, so no in-process run can reproduce the host's import failure.
  return transpiler.scanImports(readFileSync(file, 'utf8'));
}

function resolveImport(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, join(base, 'index.ts')].find((path) => existsSync(path) && statSync(path).isFile()) ?? base;
}

function isCode(path: string): boolean {
  return /\.(ts|js|mjs)$/.test(path);
}

function staticImports(file: string): string[] {
  return imports(file)
    .filter(({ path, kind }) => kind === 'import-statement' && path.startsWith('.'))
    .map(({ path }) => resolveImport(file, path))
    .filter(isCode);
}

function lazyImports(file: string): string[] {
  return imports(file)
    .filter(({ path, kind }) => (kind === 'dynamic-import' || kind === 'require-call') && path.startsWith('.'))
    .map(({ path }) => resolveImport(file, path));
}

function boundaryRoots(): string[] {
  // test-reads-source-ok[structural]: the OpenClaw host loads the extension entries package.json names.
  const entries: string[] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).openclaw.extensions;
  const laneFiles = [CONTEXT_ENGINE, ...staticImports(CONTEXT_ENGINE)];
  return [...new Set([...entries.map((entry) => resolve(root, entry)), ...laneFiles.flatMap(lazyImports)])];
}

/** The first static import chain from `roots` to a Bun-only import, or null. */
function bunOnlyChain(roots: string[]): string[] | null {
  const parent = new Map<string, string | null>(roots.map((r) => [r, null]));
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift()!;
    for (const { path, kind } of imports(file)) {
      if (kind !== 'import-statement') continue;
      const target = path.startsWith('.') ? resolveImport(file, path) : null;
      const bunOnly = path === 'bun' || path.startsWith('bun:') || (target !== null && !/\.(ts|js|mjs|json|node)$/.test(target));
      if (bunOnly) {
        const chain = [`${relative(root, file)} -> ${path}`];
        for (let at = parent.get(file); at; at = parent.get(at)!) chain.unshift(relative(root, at));
        return chain;
      }
      if (target && isCode(target) && !parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  return null;
}

describe('OpenClaw assemble() path stays loadable under Node (#6906)', () => {
  test('the boundary is derived from the real entry and lazy-load sites', () => {
    const roots = boundaryRoots().map((r) => relative(root, r));
    for (const module of roots) expect(existsSync(join(root, module))).toBe(true);
    expect(roots).toContain('src/openclaw-context-engine.ts');
    expect(roots).toContain('src/core/context/resolve-ipc.ts');
    expect(roots).toContain('src/core/context/session-state.ts');
    expect(roots).toContain('src/core/engine-factory.ts');
    expect(roots.length).toBeGreaterThan(20);
  });

  test('no root reaches a Bun-only import over static imports', () => {
    expect(bunOnlyChain(boundaryRoots())).toBeNull();
  });

  test('the guard detects a Bun file-asset import', () => {
    expect(bunOnlyChain([join(root, 'src/core/schema-pack/load-active.ts')])).toEqual([
      'src/core/schema-pack/load-active.ts',
      'src/core/schema-pack/bundled-assets.ts -> ./base/gbrain-base.yaml',
    ]);
  });

  test('the guard detects an import of the bun module', () => {
    expect(bunOnlyChain([join(root, 'src/core/ai/providers/claude-cli-language-model.ts')])).toEqual([
      'src/core/ai/providers/claude-cli-language-model.ts -> bun',
    ]);
  });
});

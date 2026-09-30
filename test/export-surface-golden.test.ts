/**
 * Export-surface golden (refactor wave 1: O13).
 *
 * Protects: downstream consumers need zero import edits. Every package.json
 * `exports` subpath keeps the same runtime export names and the same
 * .d.ts-level type surface; `PGLiteEngine` / `PostgresEngine` keep every
 * prototype method; an external consumer importing through package names
 * still resolves (runtime here, types via `bun run typecheck`).
 * Fails when: a peel/move drops or renames an export, changes an exported
 * signature or member type, or removes an engine method.
 * Why new: test/public-exports.test.ts pins only 1-3 canaries per subpath.
 * Normalizers: `export-runtime-v1` (identity over sorted names) and
 * `export-types-v1` (checker-printed signatures with `import("<path>").`
 * qualifiers stripped so a declaration moving between files is not a
 * surface change; printing depends on the pinned TypeScript 5.9 / bun-types);
 * both proven stable by double capture.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { exportSubpaths, prototypeChainMethods, runtimeExports, typeSurface, type TypeSurfaceEntry } from './helpers/export-surface.ts';

const runtimeNormalizer = defineNormalizer('export-runtime-v1', (v: unknown) => v);
const typesNormalizer = defineNormalizer('export-types-v1', (v: Record<string, TypeSurfaceEntry[]>) => v);
const CONSUMER = join(import.meta.dir, 'fixtures', 'export-consumer', 'consumer.ts');

describe('export-surface golden', () => {
  test('runtime export names per subpath and engine prototype methods match master', async () => {
    const capture = async () => ({
      subpaths: await runtimeExports(),
      prototypes: {
        PGLiteEngine: prototypeChainMethods(PGLiteEngine),
        PostgresEngine: prototypeChainMethods(PostgresEngine),
      },
    });
    const surface = await expectNormalizerStable(capture, runtimeNormalizer);
    expect(Object.keys(surface.subpaths).length).toBe(exportSubpaths().length);
    expectGolden('exports/runtime', surface, runtimeNormalizer);
  });

  test('.d.ts-level type surface per subpath matches master', async () => {
    const surface = await expectNormalizerStable(() => typeSurface(), typesNormalizer);
    expectGolden('exports/types', surface, typesNormalizer);
  }, 120_000);

  test('external consumer fixture imports every subpath through the package name', async () => {
    const text = readFileSync(CONSUMER, 'utf8');
    const sf = ts.createSourceFile(CONSUMER, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const specifiers = sf.statements
      .filter(ts.isImportDeclaration)
      .map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    for (const s of specifiers) expect(s === 'gbrain' || s.startsWith('gbrain/')).toBe(true);
    for (const { specifier } of exportSubpaths()) expect(specifiers).toContain(specifier);
    const consumer = (await import(CONSUMER)) as { RUNTIME_IMPORTS: readonly unknown[] };
    expect(consumer.RUNTIME_IMPORTS.length).toBe(exportSubpaths().length);
    for (const value of consumer.RUNTIME_IMPORTS) expect(value).toBeDefined();
  });
});

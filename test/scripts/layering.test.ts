/**
 * T-G9 (refactor wave 1, EO10): scripts/check-layering.ts keeps
 * src/core/engine-sql/ from importing an engine façade and
 * src/core/schema-migrations/ from importing migrate.ts, and the write commit
 * path in src/core/persistence/ from importing the model gateway, in every
 * import form.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-layering.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-layering-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const r = spawnSync('bun', [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('check-layering.ts', () => {
  test.each([
    ['static import', "import { a } from '../postgres-engine.ts';"],
    ['type-only import', "import type { PostgresEngine } from '../postgres-engine';"],
    ['export-from', "export * from '../engine-factory.ts';"],
    ['dynamic import', "export const f = () => import('../pglite-engine.ts');"],
    ['require', "export const f = () => require('../pglite-engine.ts');"],
  ])('engine-sql: %s of an engine façade fails with FAIL/Fix/Why/See', (_label, line) => {
    const r = run({ 'src/core/engine-sql/facts.ts': line + '\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: src/core/engine-sql/facts.ts:1 imports src/core/');
    for (const label of ['Fix:', 'Why:', 'See:  docs/TESTING.md#layering-guard']) expect(r.out).toContain(label);
  });

  test('schema-migrations: any import of migrate.ts fails, including from a nested dir', () => {
    const r = run({ 'src/core/schema-migrations/nested/v1.ts': "import { MIGRATIONS } from '../../migrate.ts';\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain('imports src/core/migrate.ts');
  });

  test('persistence: importing the model gateway fails', () => {
    const r = run({ 'src/core/persistence/page-prepare.ts': "export const f = () => import('../ai/gateway.ts');\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain('imports src/core/ai/gateway.ts');
  });

  test('allowed edges pass: engine.ts types, sql-query.ts, sibling helpers, packages', () => {
    const r = run({
      'src/core/engine-sql/facts.ts': "import type { BrainEngine } from '../engine.ts';\nimport { executeRawJsonb } from '../sql-query.ts';\nimport ts from 'typescript';\n",
      'src/core/schema-migrations/v2.ts': "import { helper } from './helpers.ts';\nimport type { Migration } from './types.ts';\n",
      'src/core/migrate.ts': "import { REGISTRY } from './schema-migrations/registry.generated.ts';\n",
    });
    expect(r.code).toBe(0);
  });
});

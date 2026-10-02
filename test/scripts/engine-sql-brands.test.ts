/**
 * EO4 / AR2 (refactor wave 1): scripts/check-engine-sql-brands.ts keeps the
 * ScopedRead / LegacyUnscopedRead brands unforgeable: no brand-key mentions
 * outside brands.ts, no casts onto the brands or executor types in src/, and
 * the brand factories importable only from their allowlists (never
 * src/core/ops/**).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-engine-sql-brands.ts');
const KEY = ['__obtainVia', 'UnscopedExecutor'].join('');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-engine-sql-brands-'));
  dirs.push(root);
  const tree = { 'src/core/engine-sql/brands.ts': `export type LegacyUnscopedRead = { readonly ${KEY}: true };\n`, ...files };
  for (const [rel, body] of Object.entries(tree)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const r = spawnSync('bun', [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: root } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function expectFail(files: Record<string, string>, where: string, what: string) {
  const r = run(files);
  expect(r.code).toBe(1);
  expect(r.out.split('\n').find((l) => l.startsWith(`FAIL: ${where} `))).toContain(what);
  for (const label of ['Fix:', 'Why:', 'See:  docs/TESTING.md#engine-sql-brands']) expect(r.out).toContain(label);
}

describe('check-engine-sql-brands.ts: brand keys', () => {
  test.each([
    ['src code', 'src/core/search/forge.ts', `export const f = { ${KEY}: true };\n`],
    ['a test file', 'test/forge.test.ts', `// ${KEY}\n`],
    ['a script of any text kind', 'scripts/forge.sh', `echo ${KEY}\n`],
    ['a future key', 'src/core/x.ts', 'export const k = "__obtainViaSomethingNew";\n'],
  ])('a mention in %s fails', (_label, path, body) => {
    expectFail({ [path]: body }, `${path}:1`, 'mentions brand key __obtainVia');
  });

  test('brands.ts itself may spell the keys', () => {
    expect(run({}).out).toContain('check-engine-sql-brands: ok');
  });
});

describe('check-engine-sql-brands.ts: casts in src/', () => {
  const header = 'type ScopedRead = object; type LegacyUnscopedRead = object; type SqlExecutor = object; type Handle = object;\n';
  test.each([
    ['as ScopedRead', 'export const f = (x: object) => x as ScopedRead;', 'cast to ScopedRead outside'],
    ['angle-bracket LegacyUnscopedRead', 'export const f = (x: object) => <LegacyUnscopedRead>x;', 'cast to LegacyUnscopedRead outside'],
    ['as unknown as ScopedRead', 'export const f = (x: object) => x as unknown as ScopedRead;', 'cast to ScopedRead outside'],
    ['as unknown as SqlExecutor', 'export const f = (x: object) => x as unknown as SqlExecutor;', "double cast 'as unknown as SqlExecutor'"],
    ['double cast fed to scopedRead(', 'declare function scopedRead(x: unknown): unknown;\nexport const f = (x: object) => scopedRead(x as unknown as Handle);', "double cast 'x as unknown as Handle' fed to scopedRead()"],
  ])('%s fails', (_label, body, what) => {
    const r = run({ 'src/core/search/cast.ts': header + body + '\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL: src/core/search/cast.ts:${body.split('\n').length + 1} ${what}`);
    expect(r.out.match(/^FAIL:/gm)).toHaveLength(1);
  });

  test('driver-handle casts in src and executor casts in test/ pass', () => {
    const r = run({
      'src/core/engine-sql/dialect-postgres.ts': 'type PgConn = object;\nexport const f = (tx: object) => tx as unknown as PgConn;\n',
      'test/fake-executor.ts': 'type SqlExecutor = object;\nexport const f = (x: object) => x as unknown as SqlExecutor;\n',
    });
    expect(r.out).toContain('check-engine-sql-brands: ok');
    expect(r.code).toBe(0);
  });
});

describe('check-engine-sql-brands.ts: import allowlists', () => {
  test.each([
    ['value import', "import { unscopedExecutor } from '../engine-sql/brands.ts';", 'imports unscopedExecutor outside its allowlist'],
    ['type import', "import type { LegacyUnscopedRead } from '../engine-sql/brands.ts';", 'imports LegacyUnscopedRead outside its allowlist'],
    ['aliased import', "import { unscopedExecutor as u } from '../engine-sql/brands.ts';", 'imports unscopedExecutor outside its allowlist'],
    ['re-export', "export { LegacyUnscopedRead } from '../engine-sql/brands.ts';", 'imports LegacyUnscopedRead outside its allowlist'],
    ['import type node', "export type T = import('../engine-sql/brands.ts').LegacyUnscopedRead;", 'imports LegacyUnscopedRead outside its allowlist'],
    ['namespace import', "import * as brands from '../engine-sql/brands.ts';", 'imports all of src/core/engine-sql/brands.ts'],
    ['dynamic import', "export const load = () => import('../engine-sql/brands.ts');", 'loads src/core/engine-sql/brands.ts dynamically'],
    ['require', "export const load = () => require('../engine-sql/brands');", 'loads src/core/engine-sql/brands.ts dynamically'],
    ['scopedRead import', "import { scopedRead } from '../engine-sql/brands.ts';", 'imports scopedRead outside its allowlist'],
  ])('%s from src/core/search fails', (_label, line, what) => {
    expectFail({ 'src/core/search/reader.ts': line + '\n' }, 'src/core/search/reader.ts:1', what);
  });

  test('src/core/ops/** is denied even from a doctor-like path', () => {
    expectFail(
      { 'src/core/ops/doctor-report.ts': "import { unscopedExecutor } from '../engine-sql/brands.ts';\n" },
      'src/core/ops/doctor-report.ts:1',
      'imports unscopedExecutor outside its allowlist (src/core/ops/** (MCP-facing) is never allowed)',
    );
  });

  test('doctor may import unscopedExecutor but not scopedRead', () => {
    expectFail(
      { 'src/commands/doctor.ts': "import { scopedRead } from '../core/engine-sql/brands.ts';\n" },
      'src/commands/doctor.ts:1',
      'imports scopedRead outside its allowlist',
    );
  });

  test('every allowlisted importer passes', () => {
    const unscoped = "import { unscopedExecutor, type LegacyUnscopedRead } from './x.ts';\n";
    const all = "import { scopedRead, unscopedExecutor, type LegacyUnscopedRead } from './x.ts';\nimport * as b from '../src/core/engine-sql/brands.ts';\n";
    const r = run({
      'src/core/engine-sql/facts.ts': all,
      'src/core/pglite-engine.ts': all,
      'src/core/postgres-engine.ts': all,
      'src/commands/doctor.ts': unscoped,
      'src/commands/doctor/checks/rls.ts': unscoped,
      'src/core/doctor-remote.ts': unscoped,
      'src/core/maintenance/vacuum.ts': unscoped,
      'src/commands/admin-sources.ts': unscoped,
      'src/core/admin/sources.ts': unscoped,
      'src/core/migrate.ts': unscoped,
      'src/core/schema-migrations/v1.ts': unscoped,
      'src/commands/migrations/v0_1_0.ts': unscoped,
      'test/engine-sql-brands-usage.ts': all,
    });
    expect(r.out).toContain('check-engine-sql-brands: ok');
    expect(r.code).toBe(0);
  });
});

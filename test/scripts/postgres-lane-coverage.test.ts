/**
 * GBRA-47 D8: scripts/check-postgres-lane-coverage.ts fails on a test file
 * outside test/e2e/ whose PostgreSQL arm is gated on DATABASE_URL and that no
 * Postgres lane runs, and passes once a lane names it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-postgres-lane-coverage.ts');
const FIXTURES = join(REPO, 'test', 'fixtures', 'guards', 'check-postgres-lane-coverage.ts');
const ALLOWLISTED = { 'test/export-scale.slow.test.ts': "for (const backend of testBackends()) describe(backend, () => {});\n" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(files: Record<string, string>) {
  const tree = mkdtempSync(join(tmpdir(), 'gbrain-postgres-lanes-'));
  dirs.push(tree);
  for (const [rel, body] of Object.entries({ ...ALLOWLISTED, ...files })) {
    mkdirSync(join(tree, rel, '..'), { recursive: true });
    writeFileSync(join(tree, rel), body);
  }
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env: { ...process.env, GBRAIN_GUARD_ROOT: tree } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const workflow = (env: string, files: string[]) => `name: lane\non: workflow_dispatch\njobs:\n  pg:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Postgres arms\n${env}        run: bun test ${files.join(' ')}\n`;
const PG_ENV = '        env:\n          DATABASE_URL: postgres://gbrain_test:gbrain_test@127.0.0.1:5432/gbrain_test\n';

describe('check-postgres-lane-coverage.ts', () => {
  test.each([
    ['a testBackends() loop', "for (const backend of testBackends()) describe(backend, () => {});\n"],
    ['a skipIf on DATABASE_URL', "test.skipIf(!process.env.DATABASE_URL)('postgres arm', () => {});\n"],
    ['a variable holding DATABASE_URL', "const url = process.env.DATABASE_URL;\ndescribe.skipIf(!url)('postgres arm', () => {});\n"],
    ['an if-gated connection', "beforeAll(async () => { if (process.env.DATABASE_URL) await isolatedPersistencePostgres(process.env.DATABASE_URL); });\n"],
  ])('%s with no Postgres lane fails with code, location, why, the exact fix and docs', (_label, body) => {
    const r = run({ 'test/arm.test.ts': body });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [postgres_arm_unlaned]: test/arm.test.ts:');
    expect(r.out).toContain('Why: the unit, serial and slow lanes unset DATABASE_URL, so this arm skips in every CI lane.');
    expect(r.out).toContain('Fix: add test/arm.test.ts to test/postgres-unit-arms.txt (one line, in sorted order), or load it from a test/e2e/*-postgres.test.ts wrapper with registerPostgresTests');
    expect(r.out).toContain('Docs: docs/TESTING.md#coverage-responsibilities-before-consolidation');
  });

  test('a workflow step without DATABASE_URL is not a Postgres lane', () => {
    const r = run({ 'test/arm.test.ts': ALLOWLISTED['test/export-scale.slow.test.ts'],
      '.github/workflows/lane.yml': workflow('', ['test/arm.test.ts']) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [postgres_arm_unlaned]: test/arm.test.ts:1');
  });

  test('arms named by a DATABASE_URL workflow step, an e2e wrapper or a heavy script pass', () => {
    const arm = ALLOWLISTED['test/export-scale.slow.test.ts'];
    const r = run({
      'test/stepped.test.ts': arm, 'test/wrapped.serial.test.ts': arm, 'test/heavy.test.ts': arm,
      '.github/workflows/lane.yml': workflow(PG_ENV, ['test/stepped.test.ts']),
      'test/e2e/wrapped-postgres.test.ts': "await registerPostgresTests(() => import('../wrapped.serial.test.ts'));\n",
      'tests/heavy/arm.sh': 'bun test test/heavy.test.ts\n',
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('4 test files with a DATABASE_URL-gated arm; 3 run in a Postgres lane, 1 allowlisted.');
  });

  test('a test/postgres-unit-arms.txt row is a Postgres lane', () => {
    const arm = ALLOWLISTED['test/export-scale.slow.test.ts'];
    const r = run({ 'test/listed.test.ts': arm, 'test/postgres-unit-arms.txt': '# comment\ntest/listed.test.ts\n' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('2 test files with a DATABASE_URL-gated arm; 1 run in a Postgres lane, 1 allowlisted.');
  });

  test('a list row for a missing file or a file with no gated arm is stale and names the line to delete', () => {
    const r = run({ 'test/plain.test.ts': "test('pglite only', () => {});\n", 'test/postgres-unit-arms.txt': 'test/gone.test.ts\ntest/plain.test.ts\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [postgres_arm_list_stale]: the test/postgres-unit-arms.txt row test/gone.test.ts names a missing file');
    expect(r.out).toContain('FAIL [postgres_arm_list_stale]: the test/postgres-unit-arms.txt row test/plain.test.ts names a file with no DATABASE_URL-gated arm');
    expect(r.out).toContain('Fix: delete the test/plain.test.ts line from test/postgres-unit-arms.txt');
    expect(r.out).toContain('Docs: docs/TESTING.md#postgres-arm-lanes');
  });

  test('duplicate, unsorted and malformed list rows fail with their line numbers', () => {
    const arm = ALLOWLISTED['test/export-scale.slow.test.ts'];
    const r = run({ 'test/a.test.ts': arm, 'test/b.test.ts': arm,
      'test/postgres-unit-arms.txt': 'test/b.test.ts\ntest/a.test.ts\ntest/a.test.ts\nsrc/not-a-test.ts\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [postgres_arm_list_invalid]: test/postgres-unit-arms.txt:2: test/a.test.ts is out of sorted order');
    expect(r.out).toContain('FAIL [postgres_arm_list_invalid]: test/postgres-unit-arms.txt:3: test/a.test.ts is listed twice');
    expect(r.out).toContain('FAIL [postgres_arm_list_invalid]: test/postgres-unit-arms.txt:4: "src/not-a-test.ts" is not a repo-relative test/…/*.test.ts path');
  });

  test('save-and-restore reads, assertions and a self-supplied DATABASE_URL are not arms', () => {
    const r = run({
      'test/restore.test.ts': readFileSync(join(FIXTURES, 'good', 'test', 'restore.test.fixture.ts'), 'utf8'),
      'test/own-url.test.ts': "test('helper', () => withEnv({ DATABASE_URL: 'postgresql://localhost/gbrain_test' }, () => { expect(testBackends()).toEqual(['pglite', 'postgres']); }));\n",
      'test/strings.test.ts': "const fixture = `await engine.connect({ database_url: process.env.DATABASE_URL });`;\n",
    });
    expect(r.code, r.out).toBe(0);
  });

  test('an allowlist row for a laned file is stale and names the row to delete', () => {
    const r = run({ '.github/workflows/lane.yml': workflow(PG_ENV, ['test/export-scale.slow.test.ts']) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [postgres_arm_allowlist_stale]: the ALLOWLIST row for test/export-scale.slow.test.ts names a file a Postgres lane already runs');
    expect(r.out).toContain('Fix: delete the test/export-scale.slow.test.ts row from ALLOWLIST in scripts/check-postgres-lane-coverage.ts');
  });

  test('every DATABASE_URL-gated arm in this repository runs in a Postgres lane or is allowlisted', () => {
    const env = { ...process.env };
    delete env.GBRAIN_GUARD_ROOT;
    const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', cwd: REPO, env });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('the docs anchors the guard prints exist', () => {
    const docs = readFileSync(join(REPO, 'docs', 'TESTING.md'), 'utf8');
    expect(docs).toContain('### Coverage responsibilities before consolidation');
    expect(docs).toContain('#### Postgres-arm lanes');
  });
});

/**
 * scripts/stress/run.ts end to end against fixture trees (GBRAIN_STRESS_ROOT):
 * per-iteration receipts, seeded replay, failure detection with the
 * reproduce line, zero-executed and unexpected-skip failures, and the
 * platform-only "not stressed" path. The Postgres paths live in
 * test/scripts/test-stress-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureSignature, parseArgs, readReport } from '../../scripts/stress/run.ts';

const RUNNER = join(import.meta.dir, '..', '..', 'scripts', 'stress', 'run.ts');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-test-stress-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), body); }
  return root;
}
function stress(root: string, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_STRESS_ROOT: root };
  delete env.DATABASE_URL;
  delete env.GITHUB_SHA;
  // CI writes receipts outside the checkout ($RUNNER_TEMP); so does this test.
  const out = mkdtempSync(join(tmpdir(), 'gbrain-test-stress-out-'));
  dirs.push(out);
  const r = spawnSync(process.execPath, [RUNNER, ...args, '--out', out], { encoding: 'utf8', env, timeout: 120_000 });
  const manifestPath = join(out, 'stress-manifest.json');
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined };
}

describe('test:stress runner', () => {
  test('a stable file passes every iteration and leaves one JUnit receipt per iteration', () => {
    const root = tree({ 'test/stable.test.ts': "import { test, expect } from 'bun:test';\ntest('one', () => expect(1).toBe(1));\ntest('two', () => {});\n" });
    const r = stress(root, 'test/stable.test.ts', '--iterations', '3', '--seed', '40');
    expect(r.code, r.out).toBe(0);
    const file = r.manifest.files[0];
    expect(file).toMatchObject({ file: 'test/stable.test.ts', profile: 'unit', env: 'no-database', status: 'pass', seedBase: 40 });
    expect(file.iterations.map((it: { index: number; seed: number; executed: number }) => [it.index, it.seed, it.executed])).toEqual([[1, 40, 2], [2, 41, 2], [3, 42, 2]]);
    for (const it of file.iterations) {
      const dir = it.receipt;
      expect(readdirSync(dir).filter(f => f.endsWith('.junit.xml') || f.endsWith('.receipt')).sort()).toEqual(['stress--stable.test.ts-i' + it.index + '--primary.receipt', 'stress.junit.xml']);
    }
    expect(r.out).toContain('setup');
    expect(r.out).toMatch(/run \d+\.\d+s/);
  });

  test('a seed-dependent failure fails the run with its iteration, signature and a replayable reproduce line', () => {
    const root = tree({ 'test/flaky.test.ts': "import { test, expect } from 'bun:test';\ntest('odd seeds only', () => { expect(Number(process.env.GBRAIN_TEST_SEED) % 2).toBe(1); });\n" });
    const r = stress(root, 'test/flaky.test.ts', '--iterations', '4', '--seed', '1');
    expect(r.code, r.out).toBe(1);
    expect(r.manifest.failures.map((f: { iteration: number }) => f.iteration)).toEqual([2, 4]);
    expect(r.manifest.failures[0]).toMatchObject({ test: 'odd seeds only', backend: 'pglite', signature: 'expect(received).toBe(expected) Expected: N Received: N' });
    expect(r.out).toContain('FAIL [stress_failure]: test/flaky.test.ts failed in 2 iteration(s) (first: iteration 2');
    expect(r.out).toContain('bun run test:stress test/flaky.test.ts --iterations 4 --first-iteration 2 --seed 1');
    expect(r.out).toContain('iteration 2, seed 2');
    expect(r.out).toContain('Docs: docs/TESTING.md#stress-gate');
    // Replaying the printed command from the failing iteration fails at once.
    const replay = stress(root, 'test/flaky.test.ts', '--iterations', '1', '--first-iteration', '2', '--seed', '1');
    expect(replay.code).toBe(1);
  });

  test('zero executed tests fails unless the file is platform-only', () => {
    const root = tree({
      'test/empty.test.ts': "import { test } from 'bun:test';\ntest.skip('never', () => {});\n",
      'test/platform.test.ts': "import { test } from 'bun:test';\ntest.skipIf(process.platform !== 'aix')('aix only', () => {});\n",
    });
    const r = stress(root, 'test/empty.test.ts', 'test/platform.test.ts', '--iterations', '2');
    expect(r.code, r.out).toBe(1);
    const byFile = Object.fromEntries(r.manifest.files.map((f: { file: string }) => [f.file, f]));
    expect(byFile['test/empty.test.ts'].iterations[0].failures[0].message).toBe('zero tests executed');
    expect(byFile['test/platform.test.ts']).toMatchObject({ status: 'not-stressed', reason: expect.stringContaining('platform-only') });
    expect(r.manifest.not_stressed.map((n: { file: string }) => n.file)).toEqual(['test/platform.test.ts']);
  });

  test('a file that skips without a prerequisite its owning heavy-tests job installs is not stressed', () => {
    const root = tree({
      'test/door.serial.test.ts': "import { describe, test } from 'bun:test';\nconst BIN = Bun.which('some-agent-cli-not-installed');\ndescribe.skipIf(!BIN)('door', () => { test('install', () => {}); });\n",
      '.github/workflows/heavy-tests.yml': 'jobs:\n  door:\n    steps:\n      - run: bun test --timeout=600000 test/door.serial.test.ts\n',
    });
    const r = stress(root, 'test/door.serial.test.ts', '--iterations', '2');
    expect(r.code, r.out).toBe(0);
    expect(r.manifest.files[0]).toMatchObject({ status: 'not-stressed', reason: expect.stringContaining('owning job in .github/workflows/heavy-tests.yml') });
  });

  test('a test that ran in the first iteration and skips later is an unexpected skip', () => {
    const root = tree({ 'test/vanish.test.ts': "import { test } from 'bun:test';\nif (Number(process.env.GBRAIN_TEST_SEED) % 2 === 1) test('sometimes', () => {});\ntest('always', () => {});\n" });
    const r = stress(root, 'test/vanish.test.ts', '--iterations', '2', '--seed', '1');
    expect(r.code, r.out).toBe(1);
    expect(r.manifest.failures[0]).toMatchObject({ iteration: 2, signature: 'unexpected skip' });
    expect(r.manifest.files[0].iterations[1].missing).toEqual(['sometimes']);
  });

  test('an E2E file without --postgres is listed as not stressed with the next step', () => {
    const root = tree({ 'test/e2e/x.test.ts': "import { test } from 'bun:test';\ntest('x', () => {});\n" });
    const r = stress(root, 'test/e2e/x.test.ts', '--iterations', '1');
    expect(r.code, r.out).toBe(0);
    expect(r.manifest.not_stressed[0].reason).toContain('re-run with --postgres');
  });
});

describe('arguments, reports and signatures', () => {
  test('flags are validated before anything runs', () => {
    expect(parseArgs(['test/a.test.ts', '--iterations', '0'])).toBe('--iterations must be a positive integer');
    expect(parseArgs(['../etc/passwd'])).toContain('not a repo-relative test file');
    expect(parseArgs(['--base', '$(id)'])).toContain('--base/--head must be');
    expect(parseArgs(['--work', '[{"file":"test/a.test.ts","first":0,"count":1}]'])).toContain('--work must be');
    expect(parseArgs(['--work', '[{"file":"test/../x.test.ts","first":1,"count":1}]'])).toContain('--work must be');
    expect(parseArgs(['--bogus'])).toBe('unknown flag --bogus');
    expect(parseArgs(['test/a.test.ts', '--postgres', '--seed', '9'])).toMatchObject({ files: ['test/a.test.ts'], postgres: true, seed: 9, iterations: 10, base: 'origin/master' });
  });

  test('failure messages come out of the JUnit report in order', () => {
    const xml = '<?xml version="1.0"?><testsuites tests="2"><testsuite name="a.test.ts" file="a.test.ts" tests="2"><testcase name="ok"/><testcase name="bad"><failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 7&#10;Received: 6&#10;">x</failure></testcase></testsuite></testsuites>';
    const r = readReport(xml);
    expect(r.cases.map(c => [c.test, c.status])).toEqual([['ok', 'pass'], ['bad', 'fail']]);
    expect(r.messages).toEqual(['expect(received).toBe(expected)\n\nExpected: 7\nReceived: 6\n']);
  });

  test('signatures mask numbers, temp paths and UUIDs', () => {
    expect(failureSignature('ENOENT: /tmp/gbrain-x123/a.md at line 42 id 0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('ENOENT: <tmp> at line N id <uuid>');
  });
});

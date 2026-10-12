/**
 * scripts/check-test-env-opt-ins.ts (D7): a test gating execution on a
 * GBRAIN_* opt-in the operator-env preload strips is a silent skip. The
 * guard-self-test harness proves the bad fixtures fail and the good one
 * passes; this file pins the agent-facing output (Why / Fix / Docs, with an
 * anchor that exists) and that the real tree is clean. The same guard's
 * second rule (GBRA-79): a module-scope delete/assignment of
 * GBRAIN_PGLITE_SNAPSHOT in a file the unit matrix loads leaks through the
 * shard's single bun process and cold-boots every later PGLite engine.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-test-env-opt-ins.ts');
const FIXTURES = join(REPO, 'test', 'fixtures', 'guards', 'check-test-env-opt-ins.ts');

function run(root?: string) {
  return spawnSync('bun', [GUARD], {
    encoding: 'utf8',
    env: { ...process.env, ...(root ? { GBRAIN_GUARD_ROOT: root } : {}) },
  });
}

describe('check-test-env-opt-ins', () => {
  test('names each dead gate with file:line and prints Why / Fix / Docs', () => {
    const r = run(join(FIXTURES, 'bad-derived'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL [test_env_opt_in_stripped]: test/opt-in-const.ts:4 gates execution on GBRAIN_FIXTURE_SKIP_SUBPROCESS');
    expect(r.stderr).toMatch(/^Why: .*operator-env-preload\.ts strips every GBRAIN_\* name/m);
    expect(r.stderr).toMatch(/^Fix: rename the opt-in to GBRAIN_TEST_<AREA>_<WHAT>.*RENAMED in test\/helpers\/operator-env-policy\.ts/m);
    const anchor = r.stderr.match(/^Docs: docs\/TESTING\.md#([a-z0-9-]+)$/m)?.[1];
    expect(anchor).toBeDefined();
    const headings = readFileSync(join(REPO, 'docs', 'TESTING.md'), 'utf8')
      .split('\n')
      .filter(l => l.startsWith('#'))
      .map(l => l.replace(/^#+\s*/, '').toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-'));
    expect(headings).toContain(anchor!);
  });

  test('a module-scope GBRAIN_PGLITE_SNAPSHOT delete or assignment in a matrix file names the one-process shard runner and the hook shape', () => {
    const leak = run(join(FIXTURES, 'bad-snapshot-leak'));
    expect(leak.status).toBe(1);
    expect(leak.stderr).toContain('FAIL [test_env_snapshot_module_scope]: test/snapshot-leak.ts:5 deletes process.env.GBRAIN_PGLITE_SNAPSHOT at module scope');
    expect(leak.stderr).toMatch(/^Why: scripts\/test-shard\.sh runs a whole unit shard .* in ONE bun process.*cold-boots initSchema\(\)/m);
    expect(leak.stderr).toMatch(/^Fix: .*beforeAll saves process\.env\.GBRAIN_PGLITE_SNAPSHOT and deletes it, afterAll restores the saved value.*with-snapshot\.ts/m);
    expect(leak.stderr).not.toContain('test_env_opt_in_stripped');
    expect(leak.stderr).toMatch(/^Docs: docs\/TESTING\.md#test-isolation-lint-and-helpers$/m);

    const assign = run(join(FIXTURES, 'bad-snapshot-assign'));
    expect(assign.status).toBe(1);
    expect(assign.stderr).toContain('FAIL [test_env_snapshot_module_scope]: test/snapshot-assign.ts:6 assigns process.env.GBRAIN_PGLITE_SNAPSHOT at module scope');
  });

  test('hook-scoped, e2e and preload snapshot changes pass', () => {
    const r = run(join(FIXTURES, 'good'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('a *.serial.test.ts file may delete the snapshot at module scope (own bun process)', () => {
    // Written to a temp root, not test/fixtures/guards/: the serial runner
    // collects every *.serial.test.ts under test/ and would run a fixture.
    // The source is assembled so check-test-isolation's R1 grep does not read
    // this test file itself as mutating process.env.
    const moduleScopeDelete = ['delete process', 'env.GBRAIN_PGLITE_SNAPSHOT;\n'].join('.');
    const root = mkdtempSync(join(tmpdir(), 'opt-ins-serial-'));
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test', 'cold.serial.test.ts'), moduleScopeDelete);
    writeFileSync(join(root, 'test', 'cold.test.ts'), moduleScopeDelete);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL [test_env_snapshot_module_scope]: test/cold.test.ts:1 deletes');
    expect(r.stderr).not.toContain('cold.serial.test.ts');
  });

  test('the real tree is clean', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

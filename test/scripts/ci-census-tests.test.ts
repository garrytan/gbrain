import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// scripts/ci-census-tests.sh is the one list test.yml's enumeration-census-tests job and the crew's
// by-hand check both read (docs/ci-event-parity.md#enumeration-and-census-tests).
const root = join(import.meta.dir, '../..');
const script = join(root, 'scripts/ci-census-tests.sh');
const run = (...args: string[]) => spawnSync('bash', [script, ...args], { cwd: root, encoding: 'utf8' });

describe('ci-census-tests.sh', () => {
  const listed = run();
  const files = listed.stdout.split('\n').filter(Boolean);

  test('prints a sorted, unique list of tracked unit test files', () => {
    expect(listed.status, listed.stderr).toBe(0);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toEqual([...new Set(files)].sort());
    for (const file of files) expect(file, file).toMatch(/^test\/.+\.test\.ts$/);
  });

  test('covers each kind of file that failed a first full-ci run', () => {
    for (const file of [
      'test/doctor-json-golden.test.ts',
      'test/cli-flag-validation.test.ts',
      'test/conversation-facts-type-allowlist-drift.test.ts',
      'test/mcp-tool-defs.test.ts',
      'test/cli-flag-equals.test.ts',
      'test/remote-privacy-sweep.test.ts',
      'test/persistence-consumer-idle.test.ts',
      'test/test-reads-source-smell.test.ts',
      'test/cli-exit-verdict-pin.test.ts',
      'test/git-env-guard.test.ts',
      'test/scripts/run-unit-shard.test.ts',
    ]) expect(files, file).toContain(file);
    const structuralTag = ['test-reads-source', 'ok\\[structural\\]'].join('-');
    const structural = spawnSync('git', ['grep', '-l', structuralTag, '--', 'test'], { cwd: root, encoding: 'utf8' }).stdout
      .split('\n').filter(file => /\.test\.ts$/.test(file) && !/\.serial\.test\.ts$/.test(file));
    expect(structural.length).toBeGreaterThan(40);
    for (const file of structural) expect(files, file).toContain(file);
  });

  test('leaves out E2E, serial, slow and setup files', () => {
    for (const file of files) expect(file, file).not.toMatch(/^test\/e2e\/|\.(serial|slow)\.test\.ts$|^test\/setup\.test\.ts$/);
  });

  test('refuses arguments it does not know', () => {
    for (const args of [['--list'], ['--run', '1'], ['--run', '1', '2', '3']]) expect(run(...args).status, args.join(' ')).toBe(2);
  });
});

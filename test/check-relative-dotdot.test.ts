/**
 * Self-test for scripts/check-relative-dotdot.mjs, the guard against
 * `.startsWith('..')` containment checks (a legal folder such as `..drafts`
 * also matches that prefix).
 *
 * Runs the scanner against the committed fixtures at
 * test/fixtures/guards/check-relative-dotdot.mjs/{bad,bad-double-quote,good}/
 * (the same fixtures guard-self-test.sh exercises) and against the real src/.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-relative-dotdot.mjs');
const FIXTURES = join(import.meta.dir, 'fixtures', 'guards', 'check-relative-dotdot.mjs');

function runGuard(dir?: string): { code: number; out: string } {
  const args = dir ? [process.execPath, SCRIPT, dir] : [process.execPath, SCRIPT];
  const res = Bun.spawnSync(args, { cwd: join(import.meta.dir, '..') });
  return { code: res.exitCode, out: res.stderr.toString() + res.stdout.toString() };
}

describe('check-relative-dotdot guard', () => {
  test('flags a single-quoted prefix check and names the helper', () => {
    const { code, out } = runGuard(join(FIXTURES, 'bad'));
    expect(code).toBe(1);
    expect(out).toContain('fixture.ts:5');
    expect(out).toContain('relativeEscapesRoot');
  });

  test('flags a double-quoted prefix check', () => {
    const { code, out } = runGuard(join(FIXTURES, 'bad-double-quote'));
    expect(code).toBe(1);
    expect(out).toContain('fixture.ts:3');
  });

  test('passes the helper, component-aware prefixes, comments and an opt-out', () => {
    const { code, out } = runGuard(join(FIXTURES, 'good'));
    expect(code).toBe(0);
    expect(out).toContain('OK');
  });

  test('the real src/ tree is clean', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toContain('OK');
  }, 30_000);
});

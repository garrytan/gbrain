/**
 * Self-test for scripts/check-ascii-slug-class.mjs — the guard against
 * ASCII-only replace() classes that drop non-Latin text (#21).
 *
 * Runs the scanner against the COMMITTED fixtures at
 * test/fixtures/guards/check-ascii-slug-class.mjs/{bad,good}/ (the same
 * fixtures guard-self-test.sh exercises).
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-ascii-slug-class.mjs');
const FIXTURES = join(import.meta.dir, 'fixtures', 'guards', 'check-ascii-slug-class.mjs');

function runGuard(dir: string): { code: number; out: string } {
  const res = Bun.spawnSync([process.execPath, SCRIPT, dir]);
  return { code: res.exitCode, out: res.stderr.toString() + res.stdout.toString() };
}

describe('check-ascii-slug-class guard', () => {
  test('flags unmarked a-z, \\w and A-Z classes, and a marker with no reason', () => {
    const { code, out } = runGuard(join(FIXTURES, 'bad'));
    expect(code).toBe(1);
    expect(out).toContain('fixture.ts:3:');
    expect(out).toContain('fixture.ts:7:');
    expect(out).toContain('fixture.ts:12:');
    expect(out).toContain('slugifyText');
  });

  test('passes marked identifiers, Unicode classes, validators, comments and non-letter classes', () => {
    const { code, out } = runGuard(join(FIXTURES, 'good'));
    expect(code).toBe(0);
    expect(out).toContain('clean');
  });

  test('the real src/ tree is clean', () => {
    const res = Bun.spawnSync([process.execPath, SCRIPT], { cwd: join(import.meta.dir, '..') });
    const out = res.stderr.toString() + res.stdout.toString();
    expect(res.exitCode).toBe(0);
    expect(out).toContain('clean');
  }, 30_000);
});

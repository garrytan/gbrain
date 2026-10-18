/**
 * Self-test for scripts/check-origin-assignment.mjs, the #6948 guard that every
 * page origin write goes through src/core/persistence/origin-guard.ts. Runs the
 * scanner against the committed fixtures at
 * test/fixtures/guards/check-origin-assignment.mjs/{bad,good}/ (the same
 * fixtures guard-self-test.sh exercises) and against the real src/ tree.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-origin-assignment.mjs');
const FIXTURES = join(import.meta.dir, 'fixtures', 'guards', 'check-origin-assignment.mjs');

function runGuard(dir?: string): { code: number; out: string } {
  const res = Bun.spawnSync([process.execPath, SCRIPT, ...(dir ? [dir] : [])], { cwd: join(import.meta.dir, '..') });
  return { code: res.exitCode, out: res.stderr.toString() + res.stdout.toString() };
}

describe('check-origin-assignment guard', () => {
  test('flags raw origin assignments, origin-carrying inserts, aliased SET clauses and unguarded slug renames', () => {
    const { code, out } = runGuard(join(FIXTURES, 'bad'));
    expect(code).toBe(1);
    expect(out).toContain('fixture.ts:3: UPDATE pages assigns source_path');
    expect(out).toContain('fixture.ts:7: INSERT INTO pages carries source_path');
    expect(out).toContain('fixture.ts:11: UPDATE pages assigns source_path');
    expect(out).toContain('fixture.ts:16: UPDATE pages renames a slug');
    expect(out).toContain('bindOrigin');
  });

  test('passes clears, comparisons, origin-free inserts, marked guarded sites and renames, and doc comments', () => {
    const { code, out } = runGuard(join(FIXTURES, 'good'));
    expect(code).toBe(0);
    expect(out).toContain('clean');
  });

  test('the real src/ tree is clean', () => {
    const { code, out } = runGuard();
    expect(code).toBe(0);
    expect(out).toContain('clean');
  }, 30_000);
});

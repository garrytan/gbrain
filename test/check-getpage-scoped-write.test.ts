/**
 * Self-test for scripts/check-getpage-scoped-write.mjs — the
 * unscoped-check/scoped-write source-isolation guard.
 *
 * Runs the scanner against the COMMITTED fixtures at
 * test/fixtures/guards/check-getpage-scoped-write.mjs/{bad,good}/ (the same
 * fixtures guard-self-test.sh exercises), so the pinned shapes live in one
 * place. Also pins the file-scoped heuristic: an unscoped getPage in a file
 * with NO write path must not be flagged.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-getpage-scoped-write.mjs');
const FIXTURES = join(import.meta.dir, 'fixtures', 'guards', 'check-getpage-scoped-write.mjs');

function runGuard(dir: string): { code: number; out: string } {
  const res = Bun.spawnSync([process.execPath, SCRIPT, dir]);
  return { code: res.exitCode, out: res.stderr.toString() + res.stdout.toString() };
}

describe('check-getpage-scoped-write guard', () => {
  test('flags unscoped + ternary-undefined getPage reads in files that also write', () => {
    const { code, out } = runGuard(join(FIXTURES, 'bad'));
    expect(code).toBe(1);
    expect(out).toContain('fixture.ts:3'); // no-opts read
    expect(out).toContain('fixture.ts:8'); // conditional-undefined read (shorthand)
    expect(out).toContain('fixture.ts:14'); // EXPANDED ternary `{ sourceId: x } : undefined`
    expect(out).toContain('fixture.ts:19'); // empty-object false branch `: {}`
    expect(out).toContain("sourceId: x ?? 'default'");
  });

  test('passes scoped reads, opt-out markers, and read-only files', () => {
    const { code, out } = runGuard(join(FIXTURES, 'good'));
    expect(code).toBe(0);
    expect(out).toContain('clean');
  });

  test('the real src/ tree is clean (grandfathered allowlist is EMPTY by design)', () => {
    const res = Bun.spawnSync([process.execPath, SCRIPT], { cwd: join(import.meta.dir, '..') });
    const out = res.stderr.toString() + res.stdout.toString();
    expect(res.exitCode).toBe(0);
    expect(out).toContain('clean');
  }, 30_000);
});

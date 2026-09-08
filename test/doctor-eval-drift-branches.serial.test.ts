/**
 * Pins the two degraded arms of `checkEvalDrift` (src/commands/doctor/checks/search-eval.ts)
 * that the PGLite-backed doctor tests can never reach from inside a source checkout:
 *
 *   (a) `resolveGbrainSourceRoot()` → null  (installed package / compiled binary):
 *       "Not applicable" — and the git probe is never attempted.
 *   (b) root present but `watchedFilesDrifted()` → null (git unavailable / not a
 *       work tree): "Could not probe" — the probe was attempted against that root.
 *
 * Serial (*.serial.test.ts): uses mock.module, which leaks across files in a shared
 * shard process. Every other drift-watch export stays real via the `...real` spread
 * (same pattern as test/cycle-start-recovery-throw.serial.test.ts).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

const real = await import('../src/core/eval/drift-watch.ts');

const FAKE_ROOT = '/tmp/fake-gbrain-src-root';
let fakeRoot: string | null = null;
let probedRoots: string[] = [];

mock.module('../src/core/eval/drift-watch.ts', () => ({
  ...real,
  resolveGbrainSourceRoot: (): string | null => fakeRoot,
  watchedFilesDrifted: (repoRoot: string): string[] | null => {
    probedRoots.push(repoRoot);
    return null;
  },
}));

// Import AFTER the mock so the check's dynamic `import('../../../core/eval/drift-watch.ts')`
// resolves to the mocked namespace.
const { checkEvalDrift } = await import('../src/commands/doctor/checks/search-eval.ts');

// checkEvalDrift never touches the engine; a stub keeps the file PGLite-free.
const engine = {} as unknown as BrainEngine;

beforeEach(() => {
  probedRoots = [];
});

describe('checkEvalDrift degraded branches', () => {
  test('null source root → "Not applicable" and the git probe is skipped', async () => {
    fakeRoot = null;
    const c = await checkEvalDrift(engine);
    expect(c.name).toBe('eval_drift');
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Not applicable');
    expect(probedRoots).toEqual([]);
  });

  test('root present but probe returns null → "Could not probe" against that root', async () => {
    fakeRoot = FAKE_ROOT;
    const c = await checkEvalDrift(engine);
    expect(c.name).toBe('eval_drift');
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Could not probe');
    expect(c.message).toContain('not a git work tree');
    expect(c.message).not.toContain('Not applicable');
    expect(probedRoots).toEqual([FAKE_ROOT]);
  });
});

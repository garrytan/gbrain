/**
 * Tests for resolveGbrainCliPath() — picks the right executable to supervise
 * as the Minions worker child. Codex caught that the earlier plan's use of
 * process.execPath is wrong on source installs (points at the Bun runtime,
 * not `gbrain`).
 */

import { describe, test, expect } from 'bun:test';
import { resolveGbrainCliPath } from '../src/commands/autopilot.ts';

describe('resolveGbrainCliPath', () => {
  test('returns a non-empty string', () => {
    // Whatever the test environment is (bun run ...), the resolver should
    // find *something* — either argv[1] (cli.ts entry), execPath (compiled
    // binary), or `which gbrain`. If none of those work, it throws; in
    // test, argv[1] is the test runner path which usually ends in .ts, so
    // the first branch or the `which` fallback catches it.
    let path: string;
    try {
      path = resolveGbrainCliPath();
    } catch (e) {
      // If we throw, that means neither argv[1] nor execPath nor $PATH has
      // gbrain — on a machine without gbrain installed, this is expected.
      expect((e as Error).message).toContain('resolve');
      return;
    }
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });

  test('accepts /gbrain suffix (compiled binary)', () => {
    // Simulate compiled-binary detection by setting argv[1] to /usr/local/bin/gbrain
    const orig = process.argv[1];
    process.argv[1] = '/usr/local/bin/gbrain';
    try {
      const path = resolveGbrainCliPath();
      expect(path).toBe('/usr/local/bin/gbrain');
    } finally {
      process.argv[1] = orig;
    }
  });

  test('accepts /cli.ts suffix (source install)', () => {
    const orig = process.argv[1];
    process.argv[1] = '/some/path/src/cli.ts';
    try {
      const path = resolveGbrainCliPath();
      expect(path).toBe('/some/path/src/cli.ts');
    } finally {
      process.argv[1] = orig;
    }
  });
});

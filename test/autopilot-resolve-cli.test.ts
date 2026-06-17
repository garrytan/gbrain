/**
 * Tests for resolveGbrainCliPath() — picks the right executable to supervise
 * as the Minions worker child.
 *
 * Iron rule (regression guard for Bug 4, v0.14.0 upgrade night): the resolver
 * must NEVER return a `.ts` path. TypeScript source files are not executable;
 * spawning them fails with EACCES and autopilot silently loses its worker.
 * Earlier versions short-circuited on `argv[1].endsWith('/cli.ts')`, which
 * caused the bug. The canonical resolution is the `gbrain` shim on PATH.
 */

import { describe, test, expect } from 'bun:test';
import { resolveGbrainCliPath } from '../src/commands/autopilot.ts';

describe('resolveGbrainCliPath', () => {
  test('returns a non-empty string or throws with a clear install hint', () => {
    let path: string;
    try {
      path = resolveGbrainCliPath();
    } catch (e) {
      // Machine without gbrain on PATH and no compiled binary: throw is
      // expected. The error message must point the user at the install step.
      expect((e as Error).message).toMatch(/PATH|resolve/i);
      return;
    }
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });

  test('NEVER returns a path ending in .ts (regression guard — Bug 4)', () => {
    // Simulate the exact production break: bun-source install puts
    // `/path/to/src/cli.ts` in argv[1]. The resolver must not hand that back.
    const origArg1 = process.argv[1];
    const origExec = (process as { execPath?: string }).execPath;
    process.argv[1] = '/some/project/src/cli.ts';
    try {
      const path = resolveGbrainCliPath();
      // Either we got a real executable (shim on PATH from the test machine)
      // or the throw path fires. Either way, the return value is never .ts.
      expect(path.endsWith('.ts')).toBe(false);
      expect(path.endsWith('.tsx')).toBe(false);
    } catch (e) {
      expect((e as Error).message).toMatch(/PATH|resolve/i);
    } finally {
      process.argv[1] = origArg1;
      if (origExec) (process as { execPath?: string }).execPath = origExec;
    }
  });

  test('shim on PATH wins over argv[1]=cli.ts', () => {
    // If `which gbrain` resolves (most dev machines), the resolver should
    // return that shim path, not argv[1]=cli.ts. This is the canonical
    // install shape.
    const origArg1 = process.argv[1];
    process.argv[1] = '/some/project/src/cli.ts';
    try {
      const path = resolveGbrainCliPath();
      // On a machine where `which gbrain` resolves, path ends in /gbrain.
      // On a machine without, we throw. Both outcomes prove the resolver
      // did not short-circuit on the .ts suffix.
      expect(path.endsWith('/cli.ts')).toBe(false);
    } catch (e) {
      expect((e as Error).message).toMatch(/PATH|resolve/i);
    } finally {
      process.argv[1] = origArg1;
    }
  });

  test('accepts argv[1]=/gbrain when shim is absent (compiled binary)', () => {
    // If the machine has neither shim nor compiled exec, but argv[1]
    // happens to be a literal /gbrain path (direct invocation), accept it.
    const origArg1 = process.argv[1];
    process.argv[1] = '/usr/local/bin/gbrain';
    try {
      const path = resolveGbrainCliPath();
      // On a machine with `which gbrain`, we get the shim. On a machine
      // without, argv[1] fallback fires. Either way the result is valid.
      expect(path.endsWith('/gbrain') || path.endsWith('\\gbrain.exe')).toBe(true);
    } finally {
      process.argv[1] = origArg1;
    }
  });
});

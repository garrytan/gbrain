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
import { resolveGbrainCliPath, resolveWindowsCliPath } from '../src/commands/autopilot.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';

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



describe('resolveWindowsCliPath', () => {
  function withFakePath(dirs: string[], fn: () => Promise<void>) {
    // withEnv is the repo's canonical env isolation pattern (R1); bare
    // process.env mutation in a non-serial file trips the isolation lint.
    return withEnv({ PATH: dirs.join(';'), PATHEXT: '.EXE;.CMD' }, fn);
  }

  test('finds gbrain.exe on %PATH% (issue #3793)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-path-'));
    try {
      writeFileSync(join(dir, 'gbrain.exe'), 'fake');
      await withFakePath([dir], async () => {
        const result = resolveWindowsCliPath();
        expect(result).toBe(join(dir, 'gbrain.exe'));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('NEVER resolves from the current directory (cwd-hijack guard)', async () => {
    // `where` would search cwd before %PATH% and pick up a stray
    // gbrain.exe dropped there. Our enumeration must not.
    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-cwd-'));
    const pathDir = mkdtempSync(join(tmpdir(), 'gbrain-path2-'));
    const origCwd = process.cwd();
    try {
      writeFileSync(join(cwd, 'gbrain.exe'), 'evil');
      // pathDir has no gbrain.exe — nothing legit to find.
      process.chdir(cwd);
      await withFakePath([pathDir], async () => {
        expect(resolveWindowsCliPath()).toBe('');
      });
      // And a legit candidate on PATH wins even when cwd has one too.
      writeFileSync(join(pathDir, 'gbrain.exe'), 'real');
      await withFakePath([pathDir], async () => {
        expect(resolveWindowsCliPath()).toBe(join(pathDir, 'gbrain.exe'));
      });
    } finally {
      process.chdir(origCwd);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  test('honors PATHEXT when .exe is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-cmd-'));
    try {
      writeFileSync(join(dir, 'gbrain.cmd'), 'fake');
      await withFakePath([dir], async () => {
        expect(resolveWindowsCliPath()).toBe(join(dir, 'gbrain.cmd'));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns empty string when nothing matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-empty-'));
    try {
      await withFakePath([dir], async () => {
        expect(resolveWindowsCliPath()).toBe('');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores relative %PATH% entries (cwd-hijack guard, round 2)', async () => {
    // A PATH entry like '.' or 'bin' resolves against cwd. `where` would
    // pick up a gbrain.exe there; explicit enumeration must skip non-
    // absolute entries entirely.
    const cwd = mkdtempSync(join(tmpdir(), 'gbrain-cwd2-'));
    const absDir = mkdtempSync(join(tmpdir(), 'gbrain-abs-'));
    const origCwd = process.cwd();
    try {
      writeFileSync(join(cwd, 'gbrain.exe'), 'evil');
      writeFileSync(join(absDir, 'gbrain.exe'), 'real');
      process.chdir(cwd);
      // Only relative entries: must NOT resolve the cwd copy.
      await withFakePath(['.', 'bin'], async () => {
        expect(resolveWindowsCliPath()).toBe('');
      });
      // Absolute entry wins even when a relative one appears first.
      await withFakePath(['.', absDir], async () => {
        expect(resolveWindowsCliPath()).toBe(join(absDir, 'gbrain.exe'));
      });
    } finally {
      process.chdir(origCwd);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(absDir, { recursive: true, force: true });
    }
  });

  test('skips non-spawnable PATHEXT types like .js (EFTYPE guard)', async () => {
    // PATHEXT can carry .JS/.VBS (Windows Script Host); Bun cannot exec
    // those directly. A gbrain.js must never be picked over nothing.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-js-'));
    try {
      writeFileSync(join(dir, 'gbrain.js'), 'evil');
      await withEnv(
        { PATH: dir, PATHEXT: '.JS;.EXE' },
        async () => {
          expect(resolveWindowsCliPath()).toBe('');
        },
      );
      // But a real .exe in the same dir still resolves.
      writeFileSync(join(dir, 'gbrain.exe'), 'real');
      await withEnv(
        { PATH: dir, PATHEXT: '.JS;.EXE' },
        async () => {
          expect(resolveWindowsCliPath()).toBe(join(dir, 'gbrain.exe'));
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a directory named gbrain.exe cannot shadow a real binary', async () => {
    // statSync().isFile() guard: a folder that happens to be named
    // gbrain.exe must not be returned as the CLI.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-dirshadow-'));
    try {
      mkdirSync(join(dir, 'gbrain.exe'));
      await withEnv({ PATH: dir, PATHEXT: '.EXE' }, async () => {
        expect(resolveWindowsCliPath()).toBe('');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

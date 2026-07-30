/**
 * `makeGbrainShim` — a throwaway `gbrain` executable on PATH that routes to
 * `bun run <repo>/src/cli.ts`, for tests whose subject spawns `gbrain ...`.
 *
 * Several migration/orchestrator paths shell out by bare command name
 * (`execSync('gbrain jobs smoke')`, `execSync('gbrain init --migrate-only')`).
 * On a developer machine that resolves via `bun link`; in CI it does not
 * exist and the spawn fails with "command not found", surfacing as an
 * orchestrator failure that has nothing to do with the code under test.
 * The shim removes the global-install dependency.
 *
 * ## Why this is platform-split
 *
 * The obvious implementation — write `#!/bin/sh\nexec bun run …` to an
 * extensionless file and `chmod 0o755` — is POSIX-only, in two ways that
 * both fail silently rather than loudly:
 *
 *   1. **No shebang, no extensionless resolution.** Windows does not
 *      interpret `#!`, and `cmd.exe` resolves a bare command name only
 *      against `PATHEXT` (`.COM;.EXE;.BAT;.CMD;…`). An extensionless
 *      `gbrain` is invisible to PATH lookup, so the spawn dies with
 *      "'gbrain' is not recognized as an internal or external command".
 *   2. **`chmodSync(…, 0o755)` is a no-op** on Windows — there is no
 *      execute bit to set, so it neither helps nor errors.
 *
 * Windows therefore gets a `.CMD` batch shim. Verified on win32/bun: a
 * `.cmd` shim resolves through `execSync` (which goes via `cmd.exe`) AND
 * through `Bun.spawn` (which applies `PATHEXT` itself), forwards `%*`
 * argument-for-argument, and propagates the child's non-zero exit code.
 *
 * ## Why `pathValue` exists
 *
 * Callers must not hand-roll `` `${binDir}:${process.env.PATH}` ``. Windows
 * separates PATH entries with `;`, and a `:`-joined value does not error —
 * it makes the shim directory *and every inherited entry* unresolvable, so
 * the lookup falls through to whatever `gbrain` happens to be globally
 * installed. That masks the failure locally and produces a green test that
 * exercised the wrong binary.
 */
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { repoPath } from './repo-root.ts';

export interface GbrainShim {
  /** Directory containing the shim. Prepend to PATH via `pathValue`. */
  binDir: string;
  /** `binDir` prepended to the inherited PATH with the platform delimiter. */
  pathValue: string;
  /** Best-effort removal of the shim directory. Safe to call twice. */
  cleanup: () => void;
}

export function makeGbrainShim(prefix = 'gbrain-shim-'): GbrainShim {
  const binDir = mkdtempSync(join(tmpdir(), prefix));
  const cliPath = repoPath('src', 'cli.ts');

  if (process.platform === 'win32') {
    // CRLF: batch files are canonically CRLF and cmd.exe's parser is
    // documented against bare LF. Write the canonical form.
    writeFileSync(join(binDir, 'gbrain.cmd'), `@echo off\r\nbun run "${cliPath}" %*\r\n`);
  } else {
    const shimPath = join(binDir, 'gbrain');
    writeFileSync(shimPath, `#!/bin/sh\nexec bun run "${cliPath}" "$@"\n`, { mode: 0o755 });
    chmodSync(shimPath, 0o755);
  }

  return {
    binDir,
    pathValue: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    cleanup: () => {
      try {
        rmSync(binDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

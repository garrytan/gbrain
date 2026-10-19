#!/usr/bin/env bun
// scripts/postinstall.ts
//
// Postinstall hook: after `bun install`, apply any pending schema migrations so
// a freshly-installed gbrain is immediately usable. Wired via package.json
// ("postinstall": "bun run scripts/postinstall.ts") as a real Bun script rather
// than an inline `node -e` one-liner.
//
// Why a script file and not an inline command:
//   Embedding a program inside the package.json postinstall string lets the
//   lifecycle shell mangle it. Bun's Windows script-runner expands `\n` in the
//   hint string into a REAL newline before node sees it, producing
//   `SyntaxError: Invalid or unexpected token` and aborting the whole install.
//   `node` is also not guaranteed present under a Bun install (bun is the
//   guaranteed runtime), and `shell: win32` re-opens a quoting surface. A
//   checked-in .ts run by `bun run` sidesteps all three.
//
// Uses builtin APIs only — `which()` for Windows-aware PATH resolution (finds
// gbrain.exe / gbrain.cmd) and an argv-array `Bun.spawnSync` (no shell, nothing
// to quote). It NEVER fails the install: every path exits 0.

import { which } from 'bun';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// Repo modules load dynamically inside try/catch: a static import of a file
// that is not on disk (a Docker dependency layer, a partial checkout) would
// exit 1 before any line here runs and fail the whole install.
async function runtimeRefusalMessage(): Promise<string | null> {
  try {
    const { unsupportedBunMessage } = await import('../src/core/runtime-version.ts');
    return unsupportedBunMessage();
  } catch {
    return null;
  }
}

// The install itself runs on the user's Bun, so this is the first place an
// upgrade onto a newer Bun floor can say so. Nothing else here would work:
// every gbrain command refuses until Bun is upgraded.
const runtimeRefusal = await runtimeRefusalMessage();
if (runtimeRefusal) {
  console.error(`[gbrain] Installed, but gbrain will not start on this Bun.\n${runtimeRefusal}`);
  process.exit(0);
}

const HINT =
  '[gbrain] postinstall skipped. If installed via bun install -g github:...: ' +
  'run `gbrain doctor` and `gbrain apply-migrations --yes` manually. ' +
  'See https://github.com/garrytan/gbrain/issues/218';

// #5693: under `gbrain upgrade`, post-upgrade owns migrations. Running them
// here too would run them twice, and a slow run here outlives the install
// timeout that `gbrain upgrade` reads as a failed upgrade.
if (process.env.GBRAIN_UPGRADE_OWNS_MIGRATIONS === '1') {
  console.error('[gbrain] postinstall: migrations deferred to `gbrain post-upgrade`.');
  process.exit(0);
}

// Windows-aware PATH resolution — finds gbrain, gbrain.exe or gbrain.cmd.
const bin = which('gbrain');

if (!bin) {
  // Fresh clone / global install where gbrain isn't on PATH yet: skip cleanly.
  console.error(HINT);
  process.exit(0);
}

// A dev checkout may find a different install on PATH. Global installs and
// bun-link launchers are symlinks into their own package: compare real paths
// with a directory boundary, including when the package root is a symlink.
let skipReason: string | undefined;
try {
  const packageRoot = realpathSync(resolve(import.meta.dir, '..'));
  const binaryPath = realpathSync(bin);
  if (!binaryPath.startsWith(packageRoot + sep)) {
    skipReason = 'gbrain on PATH resolves outside this package';
  }
} catch {
  skipReason = 'could not resolve gbrain on PATH to this package';
}
if (skipReason) {
  console.error(`[gbrain] postinstall skipped: ${skipReason}. Run \`gbrain apply-migrations --yes\` manually.`);
  process.exit(0);
}

try {
  const r = Bun.spawnSync({
    cmd: [bin, 'apply-migrations', '--yes', '--non-interactive'],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (r.exitCode !== 0) console.error(HINT);
} catch {
  console.error(HINT);
}

process.exit(0); // never abort the install

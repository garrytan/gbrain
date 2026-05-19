import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectBunGlobalInstallRoot } from '../src/commands/upgrade.ts';

/**
 * detectBunGlobalInstallRoot is the cwd source for `bun update gbrain`.
 *
 * Pre-fix, the upgrade command spawned `bun update gbrain` with the
 * inherited cwd (typically `~`), which has no package.json — so bun
 * silently no-ops with "No package.json, so nothing to update" and the
 * upgrade was reported as failed against a perfectly working install.
 *
 * The fixtures below stand up a faithful replica of bun's global install
 * layout in a tmpdir and assert that the detector reaches the right
 * level (the dir with both package.json AND node_modules).
 */
describe('detectBunGlobalInstallRoot', () => {
  let workDir: string;
  let origArgv1: string | undefined;

  beforeEach(() => {
    // realpathSync resolves macOS's /tmp → /private/tmp symlink, matching
    // what the detector sees after its own realpathSync call.
    const rawDir = join(tmpdir(), `gbrain-upgrade-cwd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(rawDir, { recursive: true });
    workDir = realpathSync(rawDir);
    origArgv1 = process.argv[1];
  });

  afterEach(() => {
    if (origArgv1 !== undefined) process.argv[1] = origArgv1;
    else delete (process.argv as unknown as { [k: number]: unknown })[1];
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('walks up to the install root when argv[1] points inside node_modules/gbrain', () => {
    // Mirror `bun install -g`:
    //   <root>/package.json   (lists gbrain as a dep)
    //   <root>/node_modules/
    //   <root>/node_modules/gbrain/package.json   (gbrain's own)
    //   <root>/node_modules/gbrain/src/cli.ts
    const root = join(workDir, 'install-root');
    const pkgDir = join(root, 'node_modules', 'gbrain');
    const srcDir = join(pkgDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { gbrain: 'github:garrytan/gbrain' },
    }));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain' }));
    const cliPath = join(srcDir, 'cli.ts');
    writeFileSync(cliPath, '#!/usr/bin/env bun\n');

    process.argv[1] = cliPath;
    expect(detectBunGlobalInstallRoot()).toBe(root);
  });

  test('returns null when argv[1] is missing', () => {
    delete (process.argv as unknown as { [k: number]: unknown })[1];
    expect(detectBunGlobalInstallRoot()).toBeNull();
  });

  test('returns null when no ancestor has both package.json AND node_modules', () => {
    // Plain script in a directory tree with no install-root signal.
    const lone = join(workDir, 'lonely', 'sub');
    mkdirSync(lone, { recursive: true });
    const cliPath = join(lone, 'cli.ts');
    writeFileSync(cliPath, '#!/usr/bin/env bun\n');
    process.argv[1] = cliPath;
    expect(detectBunGlobalInstallRoot()).toBeNull();
  });

  test('does NOT return the gbrain package dir (package.json without node_modules sibling)', () => {
    // If we naively stopped at the FIRST package.json walking up, we'd
    // land on node_modules/gbrain/package.json — the wrong dir, since
    // running `bun update gbrain` there still has no notion of the user's
    // top-level dep manifest. This test pins the second predicate.
    const root = join(workDir, 'install-root');
    const pkgDir = join(root, 'node_modules', 'gbrain');
    const srcDir = join(pkgDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    // Owner package.json exists, but no node_modules sibling — so
    // detector must keep walking. We simulate that by deleting the
    // node_modules dir (it would normally hold gbrain itself, but for
    // this test we want to force the package.json-only fail path).
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain' }));
    writeFileSync(join(srcDir, 'cli.ts'), '#!/usr/bin/env bun\n');
    process.argv[1] = join(srcDir, 'cli.ts');
    // Note: no <root>/package.json AND no <root>/node_modules-as-sibling,
    // so the walk should return null instead of falsely landing inside
    // node_modules/gbrain.
    expect(detectBunGlobalInstallRoot()).toBeNull();
  });

  test('resolves through symlinked argv[1] (mirrors ~/.bun/bin/gbrain → install/global/node_modules/gbrain/src/cli.ts)', () => {
    const root = join(workDir, 'install-root');
    const pkgDir = join(root, 'node_modules', 'gbrain');
    const srcDir = join(pkgDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { gbrain: 'github:garrytan/gbrain' },
    }));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain' }));
    const realCli = join(srcDir, 'cli.ts');
    writeFileSync(realCli, '#!/usr/bin/env bun\n');

    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, 'gbrain');
    symlinkSync(realCli, link);

    process.argv[1] = link;
    // realpathSync inside the detector should resolve through the symlink
    // back to the real cli.ts under the install root.
    expect(detectBunGlobalInstallRoot()).toBe(root);
  });
});

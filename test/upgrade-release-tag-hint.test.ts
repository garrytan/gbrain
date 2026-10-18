/**
 * #6662: the reinstall hint for a tag-pinned Bun install removed the working
 * CLI before proving the target tag exists, and the target came from master's
 * VERSION, which is stamped before release.yml mints the tag. Now the printed
 * command probes the tag first and ends with a restore line, upgrade probes
 * the tag itself (published / not published / unknown), and a tag-pinned
 * install reinstalls the newest published tag (D24).
 *
 * The subprocess tests shim `git` and `bun` on PATH (Bun snapshots PATH at
 * process start), so no test touches the network.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  bunReinstallCommand,
  latestPublishedVersion,
  planPinnedReinstall,
  probeReleaseTag,
  reinstallHintLines,
} from '../src/commands/upgrade.ts';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');
const fakeGit = (byArgs: (args: string[]) => { status: number | null; stdout?: string }) => (args: string[]) => ({ stdout: '', ...byArgs(args) });
const TAGS = ['aaa\trefs/tags/v0.60.200.0', 'bbb\trefs/tags/v0.60.213.0', 'ccc\trefs/tags/v0.60.9.0', 'ddd\trefs/tags/latest-stable'].join('\n');

describe('#6662 reinstall hint', () => {
  test('the tag probe runs before the removal, and the removal still precedes the add (#5034)', () => {
    const cmd = bunReinstallCommand('#v0.60.204.0');
    expect(cmd).toBe('git ls-remote --exit-code --tags https://github.com/garrytan/gbrain refs/tags/v0.60.204.0 && bun remove -g gbrain && bun add -g github:garrytan/gbrain#v0.60.204.0');
    expect(cmd.indexOf('git ls-remote')).toBeLessThan(cmd.indexOf('bun remove -g gbrain'));
    expect(cmd.indexOf('bun remove -g gbrain')).toBeLessThan(cmd.indexOf('bun add -g'));
    expect(bunReinstallCommand('')).toBe('bun remove -g gbrain && bun add -g github:garrytan/gbrain');
  });

  test('POSIX hint is the guarded one-liner plus a restore line; Windows prints one step per line', () => {
    expect(reinstallHintLines('0.60.213.0', '0.60.200.0', 'linux')).toEqual([
      bunReinstallCommand('#v0.60.213.0'),
      'If the add fails, restore 0.60.200.0 with: bun add -g github:garrytan/gbrain#v0.60.200.0',
    ]);
    const win = reinstallHintLines('0.60.213.0', '0.60.200.0', 'win32');
    expect(win.some(l => l.includes('&&'))).toBe(false);
    expect(win.slice(1)).toEqual([
      'git ls-remote --exit-code --tags https://github.com/garrytan/gbrain refs/tags/v0.60.213.0',
      'bun remove -g gbrain',
      'bun add -g github:garrytan/gbrain#v0.60.213.0',
      'If the add fails, restore 0.60.200.0 with: bun add -g github:garrytan/gbrain#v0.60.200.0',
    ]);
  });

  test('the tag probe has three outcomes', () => {
    expect(probeReleaseTag('1.0.0', fakeGit(() => ({ status: 0 })))).toBe('published');
    expect(probeReleaseTag('1.0.0', fakeGit(() => ({ status: 2 })))).toBe('not_published');
    expect(probeReleaseTag('1.0.0', fakeGit(() => ({ status: 128 })))).toBe('unknown');
    expect(probeReleaseTag('1.0.0', fakeGit(() => ({ status: null })))).toBe('unknown');
  });

  test('the newest published tag is the highest v<x> release tag', () => {
    expect(latestPublishedVersion(fakeGit(() => ({ status: 0, stdout: TAGS })))).toBe('0.60.213.0');
    expect(latestPublishedVersion(fakeGit(() => ({ status: 128 })))).toBeNull();
  });

  test('an unpublished target falls back to the newest published tag; unknown keeps the target', () => {
    const missing = fakeGit(a => a.includes('--exit-code') ? { status: 2 } : { status: 0, stdout: TAGS });
    expect(planPinnedReinstall('0.60.214.0', '0.60.200.0', missing)).toEqual({ version: '0.60.213.0', unpublished: '0.60.214.0' });
    expect(planPinnedReinstall('0.60.214.0', '0.60.213.0', missing)).toEqual({ version: null, unpublished: '0.60.214.0' });
    expect(planPinnedReinstall('0.60.214.0', '0.60.200.0', fakeGit(() => ({ status: 128 })))).toEqual({ version: '0.60.214.0', unpublished: null });
    expect(planPinnedReinstall(null, '0.60.200.0', fakeGit(() => ({ status: 0, stdout: TAGS })))).toEqual({ version: '0.60.213.0', unpublished: null });
  });
});

async function runPinnedUpgrade(gitShim: string, targetVersion: string): Promise<{ home: string; exitCode: number; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-6662-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\necho "gbrain ${VERSION}"\n`);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${gitShim}\n`);
  for (const tool of ['bun', 'gbrain', 'git']) chmodSync(join(bin, tool), 0o755);
  const globalRoot = join(home, '.bun', 'install', 'global');
  const pkgDir = join(globalRoot, 'node_modules', 'gbrain');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(globalRoot, 'package.json'), JSON.stringify({ dependencies: { gbrain: `github:garrytan/gbrain#v${VERSION}` } }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain', repository: 'github:garrytan/gbrain' }));
  const driver = join(pkgDir, 'driver.ts');
  writeFileSync(driver, `import { runUpgrade } from '${REPO}/src/commands/upgrade.ts';\nawait runUpgrade(['--swap-only', '--no-bun-floor-check'], { targetVersion: '${targetVersion}' });\n`);
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.BUN_INSTALL;
  const proc = Bun.spawn([process.execPath, 'run', driver], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(proc.stderr).text();
  return { home, exitCode: await proc.exited, stderr };
}

describe('#6662 upgrade on a pinned install whose target tag is missing', () => {
  const target = '99.0.0.0';

  test('a missing tag with no newer published release says so and prints no remove-first command', async () => {
    const r = await runPinnedUpgrade(`case "$*" in *--exit-code*) exit 2;; *) echo "aaa\trefs/tags/v${VERSION}"; exit 0;; esac`, target);
    try {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(`v${target} is not published yet`);
      expect(r.stderr).not.toContain('bun remove -g gbrain');
      const errors = readFileSync(join(r.home, '.gbrain', 'upgrade-errors.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(errors.at(-1)).toMatchObject({ phase: 'verify-target', hint: `v${target} is not published yet; retry gbrain upgrade later` });
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  }, 60_000);

  test('a missing tag with a newer published release offers that tag, guarded, with the restore line', async () => {
    const r = await runPinnedUpgrade(`case "$*" in *--exit-code*) exit 2;; *) echo "aaa\trefs/tags/v98.0.0.0"; exit 0;; esac`, target);
    try {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(`v${target} is not published yet`);
      expect(r.stderr).toContain(`The newest published release is 98.0.0.0.`);
      expect(r.stderr).toContain(bunReinstallCommand('#v98.0.0.0'));
      expect(r.stderr).toContain(`restore ${VERSION} with: bun add -g github:garrytan/gbrain#v${VERSION}`);
      expect(r.stderr).not.toContain(`gbrain#v${target}`);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  }, 60_000);
});

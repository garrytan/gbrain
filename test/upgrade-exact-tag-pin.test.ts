/**
 * #5311: bare `gbrain upgrade` reported success on an exact-tag Bun Git
 * install. `bun update` keeps a pinned tag (exit 0, nothing changes) and the
 * #4366 mismatch check only runs when a caller passes a target version, so the
 * user saw "Upgrade complete" while still on the old version.
 *
 * SERIAL + subprocess: detectInstallMethod keys on argv[1] living under
 * node_modules and the `bun update` / `gbrain --version` calls must hit PATH
 * shims, which Bun snapshots at process start.
 */

import { describe, test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { bunGlobalExactTagPin, bunReinstallCommand } from '../src/commands/upgrade.ts';
import { VERSION } from '../src/version.ts';
import { upgradeErrorResolved } from '../src/commands/doctor.ts';

const REPO = resolve(import.meta.dir, '..');

async function runBareUpgrade(spec: string, observedVersion: string, cache?: string): Promise<{ home: string; exitCode: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-5311-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  // `bun update` succeeds without changing anything (the pinned-tag no-op);
  // `gbrain --version` keeps reporting the observed version.
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$*" >> '${join(home, 'bun-calls.log')}'\nexit 0\n`);
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\necho "gbrain ${observedVersion}"\n`);
  // #6662: the pin path reads published release tags with `git ls-remote`; answer with no newer tag, offline.
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in ls-remote) echo "aaa\trefs/tags/v${observedVersion}"; exit 0;; esac\nexit 1\n`);
  chmodSync(join(bin, 'git'), 0o755);
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'gbrain'), 0o755);
  if (cache) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'last-update-check'), `${cache}\n`);
  }
  const globalRoot = join(home, '.bun', 'install', 'global');
  const pkgDir = join(globalRoot, 'node_modules', 'gbrain');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(globalRoot, 'package.json'), JSON.stringify({ dependencies: { gbrain: spec } }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain', repository: 'github:garrytan/gbrain' }));
  const driver = join(pkgDir, 'driver.ts');
  writeFileSync(driver, `import { runUpgrade } from '${REPO}/src/commands/upgrade.ts';\nawait runUpgrade(['--swap-only', '--no-bun-floor-check']);\n`);
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.BUN_INSTALL;
  const proc = Bun.spawn([process.execPath, 'run', driver], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { home, exitCode: await proc.exited, stdout, stderr };
}

describe('#5311 bare upgrade on an exact-tag pin', () => {
  test('bunGlobalExactTagPin recognizes tag pins only', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-5311-pin-'));
    try {
      const pin = (spec: string | null) => {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: spec === null ? {} : { gbrain: spec } }));
        return bunGlobalExactTagPin(root);
      };
      expect(pin('github:garrytan/gbrain#v0.51.6.0')).toBe('github:garrytan/gbrain#v0.51.6.0');
      expect(pin('github:garrytan/gbrain#0.51.6')).toBe('github:garrytan/gbrain#0.51.6');
      expect(pin('github:garrytan/gbrain')).toBeNull();
      expect(pin('github:garrytan/gbrain#master')).toBeNull();
      expect(pin(null)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unchanged version on a pinned tag exits non-zero with the reinstall command', async () => {
    const r = await runBareUpgrade(`github:garrytan/gbrain#v${VERSION}`, VERSION);
    try {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('Upgrade did not take effect');
      expect(r.stderr).toContain(`pinned to github:garrytan/gbrain#v${VERSION}`);
      // #5034 / B-NEW-5: remove before add; an in-place global tag swap fails (Bun 1.3) or silently corrupts the lock (Bun 1.4).
      expect(r.stderr).toContain('bun remove -g gbrain && bun add -g github:garrytan/gbrain');
      expect(r.stderr).not.toContain('not published yet');
      expect(readFileSync(join(r.home, 'bun-calls.log'), 'utf-8')).toContain('update gbrain');
      // No false "just upgraded" breadcrumb for an upgrade that never happened.
      expect(existsSync(join(r.home, '.gbrain', 'just-upgraded-from'))).toBe(false);
      const errors = readFileSync(join(r.home, '.gbrain', 'upgrade-errors.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(errors.some(e => e.phase === 'verify-pin' && e.hint.startsWith('bun remove -g gbrain && bun add -g github:garrytan/gbrain'))).toBe(true);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  }, 60_000);

  test('#6718: with no newer published tag, the hint and the ledger never name an unpublished version', async () => {
    const v = VERSION.split('.').map(Number);
    const unpublished = `${v[0]}.${v[1]}.${v[2] + 1}.0`;
    // A fresh marker naming master's VERSION (what an older binary's check wrote); no tag exists for it.
    const r = await runBareUpgrade(`github:garrytan/gbrain#v${VERSION}`, VERSION, `UPGRADE_AVAILABLE ${VERSION} ${unpublished}`);
    try {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).not.toContain(unpublished);
      const errors = readFileSync(join(r.home, '.gbrain', 'upgrade-errors.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      const row = errors.find(e => e.phase === 'verify-pin');
      expect(row.to_version).toBe('latest');
      expect(row.hint).not.toContain(unpublished);
      // The record clears once the binary moves past the version it failed from.
      expect(upgradeErrorResolved(row.to_version, VERSION, true, row.from_version)).toBe(false);
      expect(upgradeErrorResolved(row.to_version, unpublished, true, row.from_version)).toBe(true);
      expect(upgradeErrorResolved(row.to_version, unpublished, false, row.from_version)).toBe(false);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  }, 60_000);

  test('every reinstall hint removes the global package before adding the tag (#5034, B-NEW-5)', () => {
    // #6662: a tag reinstall first proves the tag exists, so a missing tag stops before the removal.
    expect(bunReinstallCommand('#v0.60.1.0')).toBe('git ls-remote --exit-code --tags https://github.com/garrytan/gbrain refs/tags/v0.60.1.0 && bun remove -g gbrain && bun add -g github:garrytan/gbrain#v0.60.1.0');
    expect(bunReinstallCommand('')).toBe('bun remove -g gbrain && bun add -g github:garrytan/gbrain');
  });

  test('an unpinned install that is already current still succeeds', async () => {
    const r = await runBareUpgrade('github:garrytan/gbrain', VERSION);
    try {
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain('Upgrade did not take effect');
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  }, 60_000);
});

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

import { bunGlobalExactTagPin } from '../src/commands/upgrade.ts';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');

async function runBareUpgrade(spec: string, observedVersion: string): Promise<{ home: string; exitCode: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-5311-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  // `bun update` succeeds without changing anything (the pinned-tag no-op);
  // `gbrain --version` keeps reporting the observed version.
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$*" >> '${join(home, 'bun-calls.log')}'\nexit 0\n`);
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\necho "gbrain ${observedVersion}"\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'gbrain'), 0o755);
  const globalRoot = join(home, '.bun', 'install', 'global');
  const pkgDir = join(globalRoot, 'node_modules', 'gbrain');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(globalRoot, 'package.json'), JSON.stringify({ dependencies: { gbrain: spec } }));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'gbrain', repository: 'github:garrytan/gbrain' }));
  const driver = join(pkgDir, 'driver.ts');
  writeFileSync(driver, `import { runUpgrade } from '${REPO}/src/commands/upgrade.ts';\nawait runUpgrade(['--swap-only']);\n`);
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
      expect(r.stderr).toContain('bun add -g github:garrytan/gbrain');
      expect(readFileSync(join(r.home, 'bun-calls.log'), 'utf-8')).toContain('update gbrain');
      // No false "just upgraded" breadcrumb for an upgrade that never happened.
      expect(existsSync(join(r.home, '.gbrain', 'just-upgraded-from'))).toBe(false);
      const errors = readFileSync(join(r.home, '.gbrain', 'upgrade-errors.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(errors.some(e => e.phase === 'verify-pin' && e.hint.startsWith('bun add -g github:garrytan/gbrain'))).toBe(true);
    } finally {
      rmSync(r.home, { recursive: true, force: true });
    }
  }, 60_000);

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

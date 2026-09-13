/**
 * #4728 — the generated autopilot wrapper falls back when the baked CLI path
 * is gone.
 *
 * writeWrapperScript bakes the CLI path once at --install. On the
 * ephemeral-container target the container layer is wiped on every deploy, so
 * a CLI that lived there vanishes while the wrapper (on the volume) survives —
 * and bash's bare "No such file or directory" (exit 127) named no remedy.
 * These run the FULL generated wrapper under real bash; the #2608 harness in
 * test/autopilot-install.test.ts deliberately truncates before the exec line,
 * so the exec path lives here.
 *
 * SERIAL: the wrapper prepends dirname(process.execPath) onto PATH at install
 * time, and on a dev box the real bun dir often also holds a real `gbrain`
 * shim the fallback would find (and launch!). The rig points process.execPath
 * at an empty tmp dir so PATH resolution is fully test-controlled —
 * process-global state that cannot share a shard process. Env goes through
 * withEnv; everything is restored in finally.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

import { writeWrapperScript } from '../src/commands/autopilot.ts';
import { withEnv } from './helpers/with-env.ts';

const NO_GBRAIN_PATH = '/usr/bin:/bin';

interface Rig {
  /** HOME the wrapper runs under (holds the repo and any .bashrc). */
  home: string;
  /** The `which gbrain` hit baked into the wrapper at install time. */
  bakedBinDir: string;
  repoDir: string;
  wrapperPath: string;
  run: (path: string) => SpawnSyncReturns<string>;
}

async function withRig(fn: (rig: Rig) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-4728-home-'));
  const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-4728-gbrain-home-'));
  const bakedBinDir = mkdtempSync(join(tmpdir(), 'gbrain-4728-baked-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gbrain-4728-runtime-'));
  // The baked shim reports that IT ran, so the present case proves the
  // baked path stays primary rather than merely "something exited 0".
  writeFileSync(join(bakedBinDir, 'gbrain'), '#!/bin/sh\necho "BAKED_RAN $@"\nexit 0\n', { mode: 0o755 });
  const repoDir = join(home, 'repo-4728');
  mkdirSync(repoDir, { recursive: true });
  const originalExecPath = process.execPath;
  try {
    await withEnv(
      { HOME: home, GBRAIN_HOME: gbrainHome, PATH: `${bakedBinDir}:${process.env.PATH ?? ''}` },
      async () => {
        process.execPath = join(runtimeDir, 'bun');
        let wrapperPath: string;
        try {
          wrapperPath = writeWrapperScript(repoDir, 'ephemeral-container');
        } finally {
          process.execPath = originalExecPath;
        }
        const run = (path: string) =>
          spawnSync('bash', [wrapperPath], { env: { HOME: home, PATH: path }, encoding: 'utf8', timeout: 15_000 });
        await fn({ home, bakedBinDir, repoDir, wrapperPath, run });
      },
    );
  } finally {
    process.execPath = originalExecPath;
    for (const d of [home, gbrainHome, bakedBinDir, runtimeDir]) {
      rmSync(d, { recursive: true, force: true });
    }
  }
}

describe('#4728 wrapper falls back when the baked CLI path is gone', () => {
  test('baked path present: byte-for-byte old behavior, no fallback chatter', async () => {
    await withRig(rig => {
      const r = rig.run(NO_GBRAIN_PATH);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`BAKED_RAN autopilot --repo ${rig.repoDir}`);
      expect(r.stdout).not.toContain('baked CLI path');
      expect(r.stderr).toBe('');
    });
  });

  test('baked path gone, gbrain on PATH: logs the substitution to stdout and execs the PATH one', async () => {
    await withRig(rig => {
      rmSync(join(rig.bakedBinDir, 'gbrain')); // the container-layer wipe
      const fallbackDir = mkdtempSync(join(tmpdir(), 'gbrain-4728-fallback-'));
      try {
        writeFileSync(join(fallbackDir, 'gbrain'), '#!/bin/sh\necho "FALLBACK_RAN $@"\nexit 0\n', { mode: 0o755 });
        const r = rig.run(`${fallbackDir}:${NO_GBRAIN_PATH}`);
        expect(r.status).toBe(0);
        // stdout, not stderr: stdout is the autopilot.log sink on all four
        // targets (same choice as chatBootWarning); autopilot.err is never
        // surfaced by install output or --status.
        expect(r.stdout).toContain('baked CLI path is gone');
        expect(r.stdout).toContain(join(fallbackDir, 'gbrain'));
        expect(r.stdout).toContain(`FALLBACK_RAN autopilot --repo ${rig.repoDir}`);
      } finally {
        rmSync(fallbackDir, { recursive: true, force: true });
      }
    });
  });

  test('baked path gone, nothing on PATH: exit 1 with the --install remediation instead of a bare exec failure (bash 3.2: 126, bash 4+: 127)', async () => {
    await withRig(rig => {
      rmSync(join(rig.bakedBinDir, 'gbrain'));
      const r = rig.run(NO_GBRAIN_PATH);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('gbrain autopilot --install');
      expect(r.stderr).not.toContain('No such file or directory');
    });
  });

  test('a shell function named gbrain (from a sourced rc file) does not satisfy the fallback', async () => {
    await withRig(rig => {
      rmSync(join(rig.bakedBinDir, 'gbrain'));
      // The wrapper sources ~/.bashrc under HOME=rig.home before the guard runs.
      writeFileSync(join(rig.home, '.bashrc'), 'gbrain() { echo "FUNCTION_RAN $@"; }\n');
      const r = rig.run(NO_GBRAIN_PATH);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('FUNCTION_RAN');
      expect(r.stdout).toContain('gbrain autopilot --install');
    });
  });

  test('the final line is still the bare single-quoted exec the truncation harness anchors on', async () => {
    await withRig(rig => {
      const src = readFileSync(rig.wrapperPath, 'utf8');
      const lines = src.trimEnd().split('\n');
      const last = lines[lines.length - 1];
      expect(last).toMatch(/^exec '.*' autopilot --repo '.*'$/);
      // indexOf("exec '") (used by the #2608 truncation harness and the
      // launchd-lifecycle ordering pins) must still land on that FINAL line,
      // not on the fallback.
      expect(src.slice(src.indexOf("exec '")).trimEnd()).toBe(last);
      // The guard sits after the repo-cwd pin (#3696 ordering) and before the exec.
      expect(src.indexOf(`\ncd '`)).toBeLessThan(src.indexOf('exec '));
    });
  });
});

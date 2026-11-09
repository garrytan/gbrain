/**
 * GBRA-346: new installs follow the stable channel. A fresh `gbrain init`
 * persists `self_upgrade.channel: stable`, so the update check, `gbrain
 * upgrade` and the autopilot channel offer only releases promoted after the
 * production soak. An existing brain that never chose a channel keeps its
 * config untouched on re-init (its move to stable comes with a one-time notice,
 * not silently), and an explicit channel always wins.
 *
 * Subprocess-driven with a hermetic per-test GBRAIN_HOME, same pattern as
 * test/init-force-engine-preservation.test.ts.
 */

import { describe, test as testRaw, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 120_000);
}

const REPO_ROOT = join(import.meta.dir, '..');

async function runInit(gbrainHome: string, cwd: string): Promise<{ stderr: string; exitCode: number }> {
  const { spawn } = await import('child_process');
  return new Promise((resolve) => {
    const child = spawn('bun', ['run', join(REPO_ROOT, 'src', 'cli.ts'), 'init', '--pglite', '--no-embedding', '--json'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GBRAIN_HOME: gbrainHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    });
    let stderr = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ stderr, exitCode: code ?? -1 }));
  });
}

function makeHome(): { home: string; cwd: string; config: () => any; write: (c: unknown) => void; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-init-channel-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'gbrain-init-channel-cwd-'));
  const file = join(home, '.gbrain', 'config.json');
  return {
    home,
    cwd,
    config: () => JSON.parse(readFileSync(file, 'utf-8')),
    write: (c) => { mkdirSync(join(home, '.gbrain'), { recursive: true }); writeFileSync(file, JSON.stringify(c, null, 2)); },
    cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); },
  };
}

describe('init: release channel for new installs (GBRA-346)', () => {
  test('a fresh install persists self_upgrade.channel = stable', async () => {
    const h = makeHome();
    try {
      const r = await runInit(h.home, h.cwd);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(h.config().self_upgrade).toMatchObject({ mode: 'notify', mode_prompted: true, channel: 'stable' });
    } finally {
      h.cleanup();
    }
  });

  test('re-init of an existing brain that never chose a channel leaves the channel unset', async () => {
    const h = makeHome();
    try {
      expect((await runInit(h.home, h.cwd)).exitCode).toBe(0);
      const cfg = h.config();
      delete cfg.self_upgrade.channel;
      h.write(cfg);
      const r = await runInit(h.home, h.cwd);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(h.config().self_upgrade.channel).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test('an explicit channel in an existing config is kept', async () => {
    const h = makeHome();
    try {
      h.write({ engine: 'pglite', self_upgrade: { mode: 'auto', channel: 'latest' } });
      const r = await runInit(h.home, h.cwd);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(h.config().self_upgrade).toMatchObject({ mode: 'auto', channel: 'latest' });
    } finally {
      h.cleanup();
    }
  });
});

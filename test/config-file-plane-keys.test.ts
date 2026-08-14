/**
 * Bootstrap hook-lane config keys are FILE-plane canonical [D18]:
 * `config set` must route `push.allow_unverified_remote` and
 * `hooks.stop_push_debounce_min` to ~/.gbrain/config.json (NEVER the DB
 * plane) because their readers are engine-free hook/push children that only
 * see loadConfigFileOnly. These tests pin the write half (runConfig routing +
 * the loud warning) and the read half (configAllowsUnverifiedRemote).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runConfig } from '../src/commands/config.ts';
import { configAllowsUnverifiedRemote } from '../src/core/workspace-push.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

// The file-plane branch returns before any engine access — a null stub proves it.
const noEngine = null as unknown as BrainEngine;

async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return out;
}

describe('config set — file-plane bootstrap hook-lane keys [D18]', () => {
  test('push.allow_unverified_remote: set true → file plane + loud warning; read half sees it; set false unsets', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-plane-'));
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(noEngine, ['set', 'push.allow_unverified_remote', 'true']));
      expect(out).toContain('file plane');
      // Every enable warns loudly — the override trusts the remote on the user's word.
      expect(out).toContain('WARNING');
      expect(out).toContain('SKIP repo-visibility verification');
      const cfgPath = join(parent, '.gbrain', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { push?: { allow_unverified_remote?: boolean } };
      expect(cfg.push?.allow_unverified_remote).toBe(true);
      // The engine-free read half (detached push children) sees the same file.
      expect(configAllowsUnverifiedRemote()).toBe(true);

      // set false → off, and no warning banner.
      const out2 = await captureLog(() => runConfig(noEngine, ['set', 'push.allow_unverified_remote', 'false']));
      expect(out2).not.toContain('WARNING');
      expect(configAllowsUnverifiedRemote()).toBe(false);
    });
  });

  test('hooks.stop_push_debounce_min: integer minutes land on the file plane (0 = every turn allowed)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-plane2-'));
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const out = await captureLog(() => runConfig(noEngine, ['set', 'hooks.stop_push_debounce_min', '7']));
      expect(out).toContain('Set hooks.stop_push_debounce_min = 7');
      expect(out).toContain('file plane');
      const cfgPath = join(parent, '.gbrain', 'config.json');
      let cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { hooks?: { stop_push_debounce_min?: number } };
      expect(cfg.hooks?.stop_push_debounce_min).toBe(7);
      // 0 is valid (cloud-sandbox cadence: push every turn).
      await captureLog(() => runConfig(noEngine, ['set', 'hooks.stop_push_debounce_min', '0']));
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { hooks?: { stop_push_debounce_min?: number } };
      expect(cfg.hooks?.stop_push_debounce_min).toBe(0);
    });
  });
});

/**
 * v0.37.7.0 #1226 regression test.
 *
 * The autopilot lockfile was hardcoded at `~/.gbrain/autopilot.lock`
 * (via `process.env.HOME`), bypassing GBRAIN_HOME. Two brains pointed
 * at different GBRAIN_HOME directories would still write to the same
 * global lockfile; one would silently take over the other on each
 * restart.
 *
 * Fix: route through `gbrainPath('autopilot.lock')` which honors
 * GBRAIN_HOME. This file pins the contract via the canonical helper
 * directly, since the autopilot daemon's lifecycle is heavy to drive
 * in a unit test.
 */

import { describe, test, expect } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gbrainPath } from '../src/core/config.ts';

describe('autopilot lock path scoped to GBRAIN_HOME (#1226)', () => {
  test('one GBRAIN_HOME produces one canonical lock path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-lock-'));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const lockPath = gbrainPath('autopilot.lock');
      // Lockfile MUST live inside the per-brain GBRAIN_HOME, not under
      // process.env.HOME — that was the pre-fix bug.
      expect(lockPath.startsWith(home)).toBe(true);
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
    });
  });

  test('two GBRAIN_HOME values produce two distinct lockfiles', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-A-'));
    const homeB = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-B-'));

    let lockA = '';
    let lockB = '';
    await withEnv({ GBRAIN_HOME: homeA }, async () => {
      lockA = gbrainPath('autopilot.lock');
    });
    await withEnv({ GBRAIN_HOME: homeB }, async () => {
      lockB = gbrainPath('autopilot.lock');
    });

    // The contract that prevents two brains from silently colliding:
    // distinct GBRAIN_HOME values MUST produce distinct lockfile paths.
    expect(lockA).not.toBe(lockB);
    expect(lockA.startsWith(homeA)).toBe(true);
    expect(lockB.startsWith(homeB)).toBe(true);
  });

  test('default (no GBRAIN_HOME override) still produces a valid path', async () => {
    // When GBRAIN_HOME is unset, gbrainPath falls through to its
    // default (`~/.gbrain`). The path must still exist as a string
    // and end with the expected filename — we don't assert the exact
    // home dir since that varies by environment.
    await withEnv({ GBRAIN_HOME: undefined }, async () => {
      const lockPath = gbrainPath('autopilot.lock');
      expect(typeof lockPath).toBe('string');
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
      expect(lockPath.length).toBeGreaterThan('autopilot.lock'.length);
    });
  });
});

/**
 * Refusal-swallow site 5, the callers (triage row src/commands/autopilot.ts computeAutopilotIdle): the idle check now
 * lets a Rust brain's `engine_capability_missing` refusal through, and both production callers sit in a catch that
 * must stay nonfatal (a self-upgrade problem never breaks the autopilot tick) but must not be silent about it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: attemptAutopilotSelfUpgrade and restartServeAfterSelfUpgrade return normally when the idle check is
 *    refused, and each reports the refusal on stderr (`[autopilot] ...`, the channel the daemon's other self-upgrade
 *    warnings use); any other error stays silent as before.
 *  - Regression: the callers' bare `catch {}` swallowed the refusal, so a Rust brain's autopilot looked like it had no
 *    upgrade to apply.
 *  - Why existing coverage misses it: test/autopilot-self-upgrade.test.ts and test/autopilot-serve-restart-*.test.ts
 *    pass an idle check that never fails.
 *  - Seam: an engine stub whose `readCycleLocks` throws the real refusal (the first read computeAutopilotIdle makes), a
 *    temp GBRAIN_HOME with auto mode, quiet hours now and a cached upgrade_available marker.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { attemptAutopilotSelfUpgrade } from '../src/commands/autopilot.ts';
import { restartServeAfterSelfUpgrade } from '../src/commands/upgrade-restart.ts';
import { VERSION } from '../src/version.ts';
import { parseSemver } from '../src/core/semver.ts';
import { writeChannelCache } from './helpers/update-cache.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const v = parseSemver(VERSION)!;
const NEWER = `${v[0]}.${v[1]}.${v[2] + 1}.0`;

function brainHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-refusal-self-upgrade-'));
  dirs.push(root);
  const dotG = join(root, '.gbrain');
  mkdirSync(dotG, { recursive: true });
  const hour = new Date().getUTCHours();
  writeFileSync(join(dotG, 'config.json'), JSON.stringify({
    engine: 'pglite', database_path: join(dotG, 'brain.pglite'),
    self_upgrade: { mode: 'auto', channel: 'alpha', quiet_hours: { start: hour, end: (hour + 2) % 24, tz: 'UTC' } },
  }));
  writeChannelCache(dotG, `UPGRADE_AVAILABLE ${VERSION} ${NEWER}`);
  return root;
}

const refusedEngine = (error: () => Error) => ({ kind: 'rust', readCycleLocks: async () => { throw error(); } }) as unknown as BrainEngine;
const refusal = () => capabilityMissing('minion_queue', 'readCycleLocks');

/** stderr lines written while `fn` runs. */
async function stderrOf(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const err = spyOn(console, 'error').mockImplementation(((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }) as never);
  try { await fn(); } finally { err.mockRestore(); }
  return lines.join('\n');
}

describe('self-upgrade callers of the idle check', () => {
  test('C1 attemptAutopilotSelfUpgrade: a refused idle check is reported and the tick carries on; any other error stays silent', async () => {
    const home = brainHome();
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit') }, async () => {
      const out = await stderrOf(() => attemptAutopilotSelfUpgrade(refusedEngine(refusal), 'rust', join(home, 'autopilot.lock')));
      expect(out).toContain('[autopilot] self-upgrade skipped this tick');
      expect(out).toContain('does not support readCycleLocks');
      const quiet = await stderrOf(() => attemptAutopilotSelfUpgrade(refusedEngine(() => new Error('connection reset')), 'postgres', join(home, 'autopilot.lock')));
      expect(quiet).not.toContain('self-upgrade skipped');
    });
  });

  test('C2 restartServeAfterSelfUpgrade: a refused idle check is reported and the tick carries on; any other error stays silent', async () => {
    const home = brainHome();
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit') }, async () => {
      const state = { tried: false };
      const restart = async () => { throw new Error('must not restart'); };
      const out = await stderrOf(() => restartServeAfterSelfUpgrade(async () => { throw refusal(); }, { state, restart }));
      expect(out).toContain('[autopilot] serve restart skipped this tick');
      expect(out).toContain('does not support readCycleLocks');
      expect(state.tried).toBe(false);
      const quiet = await stderrOf(() => restartServeAfterSelfUpgrade(async () => { throw new Error('connection reset'); }, { state, restart }));
      expect(quiet).not.toContain('serve restart skipped');
    });
  });
});

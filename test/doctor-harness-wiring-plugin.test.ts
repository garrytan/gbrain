/**
 * #6082: `harness_wiring` counts a harness whose config enables a gbrain
 * plugin as wired, through the same enabledPluginLanes() list
 * `plugin_lane_collision` reads, so the two checks agree. Hermetic temp HOME,
 * CODEX_HOME, CLAUDE_CONFIG_DIR and GBRAIN_HOME; no serve is spawned (the
 * registration read only, smoke off).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessWiringCheck } from '../src/commands/doctor/checks/harness-wiring.ts';
import { bootstrapDoctorChecks } from '../src/commands/doctor.ts';
import { enabledPluginLanes } from '../src/core/bootstrap/plugin-lanes.ts';
import { withEnv } from './helpers/with-env.ts';

interface Box { root: string; env: Record<string, string | undefined> }

/** A fresh machine: nothing configured, no agent-process marker in env. */
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gb-hw-plugin-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    root,
    env: {
      HOME: home,
      GBRAIN_HOME: join(root, 'gbrain-home'),
      CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
      CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined, OPENCODE: undefined, OPENCODE_PID: undefined,
    },
  };
}

function codexPlugin(b: Box): void {
  mkdirSync(b.env.CODEX_HOME!, { recursive: true });
  writeFileSync(join(b.env.CODEX_HOME!, 'config.toml'), '[plugins."gbrain@gbrain"]\nenabled = true\n');
}

function claudePlugin(b: Box): void {
  mkdirSync(b.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(b.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true } }));
}

describe('harness_wiring with an enabled plugin lane (#6082)', () => {
  test('Codex plugin only → ok plugin_lane_enabled, and plugin_lane_collision agrees', async () => {
    const b = box();
    codexPlugin(b);
    await withEnv(b.env, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.status).toBe('ok');
      expect(check.details).toMatchObject({ reason: 'plugin_lane_enabled', plugins: ['gbrain@gbrain'], harnesses: ['codex'] });
      expect(check.message).toMatch(/does not smoke-test plugin lanes/);
      expect(enabledPluginLanes()).toEqual([{ harness: 'codex', plugin: 'gbrain@gbrain' }]);
      const collision = (await bootstrapDoctorChecks(null)).filter((c) => c.name === 'plugin_lane_collision');
      expect(collision.map((c) => c.status)).toEqual(['ok']);
    });
  });

  test('Claude Code plugin under CLAUDE_CONFIG_DIR only → ok', async () => {
    const b = box();
    claudePlugin(b);
    await withEnv(b.env, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.status).toBe('ok');
      expect(check.details).toMatchObject({ reason: 'plugin_lane_enabled', harnesses: ['claude-code'] });
    });
  });

  test('partly covered → warn names only the uncovered harness', async () => {
    const b = box();
    codexPlugin(b);
    mkdirSync(join(b.env.HOME!, '.claude'), { recursive: true });
    await withEnv(b.env, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.status).toBe('warn');
      expect(check.message).toMatch(/^Claude Code is installed but has no gbrain MCP registration/);
      expect(check.message).not.toContain('Codex');
    });
  });

  test('no plugin → the unchanged missing-registration warning', async () => {
    const b = box();
    mkdirSync(b.env.CODEX_HOME!, { recursive: true });
    writeFileSync(join(b.env.CODEX_HOME!, 'config.toml'), '[plugins."gbrain@gbrain"]\nenabled = false\n');
    await withEnv(b.env, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.status).toBe('warn');
      expect(check.message).toMatch(/^Codex is installed but has no gbrain MCP registration/);
      expect(enabledPluginLanes()).toEqual([]);
    });
  });
});

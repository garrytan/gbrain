import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { claudeManagedSettingsPaths } from '../src/core/bootstrap/host-specs.ts';
import { inspectTurnHook } from '../src/core/setup/turn-hook-check.ts';
import { turnRuleHookYields } from '../src/core/setup/turn-hook.ts';

// #8057: Claude Code also reads hooks from its managed settings
// (managed-settings.json and managed-settings.d/*.json in the system
// directory). A gbrain UserPromptSubmit hook there wires every session.

const promptHook = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/opt/gbrain/bin/gbrain hook user-prompt', _gbrain: 'setup-v1' }] }] } };

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-managed-8057-'));
  const home = join(root, 'home'); const managed = join(root, 'managed'); const project = join(root, 'project');
  for (const d of [join(home, '.claude'), managed, project]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: join(home, '.codex') };
  return { home, managed, project, env };
}

describe('Claude Code managed-settings hooks (#8057)', () => {
  test('a gbrain UserPromptSubmit hook in managed-settings.json counts as wired', async () => {
    const s = sandbox();
    writeFileSync(join(s.managed, 'managed-settings.json'), JSON.stringify(promptHook));
    await withEnv(s.env, async () => {
      const state = inspectTurnHook('claude-code', { managedDir: s.managed });
      expect(state.state).toBe('wired');
      expect(state.source).toBe(join(s.managed, 'managed-settings.json'));
      expect(turnRuleHookYields('claude-code', s.project, s.managed)).toBe(true);
    });
  });

  test('a drop-in under managed-settings.d counts as wired', async () => {
    const s = sandbox();
    mkdirSync(join(s.managed, 'managed-settings.d'));
    writeFileSync(join(s.managed, 'managed-settings.d', '10-gbrain.json'), JSON.stringify(promptHook));
    await withEnv(s.env, async () => {
      expect(inspectTurnHook('claude-code', { managedDir: s.managed }).state).toBe('wired');
      expect(turnRuleHookYields('claude-code', s.project, s.managed)).toBe(true);
    });
  });

  test('no managed hook: still missing, the turn-rule lane does not yield, and the message names the managed file', async () => {
    const s = sandbox();
    writeFileSync(join(s.managed, 'managed-settings.json'), JSON.stringify({ permissions: { allow: [] } }));
    await withEnv(s.env, async () => {
      const state = inspectTurnHook('claude-code', { managedDir: s.managed });
      expect(state.state).toBe('missing');
      expect(state.detail).toContain(join(s.managed, 'managed-settings.json'));
      expect(turnRuleHookYields('claude-code', s.project, s.managed)).toBe(false);
    });
  });

  test('the default managed directory is the platform system path', () => {
    const [file] = claudeManagedSettingsPaths();
    expect(file.endsWith('managed-settings.json')).toBe(true);
    if (process.platform === 'linux') expect(file).toBe('/etc/claude-code/managed-settings.json');
    if (process.platform === 'darwin') expect(file).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
  });
});

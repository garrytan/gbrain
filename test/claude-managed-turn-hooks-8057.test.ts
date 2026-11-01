import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTurnHook } from '../src/core/setup/turn-hook-check.ts';
import { turnRuleHookYields } from '../src/core/setup/turn-hook.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe('Claude Code managed turn hooks (#8057)', () => {
  test('doctor and runtime dedupe recognize managed settings and drop-ins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-managed-hooks-'));
    roots.push(root);
    const home = join(root, 'home');
    const managed = join(root, 'managed');
    const dropins = join(managed, 'managed-settings.d');
    const cwd = join(root, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(dropins, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const hook = { type: 'command', command: 'gbrain hook user-prompt', _gbrain: 'setup-v1' };
    const settings = (path: string) => writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [hook] }] } }));

    await withEnv({ HOME: home, CLAUDE_CONFIG_DIR: undefined }, async () => {
      const sources = [join(managed, 'managed-settings.json'), join(dropins, '10-policy.json')];
      for (const source of sources) {
        settings(source);
        expect(inspectTurnHook('claude-code', { managedSettingsDir: managed })).toMatchObject({ state: 'wired', via: 'setup', source });
        expect(turnRuleHookYields('claude-code', cwd, { managedSettingsDir: managed })).toBe(true);
        rmSync(source);
      }
    });
  });
});

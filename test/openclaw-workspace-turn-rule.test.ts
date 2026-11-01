import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { syncOpenclawTurnPlugin } from '../src/core/setup/openclaw-turn-plugin.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('workspace-specific OpenClaw setup preserves the shared turn rule', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-workspace-'));
  roots.push(root);
  const home = join(root, 'home');
  const state = join(root, 'openclaw');
  const bin = join(root, 'bin');
  const workspace = join(root, 'agent-a');
  const plugin = join(state, 'gbrain', 'gbrain-turn-rule');
  const fakeOpenclaw = join(bin, 'openclaw');
  const env = {
    HOME: home,
    GBRAIN_HOME: home,
    PATH: bin,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_WORKSPACE_DIR: undefined,
    GBRAIN_AGENT_INSTRUCTIONS: undefined,
    GBRAIN_HOOKS: undefined,
  };
  const setup = async (args: string[] = []) => {
    const result = await runCli(['setup', 'openclaw', ...args, '--json'], { env, cwd: root });
    let doc: any = null;
    try { doc = JSON.parse(result.stdout); } catch { /* a refusal is reported in stderr */ }
    return { ...result, doc };
  };

  mkdirSync(bin, { recursive: true });
  writeFileSync(fakeOpenclaw, [
    '#!/bin/sh',
    'if [ "$1" = "plugins" ] && [ "$2" = "inspect" ]; then',
    '  printf \'{"id":"gbrain-turn-rule","status":"loaded","imported":true,"hooks":["before_prompt_build"]}\'',
    'elif [ "$1" = "config" ]; then',
    '  printf \'{"plugins":{"entries":{"gbrain-turn-rule":{"enabled":true,"hooks":{"allowConversationAccess":true}}}}}\' > "$OPENCLAW_STATE_DIR/openclaw.json"',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(fakeOpenclaw, 0o755);
  const seeded = await withEnv(env, async () => syncOpenclawTurnPlugin({
    access: { kind: 'mcp', server: 'gbrain' },
    dryRun: false,
    openclawBin: fakeOpenclaw,
    run: () => ({ ok: true, output: '' }),
  }));
  expect(seeded.action).toBe('write');
  const installedRule = readFileSync(join(plugin, 'index.js'), 'utf8');

  const scoped = await setup(['--name', 'gbrain-a', '--workspace', workspace]);
  expect(scoped.exitCode).toBe(2);
  expect(readFileSync(join(plugin, 'index.js'), 'utf8')).toBe(installedRule);
  expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false);

  mkdirSync(workspace, { recursive: true });
  expect((await setup(['--workspace', workspace])).exitCode).toBe(0);
  const declined = await setup(['--workspace', workspace, '--no-instructions']);
  expect(declined.exitCode).toBe(0);
  expect(declined.doc.turn_hook.action).toBe('skip');
  expect(readFileSync(join(plugin, 'index.js'), 'utf8')).toBe(installedRule);

  expect((await setup(['--workspace', workspace, '--instructions'])).exitCode).toBe(0);
  const removed = await setup(['--workspace', workspace, '--remove']);
  expect(removed.exitCode).toBe(0);
  expect(removed.doc.turn_hook.action).toBe('skip');
  expect(readFileSync(join(plugin, 'index.js'), 'utf8')).toBe(installedRule);
}, 30_000);

/**
 * codexHome() resolves CODEX_HOME, then $HOME, then homedir(), like claudeConfigBase. On Windows homedir() reads
 * USERPROFILE, so with homedir() first a test that remaps HOME read and wrote the operator's real ~/.codex.
 */
import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { codexConfigPath, codexGlobalAgentsPath, codexHooksPath } from '../src/core/bootstrap/host-specs.ts';

const home = join('example', 'home');

test('CODEX_HOME wins over HOME', async () => {
  await withEnv({ HOME: home, CODEX_HOME: join('example', 'codex-home') }, async () => {
    expect(codexConfigPath()).toBe(join('example', 'codex-home', 'config.toml'));
  });
});

test('without CODEX_HOME, every codex path follows $HOME', async () => {
  await withEnv({ HOME: home, CODEX_HOME: undefined }, async () => {
    const base = join(home, '.codex');
    expect(codexConfigPath()).toBe(join(base, 'config.toml'));
    expect(codexHooksPath()).toBe(join(base, 'hooks.json'));
    expect(codexGlobalAgentsPath()).toBe(join(base, 'AGENTS.md'));
  });
});

test('with neither set, homedir() is the fallback', async () => {
  await withEnv({ HOME: undefined, CODEX_HOME: undefined }, async () => {
    expect(codexConfigPath()).toBe(join(homedir(), '.codex', 'config.toml'));
  });
});

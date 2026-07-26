import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { loadConfigFileOnly, readFileConfigValue, saveConfig } from '../src/core/config.ts';

class StubEngine {
  private config = new Map<string, string>();
  async getConfig(key: string) { return this.config.get(key) ?? null; }
  async setConfig(key: string, value: string) { this.config.set(key, value); }
  async unsetConfig(key: string) { return this.config.delete(key) ? 1 : 0; }
  async listConfigKeys(prefix: string) {
    return [...this.config.keys()].filter(key => key.startsWith(prefix));
  }
}

const originalPmbrainHome = process.env.PMBRAIN_HOME;
let configHome: string;
let engine: StubEngine;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'pmbrain-config-file-system-'));
  process.env.PMBRAIN_HOME = configHome;
  saveConfig({ engine: 'pglite' });
  engine = new StubEngine();
});

afterEach(() => {
  if (originalPmbrainHome === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = originalPmbrainHome;
  rmSync(configHome, { recursive: true, force: true });
});

describe('config command model system of record', () => {
  test('set and unset persist model routing only in config.json', async () => {
    await engine.setConfig('models.default', 'stale:database-model');

    await runConfig(engine as never, ['set', 'models.default', 'deepseek:deepseek-v4-flash']);
    expect(readFileConfigValue(loadConfigFileOnly(), 'models.default')).toBe('deepseek:deepseek-v4-flash');
    expect(await engine.getConfig('models.default')).toBeNull();

    await runConfig(engine as never, ['unset', 'models.default']);
    expect(readFileConfigValue(loadConfigFileOnly(), 'models.default')).toBeUndefined();
  });

  test('pattern reset removes matching file and legacy database keys together', async () => {
    await runConfig(engine as never, ['set', 'models.dream.synthesize', 'deepseek:deepseek-v4-flash']);
    await engine.setConfig('models.dream.patterns', 'legacy:database-model');

    await runConfig(engine as never, ['unset', '--pattern', 'models.dream.']);

    expect(readFileConfigValue(loadConfigFileOnly(), 'models.dream.synthesize')).toBeUndefined();
    expect(await engine.getConfig('models.dream.patterns')).toBeNull();
  });
});

/**
 * #2119: `gbrain config set <provider>_api_key` must write the file plane
 * (~/.gbrain/config.json) — the only plane the gateway reads keys from
 * (src/core/ai/build-gateway-config.ts) — never the DB plane, which was a
 * silent no-op. `config unset` for the same keys must remove the file-plane
 * value.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import { runConfig, API_KEY_FILE_PLANE_KEYS } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let home: string;
let configJson: string;
let setConfigCalls: Array<[string, string]>;
let unsetConfigCalls: string[];

const stubEngine = {
  setConfig: async (k: string, v: string) => { setConfigCalls.push([k, v]); },
  unsetConfig: async (k: string) => { unsetConfigCalls.push(k); return 0; },
  getConfig: async () => null,
  listConfigKeys: async () => [],
} as unknown as BrainEngine;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-apikey-'));
  configJson = join(home, '.gbrain', 'config.json');
  setConfigCalls = [];
  unsetConfigCalls = [];
});

describe('config set *_api_key writes the file plane (#2119)', () => {
  test('anthropic_api_key lands in ~/.gbrain/config.json, not the DB plane', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runConfig(stubEngine, ['set', 'anthropic_api_key', 'sk-ant-test-123']);
    });
    const saved = JSON.parse(readFileSync(configJson, 'utf-8'));
    expect(saved.anthropic_api_key).toBe('sk-ant-test-123');
    expect(setConfigCalls).toEqual([]); // DB plane untouched — nothing reads keys there
  });

  test('preserves existing file-plane fields', async () => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(configJson, JSON.stringify({ engine: 'pglite', database_path: '/x' }));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runConfig(stubEngine, ['set', 'openai_api_key', 'sk-oai-test']);
    });
    const saved = JSON.parse(readFileSync(configJson, 'utf-8'));
    expect(saved.engine).toBe('pglite');
    expect(saved.openai_api_key).toBe('sk-oai-test');
  });

  test('unset removes the file-plane key and clears any stale DB row', async () => {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(configJson, JSON.stringify({ anthropic_api_key: 'sk-old' }));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runConfig(stubEngine, ['unset', 'anthropic_api_key']);
    });
    const saved = JSON.parse(readFileSync(configJson, 'utf-8'));
    expect(saved.anthropic_api_key).toBeUndefined();
    expect(unsetConfigCalls).toEqual(['anthropic_api_key']);
  });

  test('key list covers every key buildGatewayConfig folds into gateway env', () => {
    expect(API_KEY_FILE_PLANE_KEYS.sort()).toEqual([
      'anthropic_api_key', 'openai_api_key', 'openrouter_api_key', 'zeroentropy_api_key',
    ]);
  });
});

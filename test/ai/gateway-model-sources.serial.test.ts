/**
 * #5585 — reconfigureGatewayWithEngine retains WHICH resolution step chose the
 * expansion and chat models (plus a key-name origin), read back through
 * getGatewayModelSource. A later configureGateway with a different model makes
 * the record stale (undefined), never silently inherited.
 *
 * Serial lane: mutates gateway module state and provider/home env vars.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway,
  getChatModel,
  getExpansionModel,
  reconfigureGatewayWithEngine,
  resetGateway,
} from '../../src/core/ai/gateway.ts';
import { getGatewayModelSource } from '../../src/core/ai/gateway-model-sources.ts';
import { _resetDeprecationWarningsForTest } from '../../src/core/model-config.ts';
import { runConfig } from '../../src/commands/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { withEnv } from '../helpers/with-env.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  async setConfig(key: string, value: string) { this.cfg.set(key, value); }
  async getAllConfig() { return Object.fromEntries(this.cfg); }
}

let tmpHome: string;
let stub: StubEngine;
const origWrite = process.stderr.write.bind(process.stderr);
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

function env(extra: Record<string, string | undefined> = {}) {
  return {
    GBRAIN_HOME: tmpHome, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: undefined,
    GBRAIN_MODEL: undefined, GBRAIN_CHAT_MODEL: undefined, GBRAIN_EXPANSION_MODEL: undefined,
    GBRAIN_MODEL_DISCOVERY: 'off', ...extra,
  };
}

async function reconfigure(extra: Record<string, string | undefined> = {}) {
  await withEnv(env(extra), async () => {
    configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    await reconfigureGatewayWithEngine(stub as never);
  });
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-gw-sources-'));
  stub = new StubEngine();
  resetGateway();
  _resetDeprecationWarningsForTest();
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origWrite;
  resetGateway();
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('gateway model provenance', () => {
  test('#6795: persisted config writes reach both gateway models with one DB snapshot', async () => {
    await withEnv(env(), async () => {
      await runConfig(engine, ['set', 'chat_model', 'anthropic:claude-opus-4-7']);
      await runConfig(engine, ['set', 'expansion_model', 'anthropic:claude-sonnet-4-6']);
      expect(await engine.getConfig('chat_model')).toBe('anthropic:claude-opus-4-7');
      expect(await engine.getConfig('expansion_model')).toBe('anthropic:claude-sonnet-4-6');
      const all = engine.getAllConfig;
      const one = engine.getConfig;
      let snapshots = 0;
      engine.getAllConfig = async function () { snapshots++; return all.call(this); };
      engine.getConfig = async function () { throw new Error('unexpected per-key round trip'); };
      try {
        configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
        await reconfigureGatewayWithEngine(engine);
        expect(getChatModel()).toBe('anthropic:claude-opus-4-7');
        expect(getExpansionModel()).toBe('anthropic:claude-sonnet-4-6');
        expect(snapshots).toBe(1);
      } finally {
        engine.getAllConfig = all;
        engine.getConfig = one;
      }
    });
  });

  for (const [key, touchpoint, model] of [
    ['chat_model', 'chat', 'anthropic:claude-opus-4-7'],
    ['expansion_model', 'expansion', 'anthropic:claude-sonnet-4-6'],
  ] as const) {
    const selected = () => touchpoint === 'chat' ? getChatModel() : getExpansionModel();

    test(`#6795: config set ${key} reaches reconnect and names its DB origin`, async () => {
      await withEnv(env(), async () => {
        await runConfig(stub as never, ['set', key, model]);
        expect(await stub.getConfig(key)).toBe(model);
        configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
        await reconfigureGatewayWithEngine(stub as never);
        expect(selected()).toBe(model);
        expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'config_key', origin: key });
        stub.set(key, 'anthropic:claude-haiku-4-5-20251001');
        await reconfigureGatewayWithEngine(stub as never);
        expect(selected()).toBe('anthropic:claude-haiku-4-5-20251001');
      });
    });

    test(`#6795: ${key} preserves file/env and models.* precedence`, async () => {
      stub.set(key, model);
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', [key]: 'anthropic:claude-haiku-4-5-20251001' }));
      await reconfigure();
      expect(selected()).toBe('anthropic:claude-haiku-4-5-20251001');
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'file_config', origin: `${key} (config.json)` });
      const envKey = touchpoint === 'chat' ? 'GBRAIN_CHAT_MODEL' : 'GBRAIN_EXPANSION_MODEL';
      await reconfigure({ [envKey]: 'anthropic:claude-sonnet-4-6' });
      expect(selected()).toBe('anthropic:claude-sonnet-4-6');
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'env', origin: envKey });
      stub.set(`models.${touchpoint}`, 'anthropic:claude-opus-4-7');
      await reconfigure();
      expect(selected()).toBe('anthropic:claude-opus-4-7');
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'config_key', origin: `models.${touchpoint}` });
    });

    test(`#6795: unavailable ${key} provider still falls back rather than rerouting credentials`, async () => {
      stub.set(key, 'openai:gpt-5.2');
      await reconfigure();
      expect(selected()).not.toBe('openai:gpt-5.2');
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'tier_default', origin: 'built-in default' });
    });

    test(`#6795: setting shadowed ${key} discloses precedence without changing the file`, async () => {
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      const path = join(tmpHome, '.gbrain', 'config.json');
      const content = JSON.stringify({ engine: 'pglite', [key]: 'anthropic:claude-haiku-4-5-20251001' });
      writeFileSync(path, content);
      const messages: string[] = [];
      const capture = spyOn(console, 'error').mockImplementation((...args) => { messages.push(args.join(' ')); });
      try {
        await withEnv(env(), () => runConfig(stub as never, ['set', key, model]));
      } finally {
        capture.mockRestore();
      }
      expect(await stub.getConfig(key)).toBe(model);
      expect(readFileSync(path, 'utf8')).toBe(content);
      expect(messages.join('\n')).toContain('DB plane');
      expect(messages.join('\n')).toContain('shadowed');
      expect(messages.join('\n')).toContain(`gbrain config set models.${touchpoint}`);
    });

    test(`#6795: ${key} keeps generic env, tier and global overrides above the legacy row`, async () => {
      stub.set(key, model);
      await reconfigure({ GBRAIN_MODEL: 'anthropic:claude-haiku-4-5-20251001' });
      expect(selected()).toBe('anthropic:claude-haiku-4-5-20251001');
      stub.set('models.default', 'anthropic:claude-haiku-4-5-20251001');
      await reconfigure();
      expect(selected()).toBe('anthropic:claude-haiku-4-5-20251001');
      stub.set(`models.tier.${touchpoint === 'chat' ? 'reasoning' : 'utility'}`, 'anthropic:claude-sonnet-4-6');
      await reconfigure();
      expect(selected()).toBe('anthropic:claude-sonnet-4-6');
    });

    test(`#6795: removing ${key} drops the previous job's selection`, async () => {
      stub.set(key, model);
      await reconfigure();
      expect(selected()).toBe(model);
      stub.set(key, '');
      await withEnv(env(), () => reconfigureGatewayWithEngine(stub as never));
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'tier_default', origin: 'built-in default' });
      expect(selected()).not.toBe(model);
    });

    test(`#6795: ${key} readiness includes file-plane provider credentials`, async () => {
      stub.set(key, model);
      mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
      writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', anthropic_api_key: 'sk-ant-test' }));
      await withEnv(env({ ANTHROPIC_API_KEY: undefined }), async () => {
        configureGateway({ env: {} });
        await reconfigureGatewayWithEngine(stub as never);
        expect(selected()).toBe(model);
        expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'config_key', origin: key });
      });
    });
  }

  test('tier config and models.default are attributed to their keys', async () => {
    stub.set('models.tier.utility', 'anthropic:claude-haiku-4-5-20251001');
    stub.set('models.default', 'anthropic:claude-sonnet-4-6');
    await reconfigure();
    expect(getGatewayModelSource('expansion', getExpansionModel())).toEqual({ source: 'tier_config', origin: 'models.tier.utility' });
    expect(getGatewayModelSource('chat', getChatModel())).toEqual({ source: 'models_default', origin: 'models.default' });
  });

  test('models.chat config key wins and is named', async () => {
    stub.set('models.chat', 'anthropic:claude-sonnet-4-6');
    await reconfigure();
    expect(getGatewayModelSource('chat', getChatModel())).toEqual({ source: 'config_key', origin: 'models.chat' });
  });

  test('a servable config.json pin reports file_config; its env override reports env', async () => {
    mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', chat_model: 'anthropic:claude-opus-4-7' }));
    await reconfigure();
    expect(getChatModel()).toBe('anthropic:claude-opus-4-7');
    expect(getGatewayModelSource('chat', getChatModel())).toEqual({ source: 'file_config', origin: 'chat_model (config.json)' });

    await reconfigure({ GBRAIN_EXPANSION_MODEL: 'anthropic:claude-haiku-4-5-20251001' });
    expect(getGatewayModelSource('expansion', getExpansionModel())).toEqual({ source: 'env', origin: 'GBRAIN_EXPANSION_MODEL' });
  });

  test('nothing configured -> tier_default / built-in default', async () => {
    await reconfigure();
    expect(getGatewayModelSource('expansion', getExpansionModel())).toEqual({ source: 'tier_default', origin: 'built-in default' });
    expect(getGatewayModelSource('chat', getChatModel())).toEqual({ source: 'tier_default', origin: 'built-in default' });
  });

  test('a later configureGateway with a different model makes the record stale; resetGateway clears it', async () => {
    stub.set('models.tier.utility', 'anthropic:claude-haiku-4-5-20251001');
    await reconfigure();
    const expansion = getExpansionModel();
    configureGateway({ expansion_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    expect(getGatewayModelSource('expansion', getExpansionModel())).toBeUndefined();
    resetGateway();
    expect(getGatewayModelSource('expansion', expansion)).toBeUndefined();
  });
});

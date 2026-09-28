/**
 * #5585 — reconfigureGatewayWithEngine retains WHICH resolution step chose the
 * expansion and chat models (plus a key-name origin), read back through
 * getGatewayModelSource. A later configureGateway with a different model makes
 * the record stale (undefined), never silently inherited.
 *
 * Serial lane: mutates gateway module state and provider/home env vars.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
import { withEnv } from '../helpers/with-env.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  async setConfig() {}
}

let tmpHome: string;
let stub: StubEngine;
const origWrite = process.stderr.write.bind(process.stderr);

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

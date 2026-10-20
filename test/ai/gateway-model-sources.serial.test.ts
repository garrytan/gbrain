/**
 * #5585 — reconfigureGatewayWithEngine retains WHICH resolution step chose the
 * expansion and chat models (plus a key-name origin), read back through
 * getGatewayModelSource. A later configureGateway with a different model makes
 * the record stale (undefined), never silently inherited.
 *
 * Serial lane: mutates gateway module state and provider/home env vars.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
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
import { withEnv } from '../helpers/with-env.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  async setConfig(key: string, value: string) { this.cfg.set(key, value); }
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

/** Run `gbrain config` against the stub; returns stdout and stderr lines. */
async function config(args: string[], extra: Record<string, string | undefined> = {}): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  try {
    await withEnv(env(extra), () => runConfig(stub as never, args));
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { out, err };
}

function pinFile(key: string, value: string): string {
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  const path = join(tmpHome, '.gbrain', 'config.json');
  writeFileSync(path, JSON.stringify({ engine: 'pglite', [key]: value }));
  return path;
}

for (const [key, touchpoint, model] of [
  ['chat_model', 'chat', 'anthropic:claude-opus-4-7'],
  ['expansion_model', 'expansion', 'anthropic:claude-sonnet-4-6'],
] as const) {
  const selected = () => touchpoint === 'chat' ? getChatModel() : getExpansionModel();
  const pinEnv = touchpoint === 'chat' ? 'GBRAIN_CHAT_MODEL' : 'GBRAIN_EXPANSION_MODEL';
  const OTHER = 'anthropic:claude-haiku-4-5-20251001';

  describe(`#6795: DB-plane ${key}`, () => {
    test('config set reaches the gateway and is attributed to the key', async () => {
      const { out, err } = await config(['set', key, model]);
      expect(out).toEqual([`Set ${key} = ${model}`]);
      expect(err.join('\n')).not.toContain('WARN');
      await reconfigure();
      expect(selected()).toBe(model);
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'config_key', origin: key });
      stub.set(key, OTHER);
      await reconfigure();
      expect(selected()).toBe(OTHER);
      stub.set(key, '');
      await reconfigure();
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'tier_default', origin: 'built-in default' });
    });

    test('a file pin, its env var, GBRAIN_MODEL and models.* keys all outrank it', async () => {
      stub.set(key, model);
      pinFile(key, OTHER);
      await reconfigure();
      expect(selected()).toBe(OTHER);
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'file_config', origin: `${key} (config.json)` });
      await reconfigure({ [pinEnv]: 'anthropic:claude-sonnet-4-6' });
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'env', origin: pinEnv });
      rmSync(join(tmpHome, '.gbrain', 'config.json'));
      await reconfigure({ GBRAIN_MODEL: OTHER });
      expect(selected()).toBe(OTHER);
      stub.set(`models.${touchpoint}`, 'anthropic:claude-sonnet-4-6');
      await reconfigure();
      expect(selected()).toBe('anthropic:claude-sonnet-4-6');
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'config_key', origin: `models.${touchpoint}` });
    });

    test('a DB value whose provider has no key falls back to the default', async () => {
      stub.set(key, 'openai:gpt-5.2');
      await reconfigure();
      expect(selected()).not.toBe('openai:gpt-5.2');
      expect(getGatewayModelSource(touchpoint, selected())).toEqual({ source: 'tier_default', origin: 'built-in default' });
    });

    test('config set --json reports effective:true when nothing outranks the write', async () => {
      const { out } = await config(['set', key, model, '--json']);
      expect(JSON.parse(out.join(''))).toEqual({ key, value: model, written: true, effective: true });
    });

    test('a shadowing config.json pin: warning names the file, never its value; the fix clears only the pin', async () => {
      const path = pinFile(key, OTHER);
      const before = readFileSync(path, 'utf8');
      const text = await config(['set', key, model]);
      expect(await stub.getConfig(key)).toBe(model);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(text.err.join('\n')).toContain(`[config] WARN: ${key} was stored in the database, but the ${key} pin in ${path} outranks it`);
      expect(text.err.join('\n')).toContain(`gbrain config unset ${key} --file`);
      expect(text.err.join('\n')).not.toContain(OTHER);
      const { out } = await config(['set', key, model, '--json']);
      const doc = JSON.parse(out.join(''));
      expect(doc).toMatchObject({ key, written: true, effective: false, shadowed_by: { kind: 'file', name: path } });
      expect(doc.notices[0]).toMatchObject({ code: 'config_write_shadowed', kind: 'degraded',
        fix: { argv: ['gbrain', 'config', 'unset', key, '--file'], next: 'ask_user', verify: { argv: ['gbrain', 'config', 'get', key] } } });
      expect(JSON.stringify(doc)).not.toContain(OTHER);
      const unset = await config(['unset', key, '--file']);
      expect(unset.out).toEqual([`Unset ${key} (file plane: ${path})`]);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ engine: 'pglite' });
      expect(await stub.getConfig(key)).toBe(model);
      await reconfigure();
      expect(selected()).toBe(model);
    });

    test('a shadowing env var is named by variable; the user unsets it', async () => {
      const { out } = await config(['set', key, model, '--json'], { [pinEnv]: OTHER });
      const doc = JSON.parse(out.join(''));
      expect(doc).toMatchObject({ effective: false, shadowed_by: { kind: 'env', name: pinEnv } });
      expect(doc.notices[0].fix).toMatchObject({ argv: ['unset', pinEnv], actor: 'user', next: 'tell_user_to_run' });
      expect(JSON.stringify(doc)).not.toContain(OTHER);
      const generic = JSON.parse((await config(['set', key, model, '--json'], { GBRAIN_MODEL: OTHER })).out.join(''));
      expect(generic.shadowed_by).toEqual({ kind: 'env', name: 'GBRAIN_MODEL' });
    });

    test('a shadowing models.* key is named; the fix unsets that key after asking', async () => {
      for (const name of [`models.${touchpoint}`, `models.tier.${touchpoint === 'chat' ? 'reasoning' : 'utility'}`, 'models.default']) {
        stub = new StubEngine();
        stub.set(name, OTHER);
        const doc = JSON.parse((await config(['set', key, model, '--json'])).out.join(''));
        expect(doc).toMatchObject({ effective: false, shadowed_by: { kind: 'config_key', name } });
        expect(doc.notices[0].fix).toMatchObject({ argv: ['gbrain', 'config', 'unset', name], next: 'ask_user' });
      }
    });

    test('--json is refused for every other key, before any write', async () => {
      const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
      try {
        await expect(config(['set', 'search.mode', 'balanced', '--json'])).rejects.toThrow('exit 1');
      } finally { exit.mockRestore(); }
      expect(await stub.getConfig('search.mode')).toBeNull();
    });
  });
}

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

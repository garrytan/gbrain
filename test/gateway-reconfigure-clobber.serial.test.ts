/**
 * reconfigureGatewayWithEngine — the clobber regression suite.
 *
 * The historical bug: reconfigure resolved `models.chat` with tier
 * 'reasoning', and the key-blind tier default beat the caller fallback — an
 * explicit `chat_model: "openai:gpt-5.2"` in ~/.gbrain/config.json was
 * silently replaced with the Anthropic default on every engine connect.
 *
 * Post-fix contract: DB-plane overrides win as before; when resolution falls
 * to the tier default, the SHARED effective-model resolver consults the RAW
 * file config — a SERVABLE pin survives, an unservable pin (provider switch)
 * falls to the key-aware default with one warn.
 *
 * Hermetic: GBRAIN_HOME points at a temp dir (the file-plane read), provider
 * key envs are pinned, gateway env is injected via configureGateway.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureGateway,
  reconfigureGatewayWithEngine,
  getChatModel,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { TIER_DEFAULTS, _resetDeprecationWarningsForTest, openaiStaticTierFallback } from '../src/core/model-config.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  private cfg = new Map<string, string>();
  set(key: string, value: string) { this.cfg.set(key, value); }
  async getConfig(key: string) { return this.cfg.get(key) ?? null; }
  async setConfig() {}
}

const PINNED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GBRAIN_MODEL', 'GBRAIN_CHAT_MODEL', 'GBRAIN_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;
let stub: StubEngine;
let stderrCapture: string;
const origWrite = process.stderr.write.bind(process.stderr);

function writeFileConfig(cfg: Record<string, unknown>): void {
  // GBRAIN_HOME is a PARENT dir — configDir() appends '.gbrain' itself.
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...cfg }));
}

beforeEach(() => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-reconf-'));
  process.env.GBRAIN_HOME = tmpHome;
  stub = new StubEngine();
  resetGateway();
  _resetDeprecationWarningsForTest();
  stderrCapture = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origWrite;
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Shard hygiene (same pattern as facts-extract-silent-no-op.test.ts): restore
// the legacy embedding pin so later fresh-schema files in this shard's
// process don't size vector columns from this file's leftover gateway state.
afterAll(() => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

describe('reconfigureGatewayWithEngine — no-clobber', () => {
  test('servable file pin survives reconnect (THE regression)', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe('openai:gpt-5.2');
  });

  test('DB-plane models.chat still wins over everything', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { OPENAI_API_KEY: 'sk-test' } });
    stub.set('models.chat', 'anthropic:claude-opus-4-7');
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe('anthropic:claude-opus-4-7');
  });

  test('provider switch: unservable openai pin + anthropic-only key → key-aware default + one warn', async () => {
    writeFileConfig({ chat_model: 'openai:gpt-5.2' });
    configureGateway({ chat_model: 'openai:gpt-5.2', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(TIER_DEFAULTS.reasoning);
    expect(stderrCapture).toContain('openai:gpt-5.2');
    expect(stderrCapture).toContain('no usable');
  });

  test('keyless + no pin → tier default (today\'s shape, honest downstream)', async () => {
    writeFileConfig({});
    configureGateway({ env: {} });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(TIER_DEFAULTS.reasoning);
  });

  test('openai-only, no pin → key-aware tier default routes chat to openai', async () => {
    writeFileConfig({ openai_api_key: 'sk-file-plane' });
    configureGateway({ env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    expect(getChatModel()).toBe(openaiStaticTierFallback().reasoning);
  });
});

describe('expansion-side effective resolution (review-army addition)', () => {
  test('servable expansion_model file pin survives reconnect', async () => {
    writeFileConfig({ expansion_model: 'openai:gpt-4o-mini' });
    configureGateway({ expansion_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'sk-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    const { getExpansionModel } = await import('../src/core/ai/gateway.ts');
    expect(getExpansionModel()).toBe('openai:gpt-4o-mini');
  });

  test('unservable expansion pin falls to the key-aware utility default + warn', async () => {
    writeFileConfig({ expansion_model: 'openai:gpt-4o-mini' });
    configureGateway({ expansion_model: 'openai:gpt-4o-mini', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    await reconfigureGatewayWithEngine(stub as never);
    const { getExpansionModel } = await import('../src/core/ai/gateway.ts');
    expect(getExpansionModel()).toBe(TIER_DEFAULTS.utility);
    expect(stderrCapture).toContain('expansion_model');
  });
});

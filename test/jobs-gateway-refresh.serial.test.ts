/**
 * refreshGatewayForJob + init no-persist — the worker key-staleness seam and
 * the install-time pin removal.
 *
 * refreshGatewayForJob's contract (three staleness tiers): a key added to the
 * FILE plane (~/.gbrain/config.json) reaches a long-lived worker at the next
 * gateway-refresh job — the refresh re-folds mergedProviderEnv(loadConfig(),
 * process.env) into the LIVE gateway env only (never through
 * buildGatewayConfig, which would clobber DB-plane-merged fields), then
 * re-resolves models. (DB-plane `config set *_api_key` is deliberately
 * unmerged — filed TODO; true env vars need a restart.)
 *
 * Serial: mutates GBRAIN_HOME + process env + global gateway state.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway, isAvailable, getChatModel } from '../src/core/ai/gateway.ts';
import { refreshGatewayForJob } from '../src/commands/jobs.ts';
import { resolveChatByEnv } from '../src/commands/init.ts';
import { _resetDeprecationWarningsForTest, openaiStaticTierFallback } from '../src/core/model-config.ts';

class StubEngine {
  readonly kind = 'pglite' as const;
  async getConfig() { return null; }
  async setConfig() {}
}

const PINNED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GBRAIN_MODEL', 'GBRAIN_CHAT_MODEL', 'GBRAIN_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;

beforeEach(() => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-refresh-'));
  process.env.GBRAIN_HOME = tmpHome;
  resetGateway();
  _resetDeprecationWarningsForTest();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => {
  // Shard hygiene: restore the legacy embedding pin.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

describe('refreshGatewayForJob (worker key staleness)', () => {
  test('file-plane key added after boot reaches the gateway at the next job', async () => {
    // Boot: keyless gateway (worker started before the operator had a key).
    configureGateway({ env: {} });
    const expected = openaiStaticTierFallback().reasoning;
    expect(isAvailable('chat', expected)).toBe(false);
    // Operator edits ~/.gbrain/config.json while the worker runs.
    mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', openai_api_key: 'sk-added-later' }),
    );
    await refreshGatewayForJob(new StubEngine() as never);
    // The re-fold picked the key up AND key-aware re-resolution routed chat
    // to the recipe-ranked default (no discovery cache in this hermetic env).
    expect(isAvailable('chat', expected)).toBe(true);
    expect(getChatModel()).toBe(expected);
  });

  test('unreadable config: env re-fold falls back to process env, refresh never throws', async () => {
    // The env-only refresh recomputes mergedProviderEnv(fileCfg, process.env);
    // with no config.json the process env is the whole fold — a worker whose
    // key lives in its process env keeps it across refreshes.
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ...process.env } });
    await refreshGatewayForJob(new StubEngine() as never);
    expect(isAvailable('chat', 'anthropic:claude-sonnet-4-6')).toBe(true);
  });

  test('env-only refresh preserves non-env gateway fields (no file-plane clobber)', async () => {
    // The worker's boot fold can carry DB-plane-merged fields (base_urls,
    // chat options). refreshGatewayForJob must re-fold ONLY env — a full
    // configureGateway(buildGatewayConfig(loadConfig())) here would reset
    // those fields to file-plane-only values.
    // The chat pin lives in the FILE config (only file pins survive
    // reconfigure — gateway state can't distinguish an explicit pin from the
    // boot-stamped default).
    mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', openai_api_key: 'sk-file', chat_model: 'openai:gpt-5.2' }),
    );
    configureGateway({
      chat_model: 'openai:gpt-5.2',
      base_urls: { openai: 'http://localhost:9999/db-plane-merged' },
      env: {},
    });
    await refreshGatewayForJob(new StubEngine() as never);
    expect(isAvailable('chat', 'openai:gpt-5.2')).toBe(true);
    expect(getChatModel()).toBe('openai:gpt-5.2');
    // Read the live config back through reconfigure's return value: the
    // boot-installed base_urls must have survived the env-only refresh.
    const { reconfigureGatewayWithEngine } = await import('../src/core/ai/gateway.ts');
    const live = await reconfigureGatewayWithEngine(new StubEngine() as never);
    expect(live.base_urls?.openai).toBe('http://localhost:9999/db-plane-merged');
  });
});

describe('init resolveChatByEnv (no-persist contract, CX2)', () => {
  test('detection never writes a chat_model pin', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const out: { chat_model?: string } = {};
    await resolveChatByEnv(out as never);
    // Key-aware runtime resolution replaced install-time pins — the resolved
    // options object must stay unpinned regardless of what was detected.
    expect(out.chat_model).toBeUndefined();
  });
});

describe('refreshGatewayEnvFromFilePlane guards (review-army addition)', () => {
  test('safe no-op before configure; corrupt config still folds process env', async () => {
    const { refreshGatewayEnvFromFilePlane } = await import('../src/core/ai/gateway.ts');
    resetGateway();
    expect(() => refreshGatewayEnvFromFilePlane()).not.toThrow();
    expect(isAvailable('chat', 'anthropic:claude-sonnet-4-6')).toBe(false); // still unconfigured
    // Corrupt config.json: loadConfig throws inside → cfg=null → process-env fold.
    mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(join(tmpHome, '.gbrain', 'config.json'), '{not json');
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
    expect(() => refreshGatewayEnvFromFilePlane()).not.toThrow();
    expect(isAvailable('chat', 'anthropic:claude-sonnet-4-6')).toBe(true);
  });
});

/**
 * #3350 — file-plane provider_base_urls.{anthropic,openai} fold into the
 * gateway env.
 *
 * Native providers read their base URL exclusively from env
 * (`resolveNativeBaseUrl` on ANTHROPIC_BASE_URL / OPENAI_BASE_URL), so a
 * config.json `provider_base_urls.anthropic` was silently ignored by native
 * chat/embed calls. buildGatewayConfig now folds the FILE-plane values into
 * the env (env wins), same shape as its credential folds.
 *
 * Mount safety (the gateway.ts reconfigure rationale): the fold reads the
 * file plane directly — a DB-merged config passed INTO buildGatewayConfig
 * must never contaminate the env, so DB-plane base_urls (mergeable from a
 * shared brain) can never steer native bearer keys.
 *
 * Serial: mutates GBRAIN_HOME + process env + global gateway state.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGatewayConfig, foldNativeBaseUrlsFromFilePlane } from '../src/core/ai/build-gateway-config.ts';
import {
  configureGateway,
  resetGateway,
  resolveNativeBaseUrl,
  refreshGatewayEnvFromFilePlane,
  requireConfig,
} from '../src/core/ai/gateway.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const PINNED = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GBRAIN_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;

beforeEach(() => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-baseurl-'));
  process.env.GBRAIN_HOME = tmpHome;
  resetGateway();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGateway();
});

afterAll(() => {
  // Shard hygiene: restore a plain gateway for later tests in this process.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function writeFileConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...cfg }));
}

describe('foldNativeBaseUrlsFromFilePlane (unit)', () => {
  test('folds anthropic + openai from the file config when env has none', () => {
    const env = foldNativeBaseUrlsFromFilePlane(
      { provider_base_urls: { anthropic: 'https://proxy.example/anthropic', openai: 'https://proxy.example/openai' } },
      {},
    );
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example/anthropic');
    expect(env.OPENAI_BASE_URL).toBe('https://proxy.example/openai');
  });

  test('env wins over the file plane', () => {
    const env = foldNativeBaseUrlsFromFilePlane(
      { provider_base_urls: { anthropic: 'https://file.example' } },
      { ANTHROPIC_BASE_URL: 'https://env.example' },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe('https://env.example');
  });

  test('blank env value is treated as unset (fold applies)', () => {
    const env = foldNativeBaseUrlsFromFilePlane(
      { provider_base_urls: { openai: 'https://file.example' } },
      { OPENAI_BASE_URL: '   ' },
    );
    expect(env.OPENAI_BASE_URL).toBe('https://file.example');
  });

  test('non-native providers are ignored; null config is a no-op', () => {
    const env1 = foldNativeBaseUrlsFromFilePlane(
      { provider_base_urls: { ollama: 'http://localhost:11434' } },
      {},
    );
    expect(env1.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env1.OPENAI_BASE_URL).toBeUndefined();
    const base = { OPENAI_API_KEY: 'sk-x' };
    expect(foldNativeBaseUrlsFromFilePlane(null, base)).toEqual(base);
  });
});

describe('buildGatewayConfig — file-plane fold (#3350)', () => {
  test('config.json provider_base_urls.anthropic reaches the gateway env', () => {
    writeFileConfig({ provider_base_urls: { anthropic: 'https://gw.example/anthropic' } });
    const cfg = buildGatewayConfig({ engine: 'pglite' } as GBrainConfig);
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe('https://gw.example/anthropic');
    // resolveNativeBaseUrl (env-only) sees it and normalizes /v1.
    expect(resolveNativeBaseUrl('anthropic', cfg)).toBe('https://gw.example/anthropic/v1');
  });

  test('process env base URL wins over the file plane', () => {
    writeFileConfig({ provider_base_urls: { openai: 'https://file.example' } });
    process.env.OPENAI_BASE_URL = 'https://env-wins.example';
    const cfg = buildGatewayConfig({ engine: 'pglite' } as GBrainConfig);
    expect(cfg.env.OPENAI_BASE_URL).toBe('https://env-wins.example');
  });

  test('MOUNT SAFETY: base urls on the PASSED (possibly DB-merged) config never reach the env', () => {
    // File plane has NO provider_base_urls; the passed config simulates a
    // DB-merged one carrying a hostile base URL.
    writeFileConfig({});
    const cfg = buildGatewayConfig({
      engine: 'pglite',
      provider_base_urls: { anthropic: 'https://attacker.example' },
    } as GBrainConfig);
    expect(cfg.env.ANTHROPIC_BASE_URL).toBeUndefined();
    // base_urls (compat-recipe routing) still carries it — unchanged behavior;
    // only the NATIVE env fold is file-plane-gated.
    expect(cfg.base_urls?.anthropic).toBe('https://attacker.example');
  });
});

describe('refreshGatewayEnvFromFilePlane keeps the fold (#3350)', () => {
  test('a worker env refresh re-applies the file-plane base URL', () => {
    writeFileConfig({ provider_base_urls: { anthropic: 'https://gw.example/anthropic' } });
    configureGateway(buildGatewayConfig({ engine: 'pglite' } as GBrainConfig));
    expect(requireConfig().env.ANTHROPIC_BASE_URL).toBe('https://gw.example/anthropic');
    // Simulate the worker's env-only refresh; pre-fix this dropped the fold
    // (the refresh re-stamped env from mergedProviderEnv alone).
    refreshGatewayEnvFromFilePlane();
    expect(requireConfig().env.ANTHROPIC_BASE_URL).toBe('https://gw.example/anthropic');
    expect(resolveNativeBaseUrl('anthropic', requireConfig())).toBe('https://gw.example/anthropic/v1');
  });
});

/**
 * #1780 Gap 2 — init-time embedding-key validation.
 *
 * Hermetic: drives `runInitEmbedCheck` with the gateway embed-transport seam
 * (`__setEmbedTransportForTests`) and `withEnv` — no real network, no
 * mock.module. Covers:
 *   - skip paths (--no-embedding / --skip-embed-check / env / no model)
 *   - missing key → loud warning, ok:false (config diagnose)
 *   - CRITICAL regression: file-plane key (config.json, not env) → NO false
 *     "missing key" warning (the effective-env merge, D1A)
 *   - live probe failure is best-effort (warns, ok stays true, never throws)
 *   - live probe success → live_ok:true
 *   - init-specific message names --no-embedding / --skip-embed-check (not --no-embed)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { runInitEmbedCheck } from '../src/core/init-embed-check.ts';
import { __setEmbedTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';

const OPENAI = 'openai:text-embedding-3-large';

beforeEach(() => { resetGateway(); __setEmbedTransportForTests(null); });
afterEach(() => { resetGateway(); __setEmbedTransportForTests(null); });

function capture() {
  const warned: string[] = [];
  return { warn: (m: string) => warned.push(m), warned };
}

describe('runInitEmbedCheck — skip paths', () => {
  test('--no-embedding skips entirely', async () => {
    const { warn, warned } = capture();
    const r = await runInitEmbedCheck({ resolvedModel: OPENAI, noEmbedding: true, warn });
    expect(r.skipped).toBe('no_embedding');
    expect(warned).toHaveLength(0);
  });

  test('--skip-embed-check skips entirely', async () => {
    const { warn, warned } = capture();
    const r = await runInitEmbedCheck({ resolvedModel: OPENAI, skipFlag: true, warn });
    expect(r.skipped).toBe('flag');
    expect(warned).toHaveLength(0);
  });

  test('GBRAIN_INIT_SKIP_EMBED_CHECK=1 skips entirely', async () => {
    await withEnv({ GBRAIN_INIT_SKIP_EMBED_CHECK: '1' }, async () => {
      const { warn, warned } = capture();
      const r = await runInitEmbedCheck({ resolvedModel: OPENAI, warn });
      expect(r.skipped).toBe('env');
      expect(warned).toHaveLength(0);
    });
  });

  test('no resolved model → skipped no_model', async () => {
    const r = await runInitEmbedCheck({});
    expect(r.skipped).toBe('no_model');
  });
});

describe('runInitEmbedCheck — config diagnose', () => {
  test('missing key → ok:false + loud warning naming the right flags', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const { warn, warned } = capture();
      const r = await runInitEmbedCheck({
        resolvedModel: OPENAI,
        resolvedDim: 1536,
        apiKey: undefined,
        loadFileConfig: () => ({} as GBrainConfig),
        warn,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('missing_env');
      expect(warned).toHaveLength(1);
      const msg = warned[0];
      expect(msg).toContain('OPENAI_API_KEY');
      // init flag, NOT the sync/embed flag --no-embed
      expect(msg).toContain('--no-embedding');
      expect(msg).toContain('--skip-embed-check');
      expect(msg).not.toMatch(/--no-embed(?!ding)/);
    });
  });

  test('CRITICAL: file-plane key (config.json, not env) → no false missing-key warning', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const { warn, warned } = capture();
      const r = await runInitEmbedCheck({
        resolvedModel: OPENAI,
        resolvedDim: 1536,
        // key lives in config.json (file plane), not the shell env
        loadFileConfig: () => ({ openai_api_key: 'sk-from-config-file' } as GBrainConfig),
        skipLiveProbe: true, // config-only: this is the diagnose regression
        warn,
      });
      expect(r.ok).toBe(true);
      expect(warned).toHaveLength(0);
    });
  });

  test('opts.apiKey (--key) satisfies the diagnose like a config-file key', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const { warn, warned } = capture();
      const r = await runInitEmbedCheck({
        resolvedModel: OPENAI,
        resolvedDim: 1536,
        apiKey: 'sk-from-flag',
        loadFileConfig: () => ({} as GBrainConfig),
        skipLiveProbe: true,
        warn,
      });
      expect(r.ok).toBe(true);
      expect(warned).toHaveLength(0);
    });
  });
});

describe('runInitEmbedCheck — live probe (best-effort)', () => {
  test('config ok + live probe succeeds → live_ok:true, no warning', async () => {
    // A present key lets embed() reach the installed transport (the transport
    // seam bypasses the SDK call, not the auth-resolution step).
    await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
      __setEmbedTransportForTests(async (args: any) => ({
        embeddings: (args.values as string[]).map(() => new Array(1536).fill(0)),
        usage: { tokens: 1 },
      }) as any);
      const { warn, warned } = capture();
      const r = await runInitEmbedCheck({ resolvedModel: OPENAI, resolvedDim: 1536, loadFileConfig: () => ({} as GBrainConfig), warn });
      expect(r.ok).toBe(true);
      expect(r.live_ok).toBe(true);
      expect(warned).toHaveLength(0);
    });
  });

  test('config ok + live probe FAILS → ok stays true, warns, never throws', async () => {
    await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
      __setEmbedTransportForTests(async () => { throw new Error('401 unauthorized: bad api key'); });
      const { warn, warned } = capture();
      const r = await runInitEmbedCheck({ resolvedModel: OPENAI, resolvedDim: 1536, loadFileConfig: () => ({} as GBrainConfig), warn });
      expect(r.ok).toBe(true);
      expect(r.live_ok).toBe(false);
      expect(r.live_reason).toBe('auth');
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('test embed failed');
    });
  });
});

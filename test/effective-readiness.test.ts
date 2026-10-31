import { afterEach, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { effectiveReadiness } from '../src/core/effective-readiness.ts';
import { configReadiness } from '../src/core/readiness.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { RECIPES } from '../src/core/ai/recipes/index.ts';
import { withEnv } from './helpers/with-env.ts';

const config = { engine: 'postgres', embedding_disabled: true } as GBrainConfig;
const noKeys = Object.fromEntries([...RECIPES.values()].flatMap(r => (r.auth_env?.required ?? []).map(k => [k, undefined])));
const engine = (getConfig: (key: string) => Promise<string | null>) => ({ getConfig, kind: 'postgres' }) as unknown as BrainEngine;
const chat = (rows: Awaited<ReturnType<typeof effectiveReadiness>>) => rows.find(r => r.capability === 'chat_llm');
afterEach(() => resetGateway());

test('a DB model route is ready without adding a key, while the cheap file-plane view remains unchanged', async () => {
  await withEnv({ ...noKeys, GBRAIN_MODEL: undefined }, async () => {
    configureGateway({ env: {} });
    const db = engine(async key => key === 'facts.extraction_model' ? 'ollama:example' : null);
    const before = configReadiness(config, { transport: 'http' });
    expect(chat(before.entries)?.state).toBe('missing');
    expect(chat(await effectiveReadiness(db, config, 'http'))).toMatchObject({ state: 'ok', reason: 'configured', tier: 'probed', http_visible: true });
    expect(configReadiness(config, { transport: 'http' })).toBe(before);
  });
});
test('an unavailable effective route does not claim ready', async () => {
  await withEnv({ ...noKeys, GBRAIN_MODEL: undefined }, async () => {
    configureGateway({ env: {} });
    const result = chat(await effectiveReadiness(engine(async key => key === 'facts.extraction_model' ? 'anthropic:example' : null), config, 'http'));
    expect(result).toMatchObject({ state: 'degraded', reason: 'model_unavailable' });
    expect(result?.why).not.toContain('API key');
  });
});
test('failed and budget-exhausted reads remain unknown, and thin clients do no engine read', async () => {
  expect(chat(await effectiveReadiness(engine(async () => { throw new Error('synthetic'); }), config, 'http'))).toMatchObject({ state: 'unknown', reason: 'probe_failed' });
  expect(chat(await effectiveReadiness(engine(async () => new Promise(() => {})), config, 'http', 5))).toMatchObject({ state: 'unknown', reason: 'probe_timeout' });
  expect(chat(await effectiveReadiness(engine(async () => { throw new Error('must not read'); }), { ...config, remote_mcp: { mcp_url: 'https://example.invalid/mcp' } } as GBrainConfig, 'http'))).toMatchObject({ state: 'not_applicable', reason: 'remote_brain' });
});

import { sourcesOperations } from '../src/core/ops/sources.ts';
import type { OperationContext } from '../src/core/operations.ts';
test('the real whoami operation reports the engine route to a local caller', async () => {
  await withEnv({ ...noKeys, GBRAIN_MODEL: undefined }, async () => {
    configureGateway({ env: {} });
    const db = engine(async key => key === 'facts.extraction_model' ? 'ollama:example' : null);
    const whoami = sourcesOperations.find(op => op.name === 'whoami')!;
    const result = await whoami.handler({ engine: db, config, remote: false } as OperationContext, {}) as { readiness: Awaited<ReturnType<typeof effectiveReadiness>> };
    expect(chat(result.readiness)).toMatchObject({ state: 'ok', reason: 'configured', tier: 'probed' });
  });
});

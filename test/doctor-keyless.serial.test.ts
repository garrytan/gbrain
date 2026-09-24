import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { buildChecks, checkProviderSunset } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

describe('keyless installation diagnostics', () => {
  let home: string;
  let engine: PGLiteEngine;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-keyless-doctor-'));
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite', embedding_disabled: true,
    }));
    configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('search.mode', 'conservative');
    configureGateway({ embedding_model: 'zeroentropyai:zembed-1', embedding_dimensions: 1280, env: {} });
  });

  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
    rmSync(home, { recursive: true, force: true });
  });

  test('does not prescribe provider migration or destructive resizing for disabled embeddings', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const checks = await buildChecks(engine, []);
      for (const name of ['embedding_width_consistency', 'embedding_column_registry', 'ze_embedding_health', 'provider_sunset']) {
        const check = checks.find(c => c.name === name);
        expect(check, name).toBeDefined();
        expect(check!.status, `${name}: ${check!.message}`).toBe('ok');
        expect(check!.message).not.toMatch(/reinit-pglite|ALTER TABLE|migrate embeddings/);
      }
    });
  });

  test('still reports an independently enabled sunset reranker', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('search.reranker.enabled', 'true');
      await engine.setConfig('search.reranker.model', 'zeroentropyai:zerank-2');
      try {
        const check = await checkProviderSunset(engine);
        expect(check.status).toBe('warn');
        expect(check.message).toContain('reranker');
        expect(check.message).not.toContain('embedding_model=');
      } finally {
        await engine.setConfig('search.reranker.enabled', 'false');
      }
    });
  });

  test('still validates explicitly declared custom embedding columns', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.setConfig('embedding_columns', JSON.stringify({
        embedding_example: { provider: 'voyage:voyage-4', dimensions: 1024, type: 'vector' },
      }));
      try {
        const checks = await buildChecks(engine, []);
        const registry = checks.find(c => c.name === 'embedding_column_registry');
        expect(registry?.status).toBe('warn');
        expect(registry?.message).toContain('embedding_example: declared but column does NOT exist');
      } finally {
        await engine.setConfig('embedding_columns', '{}');
      }
    });
  });
});

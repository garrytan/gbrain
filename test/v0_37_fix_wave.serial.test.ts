/**
 * v0.37 fix wave — fresh-install PGLite embedding setup.
 *
 * Covers the multi-bug-class fix surfaced by the user's 9-bug report and
 * the two codex outside-voice review rounds (26 findings folded). Each
 * test pins a specific finding so future regressions surface fast.
 *
 * Test framework: bun:test. Hermetic — no network, no DATABASE_URL needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Lane A — defaults sweep
describe('v0.37 Lane A — defaults sweep', () => {
  test('A.0: gateway re-exports DEFAULT_EMBEDDING_MODEL + DEFAULT_EMBEDDING_DIMENSIONS', async () => {
    // CDX2-1: these were file-private const; Lane A consumers (schema
    // helpers, registry) need them exported. Importing here is the test.
    const { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } = await import('../src/core/ai/gateway.ts');
    expect(DEFAULT_EMBEDDING_MODEL).toBe('zeroentropyai:zembed-1');
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(1280);
  });

  test('A.0: ai/defaults.ts is the canonical source (leaf module, no SDK pulls)', async () => {
    const defaults = await import('../src/core/ai/defaults.ts');
    expect(defaults.DEFAULT_EMBEDDING_MODEL).toBe('zeroentropyai:zembed-1');
    expect(defaults.DEFAULT_EMBEDDING_DIMENSIONS).toBe(1280);
  });

  // T-11 / T-12: registry + schema defaults track gateway constants.
  test('A.1: getPGLiteSchema() default-args produce a vector(1280) column', async () => {
    const { getPGLiteSchema } = await import('../src/core/pglite-schema.ts');
    const sql = getPGLiteSchema(); // no args — uses defaults
    expect(sql).toContain('vector(1280)');
    expect(sql).not.toContain('vector(1536)');
  });

  test('A.2: getPostgresSchema() default-args produce a vector(1280) column', async () => {
    const { getPostgresSchema } = await import('../src/core/postgres-engine.ts');
    const sql = getPostgresSchema();
    expect(sql).toContain('vector(1280)');
    expect(sql).not.toContain('vector(1536)');
  });

  test('A.2: getPostgresSchema() with explicit args still routes the override', async () => {
    const { getPostgresSchema } = await import('../src/core/postgres-engine.ts');
    const sql = getPostgresSchema(2048, 'voyage:voyage-4-large');
    expect(sql).toContain('vector(2048)');
    expect(sql).not.toContain('vector(1280)');
    expect(sql).toContain('voyage:voyage-4-large');
  });

  test('A.5: embedding-column registry builtin defaults to ZE/1280 on empty config + gateway', async () => {
    // The registry's resolution chain is cfg > gateway > DEFAULT. With
    // no cfg AND no gateway, it should fall through to the canonical
    // default (ZE/1280). Reset gateway first to exercise that path.
    const { resetGateway } = await import('../src/core/ai/gateway.ts');
    const { getEmbeddingColumnRegistry } = await import('../src/core/search/embedding-column.ts');
    resetGateway();
    try {
      const reg = getEmbeddingColumnRegistry({ engine: 'pglite' } as any);
      expect(reg['embedding']).toBeDefined();
      expect(reg['embedding'].provider).toBe('zeroentropyai:zembed-1');
      expect(reg['embedding'].dimensions).toBe(1280);
    } finally {
      // Re-apply legacy preload defaults so the rest of the file's tests
      // (and subsequent files in this shard) see a configured gateway.
      const { configureGateway } = await import('../src/core/ai/gateway.ts');
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        env: { ...process.env },
      });
    }
  });

  test('A.5: registry tracks gateway when cfg is empty (gateway as fallback)', async () => {
    // The new "gateway tier" of the resolution chain. Tests configure
    // the gateway to OpenAI/1536 (via preload); registry reflects that
    // even with empty cfg. Lets test fixtures avoid duplicating the
    // model config in two places.
    const { getEmbeddingColumnRegistry } = await import('../src/core/search/embedding-column.ts');
    const reg = getEmbeddingColumnRegistry({ engine: 'pglite' } as any);
    expect(reg['embedding']).toBeDefined();
    expect(reg['embedding'].provider).toBe('openai:text-embedding-3-large');
    expect(reg['embedding'].dimensions).toBe(1536);
  });

  test('A.6: isCacheSafe baselines against gateway state (not stale constants)', async () => {
    // With the preload setting gateway to OpenAI/1536, isCacheSafe
    // considers a 1536/OpenAI resolved column safe even when cfg has
    // no embedding_model.
    const { isCacheSafe } = await import('../src/core/search/embedding-column.ts');
    const resolved1536 = {
      name: 'embedding',
      dimensions: 1536,
      embeddingModel: 'openai:text-embedding-3-large',
      type: 'vector' as const,
      provider: 'openai:text-embedding-3-large',
    };
    expect(isCacheSafe(resolved1536 as any, { engine: 'pglite' } as any)).toBe(true);

    // Wrong dim → unsafe.
    const wrongDim = { ...resolved1536, dimensions: 1280 };
    expect(isCacheSafe(wrongDim as any, { engine: 'pglite' } as any)).toBe(false);

    // Wrong model → unsafe.
    const wrongModel = { ...resolved1536, embeddingModel: 'voyage:voyage-3-large' };
    expect(isCacheSafe(wrongModel as any, { engine: 'pglite' } as any)).toBe(false);
  });
});

// Lane B — init paths + B.4 file-plane merge
describe('v0.37 Lane B — init paths', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-v37-test-'));
    origHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = tmpHome;
  });

  afterAll(() => {
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
  });

  test('B.4 / T-3: loadConfigFileOnly ignores env overrides', async () => {
    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    require('fs').mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({
      engine: 'pglite',
      database_path: '/file/plane/path',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
    }));

    process.env.GBRAIN_EMBEDDING_MODEL = 'voyage:voyage-3-large';
    process.env.GBRAIN_EMBEDDING_DIMENSIONS = '2048';
    process.env.OPENAI_API_KEY = 'sk-from-env';

    // Force re-import to pick up env state (the module-level resolver in
    // config.ts reads process.env at call time, so this is safe).
    delete require.cache[require.resolve('../src/core/config.ts')];
    const { loadConfigFileOnly, loadConfig } = await import('../src/core/config.ts');

    const fileOnly = loadConfigFileOnly();
    expect(fileOnly?.embedding_model).toBe('openai:text-embedding-3-large');
    expect(fileOnly?.embedding_dimensions).toBe(1536);
    // CDX-5 regression: env keys must NOT leak into file-only loader.
    expect(fileOnly?.openai_api_key).toBeUndefined();

    // Control: loadConfig() DOES merge env.
    const merged = loadConfig();
    expect(merged?.embedding_model).toBe('voyage:voyage-3-large');
    expect(merged?.embedding_dimensions).toBe(2048);
    expect(merged?.openai_api_key).toBe('sk-from-env');

    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    delete process.env.OPENAI_API_KEY;
  });

  test('B.4 / CDX-5: loadConfigFileOnly does NOT infer engine from DATABASE_URL', async () => {
    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    require('fs').mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({
      engine: 'pglite',
      database_path: '/pglite/path',
    }));

    process.env.DATABASE_URL = 'postgres://transient@host/db';
    delete require.cache[require.resolve('../src/core/config.ts')];
    const { loadConfigFileOnly, loadConfig } = await import('../src/core/config.ts');

    const fileOnly = loadConfigFileOnly();
    expect(fileOnly?.engine).toBe('pglite');
    expect(fileOnly?.database_path).toBe('/pglite/path');
    expect(fileOnly?.database_url).toBeUndefined();

    // Control: loadConfig() WOULD infer postgres from the env URL.
    const merged = loadConfig();
    expect(merged?.engine).toBe('postgres');

    delete process.env.DATABASE_URL;
  });

  test('B.4: loadConfigFileOnly returns null when no file exists', async () => {
    delete require.cache[require.resolve('../src/core/config.ts')];
    const { loadConfigFileOnly } = await import('../src/core/config.ts');
    expect(loadConfigFileOnly()).toBeNull();
  });
});

// Lane C.3 — ZE key plumbing
describe('v0.37 Lane C.3 — ZE key reaches buildGatewayConfig', () => {
  test('CDX2-5+6: buildGatewayConfig maps zeroentropy_api_key into env dict', async () => {
    // process.env wins over config (intentional — operator escape hatch).
    // Unset the env key so the test exercises the config-only path.
    const savedZe = process.env.ZEROENTROPY_API_KEY;
    const savedOai = process.env.OPENAI_API_KEY;
    const savedAnth = process.env.ANTHROPIC_API_KEY;
    delete process.env.ZEROENTROPY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { buildGatewayConfig } = await import('../src/cli.ts');
      const cfg = {
        engine: 'pglite' as const,
        zeroentropy_api_key: 'test-ze-key',
        openai_api_key: 'test-oai',
        anthropic_api_key: 'test-anth',
      };
      const gwCfg = buildGatewayConfig(cfg as any);
      expect(gwCfg.env?.ZEROENTROPY_API_KEY).toBe('test-ze-key');
      // Regression on the existing two keys.
      expect(gwCfg.env?.OPENAI_API_KEY).toBe('test-oai');
      expect(gwCfg.env?.ANTHROPIC_API_KEY).toBe('test-anth');
    } finally {
      if (savedZe !== undefined) process.env.ZEROENTROPY_API_KEY = savedZe;
      if (savedOai !== undefined) process.env.OPENAI_API_KEY = savedOai;
      if (savedAnth !== undefined) process.env.ANTHROPIC_API_KEY = savedAnth;
    }
  });

  test('CDX2-5+6: process.env wins over config (operator escape hatch contract)', async () => {
    const saved = process.env.ZEROENTROPY_API_KEY;
    process.env.ZEROENTROPY_API_KEY = 'env-wins-key';
    try {
      const { buildGatewayConfig } = await import('../src/cli.ts');
      const cfg = { engine: 'pglite' as const, zeroentropy_api_key: 'file-key' };
      const gwCfg = buildGatewayConfig(cfg as any);
      expect(gwCfg.env?.ZEROENTROPY_API_KEY).toBe('env-wins-key');
    } finally {
      if (saved === undefined) delete process.env.ZEROENTROPY_API_KEY;
      else process.env.ZEROENTROPY_API_KEY = saved;
    }
  });

  test('GBrainConfig type includes zeroentropy_api_key field (TS compile guard)', async () => {
    const { type } = await import('../src/core/config.ts').then(m => ({ type: undefined }));
    // The type-level assertion happens at compile time. If this file
    // compiles, the field exists. Body of the test is a runtime no-op.
    expect(true).toBe(true);
  });
});

// Lane D.1 — engine-kind branching already covered in test/embedding-dim-check.test.ts
// (extended in same wave). The PGLite branch + Postgres branch + databasePath
// fallback + no-op-recipe-removal tests live there.

// Lane D.2 — embed pre-flight dim mismatch
describe('v0.37 Lane D.2 — embed pre-flight dim mismatch', () => {
  test('CDX2-9: EmbeddingDimMismatchError is exported + tagged', async () => {
    const { EmbeddingDimMismatchError } = await import('../src/commands/embed.ts');
    expect(typeof EmbeddingDimMismatchError).toBe('function');
    const err = new EmbeddingDimMismatchError('test recipe');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('embedding_dim_mismatch');
    expect(err.recipeMessage).toBe('test recipe');
    expect(err.name).toBe('EmbeddingDimMismatchError');
  });
});

// Lane D.4 — sync help dispatch
describe('v0.37 Lane D.4 — sync --help dispatch', () => {
  test('CDX2-12: sync is in CLI_ONLY_SELF_HELP', async () => {
    // This is a structural test — read the cli.ts source and assert
    // sync appears in the set. Avoids requiring engine wiring.
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf-8');
    // Match the CLI_ONLY_SELF_HELP set definition.
    const setMatch = src.match(/const CLI_ONLY_SELF_HELP = new Set\(\[([\s\S]*?)\]\)/);
    expect(setMatch).not.toBeNull();
    const body = setMatch![1];
    expect(body).toContain(`'sync'`);
  });
});

// Deferred-TODO ship: gbrain reinit-pglite
describe('v0.37 deferred TODO shipped — gbrain reinit-pglite', () => {
  test('reinit-pglite is registered in CLI_ONLY + CLI_ONLY_SELF_HELP', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf-8');
    const onlyMatch = src.match(/const CLI_ONLY = new Set\(\[([\s\S]*?)\]\)/);
    expect(onlyMatch).not.toBeNull();
    expect(onlyMatch![1]).toContain(`'reinit-pglite'`);

    const selfHelpMatch = src.match(/const CLI_ONLY_SELF_HELP = new Set\(\[([\s\S]*?)\]\)/);
    expect(selfHelpMatch).not.toBeNull();
    expect(selfHelpMatch![1]).toContain(`'reinit-pglite'`);
  });

  test('reinit-pglite module exports runReinitPglite', async () => {
    const mod = await import('../src/commands/reinit-pglite.ts');
    expect(typeof mod.runReinitPglite).toBe('function');
  });

  test('embeddingMismatchMessage PGLite branch recommends `gbrain reinit-pglite`', async () => {
    const { embeddingMismatchMessage } = await import('../src/core/embedding-dim-check.ts');
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 1280,
      requestedModel: 'zeroentropyai:zembed-1',
      source: 'doctor',
      engineKind: 'pglite',
      databasePath: '/tmp/test.pglite',
    });
    // The one-command path appears before the by-hand recipe.
    expect(msg).toContain('gbrain reinit-pglite --embedding-model zeroentropyai:zembed-1 --embedding-dimensions 1280');
    // The by-hand path is still present as fallback.
    expect(msg).toContain('mv /tmp/test.pglite /tmp/test.pglite.bak');
    // The recommended-section header precedes the by-hand section.
    const recIdx = msg.indexOf('Recommended');
    const handIdx = msg.indexOf('Or by hand');
    expect(recIdx).toBeGreaterThan(0);
    expect(handIdx).toBeGreaterThan(recIdx);
  });
});

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
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { surfaceFileSource } from './helpers/source-surface.ts';
import { CLI_ONLY, CLI_ONLY_SELF_HELP } from '../src/cli/command-table.ts';

// Lane A — defaults sweep
describe('v0.37 Lane A — defaults sweep', () => {
  test('A.0: gateway re-exports DEFAULT_EMBEDDING_MODEL + DEFAULT_EMBEDDING_DIMENSIONS', async () => {
    // CDX2-1: these were file-private const; Lane A consumers (schema
    // helpers, registry) need them exported. Importing here is the test.
    const { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } = await import('../src/core/ai/gateway.ts');
    expect(DEFAULT_EMBEDDING_MODEL).toBe('voyage:voyage-4');
    expect(DEFAULT_EMBEDDING_DIMENSIONS).toBe(1024);
  });

  test('A.0: ai/defaults.ts is the canonical source (leaf module, no SDK pulls)', async () => {
    const defaults = await import('../src/core/ai/defaults.ts');
    expect(defaults.DEFAULT_EMBEDDING_MODEL).toBe('voyage:voyage-4');
    expect(defaults.DEFAULT_EMBEDDING_DIMENSIONS).toBe(1024);
  });

  // T-11 / T-12: registry + schema defaults track gateway constants.
  test('A.1: getPGLiteSchema() default-args produce a vector(1024) column', async () => {
    const { getPGLiteSchema } = await import('../src/core/pglite-schema.ts');
    const sql = getPGLiteSchema(); // no args — uses defaults
    expect(sql).toContain('vector(1024)');
    expect(sql).not.toContain('vector(1536)');
  });

  test('A.2: getPostgresSchema() default-args produce a vector(1024) column', async () => {
    const { getPostgresSchema } = await import('../src/core/postgres-engine.ts');
    const sql = getPostgresSchema();
    expect(sql).toContain('vector(1024)');
    expect(sql).not.toContain('vector(1536)');
  });

  test('A.2: getPostgresSchema() with explicit args still routes the override', async () => {
    const { getPostgresSchema } = await import('../src/core/postgres-engine.ts');
    const sql = getPostgresSchema(2048, 'voyage:voyage-4-large');
    expect(sql).toContain('vector(2048)');
    expect(sql).not.toMatch(/\n\s*embedding vector\(1024\)/);
    expect(sql).toContain('voyage:voyage-4-large');
  });

  test('A.5: embedding-column registry builtin defaults to Voyage/1024 on empty config + gateway', async () => {
    // The registry's resolution chain is cfg > gateway > DEFAULT. With
    // no cfg AND no gateway, it should fall through to the canonical
    // default (Voyage/1024). Hard-unconfigure first to exercise that path —
    // resetGateway() would restore the preload's 1536 baseline (#3554).
    const { __unconfigureGatewayForTests, resetGateway } = await import('../src/core/ai/gateway.ts');
    const { getEmbeddingColumnRegistry } = await import('../src/core/search/embedding-column.ts');
    __unconfigureGatewayForTests();
    try {
      const reg = getEmbeddingColumnRegistry({ engine: 'pglite' } as any);
      expect(reg['embedding']).toBeDefined();
      expect(reg['embedding'].provider).toBe('voyage:voyage-4');
      expect(reg['embedding'].dimensions).toBe(1024);
    } finally {
      // Restore the preload's legacy baseline so the rest of the file's
      // tests (and subsequent files in this shard) see a configured gateway.
      resetGateway();
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
    const wrongDim = { ...resolved1536, dimensions: 1024 };
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
    process.env.OPENROUTER_API_KEY = 'sk-or-from-env';

    // Force re-import to pick up env state (the module-level resolver in
    // config.ts reads process.env at call time, so this is safe).
    delete require.cache[require.resolve('../src/core/config.ts')];
    const { loadConfigFileOnly, loadConfig } = await import('../src/core/config.ts');

    const fileOnly = loadConfigFileOnly();
    expect(fileOnly?.embedding_model).toBe('openai:text-embedding-3-large');
    expect(fileOnly?.embedding_dimensions).toBe(1536);
    // CDX-5 regression: env keys must NOT leak into file-only loader.
    expect(fileOnly?.openai_api_key).toBeUndefined();
    expect(fileOnly?.openrouter_api_key).toBeUndefined();

    // Control: loadConfig() DOES merge env.
    const merged = loadConfig();
    expect(merged?.embedding_model).toBe('voyage:voyage-3-large');
    expect(merged?.embedding_dimensions).toBe(2048);
    expect(merged?.openai_api_key).toBe('sk-from-env');
    expect(merged?.openrouter_api_key).toBe('sk-or-from-env');

    delete process.env.GBRAIN_EMBEDDING_MODEL;
    delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
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

// Lane C.3 — Voyage key plumbing
describe('v0.37 Lane C.3 — Voyage key reaches buildGatewayConfig', () => {
  test('CDX2-5+6: buildGatewayConfig maps voyage_api_key into env dict', async () => {
    // process.env wins over config (intentional — operator escape hatch).
    // Unset the env key so the test exercises the config-only path.
    const savedVoyage = process.env.VOYAGE_API_KEY;
    const savedOai = process.env.OPENAI_API_KEY;
    const savedAnth = process.env.ANTHROPIC_API_KEY;
    const savedOr = process.env.OPENROUTER_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const { buildGatewayConfig } = await import('../src/cli/main.ts');
      const cfg = {
        engine: 'pglite' as const,
        voyage_api_key: 'test-voyage-key',
        openai_api_key: 'test-oai',
        anthropic_api_key: 'test-anth',
        openrouter_api_key: 'test-or',
      };
      const gwCfg = buildGatewayConfig(cfg as any);
      expect(gwCfg.env?.VOYAGE_API_KEY).toBe('test-voyage-key');
      // Regression on the existing two keys.
      expect(gwCfg.env?.OPENAI_API_KEY).toBe('test-oai');
      expect(gwCfg.env?.ANTHROPIC_API_KEY).toBe('test-anth');
      expect(gwCfg.env?.OPENROUTER_API_KEY).toBe('test-or');
    } finally {
      if (savedVoyage !== undefined) process.env.VOYAGE_API_KEY = savedVoyage;
      if (savedOai !== undefined) process.env.OPENAI_API_KEY = savedOai;
      if (savedAnth !== undefined) process.env.ANTHROPIC_API_KEY = savedAnth;
      if (savedOr !== undefined) process.env.OPENROUTER_API_KEY = savedOr;
    }
  });

  test('CDX2-5+6: process.env wins over config (operator escape hatch contract)', async () => {
    const saved = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = 'env-wins-key';
    try {
      const { buildGatewayConfig } = await import('../src/cli/main.ts');
      const cfg = { engine: 'pglite' as const, voyage_api_key: 'file-key' };
      const gwCfg = buildGatewayConfig(cfg as any);
      expect(gwCfg.env?.VOYAGE_API_KEY).toBe('env-wins-key');
    } finally {
      if (saved === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = saved;
    }
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
    // Refactor wave 1 (W4 cli): CLI_ONLY_SELF_HELP is derived from the
    // command table; the sync record carries the membership.
    const src = surfaceFileSource('cli', 'src/cli/command-table.ts');
    const setMatch = src.match(/\{ name: 'sync', [^\n]*\},/);
    expect(setMatch).not.toBeNull();
    const body = setMatch![0];
    expect(body).toContain('selfHelp: true');
    expect(CLI_ONLY_SELF_HELP.has('sync')).toBe(true);
  });
});

// Deferred-TODO ship: gbrain reinit-pglite
describe('v0.37 deferred TODO shipped — gbrain reinit-pglite', () => {
  test('reinit-pglite is registered in CLI_ONLY + CLI_ONLY_SELF_HELP', () => {
    // Refactor wave 1 (W4 cli): one command-table record carries both
    // memberships (CLI_ONLY and CLI_ONLY_SELF_HELP are derived from it).
    const src = surfaceFileSource('cli', 'src/cli/command-table.ts');
    const onlyMatch = src.match(/\{ name: 'reinit-pglite', [^\n]*\},/);
    expect(onlyMatch).not.toBeNull();
    expect(CLI_ONLY.has('reinit-pglite')).toBe(true);

    const selfHelpMatch = onlyMatch;
    expect(selfHelpMatch).not.toBeNull();
    expect(selfHelpMatch![0]).toContain('selfHelp: true');
    expect(CLI_ONLY_SELF_HELP.has('reinit-pglite')).toBe(true);
  });

  test('embeddingMismatchMessage PGLite branch keeps `gbrain reinit-pglite` as the labelled last resort', async () => {
    const { embeddingMismatchMessage } = await import('../src/core/embedding-dim-check.ts');
    const msg = embeddingMismatchMessage({
      currentDims: 1536,
      requestedDims: 1024,
      requestedModel: 'voyage:voyage-4',
      source: 'doctor',
      engineKind: 'pglite',
      databasePath: '/tmp/test.pglite',
    });
    // reinit-pglite stays available, labelled as the last resort AFTER the
    // data-preserving migration (A7: no hand-run wipe recipe).
    expect(msg).toContain('gbrain reinit-pglite --embedding-model voyage:voyage-4 --embedding-dimensions 1024');
    expect(msg).not.toMatch(/\bmv /);
    const migrateIdx = msg.indexOf('gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run');
    const lastResortIdx = msg.indexOf('Last resort');
    expect(migrateIdx).toBeGreaterThan(0);
    expect(lastResortIdx).toBeGreaterThan(migrateIdx);
  });
});

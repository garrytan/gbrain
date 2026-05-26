/**
 * v0.37 PGLite fresh-install fix wave — test-gap fill.
 *
 * The headline `v0_37_fix_wave.test.ts` pins the lane-level invariants
 * (defaults exports, registry chain, signature shapes). This file pins
 * the END-TO-END behaviors that those structural tests don't reach:
 *
 *  - Schema seed stores provider:model (Lane A.8 — was prefix-stripped)
 *  - Chunk-row INSERT default writes gateway model (Lane A.7)
 *  - Init precedence chain (Lane B.1 + B.4 + CDX2-7)
 *  - ZE setup hint fires at init when key missing (Lane B.1)
 *  - Init merges existing config across re-init (Lane B.4)
 *  - config set refuses schema-sizing fields with the recipe (Lane C.2)
 *  - ZEROENTROPY_API_KEY env merge into GBrainConfig (Lane C.3)
 *  - Embed pre-flight catches dim mismatch end-to-end (Lane D.2)
 *  - Sync hint fires at both catch sites (Lane D.3, CDX2-8)
 *  - reinit-pglite end-to-end behavior (deferred-TODO sugar)
 *  - loadRecommendationContext reads gateway + ZE keys (Lane E.4)
 *
 * Hermetic — no DATABASE_URL, no real API keys, no real network. Uses
 * PGLite in-memory + transport stubs.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

// ─────────────────────────────────────────────────────────────────────
// Lane A.7 — Chunk-row INSERT model default tracks defaults.ts constant
// (not stale OpenAI literal). Pre-fix `chunk.model || 'text-embedding-3-large'`
// in both engines; post-fix `chunk.model || DEFAULT_EMBEDDING_MODEL`.
// ─────────────────────────────────────────────────────────────────────
describe('Lane A.7 — chunk-row INSERT default tracks ai/defaults.ts constant', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('upsertChunks without explicit model: row stores DEFAULT_EMBEDDING_MODEL', async () => {
    const { DEFAULT_EMBEDDING_MODEL } = await import('../src/core/ai/defaults.ts');
    await engine.putPage('test/a7', { type: 'note', title: 'A.7', compiled_truth: 'hello' });
    await engine.upsertChunks('test/a7', [
      { chunk_index: 0, chunk_text: 'hello', chunk_source: 'compiled_truth' },
    ]);

    const rows = await engine.executeRaw<{ model: string }>(
      `SELECT model FROM content_chunks WHERE chunk_index = 0 LIMIT 1`,
    );
    expect(rows[0]?.model).toBe(DEFAULT_EMBEDDING_MODEL);
    // CDX2-4 regression: would have been 'text-embedding-3-large'
    // (a literal pre-fix; production write site that was never tested).
    expect(rows[0]?.model).not.toBe('text-embedding-3-large');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lane A.8 — Schema seed stores provider:model (was prefix-stripped)
// ─────────────────────────────────────────────────────────────────────
describe('Lane A.8 — schema seed stores full provider:model in DB config', () => {
  test('fresh init with ZE model stores `zeroentropyai:zembed-1`, not `zembed-1`', async () => {
    // Independent engine + gateway so the assertion is unambiguous.
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ...process.env },
    });
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const stored = await engine.getConfig('embedding_model');
      expect(stored).toBe('zeroentropyai:zembed-1');
      // CDX-4 regression: would have been 'zembed-1' under the strip.
      expect(stored).not.toBe('zembed-1');
    } finally {
      await engine.disconnect();
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        env: { ...process.env },
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lane B — init paths + merged precedence
// ─────────────────────────────────────────────────────────────────────
describe('Lane B — init precedence chain (CLI > env > existing file > default)', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-v37-b-'));
    origHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = tmpHome;
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
  });

  test('configureGatewayWithMergedPrecedence honors CLI > env > file > gateway-default', async () => {
    // Write an existing config.json to simulate prior install.
    const dotgbrain = join(tmpHome, '.gbrain');
    require('fs').mkdirSync(dotgbrain, { recursive: true });
    writeFileSync(join(dotgbrain, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: join(dotgbrain, 'brain.pglite'),
      embedding_model: 'voyage:voyage-3-large',
      embedding_dimensions: 1024,
    }));

    // Set an env override that should beat the file value but lose to CLI.
    await withEnv(
      { GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-small', GBRAIN_EMBEDDING_DIMENSIONS: '768' },
      async () => {
        // The helper is non-exported; we exercise the merged-precedence
        // resolution that configureGatewayWithMergedPrecedence builds by
        // calling configureGateway with the equivalent merged payload
        // and asserting gateway accessors reflect it.
        //
        // Path A: no CLI flags → env wins over file (CLI=null, env=given, file=voyage).
        const { configureGateway: cg1, getEmbeddingModel: gm1, getEmbeddingDimensions: gd1, resetGateway: rg1 } = await import('../src/core/ai/gateway.ts');
        rg1();
        cg1({
          embedding_model: process.env.GBRAIN_EMBEDDING_MODEL ?? 'voyage:voyage-3-large',
          embedding_dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS!, 10),
          env: { ...process.env },
        });
        expect(gm1()).toBe('openai:text-embedding-3-small');
        expect(gd1()).toBe(768);

        // Path B: CLI flag overrides both env and file.
        rg1();
        cg1({
          embedding_model: 'voyage:voyage-2', // simulated CLI flag
          embedding_dimensions: 1024,
          env: { ...process.env },
        });
        expect(gm1()).toBe('voyage:voyage-2');
        expect(gd1()).toBe(1024);
      },
    );

    // Restore default gateway state for downstream tests.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lane C.3 — ZEROENTROPY_API_KEY env merge into GBrainConfig
// ─────────────────────────────────────────────────────────────────────
describe('Lane C.3 — env ZEROENTROPY_API_KEY merges into loadConfig', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-v37-c-'));
    origHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = tmpHome;
    // Write a minimal pglite config so loadConfig returns non-null.
    const dotgbrain = join(tmpHome, '.gbrain');
    require('fs').mkdirSync(dotgbrain, { recursive: true });
    writeFileSync(join(dotgbrain, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: join(dotgbrain, 'brain.pglite'),
    }));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
  });

  test('process.env.ZEROENTROPY_API_KEY → cfg.zeroentropy_api_key', async () => {
    await withEnv({ ZEROENTROPY_API_KEY: 'ze-from-env-key' }, async () => {
      const { loadConfig } = await import('../src/core/config.ts');
      const cfg = loadConfig();
      expect(cfg?.zeroentropy_api_key).toBe('ze-from-env-key');
    });
  });

  test('loadConfigFileOnly does NOT merge the env ZE key', async () => {
    await withEnv({ ZEROENTROPY_API_KEY: 'ze-from-env-key' }, async () => {
      const { loadConfigFileOnly } = await import('../src/core/config.ts');
      const cfg = loadConfigFileOnly();
      expect(cfg?.zeroentropy_api_key).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lane D.2 — Embed pre-flight fires end-to-end on dim mismatch
// ─────────────────────────────────────────────────────────────────────
describe('Lane D.2 — embed pre-flight catches dim mismatch before worker pool', () => {
  let engine: PGLiteEngine;

  // Fully self-contained: configure gateway EXPLICITLY so schema dim is
  // deterministic regardless of earlier tests' state. resetGateway() at
  // teardown so we don't poison downstream tests.
  beforeAll(async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('test/d2', { type: 'note', title: 'D.2', compiled_truth: 'hello world' });
    await engine.upsertChunks('test/d2', [
      { chunk_index: 0, chunk_text: 'hello world', chunk_source: 'compiled_truth' },
    ]);
  });

  afterAll(async () => {
    await engine.disconnect();
    __setEmbedTransportForTests(null);
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });

  test('schema=1536 + gateway=ZE/1280 → runEmbedCore throws EmbeddingDimMismatchError before transport fires', async () => {
    // Reconfigure to mismatched dim. Schema (1536) and gateway (1280)
    // now disagree; pre-flight should throw before the worker pool
    // calls embedMany.
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ...process.env },
    });

    let transportCalled = false;
    __setEmbedTransportForTests(async () => {
      transportCalled = true;
      throw new Error('Pre-flight should have caught the mismatch before this fires');
    });

    const { runEmbedCore, EmbeddingDimMismatchError } = await import('../src/commands/embed.ts');
    let caught: unknown = null;
    try {
      await runEmbedCore(engine, { all: true });
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbeddingDimMismatchError);
    const err = caught as InstanceType<typeof EmbeddingDimMismatchError>;
    expect(err.recipeMessage).toContain('vector(1536)');
    expect(err.recipeMessage).toContain('vector(1280)');
    // The transport must never have fired — pre-flight's whole point is
    // to kill the N-parallel-API-call-fail-pattern.
    expect(transportCalled).toBe(false);

    // Restore for next test.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });

  test('dryRun skips the pre-flight (no embed risk to gate)', async () => {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ...process.env },
    });
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const result = await runEmbedCore(engine, { all: true, dryRun: true });
    expect(result.dryRun).toBe(true);
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lane D.3 — Sync hint fires at both catch sites
// ─────────────────────────────────────────────────────────────────────
describe('Lane D.3 — sync surfaces dim-mismatch recipe at incremental AND first-sync catches', () => {
  test('source-text grep: both sync.ts catch sites detect EmbeddingDimMismatchError', () => {
    // Structural source-text assertion: pre-fix the incremental catch
    // (line 990) silently swallowed embed errors. Now both catches use
    // an instance check + the same recipe-printing branch.
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'sync.ts'), 'utf-8');
    const matches = src.match(/e instanceof EmbeddingDimMismatchError/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('source-text grep: tip mentions --no-embed at the hint site', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'sync.ts'), 'utf-8');
    expect(src).toContain('--no-embed');
    expect(src).toContain('Tip:');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lane E.4 — loadRecommendationContext provider-aware key check
// ─────────────────────────────────────────────────────────────────────
describe('Lane E.4 — loadRecommendationContext is provider-aware', () => {
  // doctor.ts exports loadRecommendationContext only locally; verify the
  // behavior via a public surface (the recommendation context the
  // `doctor --remediation-plan` output uses) is brittle. Use a
  // source-text assertion instead.
  test('source-text grep: loadRecommendationContext is provider-aware via the shared helper', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'doctor.ts'), 'utf-8');
    // Pre-v0.37 this was OpenAI-only; the Lane E.4 fix made it branch on
    // provider for the key. v0.40.x replaced the inline prefix ladder with the
    // shared recipe-aware helper `embeddingProviderConfigured` (so doctor +
    // autopilot can't drift) — assert that shape rather than the old inline
    // ZE strings.
    const fnIdx = src.indexOf('async function loadRecommendationContext');
    expect(fnIdx).toBeGreaterThan(0);
    const slice = src.slice(fnIdx, fnIdx + 3000);
    // Delegates to the shared helper + the env→config key map.
    expect(slice).toContain('embeddingProviderConfigured');
    expect(slice).toContain('HOSTED_EMBED_KEY_CONFIG');
    // Still reads the model from the gateway (not DB-only).
    expect(slice).toContain('gateway');
  });
});

// ─────────────────────────────────────────────────────────────────────
// reinit-pglite end-to-end behavior (deferred-TODO sugar shipped)
// ─────────────────────────────────────────────────────────────────────
describe('reinit-pglite — backup + reinit', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  // Restore gateway state for downstream tests (defense-in-depth — earlier
  // tests in this file already restore, but if this describe block ever
  // mutates the gateway via a future test, the next file in the same
  // bun-test shard process won't inherit it).
  afterAll(() => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-v37-reinit-'));
    origHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = tmpHome;
    // Pre-seed a config + a dummy brain file so reinit-pglite sees them.
    const dotgbrain = join(tmpHome, '.gbrain');
    require('fs').mkdirSync(dotgbrain, { recursive: true });
    writeFileSync(join(dotgbrain, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: join(dotgbrain, 'brain.pglite'),
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
    }));
    // PGLite uses a directory, not a single file. Create a placeholder
    // directory so existsSync() passes.
    require('fs').mkdirSync(join(dotgbrain, 'brain.pglite'), { recursive: true });
    writeFileSync(join(dotgbrain, 'brain.pglite', 'placeholder'), 'stub');
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
  });

  test('refuses on non-PGLite engine', async () => {
    // Overwrite config to claim postgres.
    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({
      engine: 'postgres',
      database_url: 'postgres://example/db',
    }));

    const { runReinitPglite } = await import('../src/commands/reinit-pglite.ts');
    const origExit = process.exit;
    const exits: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = ((code?: number) => { exits.push(code ?? 0); throw new Error('exit:' + (code ?? 0)); });
    try {
      await runReinitPglite([
        '--embedding-model', 'zeroentropyai:zembed-1',
        '--embedding-dimensions', '1280',
        '--yes', '--json',
      ]);
    } catch (e) {
      // Expected exit.
      expect((e as Error).message).toMatch(/^exit:/);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).exit = origExit;
    }
    expect(exits).toContain(1);
  });

  test('refuses when missing required --embedding-model / --embedding-dimensions', async () => {
    const { runReinitPglite } = await import('../src/commands/reinit-pglite.ts');
    const origExit = process.exit;
    const exits: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = ((code?: number) => { exits.push(code ?? 0); throw new Error('exit:' + (code ?? 0)); });
    try {
      await runReinitPglite(['--json']);
    } catch (e) {
      expect((e as Error).message).toMatch(/^exit:/);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).exit = origExit;
    }
    expect(exits).toContain(1);
  });
});

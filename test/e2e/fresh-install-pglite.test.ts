/**
 * E2E: fresh `gbrain init --pglite` produces a brain that can embed end-to-end.
 *
 * The headline behavior the v0.37 fix wave exists to fix. Pre-fix, this
 * exact path broke: schema sized to 1536 (stale default), embed pipeline
 * used ZE/1280, first chunk insert failed with vector dim mismatch.
 *
 * Hermetic: in-process (NOT a CLI subprocess), GBRAIN_HOME pinned to a
 * tmpdir, embed transport stubbed via `__setEmbedTransportForTests` so we
 * don't need real provider credentials. CDX2-12 from the plan explicitly
 * called this design out.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import {
  NEW_INSTALL_DEFAULT_EMBEDDING_MODEL,
  NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS,
} from '../../src/core/ai/defaults.ts';

describe('E2E: fresh gbrain init --pglite → import → embed works end-to-end', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  // v0.46.3: the single-ready provider for a fresh install is VOYAGE (ZE is
  // sunset-excluded from auto-pick). Scrub EVERY embedding-capable key a dev
  // machine might carry so init sees exactly one ready provider — otherwise
  // ambient multi-provider env (Garry's setup) fails the disambiguation gate
  // before the test body runs.
  const SCRUB_KEYS = [
    'ZEROENTROPY_API_KEY',
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
    'OPENROUTER_API_KEY',
    'PERPLEXITY_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GEMINI_API_KEY',
    'DASHSCOPE_API_KEY',
    'MISTRAL_API_KEY',
    'NVIDIA_API_KEY',
    'ZHIPU_API_KEY',
    'MINIMAX_API_KEY',
    'AZURE_OPENAI_API_KEY',
  ] as const;
  const savedKeys: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-e2e-fresh-'));
    origHome = process.env.GBRAIN_HOME;
    for (const k of SCRUB_KEYS) {
      savedKeys[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GBRAIN_HOME = tmpHome;
    // Stub key so init auto-picks the canonical voyage default.
    process.env.VOYAGE_API_KEY = 'pa-test-voyage';
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
    for (const k of SCRUB_KEYS) {
      if (savedKeys[k] === undefined) delete process.env[k];
      else process.env[k] = savedKeys[k];
    }
    __setEmbedTransportForTests(null);
    // Restore legacy-preload gateway state.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });

  test('bare `init --pglite`: schema sized to the new-install default (voyage-4/1024)', async () => {
    // Reset gateway so init.ts has to resolve the new-install default from
    // ai/defaults.ts. This is the actual production code path for a
    // fresh install: bare `gbrain init --pglite` with a single ready key.
    resetGateway();

    // Stub embed transport to return synthetic target-width vectors. The
    // bug fix is dimension alignment — actual provider correctness is
    // tested elsewhere.
    const synthVec = Array.from({ length: NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS }, () => 0.01);
    __setEmbedTransportForTests(async (args: any) => ({
      embeddings: args.values.map(() => synthVec),
    }) as any);

    const { runInit } = await import('../../src/commands/init.ts');

    // Capture stderr to verify init prints the resolved choice.
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const origLog = console.log;
    const stderrBuf: string[] = [];
    const stdoutBuf: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: any) => {
      stderrBuf.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    console.log = (...args: unknown[]) => {
      stdoutBuf.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    };

    try {
      await runInit(['--pglite', '--non-interactive']);
    } finally {
      process.stderr.write = origStderrWrite;
      console.log = origLog;
    }

    const allOut = stdoutBuf.join('\n');

    // Init prints the resolved embedding choice (B.1).
    expect(allOut).toContain(NEW_INSTALL_DEFAULT_EMBEDDING_MODEL);
    expect(allOut).toContain(`(${NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS}d)`);

    // config.json contains the saved resolved defaults (B.4 + CDX-3).
    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.engine).toBe('pglite');
    expect(cfg.embedding_model).toBe(NEW_INSTALL_DEFAULT_EMBEDDING_MODEL);
    expect(cfg.embedding_dimensions).toBe(NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS);

    // The actual schema column dim matches, and the voyage-picked install
    // wrote the explicit reranker override (v0.46.3 split-default: the bundle
    // default stays legacy-ZE, so a fresh voyage brain needs this config or
    // it resolves a reranker whose key it doesn't have).
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: cfg.database_path, engine: 'pglite' });
    try {
      const { readContentChunksEmbeddingDim } = await import('../../src/core/embedding-dim-check.ts');
      const colDim = await readContentChunksEmbeddingDim(engine);
      expect(colDim.exists).toBe(true);
      expect(colDim.dims).toBe(NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS);
      expect(await engine.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5');
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('re-init never clobbers an existing explicit reranker choice', async () => {
    resetGateway();
    const synthVec = Array.from({ length: NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS }, () => 0.01);
    __setEmbedTransportForTests(async (args: any) => ({
      embeddings: args.values.map(() => synthVec),
    }) as any);
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      const { runInit } = await import('../../src/commands/init.ts');
      await runInit(['--pglite', '--non-interactive']);
      const cfgPath = join(tmpHome, '.gbrain', 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: cfg.database_path, engine: 'pglite' });
      try {
        await engine.setConfig('search.reranker.model', 'openrouter:cohere/rerank-custom');
      } finally {
        await engine.disconnect();
      }
      // Re-init the same brain: the override write must respect the user's
      // explicit choice (never-clobber contract).
      await runInit(['--pglite', '--non-interactive', '--force']);
      const engine2 = new PGLiteEngine();
      await engine2.connect({ database_path: cfg.database_path, engine: 'pglite' });
      try {
        expect(await engine2.getConfig('search.reranker.model')).toBe('openrouter:cohere/rerank-custom');
      } finally {
        await engine2.disconnect();
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
  }, 60000);

  test('explicit --embedding-model on a sunset provider proceeds WITH a loud warning (D3 allow-explicit)', async () => {
    resetGateway();
    process.env.ZEROENTROPY_API_KEY = 'ze-test-explicit';
    const synthVec = Array.from({ length: 1280 }, () => 0.01);
    __setEmbedTransportForTests(async (args: any) => ({
      embeddings: args.values.map(() => synthVec),
    }) as any);
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    let errBuf = '';
    console.log = () => {};
    console.warn = () => {};
    console.error = (...args: unknown[]) => { errBuf += args.join(' ') + '\n'; };
    try {
      const { runInit } = await import('../../src/commands/init.ts');
      await runInit([
        '--pglite', '--non-interactive',
        '--embedding-model', 'zeroentropyai:zembed-1',
        '--embedding-dimensions', '1280',
      ]);
      const cfg = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
      // Allowed until the September removal — explicit choice is honored...
      expect(cfg.embedding_model).toBe('zeroentropyai:zembed-1');
      // ...but never silently: the sunset warning names the date + escape route.
      expect(errBuf).toContain('2026-09-04');
      expect(errBuf).toContain('migrate embeddings');
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
  }, 30000);

  test('v0.46.3: keyed NON-voyage install disables the reranker explicitly (no doomed legacy default)', async () => {
    resetGateway();
    delete process.env.VOYAGE_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    const origLog = console.log;
    const origError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const { runInit } = await import('../../src/commands/init.ts');
      await runInit(['--pglite', '--non-interactive']);
      const cfg = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
      expect(cfg.embedding_model).toBe('openai:text-embedding-3-large');
      const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: cfg.database_path, engine: 'pglite' });
      try {
        // No voyage key on either plane → the fresh brain must not silently
        // inherit the legacy sunset bundle reranker it has no key for.
        expect(await engine.getConfig('search.reranker.model')).toBeNull();
        expect(await engine.getConfig('search.reranker.enabled')).toBe('false');
      } finally {
        await engine.disconnect();
      }
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  }, 30000);

  test('keyless fresh install sizes the column at the NEW-INSTALL width (1024), not the legacy 1280', async () => {
    resetGateway();
    delete process.env.VOYAGE_API_KEY; // zero keys → keyless continue
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
      const { runInit } = await import('../../src/commands/init.ts');
      await runInit(['--pglite', '--non-interactive']);
      const cfg = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
      expect(cfg.embedding_disabled).toBe(true);
      const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: cfg.database_path, engine: 'pglite' });
      try {
        const { readContentChunksEmbeddingDim } = await import('../../src/core/embedding-dim-check.ts');
        const colDim = await readContentChunksEmbeddingDim(engine);
        expect(colDim.exists).toBe(true);
        expect(colDim.dims).toBe(NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS);
      } finally {
        await engine.disconnect();
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
  }, 30000);

  test('v0.46.3: keyless recovery — `init --force --embedding-model` clears embedding_disabled', async () => {
    // The documented recovery command for a deferred-setup brain is
    // `gbrain init --force --embedding-model voyage:voyage-4`. Two traps made
    // it a silent no-op: the seeded embedding_disabled sentinel set
    // out.noEmbedding (which an explicit flag must clear), and the persist
    // block's ...existingFile spread re-wrote the stale sentinel alongside
    // the new model. This pins the full keyless → keyed round trip.
    resetGateway();
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
      const { runInit } = await import('../../src/commands/init.ts');
      // Step 1: keyless install → deferred-setup sentinel persisted.
      delete process.env.VOYAGE_API_KEY;
      await runInit(['--pglite', '--non-interactive']);
      const cfgPath = join(tmpHome, '.gbrain', 'config.json');
      expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).embedding_disabled).toBe(true);
      // Step 2: the key arrives; run the documented recovery command.
      process.env.VOYAGE_API_KEY = 'pa-test-voyage';
      await runInit(['--pglite', '--non-interactive', '--force', '--embedding-model', 'voyage:voyage-4']);
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      expect(cfg.embedding_model).toBe('voyage:voyage-4');
      expect(cfg.embedding_dimensions).toBe(NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS);
      expect(cfg.embedding_disabled).toBeUndefined();
      // Keyless init wrote NO reranker config (deliberate), so the recovery
      // re-init's voyage override lands instead of being never-clobbered.
      const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: cfg.database_path, engine: 'pglite' });
      try {
        expect(await engine.getConfig('search.reranker.model')).toBe('voyage:rerank-2.5');
      } finally {
        await engine.disconnect();
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
  }, 30000);

  test('init → seed page → embed: chunks have non-null embeddings, no dim mismatch', async () => {
    resetGateway();
    const synthVec = Array.from({ length: NEW_INSTALL_DEFAULT_EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0.01);
    __setEmbedTransportForTests(async (args: any) => ({
      embeddings: args.values.map(() => synthVec),
    }) as any);

    // Silence init output for the test runner.
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};

    try {
      const { runInit } = await import('../../src/commands/init.ts');
      await runInit(['--pglite', '--non-interactive']);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }

    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));

    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: cfg.database_path, engine: 'pglite' });
    try {
      // Seed a page + chunk (the import + chunker path is tested
      // elsewhere; this E2E focuses on dim alignment).
      await engine.putPage('test/e2e-page', {
        type: 'note',
        title: 'E2E Test',
        compiled_truth: 'fresh install end-to-end happy path',
      });
      await engine.upsertChunks('test/e2e-page', [
        { chunk_index: 0, chunk_text: 'fresh install end-to-end happy path', chunk_source: 'compiled_truth' },
      ]);

      // Run embed --stale via the public CLI entry point. This goes
      // through runEmbedCore including the pre-flight dim check.
      const { runEmbedCore } = await import('../../src/commands/embed.ts');
      const result = await runEmbedCore(engine, { stale: true });
      expect(result.embedded).toBeGreaterThan(0);

      // Chunks now have non-null embeddings.
      const rows = await engine.executeRaw<{ has_emb: boolean }>(
        `SELECT embedding IS NOT NULL AS has_emb FROM content_chunks WHERE chunk_index = 0`,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].has_emb).toBe(true);
    } finally {
      await engine.disconnect();
    }
  }, 30000);
});

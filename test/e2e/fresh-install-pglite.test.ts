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
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from '../../src/core/ai/gateway.ts';

describe('E2E: fresh gbrain init --pglite → import → embed works end-to-end', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origZeKey: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-e2e-fresh-'));
    origHome = process.env.GBRAIN_HOME;
    origZeKey = process.env.ZEROENTROPY_API_KEY;
    process.env.GBRAIN_HOME = tmpHome;
    // Stub key so init's setup-hint check passes.
    process.env.ZEROENTROPY_API_KEY = 'sk-test-ze';
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
    if (origZeKey === undefined) delete process.env.ZEROENTROPY_API_KEY;
    else process.env.ZEROENTROPY_API_KEY = origZeKey;
    __setEmbedTransportForTests(null);
    // Restore legacy-preload gateway state.
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });

  test('bare `init --pglite`: schema sized to gateway defaults (ZE/1280)', async () => {
    // Reset gateway so init.ts has to resolve defaults from
    // ai/defaults.ts. This is the actual production code path for a
    // fresh install: bare `gbrain init --pglite` with no env or file
    // config.
    resetGateway();

    // Stub embed transport to return synthetic 1280-dim vectors. The
    // bug fix is dimension alignment — actual provider correctness is
    // tested elsewhere.
    const synthVec = Array.from({ length: DEFAULT_EMBEDDING_DIMENSIONS }, () => 0.01);
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
    expect(allOut).toContain(DEFAULT_EMBEDDING_MODEL);
    expect(allOut).toContain(`(${DEFAULT_EMBEDDING_DIMENSIONS}d)`);

    // config.json contains the saved resolved defaults (B.4 + CDX-3).
    const cfgPath = join(tmpHome, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.engine).toBe('pglite');
    expect(cfg.embedding_model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(cfg.embedding_dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);

    // The actual schema column dim matches.
    const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: cfg.database_path, engine: 'pglite' });
    try {
      const { readContentChunksEmbeddingDim } = await import('../../src/core/embedding-dim-check.ts');
      const colDim = await readContentChunksEmbeddingDim(engine);
      expect(colDim.exists).toBe(true);
      expect(colDim.dims).toBe(DEFAULT_EMBEDDING_DIMENSIONS);
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('init → seed page → embed: chunks have non-null embeddings, no dim mismatch', async () => {
    resetGateway();
    const synthVec = Array.from({ length: DEFAULT_EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0.01);
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

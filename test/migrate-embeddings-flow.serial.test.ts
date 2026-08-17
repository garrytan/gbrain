/**
 * #3390 — `gbrain migrate embeddings` END-TO-END on PGLite.
 *
 * The full command flow with a fake embedding transport:
 *   1. Disposable brain seeded via the REAL embed pipeline on a fake 1280d
 *      "zeroentropyai:zembed-1" provider (the shipped default).
 *   2. One page's embedding_signature NULLed (simulates a pre-v108 page,
 *      the #3391 class).
 *   3. Migration to a fake 1536d openai:text-embedding-3-small — with the
 *      transport failing two specific pages, simulating a killed/partial
 *      run. Asserts: exit 1 (incomplete), schema at 1536, config file
 *      swapped, state marker kept, partial progress banked.
 *   4. Re-run of the SAME command (the documented resume path). Asserts:
 *      exit 0, only the two failed pages re-embedded (no duplicate work),
 *      every chunk embedded at 1536, every page stamped with the new
 *      signature (including the formerly-NULL one), state marker cleared,
 *      query cache purged, vector search works against the new column.
 *
 * Named `.serial.test.ts`: the whole file runs under a temp GBRAIN_HOME +
 * an installed fake embed transport for its entire lifecycle (beforeAll →
 * afterAll), which withEnv() cannot wrap. GBRAIN_HOME is pointed at a temp dir so the file-plane config write
 * (persistEmbeddingFileConfig) never touches the developer's ~/.gbrain.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { runMigrateEmbeddings } from '../src/commands/migrate-embeddings.ts';
import {
  MIGRATION_STATE_KEY,
  MIGRATION_COMPLETED_KEY,
} from '../src/core/embedding-migration.ts';

const FROM_DIMS = 1280;
const TO_DIMS = 1536;
const PAGES = ['page-1', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6'];
const PROBE_TEXT = 'gbrain embedding migration probe';

let engine: PGLiteEngine;
let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

/** Deterministic fake transport: vector width driven by the test phase. */
let currentDims = FROM_DIMS;
/** Texts that make the transport throw (simulates a mid-run kill). */
let failTexts: string[] = [];
/** Every non-probe text the transport embedded, per phase. */
let embeddedTexts: string[] = [];

function installTransport(): void {
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    for (const v of values) {
      if (failTexts.some(f => v.includes(f))) {
        throw new Error(`fake transport: simulated failure for "${v.slice(0, 30)}..."`);
      }
    }
    for (const v of values) {
      if (v !== PROBE_TEXT) embeddedTexts.push(v);
    }
    return {
      embeddings: values.map(() => new Array(currentDims).fill(0).map((_, i) => Math.sin(i) * 0.01 + 0.001)),
      usage: { tokens: values.length * 4 },
    } as never;
  });
}

class ExitError extends Error {
  constructor(public code: number) { super(`exit ${code}`); }
}
const exitSeam = (code: number): never => { throw new ExitError(code); };

async function runMigrate(args: string[]): Promise<number> {
  try {
    await runMigrateEmbeddings(engine, args, { exit: exitSeam });
    throw new Error('runMigrateEmbeddings returned without exiting');
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

async function columnDims(): Promise<number> {
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'
        AND attnum > 0 AND NOT attisdropped`,
  );
  return Number(rows[0]?.dim);
}

beforeAll(async () => {
  // Isolate the file-plane config.
  for (const k of ['GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS', 'OPENAI_API_KEY', 'ZEROENTROPY_API_KEY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-e2e-'));
  process.env.GBRAIN_HOME = tmpHome;
  mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
  writeFileSync(join(tmpHome, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: FROM_DIMS,
    zeroentropy_api_key: 'ze-test-fake',
    openai_api_key: 'sk-test-fake',
  }, null, 2));

  resetGateway();
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: FROM_DIMS,
    env: { ZEROENTROPY_API_KEY: 'ze-test-fake', OPENAI_API_KEY: 'sk-test-fake' },
  });
  installTransport();

  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: FROM_DIMS } as never);
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(tmpHome, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('migrate embeddings — full flow on PGLite', () => {
  test('seed: 6 pages embedded at 1280d through the real embed pipeline', async () => {
    expect(await columnDims()).toBe(FROM_DIMS);
    for (const slug of PAGES) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\ncontent for ${slug}` });
      await engine.upsertChunks(slug, [
        { chunk_index: 0, chunk_text: `chunk text for ${slug}`, chunk_source: 'compiled_truth', token_count: 5 },
      ]);
    }
    const seeded = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(seeded.embedded).toBe(PAGES.length);
    expect(await engine.countStaleChunks()).toBe(0);

    // Simulate a pre-v108 page: embedded, but no recorded signature (#3391).
    await engine.executeRaw(`UPDATE pages SET embedding_signature = NULL WHERE slug = 'page-1'`);
    const sigs = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE embedding_signature = 'zeroentropyai:zembed-1:${FROM_DIMS}'`,
    );
    expect(Number(sigs[0]?.n)).toBe(PAGES.length - 1);

    // Seed a query-cache row that must not survive the migration.
    await engine.executeRaw(
      `INSERT INTO query_cache (id, query_text, source_id) VALUES ('qc-pre', 'old space query', 'default')`,
    );
  }, 60000);

  test('dry-run: prints the plan, changes nothing', async () => {
    const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--dry-run', '--json']);
    expect(code).toBe(0);
    expect(await columnDims()).toBe(FROM_DIMS);
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
    // Config file untouched.
    const cfg = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
    expect(cfg.embedding_model).toBe('zeroentropyai:zembed-1');
  });

  test('non-TTY without --yes refuses with exit 2 (cost gate)', async () => {
    const code = await runMigrate(['--to', 'openai:text-embedding-3-small']);
    expect(code).toBe(2);
    expect(await columnDims()).toBe(FROM_DIMS);
  });

  test('spend.posture=tokenmax does NOT bypass the gate (guards a destructive rebuild, not just spend)', async () => {
    await engine.setConfig('spend.posture', 'tokenmax');
    try {
      const code = await runMigrate(['--to', 'openai:text-embedding-3-small']);
      expect(code).toBe(2); // posture waives the spend ceiling, not the consent
      expect(await columnDims()).toBe(FROM_DIMS);
    } finally {
      await engine.unsetConfig('spend.posture');
    }
  });

  test('interrupted run: partial progress banks, exit 1, state marker kept', async () => {
    currentDims = TO_DIMS;
    failTexts = ['page-4', 'page-5']; // simulate dying mid-run on two pages
    embeddedTexts = [];

    const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--yes']);
    expect(code).toBe(1); // incomplete

    // Schema + config swapped BEFORE the re-embed, so the partial run is
    // already in the new space.
    expect(await columnDims()).toBe(TO_DIMS);
    const cfg = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'config.json'), 'utf-8'));
    expect(cfg.embedding_model).toBe('openai:text-embedding-3-small');
    expect(cfg.embedding_dimensions).toBe(TO_DIMS);
    expect(await engine.getConfig('embedding_model')).toBe('openai:text-embedding-3-small');

    // 4 of 6 pages embedded; the 2 failed pages remain stale (= the checkpoint).
    expect(embeddedTexts.length).toBe(PAGES.length - 2);
    expect(await engine.countStaleChunks()).toBe(2);

    // In-flight marker survives so doctor/status can see the migration.
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeTruthy();
    expect(await engine.getConfig(MIGRATION_COMPLETED_KEY)).toBeFalsy();

    // Query cache was purged at swap time.
    const qc = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM query_cache`);
    expect(Number(qc[0]?.n)).toBe(0);
  }, 60000);

  test('resume: re-running the same command finishes without redoing work', async () => {
    failTexts = [];
    embeddedTexts = [];

    const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--yes']);
    expect(code).toBe(0);

    // Only the two previously-failed pages were embedded this pass, plus the
    // 3 completion smoke-check QUERY embeds (self-retrieval runs only on the
    // completed path — the interrupted run above had none).
    expect(embeddedTexts.length).toBe(5);
    expect(embeddedTexts.join(' ')).toContain('page-4');
    expect(embeddedTexts.join(' ')).toContain('page-5');

    // Everything is in the target space now.
    expect(await engine.countStaleChunks()).toBe(0);
    expect(await engine.countStaleChunks({
      signature: `openai:text-embedding-3-small:${TO_DIMS}`,
      includeNullSignature: true,
    })).toBe(0);

    // Every page — including the formerly NULL-signature page-1 — is stamped.
    const sigs = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages
        WHERE embedding_signature = 'openai:text-embedding-3-small:${TO_DIMS}'`,
    );
    expect(Number(sigs[0]?.n)).toBe(PAGES.length);

    // Bookkeeping: marker cleared, completion stamped.
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
    const done = JSON.parse((await engine.getConfig(MIGRATION_COMPLETED_KEY))!);
    expect(done.to_model).toBe('openai:text-embedding-3-small');
  }, 60000);

  test('post-migration: vector search works against the new 1536d column', async () => {
    // HNSW index was rebuilt by the schema transition.
    const idx = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'content_chunks' AND indexname = 'idx_chunks_embedding'`,
    );
    expect(idx.length).toBe(1);

    // A cosine query at the new width returns results (all 6 chunks embedded).
    const qvec = `[${new Array(TO_DIMS).fill(0).map((_, i) => (Math.sin(i) * 0.01 + 0.001).toFixed(6)).join(',')}]`;
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT p.slug FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
       WHERE cc.embedding IS NOT NULL
       ORDER BY cc.embedding <=> $1::vector
       LIMIT 3`,
      [qvec],
    );
    expect(rows.length).toBe(3);
  });

  test('re-run on an already-migrated brain is a clean no-op', async () => {
    embeddedTexts = [];
    const code = await runMigrate(['--to', 'openai:text-embedding-3-small', '--yes']);
    expect(code).toBe(0);
    // Nothing re-embedded (probe excluded from embeddedTexts by design).
    expect(embeddedTexts.length).toBe(0);
    expect(await columnDims()).toBe(TO_DIMS);
  });
});

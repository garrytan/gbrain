/**
 * #3390 regression: page straddling a stale-batch BOUNDARY (adversarial review
 * blocker 2).
 *
 * The embed loop stamps `pages.embedding_signature` only when
 * `stale.length === existing.length` — i.e. when every chunk of the page landed
 * in the SAME batch. `listStaleChunks` is a plain keyset LIMIT with no page
 * alignment, so on any corpus bigger than one batch the page split across the
 * boundary is embedded correctly but never stamped.
 *
 * Pre-fix consequence: the completion probe counted that page stale, the
 * command printed "Migration incomplete" and exited 1 on a perfectly-migrated
 * brain, and the re-run RE-INVALIDATED and RE-PAID for those pages —
 * contradicting the "already-migrated chunks are never re-embedded" contract.
 *
 * Shape here: 3 pages x 2 chunks = 6 chunks with --batch-size 3, so the
 * boundary falls mid-page-2. Asserts exit 0 on the first run, every page
 * stamped, and ZERO embed work on the second run.
 *
 * Named `.serial.test.ts`: holds a temp GBRAIN_HOME + an installed fake embed
 * transport for its whole beforeAll→afterAll lifecycle, which withEnv() can't
 * wrap.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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
import { MIGRATION_STATE_KEY, MIGRATION_COMPLETED_KEY } from '../src/core/embedding-migration.ts';

const FROM_DIMS = 1280;
const TO_DIMS = 1536;
const PAGES = ['b-1', 'b-2', 'b-3'];
const PROBE_TEXT = 'gbrain embedding migration probe';

let engine: PGLiteEngine;
let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};
let currentDims = FROM_DIMS;
let embeddedTexts: string[] = [];

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

beforeAll(async () => {
  for (const k of ['GBRAIN_HOME', 'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS', 'OPENAI_API_KEY', 'ZEROENTROPY_API_KEY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-migrate-boundary-'));
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
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    for (const v of values) if (v !== PROBE_TEXT) embeddedTexts.push(v);
    return {
      embeddings: values.map(() => new Array(currentDims).fill(0).map((_, i) => Math.sin(i) * 0.01 + 0.003)),
      usage: { tokens: values.length * 4 },
    } as never;
  });

  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: FROM_DIMS } as never);
  await engine.initSchema();

  // 3 pages x 2 chunks each = 6 chunks.
  for (const slug of PAGES) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: `${slug} chunk zero`, chunk_source: 'compiled_truth', token_count: 4 },
      { chunk_index: 1, chunk_text: `${slug} chunk one`, chunk_source: 'compiled_truth', token_count: 4 },
    ]);
  }
  await runEmbedCore(engine, { stale: true, quiet: true });
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

describe('migration across a stale-batch boundary', () => {
  test('seed is fully embedded at the source width', async () => {
    expect(await engine.countStaleChunks()).toBe(0);
    const n = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL`,
    );
    expect(Number(n[0]?.n)).toBe(6);
  });

  test('batch-size 3 splits a page across the boundary yet still exits 0 with every page stamped', async () => {
    currentDims = TO_DIMS;
    embeddedTexts = [];

    const code = await runMigrate([
      '--to', 'openai:text-embedding-3-small', '--yes', '--batch-size', '3',
    ]);
    // Pre-fix this was 1 ("Migration incomplete") even though all 6 chunks
    // were correctly embedded — the boundary page was never stamped.
    expect(code).toBe(0);

    // 6 chunk re-embeds + 3 completion smoke-check QUERY embeds (the smoke
    // check runs only on the completed path).
    expect(embeddedTexts.length).toBe(9);
    expect(await engine.countStaleChunks()).toBe(0);

    // Every page carries the TARGET signature, including the boundary page.
    const sig = `openai:text-embedding-3-small:${TO_DIMS}`;
    const stamped = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE embedding_signature = $1`,
      [sig],
    );
    expect(Number(stamped[0]?.n)).toBe(PAGES.length);

    // Completion bookkeeping ran (it only runs when the backlog drained).
    expect(await engine.getConfig(MIGRATION_STATE_KEY)).toBeFalsy();
    expect(await engine.getConfig(MIGRATION_COMPLETED_KEY)).toBeTruthy();
  }, 60000);

  test('second run does ZERO work — the "never re-embedded twice" contract holds across a boundary', async () => {
    embeddedTexts = [];
    const code = await runMigrate([
      '--to', 'openai:text-embedding-3-small', '--yes', '--batch-size', '3',
    ]);
    expect(code).toBe(0);
    // Pre-fix the unstamped boundary page was re-invalidated and PAID FOR again.
    expect(embeddedTexts.length).toBe(0);
  }, 60000);
});

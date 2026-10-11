import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { canReuseMarkdownVector } from '../src/core/embed-reuse.ts';
import { embeddingInputHash, type EmbeddingInputContext } from '../src/core/embedding-input-hash.ts';
import { digest, sha256 } from '../src/core/persistence/digest.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { setTimeout as delay } from 'node:timers/promises';

const chunk = { chunk_text: 'A short body.' };
const provenance: EmbeddingInputContext = {
  column: 'embedding',
  model: 'ollama:embeddinggemma:latest',
  dimensions: 768,
  title: 'A real title',
  corpusGeneration: null,
  bodyHash: 'body-1',
};

const MODEL = 'ollama:embeddinggemma:latest';
let dims = 1536;
const backends = testBackends();
let engine: PGLiteEngine;
let pg: Awaited<ReturnType<typeof isolatedPersistencePostgres>> | undefined;
let server: ReturnType<typeof Bun.serve>;
let embeddedCount = 0;
let embeddingResponse = 0;
let responseGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

const paragraph = (word: string) => Array.from({ length: 400 }, (_, i) => `${word}${i}`).join(' ') + '.';
const page = (...words: string[]) => `---\ntype: note\ntitle: Markdown race\n---\n\n${words.map(word => `## Section ${word}\n\n${paragraph(word)}`).join('\n\n')}\n`;

async function prepare(db: BrainEngine, dimensions = 1536) {
  dims = dimensions;
  await db.executeRaw("DELETE FROM pages WHERE source_id='default'");
  await db.setConfig('embedding_model', MODEL);
  await db.setConfig('embedding_dimensions', String(dims));
  await db.setConfig('embedding_disabled', 'false');
  configureGateway({ embedding_model: MODEL, embedding_dimensions: dims, env: {},
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
  embeddedCount = 0;
  embeddingResponse = 0;
}

async function storedProof(db: BrainEngine, slug: string, chunkIndex: number): Promise<string | null> {
  return (await db.executeRaw<{ embedding_input_hash: string | null }>(
    `SELECT c.embedding_input_hash FROM content_chunks c JOIN pages p ON p.id=c.page_id
      WHERE p.source_id='default' AND p.slug=$1 AND c.chunk_index=$2`, [slug, chunkIndex]))[0]?.embedding_input_hash ?? null;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  if (backends.includes('postgres')) pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { input: string[]; model: string };
    embeddedCount += body.input.length;
    const value = ++embeddingResponse / 10;
    const gate = responseGate;
    if (gate) {
      responseGate = null;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_, index) => ({ object: 'embedding', index,
        embedding: [value, ...Array(dims - 1).fill(0)] })),
      usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } });
  } });
}, 60_000);

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
  await pg?.close();
  server?.stop(true);
});

function v1Hash(ctx: EmbeddingInputContext): string {
  return digest(['embedding-input-v1', ctx.column, ctx.model, ctx.dimensions, 'none', null, sha256(chunk.chunk_text)]);
}

describe('canReuseMarkdownVector for formatted document inputs', () => {
  test('rejects a legacy vector without an input hash when the model formats documents', () => {
    expect(canReuseMarkdownVector(null, null, 'none', provenance, { ...chunk, model: provenance.model })).toBe(false);
  });

  test('rejects a legacy v1 hash when the current formatted input hash is v2', () => {
    expect(canReuseMarkdownVector(v1Hash(provenance), null, 'none', provenance, chunk)).toBe(false);
  });

  test('reuses a valid v2 hash while the title and input stay unchanged', () => {
    const hash = embeddingInputHash(provenance, 'none', chunk);
    expect(canReuseMarkdownVector(hash, null, 'none', provenance, chunk)).toBe(true);
    expect(canReuseMarkdownVector(hash, null, 'none', { ...provenance, title: 'A different title' }, chunk)).toBe(false);
  });

  test('preserves same-model null-hash reuse for models without formatted document inputs', () => {
    const unaffected = { ...provenance, model: 'ollama:nomic-embed-text' };
    expect(canReuseMarkdownVector(null, null, 'none', unaffected, { ...chunk, model: unaffected.model })).toBe(true);
  });
});

describe('Markdown EmbeddingGemma reuse snapshot', () => {
  beforeEach(async () => { await prepare(engine); });

  test('a high-level PGLite import keeps valid proven vectors reusable', async () => {
    const slug = 'notes/reuse-proof';
    await importFromContent(engine, slug, page('alpha', 'bravo', 'charlie'));
    const before = await engine.getChunks(slug, { includeEmbedding: true, requireSafeChunks: true });
    expect(before.length).toBeGreaterThan(1);
    const alpha = before.find(chunk => chunk.chunk_text.includes('alpha'))!;
    const alphaProof = await storedProof(engine, slug, alpha.chunk_index);
    expect(alphaProof).not.toBeNull();
    embeddedCount = 0;
    await importFromContent(engine, slug, page('alpha', 'bravo', 'delta'));
    const after = await engine.getChunks(slug, { includeEmbedding: true, requireSafeChunks: true });
    expect(embeddedCount).toBeGreaterThan(0);
    const kept = after.find(chunk => chunk.chunk_index === alpha.chunk_index)!;
    expect(Array.from(kept.embedding as Float32Array)).toEqual(Array.from(alpha.embedding as Float32Array));
    expect(await storedProof(engine, slug, alpha.chunk_index)).toBe(alphaProof);
  });

  test.skipIf(!backends.includes('postgres'))('a concurrent canonical writer cannot pair its unproven vector with the old proof during import', async () => {
    // Authoring gate: protects persisted vector/proof pairing; fails if the page-share lock is removed; existing Markdown tests cover stable imports and the code race is a different boundary; wraps engine calls without a production seam.
    const database = pg!.engine;
    await prepare(database);
    const slug = 'notes/proof-race';
    await importFromContent(database, slug, page('alpha', 'bravo', 'charlie'));
    const original = await database.getChunks(slug, { includeEmbedding: true, requireSafeChunks: true });
    const selected = original.find(chunk => chunk.chunk_text.includes('alpha'))!;
    const pageRow = (await database.executeRaw<{ id: number }>(
      'SELECT id FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug]))[0]!;
    const originalVector = (await database.executeRaw<{ embedding: string }>(
      'SELECT embedding::text AS embedding FROM content_chunks WHERE page_id=$1 AND chunk_index=$2',
      [pageRow.id, selected.chunk_index]))[0]!.embedding;
    const originalProof = await storedProof(database, slug, selected.chunk_index);
    expect(originalProof).not.toBeNull();
    const sentinel = `[${[0.25, ...Array(dims - 1).fill(0)].join(',')}]`;
    expect(sentinel).not.toBe(originalVector);
    const enter = deferred();
    const release = deferred();
    const responseEntered = deferred();
    const responseRelease = deferred();
    responseGate = { entered: responseEntered, release: responseRelease };
    let readerPid = 0;
    let pageShareLocked = false;
    const interleaved = Object.create(database) as BrainEngine;
    const wrap = (originalExec: BrainEngine['executeRaw']) => async <R>(sql: string, params?: unknown[]): Promise<R[]> => {
      const rows = await originalExec<R>(sql, params);
      if (sql.includes('FOR SHARE') && sql.includes('FROM pages')) {
        pageShareLocked = true;
        readerPid = (await originalExec<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
      }
      if (sql.includes('SELECT c.chunk_index, c.embedding_input_hash') && params?.[0] === 'default') {
        enter.resolve();
        await bounded(release.promise, 'proof/vector snapshot barrier');
      }
      return rows;
    };
    interleaved.executeRaw = wrap(database.executeRaw.bind(database));
    interleaved.transaction = <T>(run: (tx: BrainEngine) => Promise<T>) => database.transaction(tx => {
      const wrapped = Object.create(tx) as BrainEngine;
      wrapped.executeRaw = wrap(tx.executeRaw.bind(tx));
      return run(wrapped);
    });

    const importing = importFromContent(interleaved, slug, page('alpha', 'bravo', 'delta'));
    void importing.catch(() => {});
    let writer: Promise<void> | undefined;
    try {
      await bounded(enter.promise, 'proof metadata read');
      writer = database.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('application_name',$1,true)", ['markdown-proof-writer']);
        await tx.executeRaw('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [pageRow.id]);
        await tx.executeRaw(`UPDATE content_chunks SET embedding=$1::vector, embedding_input_hash=NULL
          WHERE page_id=$2 AND chunk_index=$3`, [sentinel, pageRow.id, selected.chunk_index]);
      });
      void writer.catch(() => {});
      if (pageShareLocked) await bounded((async () => {
        const deadline = performance.now() + 8_000;
        while (performance.now() < deadline) {
          const rows = await database.executeRaw<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
               WHERE application_name='markdown-proof-writer' AND wait_event_type='Lock'
                 AND $1::int=ANY(pg_blocking_pids(pid))) AS blocked`, [readerPid]);
          if (rows[0]?.blocked) return;
          await delay(20);
        }
        throw new Error('Canonical writer never reported a page-row lock wait');
      })(), 'canonical writer lock receipt');
      else await bounded(writer, 'unprotected writer interleaving');
      release.resolve();
      await bounded(responseEntered.promise, 'changed markdown chunk embedding');
      await bounded(writer, 'canonical proof/vector writer');
      responseRelease.resolve();
      await bounded(importing, 'high-level markdown import');
    } finally {
      release.resolve();
      responseRelease.resolve();
      responseGate = null;
      await Promise.allSettled([...(writer ? [writer] : []), importing]);
    }

    const final = (await database.executeRaw<{ embedding: string; embedding_input_hash: string | null }>(
      `SELECT c.embedding::text AS embedding, c.embedding_input_hash FROM content_chunks c
        WHERE c.page_id=$1 AND c.chunk_index=$2`, [pageRow.id, selected.chunk_index]))[0]!;
    expect(final.embedding).toBe(originalVector);
    expect(final.embedding).not.toBe(sentinel);
    expect(final.embedding_input_hash).toBe(originalProof);
  }, 60_000);
});

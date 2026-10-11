/**
 * Code EmbeddingGemma formatting and reuse.
 *
 * Protects the exact Ollama request, stored proof and reuse rules on the
 * tree-sitter code-import boundary. It fails if importCodeFile drops the
 * generated title, trusts an unproven/stale vector, or loses proof when it
 * replaces a row. Existing formatter tests do not cover code import, so this
 * uses the real gateway and an ephemeral loopback Ollama-compatible endpoint.
 * No production-only test seam is needed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { digest, sha256 } from '../src/core/persistence/digest.ts';
import { embeddingInputHash } from '../src/core/embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../src/core/page-state/projections.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { setTimeout as delay } from 'node:timers/promises';

const DIMS = 1536;
const MODEL = 'ollama:embeddinggemma:latest';
const MODEL_ID = 'embeddinggemma:latest';
const formatted = (title: string, text: string) => `title: ${title} | text: ${text}`;
type RequestBody = { input: string[]; model: string };

let engine: PGLiteEngine;
let server: ReturnType<typeof Bun.serve>;
let requests: RequestBody[] = [];
let responseGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
const backends = testBackends();
let pg: Awaited<ReturnType<typeof isolatedPersistencePostgres>> | undefined;

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
  } finally {
    clearTimeout(timer);
  }
}

const source = (betaFactor = 4) => `export function alpha(a: number[], b: number[], c: number[]): number {
  let sum = 0;
  for (const x of a) { sum += x; }
  for (const x of b) { sum += x * 2; }
  for (const x of c) { sum += x * 3; }
  if (sum < 0) return 0;
  if (sum > 1_000_000) return 1_000_000;
  if (a.length === b.length) return sum * 2;
  if (b.length === c.length) return sum * 3;
  return sum / (a.length + b.length + c.length);
}

export function beta(x: number[], y: number[], z: number[]): number {
  let sum = 0;
  for (const v of x) { sum += v * 2; }
  for (const v of y) { sum += v * ${betaFactor}; }
  for (const v of z) { sum += v * 6; }
  if (sum < 0) return 0;
  if (sum > 2_000_000) return 2_000_000;
  if (x.length === y.length) return sum * 3;
  if (y.length === z.length) return sum * 5;
  return sum / (x.length + y.length + z.length);
}

export function gamma(p: number[], q: number[], r: number[]): number {
  let sum = 0;
  for (const v of p) { sum += v * 3; }
  for (const v of q) { sum += v * 6; }
  for (const v of r) { sum += v * 9; }
  if (sum < 0) return 0;
  if (sum > 3_000_000) return 3_000_000;
  if (p.length === q.length) return sum * 4;
  if (q.length === r.length) return sum * 7;
  return sum / (p.length + q.length + r.length);
}`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  if (backends.includes('postgres')) pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as RequestBody;
    requests.push(body);
    const gate = responseGate;
    if (gate) {
      responseGate = null;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_, index) => ({ object: 'embedding', index,
        embedding: [1, ...Array(DIMS - 1).fill(0)] })),
      usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } });
  } });
}, 60_000);

beforeEach(async () => {
  requests = [];
  await engine.executeRaw(`DELETE FROM pages WHERE source_id='default'`);
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIMS));
  await engine.setConfig('embedding_disabled', 'false');
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: {},
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
});

afterEach(() => resetGateway());
afterAll(async () => {
  await engine.disconnect();
  await pg?.close();
  server?.stop(true);
});

function capturedInputs(): string[] {
  return requests.flatMap(request => request.input);
}

async function stored(slug: string) {
  return engine.executeRaw<{ chunk_index: number; chunk_text: string; embedding_input_hash: string | null; model: string | null; embedding: string | null }>(
    `SELECT c.chunk_index,c.chunk_text,c.embedding_input_hash,c.model,c.embedding::text AS embedding
       FROM content_chunks c JOIN pages p ON p.id=c.page_id
      WHERE p.source_id='default' AND p.slug=$1 ORDER BY c.chunk_index`, [slug]);
}

async function importCode(path: string, text = source()) {
  return importCodeFile(engine, path, text);
}

describe('code EmbeddingGemma import formatting and reuse', () => {
  test('sends the generated path/language title, stores proof, and keeps unchanged imports on the fast path', async () => {
    const path = 'src/title-aware.ts';
    const title = `${path} (typescript)`;
    const result = await importCode(path);
    const rows = await stored(result.slug);
    expect(rows.length).toBeGreaterThan(1);
    expect(capturedInputs()).toEqual(rows.map(row => formatted(title, row.chunk_text)));
    expect(requests.map(request => request.model)).toEqual([MODEL_ID]);
    const page = await engine.getPage(result.slug);
    expect(page?.title).toBe(title);
    for (const row of rows) {
      expect(row.embedding).not.toBeNull();
      expect(row.embedding_input_hash).toBe(embeddingInputHash({ column: 'embedding', model: MODEL,
        dimensions: DIMS, title, corpusGeneration: null, bodyHash: '' }, 'none', row));
    }

    const before = await stored(result.slug);
    requests = [];
    expect((await importCode(path)).status).toBe('skipped');
    expect(requests).toEqual([]);
    expect(await stored(result.slug)).toEqual(before);
  });

  test('reuses proven exact chunks on a changed file and retains their vector proof', async () => {
    const path = 'src/reuse-exact.ts';
    const title = `${path} (typescript)`;
    const first = await importCode(path);
    const before = await stored(first.slug);
    requests = [];

    await importCode(path, source(7));
    const after = await stored(first.slug);
    const embedded = capturedInputs();
    expect(after.length).toBe(before.length);
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedded.length).toBeLessThan(after.length);
    expect(embedded).toEqual(after.filter(row => row.chunk_text.includes('function beta'))
      .map(row => formatted(title, row.chunk_text)));
    for (const row of after.filter(row => !row.chunk_text.includes('function beta'))) {
      const prior = before.find(item => item.chunk_text === row.chunk_text)!;
      expect(row.embedding).toBe(prior.embedding);
      expect(row.embedding_input_hash).toBe(prior.embedding_input_hash);
    }
  });

  test('line-header, path-title, and content changes invalidate formatted vectors', async () => {
    const path = 'src/shift.ts';
    const first = await importCode(path);
    const original = await stored(first.slug);
    requests = [];

    await importCode(path, `// inserted line one\n// inserted line two\n${source()}`);
    const shifted = await stored(first.slug);
    expect(capturedInputs()).toEqual(shifted.map(row => formatted(`${path} (typescript)`, row.chunk_text)));
    expect(shifted.length).toBe(original.length);
    expect(shifted.map(row => row.embedding_input_hash)).not.toEqual(original.map(row => row.embedding_input_hash));

    requests = [];
    await importCode('Src/shift.ts', `// inserted line one\n// inserted line two\n${source()}`);
    const renamed = await stored(first.slug);
    expect(capturedInputs()).toEqual(renamed.map(row => formatted('Src/shift.ts (typescript)', row.chunk_text)));
    expect(renamed.map(row => row.embedding_input_hash)).not.toEqual(shifted.map(row => row.embedding_input_hash));
  });

  test.skipIf(!backends.includes('postgres'))('does not reuse a vector replaced after its proof was read', async () => {
    const database = pg!.engine;
    const sourceId = 'code-proof-race';
    await database.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await database.setConfig('embedding_model', MODEL);
    await database.setConfig('embedding_dimensions', String(DIMS));
    await database.setConfig('embedding_disabled', 'false');
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: {},
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
    const path = 'src/race.ts';
    const title = `${path} (typescript)`;
    const first = await importCodeFile(database, path, source(), { sourceId });
    const slug = first.slug;
    const seed = await database.getChunks(slug, { sourceId, includeEmbedding: true, requireSafeChunks: true });
    const target = await embeddingWriteTarget(database);
    const context = embeddingInputContext(target, title, null, seed);
    const selected = seed.find(chunk => chunk.chunk_text.includes('function alpha'))!;
    const page = (await database.executeRaw<{ id: number }>(
      'SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!;
    const originalVector = (await database.executeRaw<{ embedding: string }>(
      'SELECT embedding::text AS embedding FROM content_chunks WHERE page_id=$1 AND chunk_index=$2',
      [page.id, selected.chunk_index]))[0]!.embedding;
    const encodedSentinel = `[${[0.25, ...Array(DIMS - 1).fill(0)].join(',')}]`;
    expect(encodedSentinel).not.toBe(originalVector);
    const enter = deferred();
    const release = deferred();
    let pageShareLocked = false;
    let readerPid = 0;
    let writerPid = 0;
    const responseEntered = deferred();
    const responseRelease = deferred();
    responseGate = { entered: responseEntered, release: responseRelease };

    const interleaved = Object.create(database) as BrainEngine;
    interleaved.transaction = <T>(run: (tx: BrainEngine) => Promise<T>) => database.transaction(tx => {
      const wrapped = Object.create(tx) as BrainEngine;
      const executeRaw = tx.executeRaw.bind(tx);
      wrapped.executeRaw = async <R>(sql: string, params?: unknown[]): Promise<R[]> => {
        const rows = await executeRaw<R>(sql, params);
        if (sql.includes('FOR SHARE') && sql.includes('FROM pages')) {
          pageShareLocked = true;
          readerPid = (await executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
        }
        if (sql.includes('SELECT c.chunk_index, c.embedding_input_hash') && params?.[0] === sourceId) {
          enter.resolve();
          await bounded(release.promise, 'proof reader release');
        }
        return rows;
      };
      return run(wrapped);
    });

    const importing = importCodeFile(interleaved, path, source(7), { sourceId });
    void importing.catch(() => {});
    let writer: Promise<void> | undefined;
    try {
      await bounded(enter.promise, 'proof read barrier');
      requests = [];
      writer = database.transaction(async tx => {
        await tx.executeRaw('SELECT set_config(\'application_name\',$1,true)', ['code-proof-writer']);
        const [{ pid }] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        writerPid = pid;
        await tx.executeRaw('SELECT id FROM pages WHERE id=$1 FOR UPDATE', [page.id]);
        await tx.executeRaw(
          `UPDATE content_chunks SET embedding=$1::vector, embedding_input_hash=NULL
            WHERE page_id=$2 AND chunk_index=$3`, [encodedSentinel, page.id, selected.chunk_index]);
      });
      void writer.catch(() => {});
      if (pageShareLocked) await bounded((async () => {
        const deadline = performance.now() + 8_000;
        while (performance.now() < deadline) {
          const rows = await database.executeRaw<{ blocked: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
               WHERE application_name='code-proof-writer' AND wait_event_type='Lock'
                 AND $1::int=ANY(pg_blocking_pids(pid))) AS blocked`, [readerPid]);
          if (rows[0]?.blocked) return;
          await delay(20);
        }
        throw new Error(`Writer ${writerPid} never reported a lock wait`);
      })(), 'canonical writer lock receipt');
      else await bounded(writer, 'unprotected writer interleaving');
      release.resolve();
      await bounded(responseEntered.promise, 'changed-chunk embedding request');
      await bounded(writer, 'canonical proof/vector writer');
      responseRelease.resolve();
      await bounded(importing, 'title-aware import');
    } finally {
      release.resolve();
      responseRelease.resolve();
      responseGate = null;
      await Promise.allSettled([...(writer ? [writer] : []), importing]);
    }

    expect(capturedInputs()).toHaveLength(1);
    const finalChunks = await database.getChunks(slug, { sourceId, includeEmbedding: true, requireSafeChunks: true });
    expect(capturedInputs()).toEqual([formatted(title, finalChunks.find(chunk => chunk.chunk_text.includes('function beta'))!.chunk_text)]);
    const final = (await database.executeRaw<{ embedding: string; embedding_input_hash: string | null }>(
      `SELECT c.embedding::text AS embedding, c.embedding_input_hash FROM content_chunks c
        WHERE c.page_id=$1 AND c.chunk_index=$2`, [page.id, selected.chunk_index]))[0]!;
    expect(final.embedding).toBe(originalVector);
    expect(final.embedding).not.toBe(encodedSentinel);
    expect(final.embedding_input_hash).toBe(embeddingInputHash(context, 'none', selected));
    expect(pageShareLocked).toBe(true);
  }, 60_000);

  test('null and legacy v1 proofs never authorize formatted-vector reuse', async () => {
    for (const proofKind of ['null', 'v1'] as const) {
      const path = `src/legacy-${proofKind}.ts`;
      const first = await importCode(path);
      const seeded = await stored(first.slug);
      for (const row of seeded) {
        const proof = proofKind === 'null' ? null
          : digest(['embedding-input-v1', 'embedding', MODEL, DIMS, 'none', null, sha256(row.chunk_text)]);
        await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash=$3
          WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug=$1) AND chunk_index=$2`,
          [first.slug, row.chunk_index, proof]);
      }
      requests = [];

      await importCode(path, source(7));
      const after = await stored(first.slug);
      expect(capturedInputs()).toEqual(after.map(row => formatted(`${path} (typescript)`, row.chunk_text)));
      expect(after.every(row => row.embedding_input_hash !== null)).toBe(true);
    }
  });

  test('unaffected providers keep raw formatting and header-stripped reuse', async () => {
    const model = 'ollama:nomic-embed-text';
    await engine.setConfig('embedding_model', model);
    configureGateway({ embedding_model: model, embedding_dimensions: DIMS, env: {},
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
    const path = 'src/other-model.ts';
    const first = await importCode(path);
    const rows = await stored(first.slug);
    expect(capturedInputs()).toEqual(rows.map(row => row.chunk_text));

    requests = [];
    await importCode(path, `// inserted line one\n// inserted line two\n${source()}`);
    expect(requests).toEqual([]);
    expect((await stored(first.slug)).every(row => row.embedding !== null)).toBe(true);
  });
});

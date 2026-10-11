/**
 * Lane: unit. Run: `bun test test/embedding-document-take-refresh.test.ts`.
 * Protects consent, source/census bounds, guarded installs, formatted wire input and per-attempt spend caps.
 * Regressions include clearing outside the source, accepting a late row, reinstalling a changed claim, or sending a split beyond cap.
 * Existing stale-take tests omit the consented refresh boundary; this uses the real PGLite engine and existing gateway/loopback seams.
 * No production-only test seam is added.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { saveConfig } from '../src/core/config.ts';
import { embedTakesWithConsent } from '../src/core/embed-takes-refresh.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';

const sourceId = 'embedding-document-take-refresh';
const neighborId = 'embedding-document-take-neighbor';
const archivedId = 'embedding-document-take-archived';
let root: string;
let engine: PGLiteEngine;
let wire: string[][];
let beforeResponse: (() => Promise<void>) | undefined;
let server: ReturnType<typeof Bun.serve>;
const config = () => ({ engine: 'pglite' as const, database_path: join(root, 'db'), embedding_disabled: false });
const inHome = <T>(run: () => Promise<T>) => withEnv({
  GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
}, run);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-take-refresh-'));
  await inHome(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(root, 'db') });
    await engine.initSchema();
    await engine.executeRaw('ALTER TABLE takes ALTER COLUMN embedding TYPE vector(768) USING embedding::vector(768)');
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1),($2,$2),($3,$3)', [sourceId, neighborId, archivedId]);
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { input?: string[] };
    wire.push([...(body.input ?? [])]);
    await beforeResponse?.();
    return Response.json({ object: 'list', model: 'EmbeddingGemma:latest',
      data: (body.input ?? []).map((_, index) => ({ object: 'embedding', embedding: Array(768).fill(0.25), index })),
      usage: { prompt_tokens: body.input?.length ?? 0, total_tokens: body.input?.length ?? 0 } });
  } });
});

beforeEach(async () => inHome(async () => {
  saveConfig(config());
  configureGateway({ embedding_model: 'ollama:EmbeddingGemma:latest', embedding_dimensions: 768,
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` }, env: {} });
  await engine.executeRaw('UPDATE sources SET archived=false WHERE id=ANY($1::text[])', [[sourceId, neighborId, archivedId]]);
  await engine.executeRaw('DELETE FROM takes WHERE page_id IN (SELECT id FROM pages WHERE source_id=ANY($1::text[]))', [[sourceId, neighborId, archivedId]]);
  await engine.executeRaw('DELETE FROM pages WHERE source_id=ANY($1::text[])', [[sourceId, neighborId, archivedId]]);
  await engine.setConfig('embedding_model', 'ollama:EmbeddingGemma:latest');
  await engine.setConfig('embedding_dimensions', '768');
  await engine.setConfig('embedding_disabled', 'false');
  await engine.setConfig('pricing.overrides', '{"ollama:embeddinggemma:latest":1}');
  wire = [];
  beforeResponse = undefined;
}));

afterEach(async () => inHome(async () => { resetGateway(); }));

afterAll(async () => {
  await inHome(() => engine.disconnect());
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function seed(claim: string, source = sourceId, slug = `notes/${claim.replaceAll(' ', '-')}`, active = true) {
  const page = await engine.putPage(slug, { type: 'note', title: claim, compiled_truth: claim, timeline: '' }, { sourceId: source });
  await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim, kind: 'take', holder: 'world', weight: 0.5, active }]);
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id=$1', [page.id]);
  return row.id;
}

async function vector(id: number) {
  await engine.executeRaw(`UPDATE takes SET embedding=$2::vector(768),embedded_at=now(),embedding_model=$3,
    embedded_text_hash=md5(claim) WHERE id=$1::bigint`, [id, `[${Array(768).fill(0.25).join(',')}]`, 'ollama:EmbeddingGemma:latest']);
}

const state = () => engine.executeRaw<{ id: string; claim: string; active: boolean; embedding: string | null; embedded_text_hash: string | null }>(
  `SELECT t.id::text,t.claim,t.active,t.embedding::text,t.embedded_text_hash FROM takes t JOIN pages p ON p.id=t.page_id
    WHERE p.source_id=ANY($1::text[]) ORDER BY t.id`, [[sourceId, neighborId, archivedId]]);

test('all preview freezes eligible source takes and preserves every vector', () => inHome(async () => {
  const current = await seed('current take');
  await vector(current);
  await seed('inactive take', sourceId, undefined, false);
  const deleted = await seed('deleted take');
  await engine.softDeletePage('notes/deleted-take', { sourceId });
  await seed('neighbor take', neighborId);
  await seed('archived take', archivedId);
  await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [archivedId]);
  const before = await state();

  const preview = await embedTakesWithConsent(engine, { sourceId, all: true });
  expect(preview).toMatchObject({ dryRun: true, total_stale: 1, would_embed: 1, stopped: 'preview' });
  expect(wire).toEqual([]);
  expect(await state()).toEqual(before);
  expect(deleted).toBeGreaterThan(0);
}));

test('approval is required, and interrupted all refresh resumes stale rows without clearing completed vectors', () => inHome(async () => {
  const first = await seed('first take');
  const second = await seed('second take');
  await vector(first);
  await vector(second);
  const before = await state();
  await expect(embedTakesWithConsent(engine, { sourceId, all: true, yes: true })).rejects.toMatchObject({ code: 'invalid_params' });
  expect(await state()).toEqual(before);
  const preAborted = new AbortController();
  preAborted.abort();
  await expect(embedTakesWithConsent(engine, { sourceId, all: true, yes: true, maxCostUsd: 1, signal: preAborted.signal })).rejects.toThrow();
  expect(await state()).toEqual(before);
  expect(wire).toEqual([]);

  const controller = new AbortController();
  beforeResponse = async () => { if (wire.length === 2) { controller.abort(); beforeResponse = undefined; } };
  const partial = await embedTakesWithConsent(engine, { sourceId, all: true, yes: true, maxCostUsd: 1, batchSize: 1, signal: controller.signal });
  expect(partial).toMatchObject({ takes: { embedded: 1 }, remaining: 1, stopped: 'aborted' });
  expect(wire.slice(0, 2)).toEqual([['title: none | text: first take'], ['title: none | text: second take']]);
  const firstVector = (await state())[0]?.embedding;

  const resumed = await embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 1, batchSize: 1 });
  expect(resumed).toMatchObject({ takes: { embedded: 1 }, remaining: 0, stopped: 'complete' });
  expect(wire[2]).toEqual(['title: none | text: second take']);
  expect((await state())[0]?.embedding).toBe(firstVector);
  expect((await engine.executeRaw<{ valid: boolean }>(
    'SELECT bool_and(embedded_text_hash=md5(claim)) AS valid FROM takes WHERE embedding IS NOT NULL AND page_id IN (SELECT id FROM pages WHERE source_id=$1)', [sourceId]))[0]?.valid).toBe(true);
}));

test('disabled config, width mismatch and a scoped writer refuse before invalidation or dispatch', () => inHome(async () => {
  const id = await seed('preserve me');
  await vector(id);
  const before = await state();
  await expect(embedTakesWithConsent(engine, { sourceId, all: true, yes: true, maxCostUsd: 1 },
    { ...config(), embedding_disabled: true })).rejects.toThrow();
  expect(await state()).toEqual(before);
  await engine.setConfig('embedding_model', 'ollama:another-model');
  await expect(embedTakesWithConsent(engine, { sourceId, all: true })).rejects.toThrow('configuration differs');
  expect(await state()).toEqual(before);
  await engine.setConfig('embedding_model', 'ollama:EmbeddingGemma:latest');
  await engine.executeRaw('UPDATE takes SET embedding=NULL,embedded_at=NULL,embedding_model=NULL,embedded_text_hash=NULL');
  await engine.executeRaw('ALTER TABLE takes ALTER COLUMN embedding TYPE vector(384) USING embedding::vector(384)');
  await expect(embedTakesWithConsent(engine, { sourceId, all: true })).rejects.toThrow('dimensions');
  await engine.executeRaw('ALTER TABLE takes ALTER COLUMN embedding TYPE vector(768) USING embedding::vector(768)');
  await vector(id);
  const registration = await registerLocalWriter(engine, 'cli', {
    sourceIds: [neighborId], operations: null, scopes: ['read', 'write'], slugPrefixes: null,
  }, true);
  await expect(withVerifiedLocalRegistration(engine, registration, () => embedTakesWithConsent(engine,
    { sourceId, all: true, yes: true, maxCostUsd: 1 }))).rejects.toMatchObject({ code: 'permission_denied' });
  expect(wire).toEqual([]);
  expect(await state()).toEqual(before);
}));

test('source incarnation changes roll back invalidation and census excludes a late take', () => inHome(async () => {
  const id = await seed('old take');
  await vector(id);
  const before = await state();
  const grant = await registerLocalWriter(engine, 'cli', {
    sourceIds: [sourceId], operations: null, scopes: ['read', 'write'], slugPrefixes: null,
  }, true);
  await expect(withVerifiedLocalRegistration(engine, grant, () => embedTakesWithConsent(engine,
    { sourceId, all: true, yes: true, maxCostUsd: 1, assertOwned: async tx => {
      await tx.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [grant.id]);
    } }))).rejects.toMatchObject({ code: 'permission_denied' });
  expect(await state()).toEqual(before);
  expect(wire).toEqual([]);

  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [sourceId]);
  await expect(embedTakesWithConsent(engine, { sourceId, all: true, yes: true, maxCostUsd: 1, assertOwned: async tx => {
    await tx.executeRaw('DELETE FROM page_write_guards WHERE source_incarnation=$1::uuid', [source.incarnation]);
    await tx.executeRaw('DELETE FROM page_projection_jobs WHERE source_incarnation=$1::uuid', [source.incarnation]);
    await tx.executeRaw('DELETE FROM extract_atoms_page_state WHERE source_incarnation=$1::uuid', [source.incarnation]);
    await tx.executeRaw('DELETE FROM source_ingestion_receipts WHERE source_incarnation=$1::uuid', [source.incarnation]);
    await tx.executeRaw('UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [sourceId, randomUUID()]);
  } })).rejects.toThrow('Source identity changed');
  expect(await state()).toEqual(before);
  await engine.executeRaw('UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [sourceId, source.incarnation]);

  let lateId: number | undefined;
  const result = await embedTakesWithConsent(engine, { sourceId, all: true, yes: true, maxCostUsd: 1,
    assertOwned: async tx => {
      if (lateId !== undefined) return;
      const page = await tx.putPage('notes/late-take', { type: 'note', title: 'late take', compiled_truth: 'late take', timeline: '' }, { sourceId });
      await tx.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'late take', kind: 'take', holder: 'world', weight: 0.5 }]);
      const [row] = await tx.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id=$1', [page.id]);
      lateId = row.id;
      beforeResponse = undefined;
      await tx.executeRaw(`UPDATE takes SET embedding=$2::vector(768),embedded_at=now(),embedding_model=$3,
        embedded_text_hash=md5(claim) WHERE id=$1::bigint`, [lateId, `[${Array(768).fill(0.25).join(',')}]`, 'ollama:EmbeddingGemma:latest']);
    } });
  expect(result).toMatchObject({ takes: { embedded: 1 }, remaining: 0, stopped: 'complete' });
  const late = (await state()).find(row => row.id === String(lateId));
  expect(late?.embedding).not.toBeNull();
  expect(wire).toEqual([['title: none | text: old take']]);
}));

test('claim edits during a gateway call discard its vector; split retries stay formatted and capped', () => inHome(async () => {
  const id = await seed('claim that changes');
  beforeResponse = async () => {
    beforeResponse = undefined;
    await engine.executeRaw('UPDATE takes SET claim=$2 WHERE id=$1::bigint', [id, 'new claim']);
  };
  const discarded = await embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 1 });
  expect(discarded).toMatchObject({ takes: { embedded: 0, discarded: 1 }, remaining: 1, stopped: 'failed' });
  expect((await state())[0]?.embedded_text_hash).toBeNull();

  wire = [];
  await vector(id);
  const moving = await seed('moving take');
  beforeResponse = async () => {
    beforeResponse = undefined;
    await engine.executeRaw('UPDATE pages SET source_id=$2 WHERE slug=$1', ['notes/moving-take', neighborId]);
  };
  const moved = await embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 1 });
  expect(moved).toMatchObject({ takes: { embedded: 0, discarded: 1 }, remaining: 0, stopped: 'complete' });
  expect((await engine.executeRaw<{ embedding: unknown }>('SELECT embedding FROM takes WHERE id=$1::bigint', [moving]))[0]?.embedding).toBeNull();

  wire = [];
  const a = await seed('a');
  const b = await seed('b');
  await seed('c');
  await vector(id);
  __setEmbedTransportForTests(async opts => {
    const inputs = opts.values as string[];
    wire.push([...inputs]);
    if (inputs.length === 3) throw new Error('token limit exceeded');
    return { embeddings: inputs.map(() => Array(768).fill(0.25)), usage: { tokens: 63 } } as never;
  });
  try {
    const result = await embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 0.000063, batchSize: 3 });
    expect(result).toMatchObject({ takes: { embedded: 0, failures: 3 }, remaining: 3, cost_usd: 0.000063, stopped: 'failed' });
    expect(wire).toContainEqual(['title: none | text: a', 'title: none | text: b', 'title: none | text: c']);
    expect(wire).toContainEqual(['title: none | text: a', 'title: none | text: b']);
    expect(wire).not.toContainEqual(['title: none | text: c']);
    expect((await state()).filter(row => [a, b].includes(Number(row.id))).every(row => row.embedding === null)).toBe(true);
  } finally { __setEmbedTransportForTests(null); }
}));

test('writer grant revoked by an in-flight embedding cannot authorize installation', () => inHome(async () => {
  const id = await seed('grant changes mid-flight');
  const registration = await registerLocalWriter(engine, 'cli', {
    sourceIds: [sourceId], operations: null, scopes: ['read', 'write'], slugPrefixes: null,
  }, true);
  beforeResponse = async () => {
    beforeResponse = undefined;
    await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [registration.id]);
  };

  const result = await withVerifiedLocalRegistration(engine, registration, () => embedTakesWithConsent(engine,
    { sourceId, yes: true, maxCostUsd: 1 }));
  expect(result).toMatchObject({ takes: { embedded: 0, failures: 1 }, remaining: 1, stopped: 'failed' });
  expect(wire).toEqual([['title: none | text: grant changes mid-flight']]);
  expect((await engine.executeRaw<{ embedding: unknown }>('SELECT embedding FROM takes WHERE id=$1::bigint', [id]))[0]?.embedding).toBeNull();
}));

test('gateway model changed during a request cannot install or dispatch another vector', () => inHome(async () => {
  const id = await seed('gateway identity changes');
  beforeResponse = async () => {
    beforeResponse = undefined;
    configureGateway({ embedding_model: 'ollama:Other:latest', embedding_dimensions: 768,
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` }, env: {} });
  };

  const first = await embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 1 });
  expect(first).toMatchObject({ takes: { embedded: 0, failures: 1 }, remaining: 1, stopped: 'failed' });
  expect((await engine.executeRaw<{ embedding: unknown }>('SELECT embedding FROM takes WHERE id=$1::bigint', [id]))[0]?.embedding).toBeNull();
  expect(wire).toEqual([['title: none | text: gateway identity changes']]);

  await expect(embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 1 })).rejects.toThrow('configuration differs');
  expect(wire).toEqual([['title: none | text: gateway identity changes']]);
}));

test('gateway dimension changed during a request cannot install or dispatch another vector', () => inHome(async () => {
  const id = await seed('gateway width changes');
  beforeResponse = async () => {
    beforeResponse = undefined;
    configureGateway({ embedding_model: 'ollama:EmbeddingGemma:latest', embedding_dimensions: 384,
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` }, env: {} });
  };

  const first = await embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 1 });
  expect(first).toMatchObject({ takes: { embedded: 0, failures: 1 }, remaining: 1, stopped: 'failed' });
  expect((await engine.executeRaw<{ embedding: unknown }>('SELECT embedding FROM takes WHERE id=$1::bigint', [id]))[0]?.embedding).toBeNull();
  expect(wire).toEqual([['title: none | text: gateway width changes']]);

  await expect(embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 1 })).rejects.toThrow('configuration differs');
  expect(wire).toEqual([['title: none | text: gateway width changes']]);
}));

test('slash-form provider model resolves to the same invocation identity and keeps document wire formatting', () => inHome(async () => {
  const id = await seed('slash model claim');
  await engine.setConfig('embedding_model', 'ollama/embeddinggemma');
  configureGateway({ embedding_model: 'ollama/embeddinggemma', embedding_dimensions: 768,
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` }, env: {} });

  const result = await embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 1 });
  expect(result).toMatchObject({ takes: { embedded: 1, failures: 0 }, remaining: 0, stopped: 'complete' });
  expect(wire).toEqual([['title: none | text: slash model claim']]);
  expect((await engine.executeRaw<{ embedding_model: string; provenance_unchanged: boolean }>(
    'SELECT embedding_model,embedded_text_hash=md5(claim) AS provenance_unchanged FROM takes WHERE id=$1::bigint', [id]))[0]).toEqual({
    embedding_model: 'ollama/embeddinggemma', provenance_unchanged: true,
  });
}));

test('formatted request ceiling enforces a zero-call cost cap', () => inHome(async () => {
  await seed('x');
  const refused = await embedTakesWithConsent(engine, { sourceId, yes: true, maxCostUsd: 0 });
  expect(refused).toMatchObject({ takes: { embedded: 0, failures: 1 }, stopped: 'failed' });
  expect(wire).toEqual([]);
}));

/** Lane: unit. Run: `bun test test/embedding-document-fact-refresh.test.ts`. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { saveConfig } from '../src/core/config.ts';
import type { NewFact } from '../src/core/engine.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';
import { parseFactEmbedArgs } from '../src/commands/embed-facts-delegate.ts';
import { AUDIT_ROW_SOURCES } from '../src/core/facts/audit-sources.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';

const sourceId = 'embedding-document-fact-refresh';
const neighborId = 'embedding-document-fact-neighbor';
const archivedId = 'embedding-document-fact-archived';
let root: string;
let engine: PGLiteEngine;
let wire: string[][];
let stopNextRequest: (() => void) | undefined;
let server: ReturnType<typeof Bun.serve>;
const config = () => ({ engine: 'pglite' as const, database_path: join(root, 'db'), embedding_disabled: false });
const inHome = <T>(run: () => Promise<T>) => withEnv({
  GBRAIN_HOME: root, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined,
  DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
}, run);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-fact-refresh-'));
  await inHome(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(root, 'db') });
    await engine.initSchema();
    await engine.executeRaw('ALTER TABLE facts ALTER COLUMN embedding TYPE halfvec(768) USING embedding::halfvec(768)');
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1),($2,$2),($3,$3)', [sourceId, neighborId, archivedId]);
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { input?: string[] };
    wire.push([...(body.input ?? [])]);
    stopNextRequest?.();
    stopNextRequest = undefined;
    return Response.json({ object: 'list', model: 'EmbeddingGemma:latest',
      data: (body.input ?? []).map((_, index) => ({ object: 'embedding', embedding: Array(768).fill(0.25), index })),
      usage: { prompt_tokens: (body.input ?? []).length, total_tokens: (body.input ?? []).length } });
  } });
});

beforeEach(async () => inHome(async () => {
  saveConfig(config());
  configureGateway({ embedding_model: 'ollama:EmbeddingGemma:latest', embedding_dimensions: 768,
    base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` }, env: {} });
  await engine.executeRaw('DELETE FROM facts WHERE source_id=ANY($1::text[])', [[sourceId, neighborId, archivedId]]);
  await engine.executeRaw('DELETE FROM fact_withdrawals WHERE source_id=ANY($1::text[])', [[sourceId, neighborId, archivedId]]);
  await engine.executeRaw('UPDATE sources SET archived=false WHERE id=ANY($1::text[])', [[sourceId, neighborId, archivedId]]);
  await engine.setConfig('embedding_model', 'ollama:EmbeddingGemma:latest');
  await engine.setConfig('embedding_dimensions', '768');
  await engine.setConfig('embedding_disabled', 'false');
  await engine.setConfig('pricing.overrides', '{"ollama:embeddinggemma:latest":1}');
  wire = [];
  stopNextRequest = undefined;
}));

afterEach(async () => inHome(async () => { resetGateway(); }));

afterAll(async () => {
  await inHome(() => engine.disconnect());
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function seed(fact: string, source = sourceId, fields: Partial<NewFact> = {}) {
  const row = await engine.insertFact({ fact, source: 'notes', visibility: 'world', kind: 'fact', confidence: 1, ...fields },
    { source_id: source });
  if (fields.expired_at) await engine.expireFact(row.id, { at: fields.expired_at });
  return row.id;
}

async function embedExisting(id: number) {
  await engine.executeRaw(`UPDATE facts SET embedding=$2::halfvec(768),embedded_at=now(),embedding_model=$3,
    embedded_text_hash=md5(fact) WHERE id=$1::bigint`, [id, `[${Array(768).fill(0.25).join(',')}]`, 'ollama:EmbeddingGemma:latest']);
}

const state = () => engine.executeRaw<{ id: string; fact: string; embedding: string | null; embedding_model: string | null; embedded_text_hash: string | null }>(
  'SELECT id::text,fact,embedding::text,embedding_model,embedded_text_hash FROM facts WHERE source_id=ANY($1::text[]) ORDER BY id', [[sourceId, neighborId, archivedId]]);

test('all preview counts every eligible fact without changing vectors or calling Ollama', () => inHome(async () => {
  const currentA = await seed('current a');
  const currentB = await seed('current b');
  await embedExisting(currentA);
  await embedExisting(currentB);
  await seed('audit', sourceId, { source: AUDIT_ROW_SOURCES[0] });
  await seed('expired', sourceId, { expired_at: new Date('2020-01-01') });
  await seed('out of date', sourceId, { valid_until: new Date('2020-01-01') });
  const superseded = await seed('superseded');
  await engine.executeRaw('UPDATE facts SET superseded_by=$2::bigint WHERE id=$1::bigint', [superseded, currentA]);
  await seed('withdrawn');
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
    SELECT $1,'world','*',gbrain_fact_fingerprint('withdrawn')`, [sourceId]);
  await seed('other source', neighborId);
  const deletedSlug = 'notes/deleted-fact-page';
  await engine.putPage(deletedSlug, { type: 'note', title: 'Deleted', compiled_truth: 'Deleted page.', timeline: '' }, { sourceId });
  const deletedFact = await seed('deleted page fact');
  await engine.executeRaw('UPDATE facts SET source_markdown_slug=$2 WHERE id=$1::bigint', [deletedFact, deletedSlug]);
  await engine.softDeletePage(deletedSlug, { sourceId });
  await seed('archived source fact', archivedId);
  await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [archivedId]);
  const before = await state();

  expect(parseFactEmbedArgs(['--stale', '--facts', '--source', sourceId, '--all'])).toMatchObject({ all: true, dryRun: true });
  const preview = await embedStaleFacts(engine, { sourceId, all: true });
  expect(preview).toMatchObject({ dryRun: true, total_stale: 2, would_embed: 2, stopped: 'preview' });
  expect(wire).toEqual([]);
  expect(await state()).toEqual(before);
}));

test('all invalidates then embeds; a normal resume preserves completed rows and repeated all restarts', () => inHome(async () => {
  const first = await seed('first');
  const second = await seed('second');
  await embedExisting(first);
  await embedExisting(second);

  const preview = await embedStaleFacts(engine, { sourceId, all: true });
  expect(preview.would_embed).toBe(2);
  expect(wire).toEqual([]);
  const partial = await embedStaleFacts(engine, { sourceId, all: true, yes: true, maxCostUsd: 1, maxFacts: 1 });
  expect(partial).toMatchObject({ embedded: 1, remaining: 1, stopped: 'limit' });
  expect(wire).toEqual([['title: none | text: first']]);
  const firstVector = (await state())[0]?.embedding;

  const resumed = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: 1 });
  expect(resumed).toMatchObject({ embedded: 1, remaining: 0, stopped: 'complete' });
  expect(wire).toEqual([['title: none | text: first'], ['title: none | text: second']]);
  expect((await state())[0]?.embedding).toBe(firstVector);

  const restarted = await embedStaleFacts(engine, { sourceId, all: true, yes: true, maxCostUsd: 1 });
  expect(restarted).toMatchObject({ embedded: 2, remaining: 0 });
  expect(wire.slice(2)).toEqual([['title: none | text: first', 'title: none | text: second']]);
}));

test('approval, config and writer authority refusals leave vectors intact', () => inHome(async () => {
  const id = await seed('preserved');
  await embedExisting(id);
  const before = await state();
  await expect(embedStaleFacts(engine, { sourceId, all: true, yes: true })).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(embedStaleFacts(engine, { sourceId, all: true, yes: true, maxCostUsd: 1 },
    { ...config(), embedding_disabled: true })).rejects.toThrow('no-embedding');
  const registration = await registerLocalWriter(engine, 'cli', {
    sourceIds: [neighborId], operations: null, scopes: ['read', 'write'], slugPrefixes: null,
  }, true);
  await expect(withVerifiedLocalRegistration(engine, registration, () => embedStaleFacts(engine,
    { sourceId, all: true, yes: true, maxCostUsd: 1 }))).rejects.toMatchObject({ code: 'permission_denied' });
  expect(wire).toEqual([]);
  expect(await state()).toEqual(before);
}));

test('source incarnation is rechecked inside the invalidation transaction', () => inHome(async () => {
  const id = await seed('incarnation protected');
  await embedExisting(id);
  const before = await state();
  const [sourceBefore] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [sourceId]);
  let ownershipChecked = false;
  await expect(embedStaleFacts(engine, { sourceId, all: true, yes: true, maxCostUsd: 1, assertOwned: async tx => {
    ownershipChecked = true;
    await tx.executeRaw('DELETE FROM page_write_guards WHERE source_incarnation=$1::uuid', [sourceBefore.incarnation]);
    await tx.executeRaw('UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [sourceId, randomUUID()]);
  } })).rejects.toThrow('Source identity changed');
  expect(ownershipChecked).toBe(true);
  expect(wire).toEqual([]);
  expect(await state()).toEqual(before);
  expect(await engine.executeRaw('SELECT incarnation::text FROM sources WHERE id=$1', [sourceId])).toEqual([sourceBefore]);
}));

test('invalidation stays within the census ceiling for the bounded drain', () => inHome(async () => {
  const originalId = await seed('in the refresh manifest');
  await embedExisting(originalId);
  let lateId: number | undefined;
  const result = await embedStaleFacts(engine, { sourceId, all: true, yes: true, maxCostUsd: 1, assertOwned: async tx => {
    if (lateId !== undefined) return;
    const late = await tx.insertFact({ fact: 'inserted after the census', source: 'notes', visibility: 'world', kind: 'fact', confidence: 1,
      embedding: new Float32Array(768).fill(0.25), embedding_model: 'ollama:EmbeddingGemma:latest' }, { source_id: sourceId });
    lateId = late.id;
    await tx.executeRaw('UPDATE facts SET embedded_text_hash=md5(fact) WHERE id=$1::bigint', [late.id]);
  } });
  expect(result).toMatchObject({ embedded: 1, remaining: 0, stopped: 'complete' });
  expect(lateId).toBeDefined();
  const [late] = await engine.executeRaw<{ embedding: string | null; embedded_text_hash: string | null; fact: string }>(
    'SELECT fact,embedding::text,embedded_text_hash FROM facts WHERE id=$1::bigint', [lateId]);
  expect(late).toMatchObject({ fact: 'inserted after the census', embedded_text_hash: expect.any(String) });
  expect(late.embedding).not.toBeNull();
  expect(wire).toEqual([['title: none | text: in the refresh manifest']]);
}));

test('aborted refresh leaves vectors intact before invalidation and resumes after an in-flight abort', () => inHome(async () => {
  const id = await seed('resume this');
  await embedExisting(id);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expect(embedStaleFacts(engine, { sourceId, all: true, yes: true, maxCostUsd: 1, signal: alreadyAborted.signal })).rejects.toThrow();
  expect((await state())[0]?.embedding).not.toBeNull();
  expect(wire).toEqual([]);

  const controller = new AbortController();
  stopNextRequest = () => controller.abort();
  const interrupted = await embedStaleFacts(engine, { sourceId, all: true, yes: true, maxCostUsd: 1, signal: controller.signal });
  expect(interrupted).toMatchObject({ embedded: 0, failures: 1, remaining: 1, stopped: 'aborted' });
  expect((await state())[0]?.embedding).toBeNull();
  const resumed = await embedStaleFacts(engine, { sourceId, yes: true, maxCostUsd: 1 });
  expect(resumed).toMatchObject({ embedded: 1, remaining: 0, stopped: 'complete' });
  expect(wire).toEqual([['title: none | text: resume this'], ['title: none | text: resume this']]);
}));

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { withEnv } from './helpers/with-env.ts';
import { markdownEmbeddingInputHash, reuseMarkdownEmbeddings } from '../src/core/document/markdown-embedding-reuse.ts';
import type { Chunk, ChunkInput } from '../src/core/types.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { entityIngestTools } from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import type { ToolCtx } from '../src/core/minions/types.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: BrainEngine;
let root: string;
let calls: string[][] = [];
let failEmbedding = false;
let observeEmbedding: (() => Promise<void>) | undefined;
const model = 'ollama:qwen3-embedding:0.6b';
const databaseUrl = process.env.PMBRAIN_IMPORT_REUSE_TEST_DATABASE_URL;
const dimensions = databaseUrl ? 1536 : 8;
const sourceId = 'import-reuse-test';
const slug = 'projects/incremental';

beforeAll(async () => {
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  root = mkdtempSync(join(tmpdir(), 'pmbrain-import-reuse-'));
  configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: {} });
  __setEmbedTransportForTests(async (args: { values: string[] }) => {
    calls.push([...args.values]);
    await observeEmbedding?.();
    if (failEmbedding) throw new Error('embedding reuse test outage');
    return { embeddings: args.values.map((_, index) => Array.from({ length: dimensions }, () => (index + 1) / 10)),
      values: args.values, usage: { tokens: args.values.length }, warnings: [] };
  });
  engine = databaseUrl ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : { database_path: join(root, 'brain.pglite') });
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING", [sourceId]);
}, 120_000);

afterAll(async () => {
  if (engine) {
    if (databaseUrl) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.disconnect();
  }
  __setEmbedTransportForTests(null);
  resetGateway();
  if (root) rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
  await engine.setConfig('search.mode', 'balanced');
  configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: {} });
  calls = [];
  failEmbedding = false;
  observeEmbedding = undefined;
});

function markdown(changed = -1, title = '项目进展', tags = 'initial', prefix = ''): string {
  const paragraphs = Array.from({ length: 7 }, (_, index) =>
    `${index === changed ? 'changed' : 'stable'}-${index} ` + `${String.fromCharCode(97 + index)} `.repeat(290));
  return `---\ntype: project\ntitle: ${title}\ntags: [${tags}]\n---\n\n${prefix}${paragraphs.join('\n\n')}`;
}

async function write(content: string, opts: { noEmbed?: boolean; forceRechunk?: boolean; sourceId?: string } = {}) {
  return withEnv({ PMBRAIN_HOME: undefined, GBRAIN_HOME: root, GBRAIN_AUDIT_DIR: join(root, 'audit') }, () =>
    importFromContent(engine, slug, content, { sourceId, ...opts }));
}

async function vectors() {
  return engine.executeRaw<{ chunk_index: number; chunk_text: string; embedding: string; model: string | null; embedding_input_hash: string | null }>(
    `SELECT c.chunk_index,c.chunk_text,c.embedding::text,c.model,c.embedding_input_hash FROM content_chunks c
     JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 AND p.source_id=$2 ORDER BY c.chunk_index`, [slug, sourceId]);
}

test('a paragraph edit embeds only changed inputs and retains all current chunks', async () => {
  await write(markdown());
  const oldInputs = new Set(calls.flat());
  const old = await engine.getChunks(slug, { sourceId });
  calls = [];
  await write(markdown(4));
  const current = await engine.getChunks(slug, { sourceId });
  expect(calls.flat().length).toBeGreaterThan(0);
  expect(calls.flat().length).toBeLessThan(current.length);
  expect(calls.flat().every(text => !oldInputs.has(text))).toBe(true);
  expect(current.some(chunk => chunk.chunk_text.includes('changed-4'))).toBe(true);
  expect(current.length).toBe(old.length);
  expect((await vectors()).every(row => row.embedding && row.embedding_input_hash)).toBe(true);
});

test('a paragraph edit leaves unchanged database chunk rows untouched', async () => {
  await write(markdown());
  const before = await engine.executeRaw<{chunk_index:number;embedded_at:string}>(
    `SELECT c.chunk_index,c.embedded_at::text FROM content_chunks c JOIN pages p ON p.id=c.page_id
     WHERE p.slug=$1 AND p.source_id=$2 ORDER BY c.chunk_index`, [slug,sourceId]);
  await new Promise(resolve => setTimeout(resolve, 10));
  await write(markdown(4));
  const after = await engine.executeRaw<{chunk_index:number;embedded_at:string}>(
    `SELECT c.chunk_index,c.embedded_at::text FROM content_chunks c JOIN pages p ON p.id=c.page_id
     WHERE p.slug=$1 AND p.source_id=$2 ORDER BY c.chunk_index`, [slug,sourceId]);
  expect(after.filter((row,index)=>row.embedded_at===before[index].embedded_at)).toHaveLength(before.length-1);
});

test('large ordinary pages also leave unchanged chunk rows untouched', async () => {
  const text=Array.from({length:110},(_,index)=>`paragraph-${index} ${'word '.repeat(290)}`).join('\n\n');
  await write(`---\ntitle: 大篇幅普通页\n---\n${text}`);
  const before=await engine.executeRaw<{chunk_index:number;embedded_at:string}>(
    'SELECT chunk_index,embedded_at::text FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug=$1 AND source_id=$2) ORDER BY chunk_index',[slug,sourceId]);
  expect(before.length).toBeGreaterThan(100);
  calls=[];
  await write(`---\ntitle: 大篇幅普通页\n---\n${text.replace('paragraph-55 ', 'modified-55 ')}`);
  const after=await engine.executeRaw<{chunk_index:number;embedded_at:string}>(
    'SELECT chunk_index,embedded_at::text FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug=$1 AND source_id=$2) ORDER BY chunk_index',[slug,sourceId]);
  expect(after.filter((row,index)=>row.embedded_at===before[index].embedded_at)).toHaveLength(before.length-1);
  expect(calls.flat()).toHaveLength(1);
},30_000);

async function ingestFixture() {
  const context={slug:'input.txt',sourceId,body:'项目进展由当前项目负责，补充一项事实。',chunkBody:'项目进展由当前项目负责，补充一项事实。'};
  await engine.putPage(context.slug,{type:'note',title:'输入资料',compiled_truth:context.body,timeline:'',frontmatter:{}},{sourceId});
  await write(markdown());
  let transactionDepth=0;
  const tracked=(base:BrainEngine):BrainEngine=>new Proxy(base,{get(target,key){
    if(key==='transaction')return async(fn:(tx:BrainEngine)=>Promise<unknown>)=>target.transaction(async tx=>{
      transactionDepth++;try{return await fn(tracked(tx));}finally{transactionDepth--;}
    });
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const scoped=tracked(engine);
  const tools=entityIngestTools(buildBrainTools({engine:scoped,subagentId:1,sourceId,allowEntityLinks:true,config:{} as GBrainConfig,
    allowedSlugPrefixes:['projects/*'],allowedNames:new Set(['put_page'])}),context);
  const ctx={engine:scoped,jobId:1} as ToolCtx;
  const input={slug:`${sourceId}:${slug}`,content:'---\ntitle: 项目进展\ntype: project\n---\n补充一项事实。[Source: input.txt]'};
  return {context,input,put:()=>withEnv({PMBRAIN_HOME:undefined,GBRAIN_HOME:root,GBRAIN_AUDIT_DIR:join(root,'audit')},()=>tools[0].execute(input,ctx)),depth:()=>transactionDepth};
}

test('real entity ingestion prepares vectors outside transactions and repeats become no-ops', async () => {
  const fixture=await ingestFixture();
  const depths:number[]=[];
  calls=[];
  observeEmbedding=async()=>{depths.push(fixture.depth());};
  await fixture.put();
  expect(depths.length).toBeGreaterThan(0);
  expect(depths.every(depth=>depth===0)).toBe(true);
  const before=await engine.getPage(slug,{sourceId});
  expect(before?.compiled_truth).toContain('stable-0');
  expect(before?.compiled_truth).toContain('补充一项事实。');
  const [revision]=await engine.executeRaw<{revision:string}>('SELECT knowledge_revision::text revision FROM pages WHERE slug=$1 AND source_id=$2',[slug,sourceId]);
  const versions=await engine.getVersions(slug,{sourceId});
  calls=[];
  expect(await fixture.put()).toMatchObject({status:'skipped'});
  expect(calls).toEqual([]);
  expect(await engine.getVersions(slug,{sourceId})).toEqual(versions);
  fixture.context.chunkBody=fixture.context.body.slice(0,-1);
  expect(await fixture.put()).toMatchObject({status:'skipped'});
  expect(calls).toEqual([]);
  expect(await engine.getVersions(slug,{sourceId})).toEqual(versions);
  expect((await engine.getPage(slug,{sourceId}))?.compiled_truth).toBe(before?.compiled_truth);
  expect(await engine.executeRaw('SELECT knowledge_revision::text revision FROM pages WHERE slug=$1 AND source_id=$2',[slug,sourceId])).toEqual([revision]);
});

for(const changed of ['source','entity'] as const)test(`an ${changed} change during vector preparation rejects the stale entity commit`,async()=>{
  const fixture=await ingestFixture();
  const old=await engine.getPage(slug,{sourceId});
  observeEmbedding=async()=>{
    observeEmbedding=undefined;
    const target=changed==='source'?fixture.context.slug:slug;
    const page=await engine.getPage(target,{sourceId});
    await engine.putPage(target,{...page!,compiled_truth:'用户刚更新的内容。'},{sourceId});
  };
  await expect(fixture.put()).rejects.toThrow(changed==='source'?'source changed':'revision conflict');
  expect((await engine.getPage(slug,{sourceId}))?.compiled_truth).toBe(changed==='source'?old?.compiled_truth:'用户刚更新的内容。');
});

test('tag-only edits and an unchanged repeat make no embedding requests', async () => {
  await write(markdown());
  const old = await vectors();
  calls = [];
  await write(markdown(-1, '项目进展', 'updated'));
  expect(calls).toEqual([]);
  expect(await vectors()).toEqual(old);
  expect((await write(markdown(-1, '项目进展', 'updated'))).status).toBe('skipped');
  expect(calls).toEqual([]);
});

test('inserting a paragraph reuses unchanged inputs even when chunk indices move', async () => {
  await write(markdown());
  const oldInputs = new Set(calls.flat());
  calls = [];
  await write(markdown(-1, '项目进展', 'initial', `inserted ${'z '.repeat(290)}\n\n`));
  expect(calls.flat().length).toBeGreaterThan(0);
  expect(calls.flat().every(text => !oldInputs.has(text))).toBe(true);
  expect(calls.flat().length).toBeLessThan((await engine.getChunks(slug, { sourceId })).length);
});

test('title or contextual mode changes invalidate wrapped inputs', async () => {
  await write(markdown());
  calls = [];
  await write(markdown(-1, '新标题'));
  expect(calls.flat()).toHaveLength((await engine.getChunks(slug, { sourceId })).length);
  expect(calls.flat().every(text => text.includes('新标题'))).toBe(true);
  calls = [];
  await engine.setConfig('search.mode', 'conservative');
  await write(markdown(-1, '新标题', 'other'));
  expect(calls.flat()).toHaveLength((await engine.getChunks(slug, { sourceId })).length);
  expect(calls.flat().every(text => !text.startsWith('<context>'))).toBe(true);
});

test('a no-embed title edit cannot make an old wrapped vector reusable under the new title', async () => {
  await write(markdown());
  await write(markdown(-1, '新标题'), { noEmbed: true });
  calls = [];
  await write(markdown(-1, '新标题', 'other'));
  expect(calls.flat()).toHaveLength((await engine.getChunks(slug, { sourceId })).length);
});

test('another model, missing vectors and forceRechunk are never silently reused', async () => {
  await write(markdown());
  await engine.executeRaw("UPDATE content_chunks SET model='other:model' WHERE page_id=(SELECT id FROM pages WHERE slug=$1 AND source_id=$2)", [slug, sourceId]);
  calls = [];
  await write(markdown(-1, '项目进展', 'second'));
  const count = (await engine.getChunks(slug, { sourceId })).length;
  expect(calls.flat()).toHaveLength(count);
  await engine.executeRaw('UPDATE content_chunks SET embedding=NULL WHERE page_id=(SELECT id FROM pages WHERE slug=$1 AND source_id=$2) AND chunk_index=0', [slug, sourceId]);
  calls = [];
  await write(markdown(-1, '项目进展', 'third'));
  expect(calls.flat()).toHaveLength(1);
  calls = [];
  await write(markdown(-1, '项目进展', 'third'), { forceRechunk: true });
  expect(calls.flat()).toHaveLength(count);
});

test('vectors with a different width cannot pass reuse validation', async () => {
  await write(markdown());
  calls = [];
  configureGateway({ embedding_model: model, embedding_dimensions: dimensions + 1, env: {} });
  failEmbedding = true;
  await expect(write(markdown(-1, '项目进展', 'changed'))).rejects.toThrow();
  expect(calls.flat()).toHaveLength((await engine.getChunks(slug, { sourceId })).length);
});

test('identical slugs in another Source cannot supply reusable vectors', async () => {
  await write(markdown(), { sourceId: 'default' });
  calls = [];
  await write(markdown(-1, '项目进展', 'other'));
  expect(calls.flat()).toHaveLength((await engine.getChunks(slug, { sourceId })).length);
  await engine.executeRaw("DELETE FROM pages WHERE slug=$1 AND source_id='default'", [slug]);
});

test('legacy NULL receipts remain intact until an edit and are reused only as raw inputs', async () => {
  await engine.setConfig('search.mode', 'conservative');
  await write(markdown());
  await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=(SELECT id FROM pages WHERE slug=$1 AND source_id=$2)', [slug, sourceId]);
  await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL WHERE slug=$1 AND source_id=$2', [slug, sourceId]);
  calls = [];
  await write(markdown(-1, '项目进展', 'other'));
  expect(calls).toEqual([]);
  await engine.setConfig('search.mode', 'balanced');
  await write(markdown(-1, '项目进展', 'wrapped'));
  expect(calls.flat()).toHaveLength((await engine.getChunks(slug, { sourceId })).length);
});

test('embedding failures preserve the previously committed page and vectors', async () => {
  await write(markdown());
  const before = await vectors();
  const page = await engine.getPage(slug, { sourceId });
  failEmbedding = true;
  await expect(write(markdown(3))).rejects.toThrow();
  expect(await vectors()).toEqual(before);
  expect((await engine.getPage(slug, { sourceId }))?.compiled_truth).toBe(page?.compiled_truth);
});

test('a writer without input provenance clears the receipt when replacing the vector', async () => {
  await write(markdown());
  const chunks = await engine.getChunks(slug, { sourceId });
  await engine.upsertChunks(slug, chunks.map(chunk => ({ chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text,
    chunk_source: chunk.chunk_source, embedding: new Float32Array(dimensions).fill(0.7), model })), { sourceId });
  expect((await vectors()).every(row => row.embedding_input_hash === null)).toBe(true);
});

test('duplicate text consumes one matching stored vector and never crosses chunk sources', () => {
  const old: Chunk = { id: 1, page_id: 1, chunk_index: 8, chunk_text: 'same', chunk_source: 'compiled_truth',
    embedding: new Float32Array(dimensions).fill(0.1), model, token_count: 1, embedded_at: new Date(),
    embedding_input_hash: markdownEmbeddingInputHash(model, dimensions, 'none', 'same') };
  const planned: ChunkInput[] = [
    { chunk_index: 0, chunk_text: 'same', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'same', chunk_source: 'compiled_truth' },
    { chunk_index: 2, chunk_text: 'same', chunk_source: 'timeline' },
  ];
  expect(reuseMarkdownEmbeddings(planned, [old], ['same', 'same', 'same'], model, dimensions, 'none', 'none'))
    .toEqual({ reused: 1, pending: [1, 2] });
  expect(reuseMarkdownEmbeddings(planned, [{ ...old, embedded_text_hash: 'stale' }], ['same', 'same', 'same'], model, dimensions, 'none', 'none'))
    .toEqual({ reused: 0, pending: [0, 1, 2] });
});

test('an unfinished page manifest cannot supply reusable vectors', async () => {
  await write(markdown());
  await engine.executeRaw('UPDATE pages SET chunker_version=-3 WHERE slug=$1 AND source_id=$2', [slug, sourceId]);
  calls = [];
  await write(markdown(-1, '项目进展', 'changed'));
  expect(calls.flat()).toHaveLength((await engine.getChunks(slug, { sourceId })).length);
});

test('the additive migration preserves legacy content, vectors and NULL provenance', async () => {
  await write(markdown());
  const before = await vectors();
  const page = await engine.getPage(slug, { sourceId });
  const migration = MIGRATIONS.find(item => item.name === 'markdown_embedding_input_provenance')!;
  await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_input_hash');
  await engine.executeRaw(migration.sql);
  await engine.executeRaw(migration.sql);
  expect(await vectors()).toEqual(before.map(row => ({ ...row, embedding_input_hash: null })));
  expect((await engine.getPage(slug, { sourceId }))?.compiled_truth).toBe(page?.compiled_truth);
});

test('reopening storage retains reuse receipts and the additive migration does not backfill', async () => {
  const migration = MIGRATIONS.find(item => item.name === 'markdown_embedding_input_provenance');
  expect(migration?.sql).toContain('ADD COLUMN IF NOT EXISTS embedding_input_hash TEXT');
  expect(migration?.sql).not.toMatch(/UPDATE|DELETE|DROP/i);
  expect(migration?.handler).toBeUndefined();
  await write(markdown());
  await engine.disconnect();
  await engine.connect(databaseUrl ? { database_url: databaseUrl } : { database_path: join(root, 'brain.pglite') });
  calls = [];
  await write(markdown(-1, '项目进展', 'reopened'));
  expect(calls).toEqual([]);
  expect((await vectors()).every(row => row.embedding_input_hash)).toBe(true);
}, 60_000);

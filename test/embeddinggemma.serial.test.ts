/**
 * #5215: pin the actual embedding inputs, not just provider input_type.
 * Dropping the recipe formatter or page-title passthrough breaks these tests.
 * Existing asymmetric tests cover flags, but not model prompts or title data.
 * Uses the existing gateway transport and real PGLite; no new test-only seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { configureGateway, resetGateway, embed, embedQuery, __setEmbedTransportForTests, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { embedBatch } from '../src/core/embedding.ts';
import { embedBatchWithBackoff } from '../src/core/embed-retry.ts';
import { embedStaleForSource, embedStalePages } from '../src/core/embed-stale.ts';
import { importFromContent, importCodeFile } from '../src/core/import-file.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { reembedPageWithContextualRetrieval } from '../src/core/contextual-retrieval-service.ts';
import { reindexCodeProjection } from '../src/core/persistence/projection-reindex.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { embedRequestCeilings } from '../src/core/ai/embed-batch-plan.ts';
import { formatEmbeddingInput } from '../src/core/ai/model-resolver.ts';
import { runRepair, resolveRepairScope } from '../src/core/repair/core.ts';
import { contextualModeRepair } from '../src/core/repair/contextual-mode.ts';

const MODEL = 'ollama:embeddinggemma:latest';
const DIMS = 768;
let engine: PGLiteEngine;
let sent: string[][] = [];

function configure(model = MODEL, env: Record<string, string> = {}) {
  configureGateway({ embedding_model: model, embedding_dimensions: DIMS, env });
}
function response(values: string[], dims = DIMS) {
  return { values, embeddings: values.map(() => new Array<number>(dims).fill(0.1)), usage: { tokens: values.length }, warnings: [] };
}
function transport() {
  __setEmbedTransportForTests(async args => { sent.push([...args.values]); return response(args.values); });
}

beforeAll(async () => {
  configure();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); resetGateway(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw("UPDATE sources SET contextual_retrieval_mode='none' WHERE id='default'");
  configure(); sent = []; transport();
});
afterEach(() => { __setEmbedTransportForTests(null); __setChatTransportForTests(null); resetGateway(); });

const document = (title: string, text: string) => `title: ${title} | text: ${text}`;
async function imported(slug = 'notes/gemma', title = 'Real metadata title', noEmbed = false) {
  await importFromContent(engine, slug, `---\ntitle: ${title}\n---\n\nAnonymous body without a title.`, { noEmbed });
  return (await engine.getChunks(slug)).map(c => c.chunk_text);
}
async function clearVectors(slug: string) {
  await engine.executeRaw('UPDATE content_chunks SET embedding=NULL WHERE page_id=(SELECT id FROM pages WHERE slug=$1)', [slug]);
  sent = [];
}

test('EmbeddingGemma prompts reach the Ollama HTTP endpoint exactly', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json(); requests.push(body);
    const values = body.input as string[];
    return Response.json({ object: 'list', model: body.model,
      data: values.map((_, index) => ({ object: 'embedding', index, embedding: new Array(DIMS).fill(0.1) })),
      usage: { prompt_tokens: values.length, total_tokens: values.length } });
  } });
  try {
    __setEmbedTransportForTests(null);
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: {},
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
    await embedQuery('find this');
    await embed(['anonymous body'], { documentTitle: 'Page title' });
    expect(requests.map(r => r.input)).toEqual([
      ['task: search result | query: find this'], [document('Page title', 'anonymous body')],
    ]);
    expect(requests.map(r => r.model)).toEqual(['embeddinggemma:latest', 'embeddinggemma:latest']);
  } finally { server.stop(true); }
});

test('bare model, default document role and missing title use the documented format', async () => {
  configure('ollama:embeddinggemma');
  await embed(['body']);
  expect(sent).toEqual([[document('none', 'body')]]);
});

test('accepted model spellings share formatting and request ceilings with the gateway', async () => {
  for (const model of [MODEL, ' Ollama : embeddinggemma:latest ', 'Ollama/embeddinggemma']) {
    configure(model); sent = [];
    await embed(['body'], { documentTitle: 'Metadata title' });
    const expected = document('Metadata title', 'body');
    expect(sent).toEqual([[expected]]);
    expect(formatEmbeddingInput('body', model, { documentTitle: 'Metadata title' })).toBe(expected);
    expect(embedRequestCeilings(['body'], model, undefined, { documentTitle: 'Metadata title' })).toEqual([Buffer.byteLength(expected)]);
  }
});

test('other Ollama models retain exact bytes with title metadata', async () => {
  configure('ollama:nomic-embed-text');
  await embedQuery('query'); await embed(['body'], { documentTitle: 'Title' });
  expect(sent).toEqual([['query'], ['body']]);
});

test('Voyage retains asymmetric flags and raw input with title metadata', async () => {
  configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'synthetic-key' } });
  const options: unknown[] = [];
  __setEmbedTransportForTests(async args => { sent.push(args.values); options.push(args.providerOptions); return response(args.values, 1024); });
  await embedQuery('query'); await embed(['body'], { inputType: 'document', documentTitle: 'Title' });
  expect(sent).toEqual([['query'], ['body']]);
  expect(options).toEqual([
    { openaiCompatible: { dimensions: 1024, input_type: 'query' } },
    { openaiCompatible: { dimensions: 1024, input_type: 'document' } },
  ]);
});

test('formatting precedes truncation and token batching, and recursive splits do not repeat it', async () => {
  configure(MODEL, { GBRAIN_EMBED_MAX_BATCH_TOKENS: '20' });
  await embed(['x'.repeat(8100)], { documentTitle: 'Title' });
  expect(sent).toEqual([[document('Title', 'x'.repeat(8100)).slice(0, 8000)]]);
  sent = [];
  await embed(['a'.repeat(30), 'b'.repeat(30)], { documentTitle: 'Title' });
  expect(sent).toEqual([[document('Title', 'a'.repeat(30))], [document('Title', 'b'.repeat(30))]]);
  configure(); sent = [];
  __setEmbedTransportForTests(async args => {
    sent.push([...args.values]);
    if (args.values.length > 1) throw new Error('token limit exceeded');
    return response(args.values);
  });
  await embed(['a', 'b'], { documentTitle: 'Title' });
  expect(sent).toEqual([[document('Title', 'a'), document('Title', 'b')], [document('Title', 'a')], [document('Title', 'b')]]);
});

test('progress slices and wrapper retries preserve title and format once', async () => {
  const texts = Array.from({ length: 101 }, (_, i) => `chunk ${i}`);
  await embedBatch(texts, { documentTitle: 'Batch title', onBatchComplete() {} });
  expect(sent.flat()).toEqual(texts.map(t => document('Batch title', t)));
  sent = [];
  __setEmbedTransportForTests(async args => {
    sent.push([...args.values]);
    if (sent.length === 1) throw new Error('ECONNRESET');
    return response(args.values);
  });
  await embedBatchWithBackoff(['body'], { documentTitle: 'Retry title' });
  expect(sent).toEqual([[document('Retry title', 'body')], [document('Retry title', 'body')]]);
});

test('empty input still refuses without sending a prompt-only document', async () => {
  await expect(embed(['  '], { documentTitle: 'Title' })).rejects.toMatchObject({ code: 'embedding_zero_norm' });
  expect(sent).toEqual([]);
});

test('Markdown ingestion passes real title, keeps canonical chunks and re-embeds a title edit', async () => {
  const chunks = await imported();
  expect(sent.flat()).toEqual(chunks.map(t => document('Real metadata title', t)));
  sent = [];
  await imported('notes/gemma', 'Replacement metadata title');
  expect(sent.flat()).toEqual(chunks.map(t => document('Replacement metadata title', t)));
});

test('imports do not reuse unformatted legacy vectors with missing provenance', async () => {
  const content = `---\ntitle: Legacy title\n---\n\n## First\n${'alpha '.repeat(800)}\n\n## Last\n${'omega '.repeat(800)}`;
  await importFromContent(engine, 'notes/legacy', content);
  const chunks = (await engine.getChunks('notes/legacy')).map(c => c.chunk_text);
  await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=(SELECT id FROM pages WHERE slug=$1)', ['notes/legacy']);
  sent = [];
  await importFromContent(engine, 'notes/legacy', `${content}\n\nExtra paragraph.`);
  expect(sent.flat()).toContain(document('Legacy title', chunks[0]));
});

test('background source and explicit-page stale embedding retain title', async () => {
  const chunks = await imported('notes/stale', 'Stale title', true);
  expect((await embedStaleForSource(engine, 'default')).embedded).toBe(chunks.length);
  expect(sent.flat()).toEqual(chunks.map(t => document('Stale title', t)));
  await clearVectors('notes/stale');
  expect((await embedStalePages(engine, ['notes/stale'], 'default')).embedded).toBe(chunks.length);
  expect(sent.flat()).toEqual(chunks.map(t => document('Stale title', t)));
});

test('contextual-mode repair clears legacy unformatted vectors even when contextual retrieval is off', async () => {
  const chunks = await imported('notes/repair', 'Repair title');
  await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL WHERE slug=$1', ['notes/repair']);
  await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=(SELECT id FROM pages WHERE slug=$1)', ['notes/repair']);
  sent = [];
  await runRepair({ engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } }, contextualModeRepair, await resolveRepairScope(engine), { apply: true, embed: true, embeddingModel: MODEL });
  expect(sent.flat()).toEqual(chunks.map(t => document('Repair title', t)));
});

for (const opts of [{ stale: true }, { all: true }, { slug: 'notes/manual' }]) test(`manual embedding ${JSON.stringify(opts)} retains title`, async () => {
  const chunks = await imported('notes/manual', 'Manual title', true);
  expect((await runEmbedCore(engine, { ...opts, quiet: true, catchUp: true })).embedded).toBe(chunks.length);
  expect(sent.flat()).toEqual(chunks.map(t => document('Manual title', t)));
});

for (const mode of ['title', 'per_chunk_synopsis'] as const) test(`contextual reindex ${mode} retains explicit title`, async () => {
  await imported('notes/contextual', 'Contextual title', true);
  await engine.executeRaw('UPDATE sources SET contextual_retrieval_mode=$1 WHERE id=\'default\'', [mode]);
  __setChatTransportForTests(async () => ({ text: 'Synthetic synopsis.', blocks: [], stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'openai:gpt-4o-mini', providerId: 'openai' }));
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, chat_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'synthetic-key' } });
  expect((await reembedPageWithContextualRetrieval({ engine, pageSlug: 'notes/contextual', sourceId: 'default', globalMode: mode,
    synopsisModel: 'openai:gpt-4o-mini' })).kind).toBe('success');
  expect(sent.flat()).toHaveLength(1);
  expect(sent[0][0]).toBe(document('Contextual title', `<context>Contextual title\n${mode === 'per_chunk_synopsis' ? 'Synthetic synopsis.\n' : ''}</context>\nAnonymous body without a title.`));
});

test('code import and projection reindex pass the stored page title for fenced code', async () => {
    const result = await importCodeFile(engine, 'example.ts', 'export function example() { return 1; }\n');
    const page = (await engine.getPage(result.slug))!;
    const chunks = await engine.getChunks(result.slug);
    expect(sent.flat()).toEqual(chunks.map(c => document(page.title, c.chunk_text)));
    await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash=NULL WHERE page_id=$1', [page.id]);
    sent = [];
    await importCodeFile(engine, 'example.ts', 'export function example() { return 1; }\n', { force: true });
    expect(sent.flat()).toEqual(chunks.map(c => document(page.title, c.chunk_text)));
    for (let i = 0; i < 2; i++) {
      sent = [];
      await importCodeFile(engine, 'example.ts', 'export function example() { return 1; }\n', { force: true });
      expect(sent).toEqual([]);
      expect((await engine.executeRaw<{ h: string | null }>('SELECT embedding_input_hash AS h FROM content_chunks WHERE page_id=$1', [page.id])).every(c => c.h !== null)).toBe(true);
    }
    await clearVectors(result.slug);
    await reindexCodeProjection(engine, result.slug, 'default', { force: true });
    expect(sent.flat()).toEqual(chunks.map(c => document(page.title, c.chunk_text)));
});

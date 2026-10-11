/**
 * Import-time EmbeddingGemma document formatting.
 *
 * This protects the observable Ollama request and stored import projection when
 * Markdown metadata has a title. It fails if importFromContent stops passing
 * the parsed title, which the formatter and provenance tests cannot catch at
 * their lower boundaries. Existing stale-import coverage exercises a different
 * caller, so this runs the real gateway against loopback Ollama-compatible HTTP.
 * No production-only seam is needed. The contract is exact request formatting;
 * the credible regression is dropping documentTitle at the Markdown caller;
 * formatter and stale-caller tests do not cover this boundary; no new seam is used.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { embeddingInputHash } from '../src/core/embedding-input-hash.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

const DIMS = 1536;
const MODEL = 'ollama:embeddinggemma:latest';
const MODEL_ID = 'embeddinggemma:latest';
const formatted = (title: string, text: string) => `title: ${title} | text: ${text}`;
const contextual = (title: string, text: string) => `<context>${title}\n</context>\n${text}`;
const importInput = (title: string, text: string) => formatted(title, contextual(title, text));
type RequestBody = { input: string[]; model: string };

let engine: PGLiteEngine;
let server: ReturnType<typeof Bun.serve>;
let requests: RequestBody[] = [];
let refuseFirst = false;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as RequestBody;
    requests.push(body);
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_, index) => ({ object: 'embedding', index,
        embedding: refuseFirst && index === 0 ? Array(DIMS).fill(0) : [1, ...Array(DIMS - 1).fill(0)] })),
      usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } });
  } });
}, 60_000);

beforeEach(async () => {
  requests = [];
  refuseFirst = false;
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
  server?.stop(true);
});

function capturedInputs(): string[] {
  return requests.flatMap(request => request.input);
}

function largePage(title: string, finalWord: string) {
  const paragraph = (word: string) => Array.from({ length: 400 }, (_, i) => `${word}${i}`).join(' ') + '.';
  return `---\ntype: note\ntitle: ${title}\n---\n\n` +
    ['alpha', 'bravo', finalWord].map(word => `## Section ${word}\n\n${paragraph(word)}`).join('\n\n');
}

async function stored(slug: string) {
  return engine.executeRaw<{ chunk_text: string; chunk_source: string | null; has_embedding: boolean; embedding_input_hash: string | null; embedding: string | null }>(
    `SELECT cc.chunk_text,cc.chunk_source,cc.embedding IS NOT NULL AS has_embedding,cc.embedding_input_hash,cc.embedding::text AS embedding
       FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
      WHERE p.source_id='default' AND p.slug=$1 ORDER BY cc.chunk_index`, [slug]);
}

describe('Markdown EmbeddingGemma import formatting', () => {
  test('sends the parsed title, preserves canonical chunks and stores matching proof', async () => {
    const slug = 'notes/document-title';
    const content = '---\ntype: note\ntitle: A real title\n---\n\nA synthetic body about alpine lakes.';
    await importFromContent(engine, slug, content);

    const rows = await stored(slug);
    expect(rows.length).toBeGreaterThan(0);
    expect(capturedInputs()).toEqual(rows.map(row => importInput('A real title', row.chunk_text)));
    expect(requests.map(request => request.model)).toEqual([MODEL_ID]);
    for (const row of rows) {
      expect(row.chunk_text).toContain('A synthetic body about alpine lakes.');
      expect(row.chunk_text).not.toContain('title: A real title');
      expect(row.has_embedding).toBe(true);
      expect(row.embedding_input_hash).toBe(embeddingInputHash({ column: 'embedding', model: MODEL,
        dimensions: DIMS, title: 'A real title', corpusGeneration: null, bodyHash: '' }, 'title', row));
    }
  });

  test('an import without an explicit title uses its parsed fallback and tagged EmbeddingGemma receives metadata', async () => {
    const untitled = await importFromContent(engine, 'notes/untitled', '---\ntype: note\ntitle: ""\n---\n\nA synthetic untitled body.');
    if (!untitled.parsedPage) throw new Error('import result omitted parsed metadata');
    const parsedTitle = untitled.parsedPage.title;
    expect(parsedTitle).toBe('Untitled');
    expect(capturedInputs()).toHaveLength(1);
    expect(capturedInputs()[0]).toBe(importInput(parsedTitle, (await stored('notes/untitled'))[0]!.chunk_text));
    expect(capturedInputs()[0]).toContain('A synthetic untitled body.');

    requests = [];
    await engine.setConfig('embedding_model', 'ollama:embeddinggemma:300m');
    configureGateway({ embedding_model: 'ollama:embeddinggemma:300m', embedding_dimensions: DIMS, env: {},
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
    await importFromContent(engine, 'notes/tagged', '---\ntype: note\ntitle: Tagged title\n---\n\nA tagged synthetic body.');
    expect(capturedInputs()).toEqual([importInput('Tagged title', (await stored('notes/tagged'))[0]!.chunk_text)]);
    expect(requests.map(request => request.model)).toEqual(['embeddinggemma:300m']);
  });

  test('a title edit invalidates vectors, while a body edit reuses unchanged proven chunks', async () => {
    const slug = 'notes/title-edit';
    const first = largePage('First title', 'charlie');
    await importFromContent(engine, slug, first);
    const before = await stored(slug);
    expect(before.length).toBeGreaterThanOrEqual(3);

    requests = [];
    await importFromContent(engine, slug, largePage('Second title', 'charlie'));
    const afterTitle = await stored(slug);
    expect(capturedInputs()).toEqual(afterTitle.map(row => importInput('Second title', row.chunk_text)));
    expect(afterTitle.map(row => row.embedding_input_hash)).not.toEqual(before.map(row => row.embedding_input_hash));

    requests = [];
    await importFromContent(engine, slug, largePage('Second title', 'delta'));
    const afterBody = await stored(slug);
    expect(capturedInputs().length).toBeGreaterThan(0);
    expect(capturedInputs().length).toBeLessThan(afterBody.length);
    expect(capturedInputs().every(input => input.includes('delta'))).toBe(true);
    expect(afterBody.filter(row => !capturedInputs().includes(importInput('Second title', row.chunk_text)))
      .every(row => row.has_embedding && row.embedding_input_hash !== null)).toBe(true);
  });

  test('unchanged content keeps valid legacy vectors without provider calls or v2 backfill', async () => {
    const slug = 'notes/unchanged-legacy';
    const content = '---\ntype: note\ntitle: Legacy title\n---\n\nA legacy body.';
    await importFromContent(engine, slug, content);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash=NULL
      WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug=$1)`, [slug]);
    const before = await stored(slug);
    expect(before.length).toBe(1);
    expect(before[0]!.has_embedding).toBe(true);

    requests = [];
    await importFromContent(engine, slug, content);

    expect(requests).toEqual([]);
    expect(await stored(slug)).toEqual(before);
  });

  test('other providers keep raw input and a partial zero-vector refusal preserves usable chunks', async () => {
    await engine.setConfig('embedding_model', 'ollama:nomic-embed-text');
    configureGateway({ embedding_model: 'ollama:nomic-embed-text', embedding_dimensions: DIMS, env: {},
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
    await importFromContent(engine, 'notes/unaffected', '---\ntype: note\ntitle: Ignored title\n---\n\nRaw provider body.');
    expect(capturedInputs()).toEqual([contextual('Ignored title', (await stored('notes/unaffected'))[0]!.chunk_text)]);

    requests = [];
    refuseFirst = true;
    await engine.setConfig('embedding_model', MODEL);
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: {},
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
    await importFromContent(engine, 'notes/refusal', largePage('Refusal title', 'delta'));
    const refused = await stored('notes/refusal');
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(refused.filter(row => row.has_embedding)).toHaveLength(refused.length - 1);
    expect(refused.filter(row => !row.has_embedding)).toHaveLength(1);
    expect(refused.filter(row => row.has_embedding).every(row => row.embedding_input_hash !== null)).toBe(true);
  });
});

import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'embeddinggemma:latest';
const PREFIX = 'task: search result | query: ';
const EXPECTED_MODEL_DIGEST = '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1';
const dataset = JSON.parse(readFileSync(new URL('./dataset.json', import.meta.url), 'utf8')) as {
  documents: Array<{ id: string; title: string; chunks: string[] }>;
  queries: Array<{ id: string; text: string }>;
};

test('runs a bounded wire-only A/B/C check against a fake local Ollama', async () => {
  const requests: Array<{ model: string; input: string[]; dimensions?: number; encoding_format?: string }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/tags') return Response.json({ models: [{
      name: MODEL, digest: EXPECTED_MODEL_DIGEST, size: 1_000_000,
      details: { quantization_level: 'Q4_K_M', embedding_length: 768 },
    }] });
    if (pathname === '/api/show') return Response.json({ model_info: { 'gemma.embedding_length': 768 } });
    if (pathname === '/api/ps') return Response.json({ models: [{
      name: MODEL, digest: EXPECTED_MODEL_DIGEST, size: 1_000_000, size_vram: 1_000_000,
    }] });
    if (pathname !== '/v1/embeddings') return new Response(null, { status: 404 });
    const body = await request.json() as { model: string; input: string[] | string; dimensions?: number; encoding_format?: string };
    const input = typeof body.input === 'string' ? [body.input] : body.input;
    requests.push({ model: body.model, input: [...input], dimensions: body.dimensions, encoding_format: body.encoding_format });
    return Response.json({ object: 'list', model: body.model,
      data: input.map((_, index) => ({ object: 'embedding', index, embedding: new Array(768).fill(0.1) })),
      usage: { prompt_tokens: input.length, total_tokens: input.length } });
  } });
  const root = mkdtempSync(join(tmpdir(), 'embeddinggemma-wire-check-'));
  const out = join(root, 'evidence');
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'run.ts'), '--endpoint', `http://127.0.0.1:${server.port}`, '--out', out], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, `${stdout}\n${stderr}`).toBe(0);

    const docInputs = dataset.documents.flatMap((document) => document.chunks.map((text) => ({ document, text })));
    const queryCount = dataset.queries.length * 3;
    let cursor = 0;
    expect(requests[cursor++]!.input).toEqual(['title: none | text: EmbeddingGemma evaluation warm primer.']);
    expect(requests.slice(cursor, cursor + docInputs.length).map((call) => call.input[0])).toEqual(docInputs.map(({ text }) => text));
    cursor += docInputs.length;
    expect(requests.slice(cursor, cursor + queryCount).map((call) => call.input[0])).toEqual(dataset.queries.flatMap(({ text }) => Array(3).fill(text)));
    cursor += queryCount;
    expect(requests.slice(cursor, cursor + queryCount).map((call) => call.input[0])).toEqual(dataset.queries.flatMap(({ text }) => Array(3).fill(PREFIX + text)));
    cursor += queryCount;
    expect(requests.slice(cursor, cursor + docInputs.length).map((call) => call.input[0])).toEqual(docInputs.map(({ document, text }) => `title: ${document.title} | text: ${text}`));
    cursor += docInputs.length;
    expect(requests.slice(cursor, cursor + queryCount).map((call) => call.input[0])).toEqual(dataset.queries.flatMap(({ text }) => Array(3).fill(PREFIX + text)));
    cursor += queryCount;
    expect(cursor).toBe(requests.length);
    expect(requests.every((call) => call.model === MODEL)).toBe(true);

    const evidenceText = readFileSync(join(out, 'evidence.json'), 'utf8');
    expect(evidenceText).not.toContain(`:${server.port}`);
    expect(evidenceText).not.toContain(root);
    const evidence = JSON.parse(evidenceText);
    expect(evidence.model.digestBefore).toBe(EXPECTED_MODEL_DIGEST);
    expect(evidence.model.digestAfter).toBe(EXPECTED_MODEL_DIGEST);
    expect(evidence.model.nativeEmbeddingLength).toBe(768);
    expect(evidence.arms.B.documentsReusedFromArm).toBe('A');
    expect(evidence.arms.B.reusedDocumentInputs).toHaveLength(docInputs.length);
    expect(evidence.arms.A.exactWireInputs.filter((call: { purpose: string }) => call.purpose === 'index')).toHaveLength(docInputs.length);
    expect(evidence.arms.B.exactWireInputs.filter((call: { purpose: string }) => call.purpose === 'index')).toHaveLength(0);
    expect(evidence.report.quality.A.primaryFirstRepeat.topK[0].queryCount).toBe(dataset.queries.length);
    expect(evidence.report.quality.A.repeated.pooledQueryRuns.topK[0].queryCount).toBe(queryCount);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

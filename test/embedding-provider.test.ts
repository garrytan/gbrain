import { afterEach, describe, expect, test } from 'bun:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempFiles: string[] = [];

afterEach(() => {
  for (const path of tempFiles.splice(0)) {
    try { unlinkSync(path); } catch { /* best effort cleanup */ }
  }
});

describe('OpenAI-compatible embedding providers', () => {
  test('sends 2560-dim Perplexity config to a local OpenAI-compatible endpoint', () => {
    const scriptPath = join(tmpdir(), `gbrain-embedding-provider-${Date.now()}-${Math.random().toString(16).slice(2)}.ts`);
    tempFiles.push(scriptPath);
    writeFileSync(scriptPath, `
      import { serve } from 'bun';
      import { embedBatch } from '${process.cwd()}/src/core/embedding.ts';

      const dimensions = 2560;
      let requestBody: any = null;
      let authorization = '';
      const server = serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname !== '/v1/embeddings') return new Response('not found', { status: 404 });
          authorization = req.headers.get('authorization') || '';
          requestBody = await req.json();
          const input = Array.isArray(requestBody.input) ? requestBody.input : [requestBody.input];
          return Response.json({
            object: 'list',
            data: input.map((_text: string, index: number) => ({
              object: 'embedding',
              index,
              embedding: Array.from({ length: dimensions }, (_unused, i) => (i === index ? 1 : 0)),
            })),
            model: requestBody.model,
            usage: { prompt_tokens: input.length, total_tokens: input.length },
          });
        },
      });

      process.env.GBRAIN_EMBEDDING_MODEL = 'pplx-embed-context-v1-4b';
      process.env.GBRAIN_EMBEDDING_DIMENSIONS = String(dimensions);
      process.env.GBRAIN_EMBEDDING_BASE_URL = \`http://127.0.0.1:\${server.port}/v1\`;
      process.env.PERPLEXITY_API_KEY = 'test-perplexity-key';
      delete process.env.GBRAIN_EMBEDDING_API_KEY;
      delete process.env.OPENAI_API_KEY;

      try {
        const embeddings = await embedBatch(['alpha', 'beta']);
        console.log(JSON.stringify({
          requestBody,
          authorization,
          length0: embeddings[0]?.length,
          length1: embeddings[1]?.length,
          isFloat32: embeddings[0] instanceof Float32Array,
        }));
      } finally {
        server.stop(true);
      }
    `);

    const result = Bun.spawnSync({
      cmd: ['bun', scriptPath],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });

    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    expect(stderr).toBe('');
    const parsed = JSON.parse(output);

    expect(parsed.requestBody.model).toBe('pplx-embed-context-v1-4b');
    expect(parsed.requestBody.dimensions).toBe(2560);
    expect(parsed.requestBody.encoding_format).toBe('float');
    expect(parsed.requestBody.input).toEqual(['alpha', 'beta']);
    expect(parsed.authorization).toBe('Bearer test-perplexity-key');
    expect(parsed.isFloat32).toBe(true);
    expect(parsed.length0).toBe(2560);
    expect(parsed.length1).toBe(2560);
  });
});

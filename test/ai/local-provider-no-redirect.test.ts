/**
 * A local model server that answers a request with a redirect does not move the caller's text to another host.
 * Real HTTP on loopback: `local` is the configured endpoint, `elsewhere` is where its 307 points.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { __setRerankTransportForTests, chat, configureGateway, embed, expand, rerank, resetGateway } from '../../src/core/ai/gateway.ts';

const TEXT = 'private note about the owner';
const embedding = { object: 'list', model: 'm', usage: { prompt_tokens: 1, total_tokens: 1 }, data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }] };
const ranked = { results: [{ index: 0, relevance_score: 0.9 }] };
const completion = { id: 'c', object: 'chat.completion', created: 1, model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] };
const body = (path: string) => Response.json(path.endsWith('/rerank') ? ranked : path.endsWith('/chat/completions') ? completion : embedding);

let received: string[] = [];
let redirected = 0;
let elsewhere: ReturnType<typeof Bun.serve>;
let local: ReturnType<typeof Bun.serve>;
let direct: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  elsewhere = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    received.push(await req.text());
    return body(new URL(req.url).pathname);
  } });
  local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    redirected++;
    return new Response(null, { status: 307, headers: { location: `${elsewhere.url.origin}${new URL(req.url).pathname}` } });
  } });
  direct = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => body(new URL(req.url).pathname) });
});
afterAll(() => { elsewhere.stop(true); local.stop(true); direct.stop(true); });
afterEach(() => { received = []; redirected = 0; resetGateway(); __setRerankTransportForTests(null); });

const base = (server: typeof local) => `${server.url.origin}/v1`;
const embedThrough = (recipe: string, server: typeof local) => {
  configureGateway({ embedding_model: `${recipe}:nomic-embed-text`, embedding_dimensions: 3, base_urls: { [recipe]: base(server) }, env: {} });
  return embed([TEXT]);
};
const rerankThrough = (server: typeof local) => {
  configureGateway({ reranker_model: 'llama-server-reranker:m', base_urls: { 'llama-server-reranker': base(server) }, env: {} });
  return rerank({ query: 'owner', documents: [TEXT] });
};

describe('local providers refuse a redirect', () => {
  for (const recipe of ['llama-server', 'ollama', 'lmstudio']) {
    test(`${recipe} embeddings stay at the configured endpoint`, async () => {
      const refused = await embedThrough(recipe, local).catch(error => error);
      expect(received.filter(text => text.includes(TEXT))).toEqual([]);
      // A wrong address does not get better on retry, and the error says what to change.
      expect(refused).toBeInstanceOf(AIConfigError);
      expect(refused.message).toContain('307 redirect');
      expect(refused.fix).toContain(`${recipe} base URL`);
      expect(redirected).toBe(1);
      expect(await embedThrough(recipe, direct)).toHaveLength(1);
    });
  }

  test('llama-server-reranker documents stay at the configured endpoint', async () => {
    await rerankThrough(local).catch(() => {});
    expect(received.filter(text => text.includes(TEXT))).toEqual([]);
    expect(await rerankThrough(direct)).toEqual([expect.objectContaining({ index: 0 })]);
  });

  for (const recipe of ['llama-server', 'ollama']) {
    test(`${recipe} chat stays at the configured endpoint`, async () => {
      const send = (server: typeof local) => {
        configureGateway({ chat_model: `${recipe}:m`, base_urls: { [recipe]: base(server) }, env: {} });
        return chat({ model: `${recipe}:m`, messages: [{ role: 'user', content: TEXT }], maxTokens: 10 });
      };
      const refused = await send(local).catch(error => error);
      expect(received.filter(text => text.includes(TEXT))).toEqual([]);
      expect(refused).toBeInstanceOf(AIConfigError);
      expect((await send(direct)).text).toBe('ok');
    });
  }

  test('ollama expansion stays at the configured endpoint', async () => {
    configureGateway({ expansion_model: 'ollama:m', base_urls: { ollama: base(local) }, env: {} });
    await expand(TEXT).catch(() => {});
    expect(received.filter(text => text.includes(TEXT))).toEqual([]);
  });
});

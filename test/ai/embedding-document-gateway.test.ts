import { afterEach, expect, test } from 'bun:test';
import { configureGateway, embed, embedQuery, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { embedRequestCeilings } from '../../src/core/ai/embed-batch-plan.ts';

const MODEL = 'ollama:embeddinggemma:latest';
const DIMS = 768;
const doc = (title: string, text: string) => `title: ${title} | text: ${text}`;

function configure(model = MODEL, env: Record<string, string> = {}) {
  configureGateway({ embedding_model: model, embedding_dimensions: DIMS, env });
}

function result(values: string[]) {
  return { values, embeddings: values.map(() => new Array(DIMS).fill(0.1)), usage: { tokens: values.length }, warnings: [] };
}

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

test('sends exact titled and untitled documents, and query prefixes only when configured', async () => {
  const requests: { input: string[]; model: string }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { input: string[]; model: string };
    requests.push(body);
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_, index) => ({ object: 'embedding', index, embedding: new Array(DIMS).fill(0.1) })),
      usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } });
  } });
  try {
    configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: {},
      base_urls: { ollama: `http://127.0.0.1:${server.port}/v1` } });
    await embed(['body'], { documentTitle: 'A real title' });
    await embed(['body']);
    await embedQuery('find this');
    await embedQuery('find this', { queryPrefix: 'task: search result | query: ' });
    await embedQuery('find this', { queryPrefix: 'custom: ' });
    expect(requests.map(({ input }) => input)).toEqual([
      [doc('A real title', 'body')], [doc('none', 'body')],
      ['find this'], ['task: search result | query: find this'], ['custom: find this'],
    ]);
    expect(requests.map(({ model }) => model)).toEqual(Array(5).fill('embeddinggemma:latest'));
  } finally { server.stop(true); }
});

test('formats before truncation, token and item splitting, retry, and request ceilings', async () => {
  configure(MODEL, { GBRAIN_EMBED_MAX_BATCH_TOKENS: '20' });
  const sent: string[][] = [];
  __setEmbedTransportForTests(async args => {
    const values = args.values;
    sent.push([...values]);
    return result(values);
  });
  await embed(['x'.repeat(8100)], { documentTitle: 'T' });
  expect(sent).toEqual([[doc('T', 'x'.repeat(8100)).slice(0, 8000)]]);

  sent.length = 0;
  await embed(['a'.repeat(30), 'b'.repeat(30)], { documentTitle: 'T' });
  const prepared = [doc('T', 'a'.repeat(30)), doc('T', 'b'.repeat(30))];
  expect(sent).toEqual(prepared.map(text => [text]));
  expect(embedRequestCeilings(['a'.repeat(30), 'b'.repeat(30)], MODEL, 20, { documentTitle: 'T' }))
    .toEqual(prepared.map(text => Buffer.byteLength(text)));

  configure();
  sent.length = 0;
  await embed(Array.from({ length: 17 }, (_, index) => `chunk ${index}`), { documentTitle: 'T' });
  expect(sent.map(batch => batch.length)).toEqual([16, 1]);
  expect(sent.flat()).toEqual(Array.from({ length: 17 }, (_, index) => doc('T', `chunk ${index}`)));

  configure();
  sent.length = 0;
  __setEmbedTransportForTests(async args => {
    const values = args.values;
    sent.push([...values]);
    if (values.length > 1) throw new Error('token limit exceeded');
    return result(values);
  });
  await embed(['a', 'b'], { documentTitle: 'T' });
  expect(sent).toEqual([[doc('T', 'a'), doc('T', 'b')], [doc('T', 'a')], [doc('T', 'b')]]);
});

test('keeps other providers unchanged and preserves empty and invalid-vector refusals', async () => {
  configure('ollama:nomic-embed-text');
  const sent: string[][] = [];
  __setEmbedTransportForTests(async args => {
    const values = args.values;
    sent.push([...values]);
    return result(values);
  });
  await embed(['body'], { documentTitle: 'Title' });
  expect(sent).toEqual([['body']]);

  configure(MODEL);
  sent.length = 0;
  await expect(embed(['  '], { documentTitle: 'Title' })).rejects.toMatchObject({ code: 'embedding_zero_norm' });
  expect(sent).toEqual([]);

  await expect(embed(['first', null, 'third'] as unknown as string[], { documentTitle: 'Title' }))
    .rejects.toMatchObject({ code: 'embedding_zero_norm', failures: [{ index: 1, reason: 'empty_input' }] });
  expect(sent).toEqual([[doc('Title', 'first'), doc('Title', 'third')]]);

  __setEmbedTransportForTests(async args => ({
    values: args.values,
    embeddings: args.values.map((_, index) => index ? new Array(DIMS).fill(Number.POSITIVE_INFINITY) : new Array(DIMS).fill(0)),
    usage: { tokens: args.values.length },
    warnings: [],
  }));
  await expect(embed(['first', 'second'], { documentTitle: 'Title' })).rejects.toMatchObject({
    code: 'embedding_zero_norm', failures: [
      { index: 0, reason: 'zero_norm' }, { index: 1, reason: 'non_finite' },
    ],
  });

  configureGateway({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: 'synthetic-key' } });
  sent.length = 0;
  __setEmbedTransportForTests(async args => {
    sent.push([...args.values]);
    return { values: args.values, embeddings: args.values.map(() => new Array(1024).fill(0.1)), usage: { tokens: args.values.length }, warnings: [] };
  });
  await embed(['body'], { documentTitle: 'Title' });
  expect(sent).toEqual([['body']]);
});

/**
 * GBRA-200 (harness ask 6): every degraded reply carries the stamp on the
 * real paths. Drives dispatchToolCall (the one path stdio and HTTP share) on a
 * PGLite brain with the embedding provider mocked: down (EMBEDFAIL), timing
 * out (EMBEDTIMEOUT) or healthy; forces the keyword rank bound through the
 * engine's `onKeywordIncomplete` signal; and checks a keyless brain whose
 * `degraded_recall` notice is deduped still stamps every call. The happy path
 * carries no stamp.
 *
 * recall and think dropped their page search's stages before this change
 * (recall: a timed-out embed answered keyword-only with no stamp at all).
 *
 * Serial: mock.module (embedding) and gateway / GBRAIN_HOME mutation.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  let norm = 0;
  for (let i = 0; i < 1536; i++) { arr[i] = Math.sin(1 + i * 0.001); norm += arr[i] * arr[i]; }
  for (let i = 0; i < 1536; i++) arr[i] /= Math.sqrt(norm);
  return arr;
}

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async (text: string) => {
    if (String(text).includes('EMBEDTIMEOUT')) throw Object.assign(new Error('mock embed deadline'), { name: 'TimeoutError' });
    if (String(text).includes('EMBEDFAIL')) throw new Error('mock embed provider failure');
    return fixedEmbedding();
  },
}));

const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { NoticeLedger } = await import('../src/core/notice-ledger.ts');
const { DEGRADED_STAMP_PREFIX } = await import('../src/core/degraded-stamp.ts');

type Out = { content: Array<{ type: string; text: string }>; _meta?: Record<string, unknown>; isError?: boolean };

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedHome = process.env.GBRAIN_HOME;

const keyed = () => {
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' } });
};
const keyless = () => {
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
};

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-degraded-stamp-'));
  process.env.GBRAIN_HOME = tmpHome;
  keyed();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('search.reranker.enabled', 'false');
  for (const [slug, title, type] of [['alice-example', 'Alice Example', 'person'], ['acme-example', 'Acme Example', 'company']] as const) {
    const truth = `${title} is a builder working on degraded stamps.`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' }]);
  }
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const stdio = () => ({ remote: true, transport: 'stdio' as const, sourceId: 'default', noticeLedger: new NoticeLedger() });
const call = async (op: string, params: Record<string, unknown>, opts: Record<string, unknown> = stdio()) =>
  await dispatchToolCall(engine, op, params, opts as never) as Out;
const stampOf = (out: Out) => (out._meta?.degraded as { reasons: string[] } | undefined)?.reasons;
const stampBlocks = (out: Out) => out.content.filter(c => c.text.startsWith(DEGRADED_STAMP_PREFIX));

function expectStamped(out: Out, ...codes: string[]) {
  expect(out.isError).toBeFalsy();
  for (const code of codes) expect(stampOf(out)).toContain(code);
  const blocks = stampBlocks(out);
  expect(blocks).toHaveLength(1);
  expect(out.content[out.content.length - 1]).toBe(blocks[0]);
  for (const code of stampOf(out)!) expect(blocks[0]!.text).toContain(code);
}

function expectClean(out: Out) {
  expect(out.isError).toBeFalsy();
  expect(out._meta?.degraded).toBeUndefined();
  expect(stampBlocks(out)).toHaveLength(0);
}

describe('search and query', () => {
  test('happy path: no stamp', async () => {
    expectClean(await call('search', { query: 'builder' }));
  });

  test('provider down: embed_unavailable, content[0] stays the bare row array', async () => {
    const out = await call('search', { query: 'EMBEDFAIL builder' });
    expectStamped(out, 'embed_unavailable');
    expect(Array.isArray(JSON.parse(out.content[0]!.text))).toBe(true);
  });

  test('embedding timeout: embed_timeout on search and query', async () => {
    expectStamped(await call('search', { query: 'EMBEDTIMEOUT builder' }), 'embed_timeout');
    expectStamped(await call('query', { query: 'EMBEDTIMEOUT builder' }), 'embed_timeout');
  });

  test('the keyword rank bound stamps keyword_candidates_incomplete (hybrid and keyword-only)', async () => {
    const original = engine.searchKeyword.bind(engine);
    (engine as unknown as { searchKeyword: unknown }).searchKeyword = async (q: string, opts: { onKeywordIncomplete?: (r: 'candidate_budget') => void } = {}) => {
      opts.onKeywordIncomplete?.('candidate_budget');
      return original(q, opts as never);
    };
    try {
      expectStamped(await call('search', { query: 'builder' }), 'keyword_candidates_incomplete');
      await engine.setConfig('search.mcp_keyword_only', 'true');
      expectStamped(await call('search', { query: 'builder' }), 'keyword_candidates_incomplete');
    } finally {
      (engine as unknown as { searchKeyword: unknown }).searchKeyword = original;
      await engine.setConfig('search.mcp_keyword_only', 'false');
    }
    expectClean(await call('search', { query: 'builder' }));
  });
});

describe('recall', () => {
  test('happy path: no stamp and no retrieval meta', async () => {
    const out = await call('recall', { query: 'builder' });
    expectClean(out);
    expect(out._meta?.retrieval).toBeUndefined();
  });

  test('provider down or timing out: the page arm is stamped, never silent', async () => {
    const down = await call('recall', { query: 'EMBEDFAIL builder' });
    expectStamped(down, 'embed_unavailable');
    expect((down._meta?.retrieval as { degraded: Array<{ stage: string }> }).degraded.map(d => d.stage)).toContain('embed_unavailable');
    const slow = await call('recall', { query: 'EMBEDTIMEOUT builder' });
    expectStamped(slow, 'embed_timeout');
    expect(slow.content.some(c => c.text.startsWith('[gbrain notice degraded_recall'))).toBe(true);
  });
});

describe('think', () => {
  test('a degraded page search in the gather is stamped (GATHER_DEGRADED warning)', async () => {
    const out = await call('think', { question: 'EMBEDTIMEOUT who is a builder?' }, { ...stdio(), remote: false });
    expectStamped(out, 'embed_timeout');
    expect((JSON.parse(out.content[0]!.text) as { warnings: string[] }).warnings).toContain('GATHER_DEGRADED:embed_timeout');
  });
});

describe('traverse_graph', () => {
  test('a walk cut at its cap is stamped graph_walk_truncated; a complete walk is clean', async () => {
    expectClean(await call('traverse_graph', { slug: 'alice-example', depth: 2 }));
    const original = engine.traversePathsDetailed.bind(engine);
    (engine as unknown as { traversePathsDetailed: unknown }).traversePathsDetailed = async (...args: Parameters<typeof original>) =>
      ({ ...(await original(...args)), truncated: true });
    try {
      const out = await call('traverse_graph', { slug: 'alice-example', depth: 2 });
      expectStamped(out, 'graph_walk_truncated');
      expect(Array.isArray(JSON.parse(out.content[0]!.text))).toBe(true);
      expect(out.content.some(c => c.text.startsWith('[gbrain notice graph_walk_truncated kind=degraded]'))).toBe(true);
    } finally {
      (engine as unknown as { traversePathsDetailed: unknown }).traversePathsDetailed = original;
    }
  });
});

describe('keyless brain: the notice dedupes, the stamp does not', () => {
  test('every search is stamped embed_unavailable; the degraded_recall notice shows once per session', async () => {
    keyless();
    try {
      const opts = stdio();
      const first = await call('search', { query: 'builder' }, opts);
      const second = await call('search', { query: 'builder' }, opts);
      for (const out of [first, second]) expectStamped(out, 'embed_unavailable');
      const noticed = (out: Out) => out.content.some(c => c.text.startsWith('[gbrain notice degraded_recall'));
      expect(noticed(first)).toBe(true);
      expect(noticed(second)).toBe(false);
      const recall = await call('recall', { query: 'builder' }, opts);
      expectStamped(recall, 'embed_unavailable');
    } finally {
      keyed();
    }
  });
});

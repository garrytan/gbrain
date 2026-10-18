/**
 * #6590: recall `question` admits a fact on cosine similarity alone at fixed
 * floors (fact-relevance.ts) that no embedding model has measured, so on a
 * high-baseline embedder an unrelated question can clear them. The response
 * now says so: an informational `facts_calibration: { status: 'unmeasured',
 * model_key }` whenever the cosine arm ran on a model without measured
 * floors, plus one `facts_calibration_unmeasured` info notice per brain per
 * session whose fix is doctor `fact_admission_floors`. `facts_degraded` and
 * the degraded_recall notice are unchanged (MEMORY_VERBS v1 keeps its closed
 * `facts_degraded.reason` enum).
 *
 * PGLite in-memory; the embedder is a deterministic bag-of-words transport ($0).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { NoticeLedger } from '../src/core/notice-ledger.ts';
import { configureGateway, getEmbeddingModel, resetGateway, __setEmbedTransportForTests, __clearQueryEmbedCacheForTests } from '../src/core/ai/gateway.ts';
import { RESPONSE_SCHEMAS } from '../src/core/verbs.ts';
import { NOTICE_CODES } from '../src/core/error-registry.ts';
import { FACT_ADMISSION_FLOOR_EVIDENCE } from '../src/core/search/fact-relevance.ts';

const MODEL_KEY_RE = /^openai:text-embedding-3-large@\d+$/;
let engine: PGLiteEngine;
let dims = 1536;

function bagOfWords(text: string): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)) {
    let h = 0x811c9dc5;
    for (const ch of token) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % dims]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map(x => x / norm);
}

function keyed(): void {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-fake' } });
  __setEmbedTransportForTests((async (args: { values: string[] }) => ({ embeddings: args.values.map(bagOfWords) })) as never);
}

function keyless(): void {
  __setEmbedTransportForTests(null);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: {} });
}

type Res = Awaited<ReturnType<typeof dispatchToolCall>>;
const body = (res: Res) => JSON.parse(res.content[0]!.text) as Record<string, unknown>;
const codes = (res: Res) => ((res._meta?.gbrain_notices ?? []) as Array<{ code: string }>).map(n => n.code);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const [col] = await engine.executeRaw<{ dims: number }>(`SELECT a.atttypmod AS dims FROM pg_attribute a WHERE a.attrelid = to_regclass('facts') AND a.attname = 'embedding'`);
  dims = Number(col!.dims);
  keyed();
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice is a founder.' });
  const text = 'Alice Example drinks dark roast coffee every morning';
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, source, source_markdown_slug, embedding, embedding_model, embedded_text_hash, embedded_at)
     VALUES ('default', 'people/alice-example', $1, 'fact', 'world', now(), 'test', 'people/alice-example', $2::text::vector, $3, md5($1), now())`,
    [text, `[${bagOfWords(text).join(',')}]`, getEmbeddingModel()]);
}, 60_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine?.disconnect();
}, 60_000);

beforeEach(() => {
  __clearQueryEmbedCacheForTests();
  keyed();
});

describe('#6590 recall facts_calibration', () => {
  test('a question ranked by semantic matching on an unmeasured model carries facts_calibration; one notice per session', async () => {
    const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default', noticeLedger: new NoticeLedger() };
    const first = await dispatchToolCall(engine as never, 'recall', { question: 'Does Alice Example drink dark roast coffee?' }, opts);
    const firstBody = body(first);
    expect(firstBody.facts_order).toBe('relevance');
    expect((firstBody.facts as unknown[]).length).toBeGreaterThan(0);
    expect(firstBody.facts_calibration).toEqual({ status: 'unmeasured', model_key: expect.stringMatching(MODEL_KEY_RE) });
    expect(firstBody.facts_degraded).toBeUndefined();
    expect(codes(first)).toContain('facts_calibration_unmeasured');
    const block = first.content.find(c => c.text.startsWith('[gbrain notice facts_calibration_unmeasured kind=info]'));
    expect(block?.text).toContain('gbrain doctor --only fact_admission_floors --json');
    expect(FACT_ADMISSION_FLOOR_EVIDENCE[(firstBody.facts_calibration as { model_key: string }).model_key]).toBeUndefined();

    const second = await dispatchToolCall(engine as never, 'recall', { question: 'What coffee does Alice Example like?' }, opts);
    expect(body(second).facts_calibration).toEqual(firstBody.facts_calibration);
    expect(codes(second)).not.toContain('facts_calibration_unmeasured');
  }, 60_000);

  test('no semantic matching (keyless brain) means no facts_calibration; facts_degraded keeps its closed reason', async () => {
    keyless();
    const res = await dispatchToolCall(engine as never, 'recall', { question: 'Does Alice Example drink dark roast coffee?' },
      { remote: true, transport: 'stdio' as const, sourceId: 'default', noticeLedger: new NoticeLedger() });
    const out = body(res);
    expect(out.facts_calibration).toBeUndefined();
    expect((out.facts_degraded as { reason: string }).reason).toBe('keyword_only_no_embedding_provider');
    expect(codes(res)).not.toContain('facts_calibration_unmeasured');
  }, 60_000);

  test('a newest-first recall (no question) has no facts_calibration', async () => {
    const res = await dispatchToolCall(engine as never, 'recall', { entity: 'people/alice-example' },
      { remote: true, transport: 'stdio' as const, sourceId: 'default', noticeLedger: new NoticeLedger() });
    expect(body(res).facts_calibration).toBeUndefined();
  }, 60_000);

  test('the field is declared in the recall response schema and the notice code is registered', () => {
    const props = (RESPONSE_SCHEMAS.recall as { properties: Record<string, { properties?: Record<string, { enum?: string[] }> }> }).properties;
    expect(props.facts_calibration?.properties?.status?.enum).toEqual(['unmeasured']);
    expect(props.facts_calibration?.properties?.model_key).toBeDefined();
    expect((NOTICE_CODES as Record<string, { kind: string }>).facts_calibration_unmeasured?.kind).toBe('info');
  });
});

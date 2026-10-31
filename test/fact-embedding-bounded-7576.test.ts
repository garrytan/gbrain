// Protect explicit partial retrieval with byte-identical canonical text.
// Reverting the strategy rejects the option; existing refusal tests never opt in.
// Uses the existing provider transport seam; no new test-only production seam.
import { expect, test, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';
import { readFactsEmbeddingDim } from '../src/core/embedding-dim-check.ts';
import { estimateTokens } from '../src/core/chunkers/token-estimate.ts';
import { withEnv } from './helpers/with-env.ts';

test('explicit bounded prefix preserves full text, identity and ordinary vectors', async () => {
  const engine = new PGLiteEngine();
  const sourceId = 'bounded-facts';
  const model = 'openai:text-embedding-3-small';
  const full = 'Synthetic retrieval clause 🧪 漢字. '.repeat(120);
  const ordinary = 'A synthetic ordinary fact.';
  const calls: string[][] = [];
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [sourceId]);
    const dims = (await readFactsEmbeddingDim(engine)).dims!;
    await engine.setConfig('embedding_model', model);
    await engine.setConfig('embedding_dimensions', String(dims));
    configureGateway({ embedding_model: model, embedding_dimensions: dims, env: { OPENAI_API_KEY: 'test-key' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      calls.push([...values]);
      expect(values.every(value => estimateTokens(value) <= 64)).toBe(true);
      return { values, usage: { tokens: values.length }, warnings: [],
        embeddings: values.map(value => Array(dims).fill(value === ordinary ? 0.5 : 0.25)) };
    }) as never);
    for (const fact of [full, ordinary]) await engine.insertFact({ fact, kind: 'fact', confidence: 1,
      source: 'notes', visibility: 'world', notability: 'medium' }, { source_id: sourceId });
    await withEnv({ GBRAIN_MAX_CHUNK_TOKENS: '64' }, async () => {
      const options = { sourceId, yes: true, maxCostUsd: 1 };
      const initial = await embedStaleFacts(engine, options);
      expect(initial).toMatchObject({ embedded: 1, refused_oversized: 1, failures: 0 });
      const result = await embedStaleFacts(engine, { ...options, oversizedStrategy: 'bounded-prefix' });
      expect(result).toMatchObject({ embedded: 1, refused_oversized: 0, failures: 0, remaining: 0 });
      const rows = await engine.executeRaw<{ id: string; fact: string; embedding: string; current: boolean }>(
        `SELECT id::text, fact, embedding::text, embedding_model=$2 AND embedded_text_hash=md5(fact) AS current
         FROM facts WHERE source_id=$1 ORDER BY id`, [sourceId, model]);
      expect(Buffer.from(rows[0].fact)).toEqual(Buffer.from(full));
      expect(rows[1].fact).toBe(ordinary);
      expect(rows.every(row => row.current)).toBe(true);
      expect(JSON.parse(rows[0].embedding)).toEqual(Array(dims).fill(0.25));
      expect(JSON.parse(rows[1].embedding)).toEqual(Array(dims).fill(0.5));
      expect(calls[0]).toEqual([ordinary]);
      expect(calls[1]).toHaveLength(1);
      expect(full.startsWith(calls[1][0])).toBe(true);
      expect(calls[1][0].length).toBeGreaterThan(0);
      expect(calls[1][0].length).toBeLessThan(full.length);
      expect(log.mock.calls.flat().join('\n')).toContain(`fact ${rows[0].id}`);
      expect(log.mock.calls.flat().join('\n')).toContain('partial retrieval representation');
      const again = await embedStaleFacts(engine, { ...options, oversizedStrategy: 'bounded-prefix' });
      expect(again.embedded).toBe(0);
      expect(calls).toHaveLength(2);
    });
  } finally {
    log.mockRestore();
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  }
}, 30_000);

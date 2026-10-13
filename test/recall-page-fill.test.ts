/**
 * recall with `return_unit` and `budget_tokens` fills its budget.
 *
 * Protects: under facts_first (the default packing), delivery gets the budget
 * the facts leave, and recall's packer costs delivered blocks the way delivery
 * counted them, so no delivered block is dropped after the facts and
 * `budget_used` lands within one block-title of the budget. query_first still
 * hands delivery the whole budget.
 * Fails when: delivery is sized to the whole budget under facts_first (recall
 * then drops whole tail blocks), or recall re-costs delivered blocks with the
 * chars/4 heuristic while delivery counted cl100k (blocks dropped with no
 * facts at all). Before the fix: 7,426 of 8,000 with no facts, 7,740 with 40.
 * Seams: keyword-only (embeddings off), synthetic conversation pages and
 * facts; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { estimateTokens } from '../src/core/search/token-budget.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const BUDGET = 8000;
const turn = (i: number, k: number) => `user: about the garden trip ${i} turn ${k}, we talked about tomatoes and the hiking plan.\n`
  + `assistant: noted the garden trip detail ${k} for session ${i} and the weekend schedule.\n`;

for (const backend of testBackends()) {
  describe(`${backend}: recall page delivery fills budget_tokens`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => {};
    const ctx = () => ({ engine, config: { engine: backend, embedding_disabled: true }, remote: false, sourceId: 'default', dryRun: false,
      logger: { info() {}, warn() {}, error() {} }, emitResponseMeta() {} }) as unknown as OperationContext;
    const recall = (params: Record<string, unknown>) => operationsByName.recall.handler(ctx(), {
      question: 'What did I say about the garden trip?', query: 'garden trip tomatoes', limit: 100, budget_tokens: BUDGET, return_unit: 'page', ...params,
    }) as Promise<any>;

    beforeAll(async () => {
      if (backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      }
      for (let i = 0; i < 40; i++) {
        await submitPageMutation(ctx(), { operation: 'put_page', params: { slug: `chat/session-${i}`,
          content: `---\ntype: conversation\ntitle: Session ${i}\n---\n` + Array.from({ length: 10 + (i * 7) % 40 }, (_, k) => turn(i, k)).join('') } });
      }
    }, 180_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await close();
    });

    test('no facts: delivered blocks are costed as delivery counted them, none dropped', async () => {
      const out = await recall({ budget_policy: 'facts_first' });
      expect(out.facts).toEqual([]);
      expect(out.delivery.budget_tokens).toBe(BUDGET);
      expect(out.budget_packing.results.dropped).toBe(0);
      expect(out.budget_used).toBe(out.delivery.budget_used);
      expect(out.budget_used).toBeGreaterThan(BUDGET * 0.98);
      expect(out.budget_used).toBeLessThanOrEqual(BUDGET);
    });

    test('facts_first: delivery gets what the facts leave and the budget fills', async () => {
      for (let i = 0; i < 40; i++) {
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, created_at, source)
          VALUES ('default', NULL, $1, 'fact', 'world', now(), now(), 'test')`,
          [`The user mentioned the garden trip detail number ${i} about tomatoes and hiking on the weekend.`]);
      }
      for (const policy of ['facts_first', undefined]) {
        const out = await recall(policy ? { budget_policy: policy } : {});
        const factsUsed = out.facts.reduce((n: number, f: { fact: string }) => n + estimateTokens(f.fact), 0);
        expect(out.facts.length).toBe(40);
        expect(out.delivery.budget_tokens).toBe(BUDGET - factsUsed);
        expect(out.dropped_count).toBe(0);
        expect(out.budget_used).toBe(factsUsed + out.delivery.budget_used);
        expect(out.budget_used).toBeGreaterThan(BUDGET * 0.98);
        expect(out.budget_used).toBeLessThanOrEqual(BUDGET);
      }
    });

    test('query_first: delivery still gets the whole budget and facts take the rest', async () => {
      const out = await recall({ budget_policy: 'query_first' });
      expect(out.delivery.budget_tokens).toBe(BUDGET);
      expect(out.budget_packing.results.dropped).toBe(0);
      expect(out.budget_used).toBeLessThanOrEqual(BUDGET);
    });
  });
}

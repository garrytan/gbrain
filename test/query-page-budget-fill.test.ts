/**
 * `query` with return_unit page fills its token budget: the hit list is sized
 * to the budget (about one row per 250 tokens, at most 100) and autocut stays
 * off unless the caller sets it, so a page lane is not cut at the default row
 * count with half its budget unused. An explicit limit or autocut still wins.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { pagePlanHits, type EvidencePlan } from '../src/core/search/evidence-delivery.ts';

let engine: PGLiteEngine;
let meta: Record<string, any> | null = null;
const ctx = () => ({ engine, config: { engine: 'pglite', embedding_disabled: true }, remote: false, sourceId: 'default', dryRun: false,
  logger: { info() {}, warn() {}, error() {} }, emitResponseMeta: (k: string, v: unknown) => { if (k === 'retrieval') meta = v as Record<string, any>; } }) as unknown as OperationContext;
const query = operations.find(o => o.name === 'query')!;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < 40; i++) {
    await submitPageMutation(ctx(), { operation: 'put_page', params: { slug: `notes/garden-${i}`,
      content: `---\ntype: note\ntitle: Garden note ${i}\n---\nThe garden tomato harvest note ${i}. ` + 'We planted tomatoes and basil in the garden beds this season. '.repeat(20) } });
  }
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

describe('page-unit budget fill', () => {
  test('pagePlanHits: autocut off and rows sized to large budgets, for page plans only', () => {
    const plan = (unit: EvidencePlan['unit'], budgetTokens: number) => ({ requestedUnit: unit, unit, window: 1, budgetTokens, explicitUnit: true, budgetExplicit: true, packing: 'cap_only' }) as EvidencePlan;
    expect(pagePlanHits(null)).toEqual({});
    expect(pagePlanHits(plan('window', 8000))).toEqual({});
    expect(pagePlanHits(plan('page', 4000))).toEqual({ autocut: false });
    expect(pagePlanHits(plan('page', 8000))).toEqual({ autocut: false, limit: 32 });
    expect(pagePlanHits(plan('page', 100_000))).toEqual({ autocut: false, limit: 100 });
  });

  test('an 8k page lane delivers close to its budget; an explicit limit still caps it', async () => {
    const rows = await query.handler(ctx(), { query: 'garden tomato harvest', return_unit: 'page', token_budget: 8000, expand: false }) as unknown[];
    expect(rows.length).toBeGreaterThan(25);
    expect(meta!.delivery.tokens_delivered ?? meta!.delivery.budget_used).toBeGreaterThan(7000);
    const capped = await query.handler(ctx(), { query: 'garden tomato harvest', return_unit: 'page', token_budget: 8000, expand: false, limit: 10 }) as unknown[];
    expect(capped.length).toBeLessThanOrEqual(10);
  });
});

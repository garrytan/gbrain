/**
 * #1663 — CRAG gate behavior on the `query` op (hermetic PGLite, keyless:
 * the keyword-only fallback path). Pins:
 *   - the crag block rides the retrieval response meta on EVERY call
 *   - a slug-identity query grades strong end-to-end (exact-lookup tier)
 *   - weak + search.crag_escalation=true → one high-ceiling re-run
 *   - weak without the config → no re-run, hint only (default OFF)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import type { CragMetaBlock } from '../../src/core/search/crag.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function ctxWithMeta(): { ctx: OperationContext; meta: Record<string, unknown> } {
  const meta: Record<string, unknown> = {};
  const ctx = {
    engine,
    remote: false,
    sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; },
  } as unknown as OperationContext;
  return { ctx, meta };
}

function cragOf(meta: Record<string, unknown>): CragMetaBlock {
  const retrieval = meta.retrieval as { crag?: CragMetaBlock } | undefined;
  expect(retrieval).toBeDefined();
  expect(retrieval!.crag).toBeDefined();
  return retrieval!.crag!;
}

describe('query op — CRAG gate (#1663)', () => {
  test('crag block is attached on every call (grade + query shape)', async () => {
    await engine.putPage('notes/kelpie-workshop', {
      type: 'note', title: 'Kelpie Workshop', compiled_truth: 'A note about the kelpie workshop agenda.',
    });
    const { ctx, meta } = ctxWithMeta();
    await operationsByName.query.handler(ctx, { query: 'kelpie workshop agenda' });
    const crag = cragOf(meta);
    expect(['strong', 'moderate', 'weak']).toContain(crag.confidence);
    expect(['factual', 'open']).toContain(crag.query_shape);
    expect(typeof crag.reason).toBe('string');
  });

  test('slug-identity query grades strong end-to-end (exact-lookup tier through the op)', async () => {
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Founder of widget-co.',
    });
    const { ctx, meta } = ctxWithMeta();
    const results = (await operationsByName.query.handler(ctx, {
      query: 'people/alice-example',
    })) as Array<{ slug: string; exact_lookup?: string }>;
    expect(results[0]?.slug).toBe('people/alice-example');
    expect(results[0]?.exact_lookup).toBe('slug');
    const crag = cragOf(meta);
    expect(crag.confidence).toBe('strong');
    expect(crag.reason).toBe('exact_lookup');
  });

  test('weak result WITHOUT config: no escalation, think hint only (default OFF)', async () => {
    const { ctx, meta } = ctxWithMeta();
    await operationsByName.query.handler(ctx, { query: 'zxqv nonexistent quux' });
    const crag = cragOf(meta);
    expect(crag.confidence).toBe('weak');
    expect(crag.escalated).toBeUndefined();
    expect(crag.escalate_to_think).toBe(true);
  });

  test('weak result + search.crag_escalation=true: one high-ceiling re-run fires', async () => {
    await engine.setConfig('search.crag_escalation', 'true');
    const { ctx, meta } = ctxWithMeta();
    await operationsByName.query.handler(ctx, { query: 'zxqv nonexistent quux' });
    const crag = cragOf(meta);
    // Keyless corpus with no match: escalation ran and honestly stayed weak.
    expect(crag.escalated).toBe(true);
    expect(crag.escalated_confidence).toBe('weak');
    expect(crag.confidence).toBe('weak');
    expect(crag.escalate_to_think).toBe(true);
  }, 30000);

  test('escalation can rescue: identity page invisible to page-1 keyword rank still grades strong via the wide re-run', async () => {
    // Sanity-bound version: with the tier + escalation both on, a present
    // page keeps strong confidence and never regresses via the re-run.
    await engine.setConfig('search.crag_escalation', 'true');
    await engine.putPage('projects/mingtang', {
      type: 'note', title: 'The Mingtang', compiled_truth: 'Indoor amphitheater notes.',
    });
    const { ctx, meta } = ctxWithMeta();
    const results = (await operationsByName.query.handler(ctx, {
      query: 'projects/mingtang',
    })) as Array<{ slug: string }>;
    expect(results[0]?.slug).toBe('projects/mingtang');
    const crag = cragOf(meta);
    expect(crag.confidence).toBe('strong');
    expect(crag.escalated).toBeUndefined(); // strong first pass → no re-run
  });
});

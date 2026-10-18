/**
 * #6723: context_pack's pinned-question enrichment matches each accepted card
 * on (source_id, scope_entity), never on the slug alone.
 *
 * Protects: two granted sources each hold companies/acme-example and each has
 * its own published pin scoped to it; a pack for one source's entity carries
 * only that source's pin, a pack for both carries both, and an unqualified
 * name packs the home card with the home pin. Regression: the enrichment
 * compared pin.scope_entity with bare card slugs, so a federated pack showed
 * the other source's same-slug pin as if it were about this entity.
 * Synthetic data only; the model is a stub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { pinQuestion } from '../src/core/questions/service.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { ENTITY, MODEL, QUESTION, localCtx, logger, seedBrain, stubAnswer, type Seeded } from './helpers/pinned-questions-fixture.ts';
import type { QuestionChatFn } from '../src/core/questions/refresh.ts';

let engine: PGLiteEngine;
let a: Seeded, b: Seeded;
const pins: Record<string, string> = {};

const chat = (prefix: string): QuestionChatFn => async (req) =>
  ({ text: stubAnswer(req.user, { prefix }), usage: { input_tokens: 1000, output_tokens: 200 }, model: MODEL });

async function pack(params: Record<string, unknown>): Promise<{ pinned_questions?: Array<{ id: string; answer: string[] }> }> {
  const result = await dispatchToolCall(engine, 'context_pack', params, {
    remote: true, transport: 'stdio', sourceId: a.sourceId, config: { engine: engine.kind, embedding_disabled: true } as never, logger,
    auth: { token: 't', clientId: 'pq-agent', scopes: ['read', 'write'], sourceId: a.sourceId, allowedSources: [a.sourceId, b.sourceId] },
  });
  expect(result.isError ?? false).toBe(false);
  return JSON.parse((result.content[0] as { text: string }).text);
}
const ids = (p: Awaited<ReturnType<typeof pack>>) => (p.pinned_questions ?? []).map((q) => q.id).sort();

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  a = await seedBrain(engine);
  b = await seedBrain(engine);
  for (const [s, prefix] of [[a, ' A-SIDE'], [b, ' B-SIDE']] as const) {
    const out = await pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { entity: ENTITY } }, { chat: chat(prefix) });
    pins[s.sourceId] = out.receipt.id;
  }
  await engine.setConfig('search.remote_private_pages', 'visible');
  __resetPrivateVisibilityCacheForTests();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('#6723 context_pack pinned questions are matched per source', () => {
  test('each source-qualified card carries only its own source\'s pin', async () => {
    const onlyA = await pack({ entity_refs: [{ source_id: a.sourceId, slug: ENTITY }] });
    expect(ids(onlyA)).toEqual([pins[a.sourceId]]);
    expect(JSON.stringify(onlyA.pinned_questions)).toContain('A-SIDE');
    expect(JSON.stringify(onlyA.pinned_questions)).not.toContain('B-SIDE');

    const onlyB = await pack({ entity_refs: [{ source_id: b.sourceId, slug: ENTITY }] });
    expect(ids(onlyB)).toEqual([pins[b.sourceId]]);
    expect(JSON.stringify(onlyB.pinned_questions)).toContain('B-SIDE');
    expect(JSON.stringify(onlyB.pinned_questions)).not.toContain('A-SIDE');
  });

  test('both same-slug cards carry both pins; an unqualified name packs the home card with the home pin', async () => {
    const both = await pack({ entity_refs: [{ source_id: a.sourceId, slug: ENTITY }, { source_id: b.sourceId, slug: ENTITY }] });
    expect(ids(both)).toEqual([pins[a.sourceId], pins[b.sourceId]].sort());
    const home = await pack({ entities: ENTITY });
    expect(ids(home)).toEqual([pins[a.sourceId]]);
  });
});

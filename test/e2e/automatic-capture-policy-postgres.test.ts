/**
 * Protects the automatic policy's actual PostgreSQL writes and historical reads.
 * Regresses when either writer drops original temporal anchors or widens private
 * history. The existing managed parity suite does not enable this opt-in.
 * Uses existing isolated DB and gateway seams; no paid model calls.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { runFactsPipeline } from '../../src/core/facts/backstop.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';

let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
beforeAll(async () => { fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!); }, 120_000);
afterEach(async () => {
  await disposePersistenceConsumer(fixture.engine);
  __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
});
afterAll(async () => { await fixture?.close(); });

const observed = '2025-01-01T12:00:00Z', until = '2025-01-02T12:00:00Z';
const turn = `user (${observed}): Synthetic project uses a queue. Review is blocked until ${until}. Synthetic personal and prior-private details stay private.`;
for (const managed of [false, true]) test(`automatic capture PostgreSQL privacy, expiry and replay (${managed ? 'managed' : 'unmanaged'})`, async () => {
  const engine = fixture.engine, sourceId = managed ? 'capture-managed-example' : 'capture-unmanaged-example';
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources (id,name) VALUES ($1,$1)', [sourceId]);
  await engine.setConfig('facts.default_visibility', 'private');
  await engine.setConfig('facts.automatic_capture_policy', 'work_shared_expiring');
  await engine.setConfig('memory.auto_writeback', 'salient');
  await engine.setConfig('extraction.date_grounding', 'off');
  await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
  await engine.setConfig('embedding_dimensions', '1536');
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
  const candidate = (fact: string, capture_scope: string, capture_lifetime = 'durable', valid_until: string | null = null) => ({
    fact, entity: 'projects/sample', kind: 'fact', notability: 'high', confidence: 1, capture_scope, capture_lifetime,
    observed_at: observed, valid_until,
  });
  __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: [
    candidate('Synthetic project uses a queue.', 'work'),
    candidate('Synthetic personal detail.', 'personal'),
    candidate('Synthetic review is blocked.', 'work', 'temporary', until),
    candidate('Prior private detail.', 'work'),
    candidate('Undated temporary detail.', 'work', 'temporary'),
    candidate('One-shot approval.', 'work', 'omit'),
  ] }), blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }));
  await engine.putPage('projects/sample', { type: 'project', title: 'Sample', compiled_truth: 'Synthetic fixture.' }, { sourceId });
  const old = await engine.insertFact({ fact: 'Prior private detail.', entity_slug: 'projects/sample', visibility: 'private', source: 'synthetic:prior', valid_from: new Date(observed), valid_until: new Date(until) }, { source_id: sourceId });
  const before = await engine.executeRaw('SELECT * FROM facts WHERE id=$1', [old.id]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
  const ctx = { engine, sourceId, sessionId: 'synthetic-replay', source: 'sweep:corpus' as const, remote: false, turnAt: new Date('2026-01-01T12:00:00Z') };
  await runFactsPipeline(turn, ctx);
  const facts = await engine.executeRaw<{ id: number; fact: string; visibility: string; valid_from: Date; valid_until: Date | null }>('SELECT id,fact,visibility,valid_from,valid_until FROM facts WHERE source_id=$1 ORDER BY id', [sourceId]);
  expect(facts).toHaveLength(5);
  expect(facts.find(f => f.fact === 'Synthetic personal detail.')!.visibility).toBe('private');
  expect(facts.filter(f => f.fact === 'Prior private detail.').every(f => f.visibility === 'private')).toBe(true);
  const temporary = facts.find(f => f.fact === 'Synthetic review is blocked.')!;
  expect(temporary.valid_from.toISOString()).toBe(new Date(observed).toISOString());
  expect(temporary.valid_until!.toISOString()).toBe(new Date(until).toISOString());
  const recall = async (remote: boolean, include_expired = false) => JSON.parse((await dispatchToolCall(engine, 'recall', { limit: 50, include_expired }, { sourceId, remote })).content[0].text).facts;
  const shared = await recall(true);
  expect(shared).toHaveLength(1);
  expect(Number(shared[0].id)).toBe(Number(facts.find(f => f.fact === 'Synthetic project uses a queue.')!.id));
  expect(await recall(false)).toHaveLength(3);
  expect(await recall(false, true)).toHaveLength(5);
  if (managed) {
    const page = await engine.getPage('projects/sample', { sourceId });
    const row = parseFactsFence(page!.compiled_truth).facts.find(f => f.claim === temporary.fact)!;
    expect(new Date(row.validFrom!).toISOString()).toBe(new Date(observed).toISOString());
    expect(new Date(row.validUntil!).toISOString()).toBe(new Date(until).toISOString());
  }
  await runFactsPipeline(turn, { ...ctx, turnAt: new Date('2026-02-01T12:00:00Z') });
  const replay = await engine.executeRaw<{ valid_from: Date; valid_until: Date }>('SELECT valid_from,valid_until FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, temporary.fact]);
  expect(replay.length).toBeGreaterThan(0);
  expect(replay.every(f => f.valid_from.toISOString() === new Date(observed).toISOString() && f.valid_until.toISOString() === new Date(until).toISOString())).toBe(true);
  expect(await engine.executeRaw('SELECT * FROM facts WHERE id=$1', [old.id])).toEqual(before);
}, 60_000);

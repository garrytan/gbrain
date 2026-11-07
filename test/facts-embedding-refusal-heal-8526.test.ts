/**
 * #8526: a page-triggered facts batch refused `embedding_configuration` by a store whose consumer held a stale config
 * replayed the stored refusal forever once the store was repaired, because the batch is keyed by the page write. It now
 * walks follow-up batches. This is the split topology from the report: `worker` admits, the consumer (`store`) refuses,
 * and the worker cannot see that, so each attempt before the repair spends a follow-up.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { GBrainConfig } from '../src/core/config.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { prepareManagedFactsSession, publishManagedFacts, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { ManagedBrain } from './helpers/managed-brain.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const ORIGIN = 'notes/input', TARGET = 'companies/example', CLAIM = 'The example roadmap ships weekly.';
const MODEL = 'openai:text-embedding-3-small', DIMENSIONS = 1536;
/** The first run and four retries: one facts-absorb job (max_attempts 5). */
const JOB_RETRIES = 4;

/** A page write's facts batch, embedded under the brain's model and refused by a consumer started with embedding_disabled. */
async function refusedBatch({ engine, ctx }: ManagedBrain) {
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIMENSIONS));
  await engine.setConfig('embedding_disabled', 'false');
  const store = { ...ctx, config: { engine: engine.kind, embedding_disabled: true } };
  const requestId = randomUUID();
  for (const slug of [TARGET, ORIGIN]) {
    await submitPageMutation(store, { operation: 'put_page', params: {
      slug, content: `---\ntype: ${slug === TARGET ? 'company' : 'concept'}\ntitle: Example\n---\nAn example note for ${slug}.\n`,
      request_id: slug === ORIGIN ? requestId : randomUUID() } });
  }
  const snapshot = (await engine.readPageSnapshot(ORIGIN, { sourceId: 'default' }))!;
  const [write] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  const worker = { engine: engine.kind, embedding_disabled: false } as GBrainConfig;
  const backstop: FactsBackstopCtx = { engine, sourceId: 'default', source: 'mcp:put_page', sessionId: null, persistenceRequestId: write!.id, config: worker };
  const input = { turnText: snapshot.page.compiled_truth, pageSlug: ORIGIN };
  const session = (await prepareManagedFactsSession(backstop, input))!;
  session.embedding = { model: MODEL, dimensions: DIMENSIONS };
  const refused = await publishManagedFacts(engine, session, backstop, [{ fact: CLAIM, kind: 'fact', source: 'mcp:put_page', entity_slug: TARGET,
    confidence: 0.9, notability: 'high', embedding: new Float32Array([1, ...Array(DIMENSIONS - 1).fill(0)]) }], 'private', ORIGIN).catch(error => error);
  expect(refused.code).toBe('embedding_configuration');
  const retry = async () => resumeManagedFacts(engine, (await prepareManagedFactsSession(backstop, input))!);
  const repairStore = async () => { await disposePersistenceConsumer(engine); store.config.embedding_disabled = false; };
  return { retry, repairStore };
}

const refusal = (retry: () => Promise<unknown>) => retry().then(() => null, error => error.code);
const facts = (engine: ManagedBrain['engine']) => engine.executeRaw<{ fact: string; embedded: boolean }>(
  'SELECT fact, embedding IS NOT NULL AS embedded FROM facts WHERE fact=$1', [CLAIM]);
const receipts = (engine: ManagedBrain['engine']) => engine.executeRaw<{ request_id: string; state: string; error_code: string | null; error_message: string | null }>(
  "SELECT request_id, state, error_code, error_message FROM persistence_requests WHERE operation='extract_facts' AND slug=$1 ORDER BY sequence", [TARGET]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  // Value: protects=a job whose every attempt was refused by a stale store heals on its next retry after the repair, with no extraction;
  // fails_when=the walk is missing or keeps the three-retry limit of the file walk, which a stale store spends before the repair;
  // why_new=#7439 covers file refusals, which recheck in the worker and spend no follow-up while the cause stands; seam=the consumer
  // restart is dispose plus a changed config object; no_claim=does not run the facts-absorb job itself, which calls this same replay
  test(`#8526 [${backend}]: a batch refused by a stale store publishes its retained facts once the store is repaired`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { retry, repairStore } = await refusedBatch(brain);
    const original = (await receipts(engine))[0]!;
    expect(original).toMatchObject({ state: 'failed', error_code: 'embedding_configuration' });
    for (let attempt = 0; attempt < JOB_RETRIES; attempt++) expect(await refusal(retry)).toBe('embedding_configuration');
    expect(await facts(engine)).toEqual([]);
    await repairStore();
    expect(await retry()).toMatchObject({ inserted: 1 });
    expect(await facts(engine)).toEqual([{ fact: CLAIM, embedded: true }]);
    expect((await receipts(engine))[0]).toEqual(original);
    expect(await retry()).toMatchObject({ inserted: 1 });
    expect(await facts(engine)).toHaveLength(1);
  }, { databaseUrl }), 120_000);

  // Value: protects=vectors from one model never install under another: a real model change keeps the refusal and admits nothing;
  // fails_when=the walk skips the admission check; why_new=the replay contract covers an explicit request_id, which never walks;
  // seam=none; no_claim=a stale store with a real model change, which the consumer refuses the same way
  test(`#8526 [${backend}]: after a real model change a retry keeps the refusal and admits nothing`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { retry, repairStore } = await refusedBatch(brain);
    await repairStore();
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    const before = await receipts(engine);
    expect(await refusal(retry)).toBe('embedding_configuration');
    expect(await receipts(engine)).toEqual(before);
    expect(await facts(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  // Value: protects=a store that stays stale cannot grow the journal without end; fails_when=the limit is removed or a retry past it admits
  // another batch; why_new=the limit differs from the file walk; seam=none; no_claim=what the operator does next, which is a new request_id
  test(`#8526 [${backend}]: a store that stays stale stops at the follow-up limit`, () => managedBrain(async brain => {
    const { engine } = brain;
    const { retry } = await refusedBatch(brain);
    for (let attempt = 0; attempt < 12; attempt++) expect(await refusal(retry)).toBe('embedding_configuration');
    expect(await receipts(engine)).toHaveLength(11);
  }, { databaseUrl }), 120_000);
}

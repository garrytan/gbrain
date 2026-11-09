/**
 * #8526: a page-triggered facts batch that the write owner's consumer refused `embedding_configuration` (it ran with a
 * stale embedding config) replayed that stored refusal on every retry, even after the owner restarted with the repaired
 * config, because the batch is keyed by the page write. It now walks follow-up batches once an owner consumer has started
 * since the refusal; while the refusing consumer is still the one running, a retry spends no follow-up.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { GBrainConfig } from '../src/core/config.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { prepareManagedFactsSession, publishManagedFacts, resumeManagedFacts } from '../src/core/persistence/facts-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const ORIGIN = 'notes/input', TARGET = 'companies/acme-example', CLAIM = 'Acme Example ships its roadmap weekly.';
const MODEL = 'openai:text-embedding-3-small', DIMENSIONS = 1536;
const UNATTRIBUTED = 'The quarterly review moved to Thursdays.';
const vector = () => new Float32Array([1, ...Array(DIMENSIONS - 1).fill(0)]);
const fact = (claim: string, entity: string | null = null): ExtractedFact => ({ fact: claim, kind: 'fact', source: 'mcp:put_page', entity_slug: entity,
  confidence: 0.9, notability: 'high', embedding: vector() });

/**
 * The owner's consumer runs with ctx.config (embedding_disabled: true); the worker embeds under the brain's model and
 * publishes with `withdrawn: 'skip'`, as the backstop does.
 */
async function refusedBatch({ engine, ctx }: ManagedBrain, facts: ExtractedFact[] = [fact(CLAIM, TARGET)], visibility: 'private' | 'world' = 'private') {
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIMENSIONS));
  await engine.setConfig('embedding_disabled', 'false');
  const requestId = randomUUID();
  for (const slug of [TARGET, ORIGIN]) {
    await submitPageMutation(ctx, { operation: 'put_page', params: {
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
  const refused = await publishManagedFacts(engine, session, backstop, facts, visibility, ORIGIN, { withdrawn: 'skip' }).catch(error => error);
  expect(refused.code).toBe('embedding_configuration');
  return async () => resumeManagedFacts(engine, (await prepareManagedFactsSession(backstop, input))!);
}

/** A live heartbeat row for a consumer of the owner's host (or of `hostId`), started `startedAgoMs` ago. */
async function ownerConsumer(engine: ManagedBrain['engine'], startedAgoMs: number, opts: { mode?: string; kind?: string; hostId?: string } = {}) {
  await engine.executeRaw(`INSERT INTO persistence_consumers (host_id,pid,nonce,kind,mode,started_at,renewed_at,host_json_path,persistence_home,version)
    SELECT COALESCE($5::uuid, owner_host_id),4242,$1,$3,$4,now()-($2::integer*interval '1 millisecond'),now(),'/tmp/host.json','/tmp/home','test'
    FROM persistence_worktrees WHERE owner_host_id IS NOT NULL LIMIT 1`, [randomUUID(), startedAgoMs, opts.kind ?? 'serve', opts.mode ?? 'full', opts.hostId ?? null]);
}

/** The refusing consumer stops (its row lapses) and a repaired one starts. */
async function restartOwner({ engine, ctx }: ManagedBrain) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw("UPDATE persistence_consumers SET renewed_at=now()-interval '1 hour' WHERE started_at<now()-interval '1 second'");
  ctx.config.embedding_disabled = false;
  await ownerConsumer(engine, 0);
}

const code = (retry: () => Promise<unknown>) => retry().then(() => null, error => error.code);
const facts = (engine: ManagedBrain['engine'], claim = CLAIM) => engine.executeRaw<{ fact: string; embedded: boolean }>(
  'SELECT fact, embedding IS NOT NULL AS embedded FROM facts WHERE fact=$1', [claim]);
const receipts = (engine: ManagedBrain['engine']) => engine.executeRaw<{ request_id: string; state: string; error_code: string | null }>(
  "SELECT request_id, state, error_code FROM persistence_requests WHERE operation='extract_facts' AND slug=$1 ORDER BY sequence", [TARGET]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`#8526 [${backend}]: a refused batch spends nothing while the refusing owner runs, then publishes once the owner restarts repaired`, () => managedBrain(async brain => {
    const { engine } = brain;
    const retry = await refusedBatch(brain);
    await ownerConsumer(engine, 3_600_000);
    const original = await receipts(engine);
    expect(original).toMatchObject([{ state: 'failed', error_code: 'embedding_configuration' }]);
    for (let attempt = 0; attempt < 5; attempt++) expect(await code(retry)).toBe('embedding_configuration');
    await ownerConsumer(engine, 0, { kind: 'sync', mode: 'waiter_only' });
    expect(await code(retry)).toBe('embedding_configuration');
    expect(await receipts(engine)).toEqual(original);
    await restartOwner(brain);
    expect(await retry()).toMatchObject({ inserted: 1 });
    expect(await facts(engine)).toEqual([{ fact: CLAIM, embedded: true }]);
    expect((await receipts(engine))[0]).toEqual(original[0]!);
    expect(await retry()).toMatchObject({ inserted: 1 });
    expect(await facts(engine)).toHaveLength(1);
  }, { databaseUrl }), 120_000);

  test(`#8526 [${backend}]: after a real model change the retry keeps the refusal and admits nothing`, () => managedBrain(async brain => {
    const { engine } = brain;
    const retry = await refusedBatch(brain);
    await restartOwner(brain);
    await engine.setConfig('embedding_model', 'openai:text-embedding-3-large');
    const before = await receipts(engine);
    expect(await code(retry)).toBe('embedding_configuration');
    expect(await receipts(engine)).toEqual(before);
    expect(await facts(engine)).toEqual([]);
  }, { databaseUrl }), 120_000);

  test(`#8526 [${backend}]: a database-only batch (no worktree) waits on every live consumer of the brain`, () => managedBrain(async brain => {
    const { engine } = brain;
    await engine.setConfig('sync.write_through', 'false');
    const retry = await refusedBatch(brain);
    expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE operation='extract_facts' AND worktree_id IS NOT NULL")).toEqual([]);
    await ownerConsumer(engine, 3_600_000, { hostId: randomUUID() });
    const original = await receipts(engine);
    for (let attempt = 0; attempt < 4; attempt++) expect(await code(retry)).toBe('embedding_configuration');
    expect(await receipts(engine)).toEqual(original);
    await restartOwner(brain);
    expect(await retry()).toMatchObject({ inserted: 1 });
  }, { databaseUrl }), 120_000);

  test(`#8526 [${backend}]: a batch with an unattributed fact recovers too`, () => managedBrain(async brain => {
    const { engine } = brain;
    const retry = await refusedBatch(brain, [fact(CLAIM, TARGET), fact(UNATTRIBUTED)]);
    await restartOwner(brain);
    expect(await retry()).toMatchObject({ inserted: 2 });
    expect(await facts(engine)).toEqual([{ fact: CLAIM, embedded: true }]);
    expect(await facts(engine, UNATTRIBUTED)).toEqual([{ fact: UNATTRIBUTED, embedded: true }]);
  }, { databaseUrl }), 120_000);

  test(`#8526 [${backend}]: a claim forgotten while the batch waited is not saved again`, () => managedBrain(async brain => {
    const { engine } = brain;
    await engine.setConfig('facts.default_visibility', 'world');
    const retry = await refusedBatch(brain, [fact(CLAIM, TARGET)], 'world');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const saved = await engine.insertFact({ fact: CLAIM, entity_slug: TARGET, visibility: 'world', kind: 'fact', source: 'fixture' }, { source_id: 'default' });
    expect((await recordFactWithdrawal(engine, saved.id, 'default', false, { semanticReview: false })).withdrawn).toBe(true);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.setConfig('facts.default_visibility', 'private');
    await restartOwner(brain);
    expect(await retry()).toMatchObject({ inserted: 0, withdrawn_skipped: 1 });
    expect(await engine.executeRaw("SELECT id FROM facts WHERE fact=$1 AND visibility='private'", [CLAIM])).toEqual([]);
  }, { databaseUrl }), 120_000);
}

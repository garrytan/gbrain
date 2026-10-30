/**
 * #7516: a conversation-facts batch request whose receipt lost its intent
 * (the journal redacts a purged_content refusal, #5575; retention compaction
 * drops any terminal intent) takes its members' attempt history with it,
 * because that history is read from the stored intent. The next run derived
 * attempt 0 again, and so the same batch request id as the compacted
 * request: a fresh extraction (a paid model call) failed with
 * idempotency_conflict, identical rows replayed the stored failure, and both
 * repeated on every run. A spent request id is now skipped: the batch
 * publishes under the next unspent attempt, and the run after makes no model
 * call. Runs on PGLite, and on Postgres through
 * test/e2e/conversation-facts-redacted-batch-7516-postgres.test.ts.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { ANCHOR_SLUG, buildConversationPage, conversationGeneration, submitConversationPages, type ConversationPageEntry } from '../src/core/facts/conversation-publication.ts';
import { currentConversationVersionToken } from '../src/commands/extract-conversation-facts.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { compactReceipt } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'meetings/2026-09-28-plan-sync';
const KEPT = 'Owner Example sends the quarterly plan on Thursday';
const PURGED = 'Alice Example reviews plans on Mondays';
const transcript = [
  '---', 'title: Plan sync', 'type: meeting', 'date: 2026-09-28', '---',
  '**Alice Example:** Can you send me the quarterly plan before the review?',
  '**Owner Example:** Yes, I will send it on Thursday with the finance appendix.',
  '**Alice Example:** Good. I review plans on Mondays, so that works.',
  '**Owner Example:** I will flag any launch date changes in the summary.', '',
].join('\n');

afterEach(() => { installFaultHook(undefined); });

async function putPage(brain: ManagedBrain): Promise<void> {
  await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(), content: transcript } });
  await disposePersistenceConsumer(brain.engine);
}

/** One run with a counting, deterministic model stub; returns its result and the idempotency_conflict lines it logged. */
async function extract(engine: BrainEngine, calls: { n: number }, facts: string[]) {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0, overrideDisabled: true, workers: 1,
      extractor: async () => {
        calls.n++;
        return facts.map(fact => ({ fact, kind: 'fact', confidence: 0.9, entity_slug: null, source: 'test', notability: 'high',
          valid_from: new Date('2026-09-28T10:00:00Z') } as ExtractedFact));
      } });
    return { result, conflicts: lines.filter(line => line.includes('idempotency_conflict')) };
  } finally {
    process.stderr.write = write;
    await disposePersistenceConsumer(engine);
  }
}

/** Fails the next batch publication once with `error`, as the owner meets it. */
function failNextPublication(error: Error): void {
  let armed = true;
  installFaultHook(async point => {
    if (point !== 'consumer:prepared' || !armed) return;
    armed = false;
    throw error;
  });
}
/** What the facts insert guard raised for a purged claim before #7485 left such claims out. */
const PURGED_GUARD = () => Object.assign(new Error('purged_content: this claim was purged from this source and cannot be saved again'), { code: 'P0001' });

async function batches(engine: BrainEngine) {
  return engine.executeRaw<Pick<WriteRequest, 'id' | 'request_id' | 'principal_kind' | 'principal_id' | 'state' | 'error_code' | 'compacted'> & { has_intent: boolean }>(
    `SELECT id::text AS id, request_id::text AS request_id, principal_kind, principal_id::text AS principal_id, state, error_code, compacted,
            intent IS NOT NULL AS has_intent
       FROM persistence_requests WHERE slug=$1 ORDER BY sequence`, [ANCHOR_SLUG]);
}

async function factsOf(engine: BrainEngine) {
  return (await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1
    AND source LIKE 'cli:extract-conversation-facts%' AND expired_at IS NULL ORDER BY row_num`, [SLUG])).map(r => r.fact);
}

/** A partial entry (no outcome row) frozen directly, so two submissions of it are byte-identical. */
async function frozenEntry(engine: BrainEngine) {
  const authority = (await maintenancePreflight(engine, 'default'))!;
  const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
  const versionToken = await currentConversationVersionToken(engine, page);
  const generation = await conversationGeneration(engine, authority, { slug: SLUG, page, versionToken, since: null, segmentLimit: 1 });
  const entry: ConversationPageEntry = await buildConversationPage(engine, { engine: engine.kind },
    { slug: SLUG, generation, attempt: 0, versionToken, since: null, segmentLimit: 1, scope: 'partial' },
    [{ fact: KEPT, kind: 'fact', source: 'cli:extract-conversation-facts', row_num: 0, source_markdown_slug: SLUG, valid_from: new Date('2026-09-28T10:00:00Z') }],
    { newestEnd: null, visibility: 'private' });
  return { authority, entry };
}

async function purge(engine: BrainEngine, text: string): Promise<void> {
  const [{ visibility }] = await engine.executeRaw<{ visibility: string }>(
    `SELECT COALESCE((SELECT value FROM config WHERE key='facts.default_visibility'), 'private') AS visibility`);
  await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES ('default', $1, '*', gbrain_fact_fingerprint($2))`,
    [visibility, text]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: a batch refused purged_content and redacted by the journal publishes next run, and the run after makes no model call`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain);
      const calls = { n: 0 };
      failNextPublication(PURGED_GUARD());
      expect((await extract(engine, calls, [KEPT, PURGED])).result.pages_failed).toBe(1);
      expect(calls.n).toBe(1);
      await purge(engine, PURGED);
      // The stuck state: the refusal's receipt keeps its request id and digest, but no intent and so no attempt history.
      expect(await batches(engine)).toMatchObject([{ state: 'failed', error_code: 'purged_content', compacted: true, has_intent: false }]);

      const next = await extract(engine, calls, [KEPT, PURGED]);
      expect(next.conflicts).toEqual([]);
      expect(next.result).toMatchObject({ pages_processed: 1, pages_failed: 0, facts_inserted: 1, facts_skipped_purged: 1 });
      expect(calls.n).toBe(2);
      expect(await factsOf(engine)).toEqual([KEPT, 'EXTRACTION_COMPLETE']);
      const [spent, published] = await batches(engine);
      expect(published).toMatchObject({ state: 'committed' });
      expect(published!.request_id).not.toBe(spent!.request_id);

      const after = await extract(engine, calls, [KEPT, PURGED]);
      expect(after.result).toMatchObject({ pages_skipped_completed: 1, pages_failed: 0 });
      expect(calls.n).toBe(2);
      expect((await batches(engine)).length).toBe(2);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a failed batch compacted by retention publishes next run instead of reusing its request id`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain);
      const calls = { n: 0 };
      failNextPublication(Object.assign(new Error('simulated owner crash'), { code: 'storage_error' }));
      expect((await extract(engine, calls, [KEPT])).result.pages_failed).toBe(1);
      const [failed] = await batches(engine);
      expect(await compactReceipt(engine, failed!)).not.toHaveProperty('skipped');
      expect(await batches(engine)).toMatchObject([{ state: 'failed', error_code: 'storage_error', compacted: true, has_intent: false }]);

      const next = await extract(engine, calls, [KEPT]);
      expect(next.conflicts).toEqual([]);
      expect(next.result).toMatchObject({ pages_processed: 1, pages_failed: 0, facts_inserted: 1 });
      expect(calls.n).toBe(2);
      expect(await factsOf(engine)).toEqual([KEPT, 'EXTRACTION_COMPLETE']);

      const after = await extract(engine, calls, [KEPT]);
      expect(after.result).toMatchObject({ pages_skipped_completed: 1 });
      expect(calls.n).toBe(2);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: an identical batch is not answered with a compacted request's stored failure`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain);
      const { authority, entry } = await frozenEntry(engine);
      failNextPublication(Object.assign(new Error('simulated owner crash'), { code: 'storage_error' }));
      await expect(submitConversationPages(engine, authority, [entry])).rejects.toMatchObject({ code: 'storage_error' });
      const [failed] = await batches(engine);
      expect(await compactReceipt(engine, failed!)).not.toHaveProperty('skipped');
      const receipt = await submitConversationPages(engine, authority, [entry]);
      expect(receipt).toMatchObject({ state: 'committed', committed: 1 });
      expect(receipt.request_id).not.toBe(failed!.request_id);
      expect(await factsOf(engine)).toEqual([KEPT]);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a genuine replay of the same batch still dedupes, before and after its committed receipt is compacted`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain);
      const { authority, entry } = await frozenEntry(engine);
      const first = await submitConversationPages(engine, authority, [entry]);
      expect(first).toMatchObject({ state: 'committed', committed: 1 });
      expect((await submitConversationPages(engine, authority, [entry])).request_id).toBe(first.request_id);
      const [committed] = await batches(engine);
      expect(await compactReceipt(engine, committed!)).not.toHaveProperty('skipped');
      expect((await submitConversationPages(engine, authority, [entry])).request_id).toBe(first.request_id);
      expect((await batches(engine)).length).toBe(1);
      expect(await factsOf(engine)).toEqual([KEPT]);
    }, { databaseUrl });
  }, 120_000);
}

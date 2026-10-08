/**
 * Wave 9 follow-ups, item 1: managed conversation facts publish as receipted
 * `managed_maintenance_conversation_facts` requests with a generation identity.
 *
 * Protects: pages publish in batch requests (caps split a run into several);
 * a crash after admission replays the stored batch with zero model calls; a
 * page whose rows fail validation is blocked inside its batch (one model
 * call across three runs); a page that moved or was recreated is skipped
 * inside its batch while the rest publish; --force and a partial-then-full
 * run start a new generation; the frozen batch round-trips every column
 * through JSONB; an embedding model change drops stale vectors, never the
 * batch; a lost insert fails the publication; the intent-bytes,
 * outstanding-request, receipt-byte and lifetime-id bounds stop before any
 * model call; a source this host does not own preflights only when a page
 * needs work. Runs on PGLite, and on
 * Postgres through test/e2e/conversation-facts-managed-postgres.test.ts.
 * Seams: the Core's injected extractor (no gateway), the persistence fault
 * hook (to stall publication), the maintenance wait and batch-cap test seams.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { runExtractConversationFactsCore, currentConversationVersionToken } from '../src/commands/extract-conversation-facts.ts';
import { CONVERSATION_FACTS_INTENT, DEFAULT_BATCH_CAPS, __setConversationBatchCapsForTests, buildConversationPage, conversationGeneration,
  replaceConversationFacts, submitConversationPages } from '../src/core/facts/conversation-publication.ts';
import { CONVERSATION_EXTRACTOR_VERSION, outcomeExtractorVersion } from '../src/core/facts/audit-sources.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { exitCodeForCode } from '../src/core/error-catalogue.ts';
import { conversationOutcomesStaleCheck } from '../src/commands/doctor/checks/conversation-outcomes.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'meetings/2026-09-28-plan-sync';
const transcript = (extra = '') => [
  '---', 'title: Plan sync', 'type: meeting', 'date: 2026-09-28', '---',
  '**Alice Example:** Can you send me the quarterly plan before the review?',
  '**Owner Example:** Yes, I will send it on Thursday with the finance appendix.',
  '**Alice Example:** Good. I review plans on Mondays, so that works.',
  `**Owner Example:** I will flag any launch date changes in the summary.${extra}`, '',
].join('\n');

afterEach(() => { installFaultHook(undefined); __setConversationBatchCapsForTests(null); });

async function putPage(brain: ManagedBrain, content: string, slug = SLUG): Promise<void> {
  const current = await brain.engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content,
    ...(current ? { expected_revision: current.revision } : {}) } });
  // The consumer keeps the config it started with; the extraction's own requests start a fresh one under the CLI config.
  await disposePersistenceConsumer(brain.engine);
}

/** One extraction run on the page with a counting extractor; `fact` shapes the returned fact. */
async function extract(engine: BrainEngine, calls: { n: number }, opts: { force?: boolean; segmentLimit?: number; fact?: Partial<ExtractedFact>;
  slugs?: string[]; onCall?: (turnText: string) => Promise<void> } = {}) {
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: opts.slugs ?? [SLUG], sleepMs: 0, overrideDisabled: true,
    force: opts.force, segmentLimit: opts.segmentLimit,
    extractor: async ({ turnText }) => {
      calls.n++;
      await opts.onCall?.(turnText);
      return [{ fact: 'Owner Example sends the quarterly plan on Thursday', kind: 'commitment', confidence: 0.9, entity_slug: null,
        source: 'test', notability: 'high', ...opts.fact } as ExtractedFact];
    } });
}

async function extractorRows(engine: BrainEngine) {
  return engine.executeRaw<Record<string, any>>(`SELECT id, fact, kind, source, source_session, context, row_num, visibility, notability, confidence,
      claim_metric, claim_value, claim_unit, claim_period, event_type, attributed_to, valid_from, embedding_model, embedding IS NOT NULL AS embedded
    FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND source LIKE 'cli:extract-conversation-facts%' ORDER BY row_num`, [SLUG]);
}

const PROSE = (title: string) => ['---', `title: ${title}`, 'type: meeting', 'date: 2026-09-28', '---',
  '**Date:** 2026-09-28', '**Attendees:** Alice Example, Owner Example', '', '## Notes', 'Hiring, the support backlog and the launch dates.', ''].join('\n');
const titled = (title: string) => transcript().replace('title: Plan sync', `title: ${title}`);

async function factsOf(engine: BrainEngine, slug: string) {
  return (await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1
    AND source LIKE 'cli:extract-conversation-facts%' AND expired_at IS NULL ORDER BY row_num`, [slug])).map(r => r.fact);
}

async function requests(engine: BrainEngine) {
  return engine.executeRaw<{ state: string; error_code: string | null }>(
    "SELECT state, error_code FROM persistence_requests WHERE intent->>'kind'=$1 ORDER BY sequence", [CONVERSATION_FACTS_INTENT]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: a transcript's facts and outcome commit in one receipted request; the frozen batch round-trips through JSONB`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      await engine.setConfig('embedding_disabled', 'false');
      const dims = Number(await engine.getConfig('embedding_dimensions') ?? 1536);
      const vector = Float32Array.from({ length: dims }, (_, i) => ((i % 7) - 3) / 10);
      const calls = { n: 0 };
      const result = await extract(engine, calls, { fact: { claim_metric: 'plan_pages', claim_value: 12.5, claim_unit: 'pages', claim_period: 'quarterly',
        event_type: 'meeting', attributed_to: 'user', embedding: vector, embedding_model: await engine.getConfig('embedding_model') ?? null,
        valid_from: new Date('2026-09-28T10:00:00Z') } });
      expect(result).toMatchObject({ pages_processed: 1, facts_inserted: 1, pages_failed: 0 });
      expect(calls.n).toBe(1);
      const rows = await extractorRows(engine);
      expect(rows.map(r => r.fact)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
      expect(rows[0]).toMatchObject({ kind: 'commitment', source: 'cli:extract-conversation-facts', notability: 'high', claim_metric: 'plan_pages',
        claim_unit: 'pages', claim_period: 'quarterly', event_type: 'meeting', attributed_to: 'user', embedded: true, row_num: 0 });
      expect(Number(rows[0]!.claim_value)).toBe(12.5);
      expect(Number(rows[0]!.confidence)).toBeCloseTo(0.9, 5);
      expect(new Date(rows[0]!.valid_from).toISOString()).toBe('2026-09-28T10:00:00.000Z');
      expect(outcomeExtractorVersion(rows[1]!.context)).toBe(CONVERSATION_EXTRACTOR_VERSION);
      expect(await requests(engine)).toEqual([{ state: 'committed', error_code: null }]);
      const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(DISTINCT write_request_id)::int AS n FROM facts
        WHERE source_id='default' AND source_markdown_slug=$1`, [SLUG]);
      expect(n).toBe(1);
      expect((await conversationOutcomesStaleCheck(engine, ['default'])).status).toBe('ok');
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a crash after admission replays the stored batch with zero model calls`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      const OTHER = 'meetings/2026-09-29-plan-sync';
      await putPage(brain, transcript());
      await putPage(brain, titled('Plan sync two'), OTHER);
      let release!: () => void;
      const stalled = new Promise<void>(resolve => { release = resolve; });
      installFaultHook(async point => { if (point === 'consumer:prepared') await stalled; });
      const restore = __setMaintenanceWriteWaitForTests(300);
      const calls = { n: 0 };
      try {
        const first = await extract(engine, calls, { slugs: [SLUG, OTHER] });
        expect(first).toMatchObject({ pages_pending: 2, facts_inserted: 0 });
        expect(calls.n).toBe(2);
        __setMaintenanceWriteWaitForTests(20_000);
        setTimeout(release, 300);
        // The first page waits for the batch and replays its receipt; the second is then complete already.
        const second = await extract(engine, calls, { slugs: [SLUG, OTHER] });
        expect(second).toMatchObject({ pages_processed: 1, pages_skipped_completed: 1, facts_inserted: 1 });
        expect(calls.n).toBe(2);
      } finally { release(); restore(); }
      expect(await factsOf(engine, SLUG)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
      expect(await factsOf(engine, OTHER)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
      expect((await requests(engine)).map(r => r.state)).toEqual(['committed']);
      const third = await extract(engine, calls, { slugs: [SLUG, OTHER] });
      expect(third).toMatchObject({ pages_skipped_completed: 2 });
      expect(calls.n).toBe(2);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a page whose rows fail validation is blocked inside its batch: one model call across three runs`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      const GOOD = 'meetings/2026-09-29-plan-sync';
      await putPage(brain, transcript());
      await putPage(brain, titled('Plan sync two'), GOOD);
      const calls = { n: 0 };
      let bad = true;
      const run = () => runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [SLUG, GOOD], sleepMs: 0, overrideDisabled: true,
        extractor: async ({ turnText }) => {
          calls.n++;
          const kind = bad && !turnText.includes('Plan sync two') ? 'not-a-kind' : 'commitment';
          return [{ fact: 'Owner Example sends the quarterly plan on Thursday', kind, confidence: 0.9, entity_slug: null, source: 'test' } as unknown as ExtractedFact];
        } });
      const first = await run();
      expect(first).toMatchObject({ pages_blocked: 1, pages_processed: 1, pages_failed: 0 });
      const second = await run();
      const third = await run();
      expect(calls.n).toBe(2);
      expect(second).toMatchObject({ pages_skipped_non_extractable: 1, pages_skipped_completed: 1 });
      expect(third).toMatchObject({ pages_skipped_non_extractable: 1, pages_skipped_completed: 1 });
      expect(await requests(engine)).toEqual([{ state: 'committed', error_code: null }]);
      expect(await factsOf(engine, SLUG)).toEqual(['EXTRACTION_NOT_APPLICABLE']);
      expect((await extractorRows(engine))[0]!.context).toContain('blocked:');
      // The page changes: a new generation extracts again.
      bad = false;
      await putPage(brain, transcript(' Thanks.'));
      const fourth = await run();
      expect(fourth).toMatchObject({ pages_processed: 1, facts_inserted: 1 });
      expect(calls.n).toBe(3);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: --force and a partial-then-full run each start a new generation`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      // 32 turns: two segments (DEFAULT_SEGMENT_MAX_MESSAGES is 30).
      const turns = Array.from({ length: 32 }, (_, i) => `**${i % 2 ? 'Owner' : 'Alice'} Example:** Turn ${i + 1} about the quarterly plan.`);
      await putPage(brain, ['---', 'title: Plan sync', 'type: meeting', 'date: 2026-09-28', '---', ...turns, ''].join('\n'));
      const calls = { n: 0 };
      const partial = await extract(engine, calls, { segmentLimit: 1 });
      expect(partial).toMatchObject({ pages_processed: 1, segments_processed: 1, facts_inserted: 1 });
      expect(calls.n).toBe(1);
      // A committed partial batch is not a completed page: no outcome row.
      expect((await extractorRows(engine)).map(r => r.fact)).toEqual(['Owner Example sends the quarterly plan on Thursday']);
      const full = await extract(engine, calls);
      expect(full).toMatchObject({ pages_processed: 1, segments_processed: 2 });
      expect(calls.n).toBe(3);
      expect((await extractorRows(engine)).map(r => r.fact).at(-1)).toBe('EXTRACTION_COMPLETE');
      expect((await extract(engine, calls)).pages_skipped_completed).toBe(1);
      expect(calls.n).toBe(3);
      const forced = await extract(engine, calls, { force: true });
      expect(forced).toMatchObject({ pages_processed: 1, segments_processed: 2 });
      expect(calls.n).toBe(5);
      expect((await requests(engine)).map(r => r.state)).toEqual(['committed', 'committed', 'committed']);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: an embedding model change without a dimension change drops the stale vectors, never the batch`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      await engine.setConfig('embedding_disabled', 'false');
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
      const versionToken = await currentConversationVersionToken(engine, page);
      const generation = await conversationGeneration(engine, authority, { slug: SLUG, page, versionToken, since: null, segmentLimit: 0 });
      const dims = Number(await engine.getConfig('embedding_dimensions') ?? 1536);
      const entry = await buildConversationPage(engine, { engine: engine.kind }, { slug: SLUG, generation, attempt: 0, versionToken, since: null, segmentLimit: 0 },
        [{ fact: 'A vector claim', kind: 'fact', source: 'cli:extract-conversation-facts', row_num: 0, source_markdown_slug: SLUG, embedding: new Float32Array(dims).fill(0.1) }],
        { newestEnd: null, visibility: 'private' });
      expect(entry.embedding).toMatchObject({ dimensions: dims });
      const model = await engine.getConfig('embedding_model');
      await engine.setConfig('embedding_model', 'openai:text-embedding-other-example');
      let receipt: Record<string, unknown>;
      try { receipt = await submitConversationPages(engine, authority, [entry]); }
      finally { await engine.setConfig('embedding_model', model!); }
      expect(receipt).toMatchObject({ state: 'committed', committed: 1, vectors_dropped: 1 });
      expect((await extractorRows(engine)).map(r => [r.fact, r.embedded])).toEqual([['A vector claim', false]]);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a page recreated at the same slug is skipped inside its batch`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
      const versionToken = await currentConversationVersionToken(engine, page);
      const generation = await conversationGeneration(engine, authority, { slug: SLUG, page, versionToken, since: null, segmentLimit: 0 });
      const entry = await buildConversationPage(engine, { engine: engine.kind }, { slug: SLUG, generation, attempt: 0, versionToken, since: null, segmentLimit: 0 },
        [{ fact: 'A stale claim', kind: 'fact', source: 'cli:extract-conversation-facts', row_num: 0, source_markdown_slug: SLUG }], { newestEnd: null, visibility: 'private' });
      const live = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      await submitPageMutation(brain.ctx, { operation: 'delete_page', params: { slug: SLUG, expected_revision: live.revision, request_id: randomUUID() } });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug=$1", [SLUG]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await disposePersistenceConsumer(engine);
      await putPage(brain, transcript());
      const receipt = await submitConversationPages(engine, authority, [entry]);
      expect(receipt).toMatchObject({ state: 'committed', committed: 0, skipped: 1 });
      expect((receipt.pages as Array<{ reason: string }>)[0]!.reason).toBe('page_identity_changed');
      expect(await extractorRows(engine)).toEqual([]);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a mixed batch publishes every page but the one that moved, which is skipped and re-extracted next run`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      const MOVED = 'meetings/2026-09-29-plan-sync', LAST = 'meetings/2026-09-30-plan-sync', NOTES = 'meetings/2026-09-28-notes';
      await putPage(brain, transcript());
      await putPage(brain, titled('Plan sync two'), MOVED);
      await putPage(brain, PROSE('Planning notes'), NOTES);
      await putPage(brain, titled('Plan sync three'), LAST);
      const calls = { n: 0 };
      let edited = false;
      const first = await extract(engine, calls, { slugs: [SLUG, MOVED, NOTES, LAST], onCall: async text => {
        // MOVED's entry is already in the batch when LAST is extracted; edit it before the batch publishes.
        if (!edited && text.includes('Plan sync three')) { edited = true; await putPage(brain, titled('Plan sync two').replace('Thursday', 'Friday'), MOVED); }
      } });
      expect(edited).toBe(true);
      expect(calls.n).toBe(3);
      expect(first).toMatchObject({ pages_processed: 2, pages_marked_non_extractable: 1, pages_failed: 1, facts_inserted: 2 });
      expect((await requests(engine)).map(r => r.state)).toEqual(['committed']);
      expect(await factsOf(engine, MOVED)).toEqual([]);
      expect(await factsOf(engine, NOTES)).toEqual(['EXTRACTION_NOT_APPLICABLE']);
      const second = await extract(engine, calls, { slugs: [SLUG, MOVED, NOTES, LAST] });
      expect(second).toMatchObject({ pages_processed: 1, pages_skipped_completed: 2, pages_skipped_non_extractable: 1 });
      expect(calls.n).toBe(4);
      expect(await factsOf(engine, MOVED)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a batch that failed retryably is resubmitted from its stored entries with zero model calls`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      let fail = true;
      installFaultHook(async point => { if (point === 'consumer:prepared' && fail) { fail = false; throw Object.assign(new Error('simulated owner crash'), { code: 'storage_error' }); } });
      const calls = { n: 0 };
      const first = await extract(engine, calls);
      expect(first.pages_processed).toBe(0);
      expect(calls.n).toBe(1);
      const failed = await requests(engine);
      expect(failed.map(r => r.state)).toEqual(['failed']);
      const second = await extract(engine, calls);
      expect(second).toMatchObject({ pages_processed: 1, facts_inserted: 1 });
      expect(calls.n).toBe(1);
      expect((await requests(engine)).map(r => r.state)).toEqual(['failed', 'committed']);
      expect(await factsOf(engine, SLUG)).toEqual(['Owner Example sends the quarterly plan on Thursday', 'EXTRACTION_COMPLETE']);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: the batch caps split a run into several requests`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      expect(DEFAULT_BATCH_CAPS).toEqual({ pages: 25, factPages: 10, bytes: 8 * 1024 * 1024 });
      const slugs = ['meetings/t1', 'meetings/p1', 'meetings/t2', 'meetings/p2', 'meetings/p3'];
      for (const slug of slugs) await putPage(brain, slug.includes('/t') ? titled(`Sync ${slug}`) : PROSE(`Notes ${slug}`), slug);
      __setConversationBatchCapsForTests({ pages: 2, factPages: 1 });
      const calls = { n: 0 };
      const result = await extract(engine, calls, { slugs });
      // [t1] (fact-page cap), [p1, t2] (page cap), [p2, p3] (page cap).
      expect(result).toMatchObject({ pages_processed: 2, pages_marked_non_extractable: 3, pages_failed: 0 });
      expect((await requests(engine)).map(r => r.state)).toEqual(['committed', 'committed', 'committed']);
      const members = await engine.executeRaw<{ n: number }>(`SELECT jsonb_array_length(intent->'pages')::int AS n FROM persistence_requests
        WHERE intent->>'kind'=$1 ORDER BY sequence`, [CONVERSATION_FACTS_INTENT]);
      expect(members.map(r => r.n)).toEqual([1, 2, 2]);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: the intent-bytes, outstanding-request and lifetime-id bounds stop before any model call`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      await putPage(brain, transcript().replace('Plan sync', 'Plan sync two'), 'meetings/2026-09-29-plan-sync');
      const calls = { n: 0 };
      // Intent bytes: one segment's largest batch cannot fit.
      await engine.setConfig('persistence.limits.principal_intent_bytes', '20000');
      const tooLarge = await extract(engine, calls);
      expect(tooLarge).toMatchObject({ pages_skipped_too_large: 1, facts_inserted: 0 });
      expect(calls.n).toBe(0);
      await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_intent_bytes'");
      // Lifetime ids: no headroom refuses before the run.
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const [used] = await engine.executeRaw<{ n: number }>("SELECT COALESCE(max(lifetime_ids),0)::int AS n FROM persistence_counters WHERE key LIKE 'principal:%'");
      await engine.setConfig('persistence.limits.principal_lifetime_ids', String(used!.n));
      const lifetime = await extract(engine, calls).then(() => null, (e: Error & { code?: string }) => e);
      expect(lifetime?.code).toBe('maintenance_backpressure');
      expect(calls.n).toBe(0);
      await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.principal_lifetime_ids'");
      // Outstanding: with one request pending, a limit of 2 (80% = 1) stops admitting the next page.
      await engine.setConfig('persistence.limits.principal_outstanding', '2');
      let release!: () => void;
      const stalled = new Promise<void>(resolve => { release = resolve; });
      installFaultHook(async point => { if (point === 'consumer:prepared') await stalled; });
      const restore = __setMaintenanceWriteWaitForTests(300);
      try {
        const pending = await extract(engine, calls);
        expect(pending.pages_pending).toBe(1);
        expect(calls.n).toBe(1);
        const stopped = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: ['meetings/2026-09-29-plan-sync'], sleepMs: 0,
          overrideDisabled: true, extractor: async () => { calls.n++; return []; } }).then(() => null, (e: Error & { code?: string }) => e);
        expect(stopped?.code).toBe('maintenance_backpressure');
        expect(exitCodeForCode('maintenance_backpressure')).toBe(12);
        expect(calls.n).toBe(1);
      } finally { release(); restore(); }
      expect(authority.writer.principal.kind).toBe('local_cli');
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: admission stops at 80% of the writer's reserved receipt bytes, before any model call`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      const [{ bytes }] = await engine.executeRaw<{ bytes: number }>("SELECT COALESCE(max(terminal_bytes),0)::bigint AS bytes FROM persistence_counters WHERE key LIKE 'principal:local_cli:%'");
      // One more 16 KiB reservation fits under the hard limit but crosses 80% of it.
      await engine.setConfig('persistence.limits.principal_terminal_bytes', String(Number(bytes) + 20_000));
      const calls = { n: 0 };
      const error = await extract(engine, calls).then(() => null, (e: Error & { code?: string; suggestion?: string }) => e);
      expect(error?.code).toBe('maintenance_backpressure');
      expect(error?.message).toContain('reserved receipt bytes');
      expect(error?.suggestion).toContain('persistence.limits.principal_terminal_bytes');
      expect(calls.n).toBe(0);
      expect(await extractorRows(engine)).toEqual([]);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: admission stops at 80% of the writer's permanent request ids, before any model call`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      await putPage(brain, transcript());
      await maintenancePreflight(engine, 'default');
      const [{ used }] = await engine.executeRaw<{ used: number }>("SELECT COALESCE(max(lifetime_ids),0)::int AS used FROM persistence_counters WHERE key LIKE 'principal:local_cli:%'");
      await engine.setConfig('persistence.limits.principal_lifetime_ids', String(used + 1)); // fits one admission, but past 80%
      const calls = { n: 0 };
      const error = await extract(engine, calls).then(() => null, (e: Error & { code?: string; suggestion?: string }) => e);
      expect(error?.code).toBe('maintenance_backpressure');
      expect(error?.message).toContain('permanent request ids');
      expect(error?.suggestion).toContain('persistence.limits.principal_lifetime_ids');
      expect(calls.n).toBe(0);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: the up-front check counts the whole planned run and names a --limit that fits`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      for (const day of ['28', '29', '30']) await putPage(brain, transcript().replace('Plan sync', `Plan sync ${day}`), `meetings/2026-09-${day}-plan-sync`);
      __setConversationBatchCapsForTests({ factPages: 1 });
      await maintenancePreflight(engine, 'default');
      const [{ used }] = await engine.executeRaw<{ used: number }>("SELECT COALESCE(max(lifetime_ids),0)::int AS used FROM persistence_counters WHERE key LIKE 'principal:local_cli:%'");
      // 80% of the limit leaves room for one admission, not the three the run plans.
      const limit = Math.ceil((used + 1) / 0.8) + 1;
      await engine.setConfig('persistence.limits.principal_lifetime_ids', String(limit));
      const room = Math.floor(limit * 0.8) - used;
      expect(room).toBeGreaterThanOrEqual(1);
      expect(room).toBeLessThan(3);
      const calls = { n: 0 };
      const error = await runExtractConversationFactsCore(engine, { sourceId: 'default', sleepMs: 0, overrideDisabled: true,
        extractor: async () => { calls.n++; return []; } }).then(() => null, (e: Error & { code?: string; suggestion?: string }) => e);
      expect(error?.code).toBe('maintenance_backpressure');
      expect(error?.message).toContain('3 planned');
      expect(error?.suggestion).toContain(`gbrain extract-conversation-facts --source-id default --limit ${room}`);
      expect(calls.n).toBe(0);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: a source owned by another host preflights nothing when no page needs work, and stops before any model call when one does`, async () => {
    await managedBrain(async brain => {
      const { engine } = brain;
      const other = 'meetings/2026-09-29-plan-sync';
      await putPage(brain, transcript());
      await putPage(brain, transcript().replace('Plan sync', 'Plan sync 29'), other);
      const calls = { n: 0 };
      expect(await extract(engine, calls)).toMatchObject({ pages_processed: 1, pages_failed: 0 });
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await tx.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$1::uuid', [randomUUID()]);
      });
      expect(await extract(engine, calls)).toMatchObject({ pages_processed: 0, pages_failed: 0 });
      const error = await runExtractConversationFactsCore(engine, { sourceId: 'default', sleepMs: 0, overrideDisabled: true,
        extractor: async () => { calls.n++; return []; } }).then(() => null, (e: Error & { code?: string }) => e);
      expect(error?.code).toBe('owner_unavailable');
      expect(calls.n).toBe(1);
      expect(await factsOf(engine, other)).toEqual([]);
    }, { databaseUrl });
  }, 120_000);
}

test('a lost insert fails the replacement instead of committing a partial batch', async () => {
  const tx = {
    executeRaw: async (sql: string) => sql.includes('DELETE') ? [{ count: '2' }] : [{ n: null }],
    insertFacts: async () => ({ inserted: 1, ids: [1], warnings: [], deleted: 0 }),
  } as unknown as BrainEngine;
  const error = await replaceConversationFacts(tx, 'default', SLUG, [
    { fact: 'one', source: 'cli:extract-conversation-facts' }, { fact: 'two', source: 'cli:extract-conversation-facts' },
  ]).then(() => null, (e: Error & { code?: string }) => e);
  expect(error?.code).toBe('storage_error');
});

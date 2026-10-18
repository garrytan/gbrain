/**
 * #6506: on a managed brain, one withdrawn candidate refused an entity's whole
 * automatic fact batch, so an unrelated new fact in the same group was never
 * published and every re-extraction of the unchanged page refused again.
 *
 * 1. Protects: automatic extraction (`withdrawn: 'skip'` frozen in the intent)
 *    skips a withdrawn candidate and publishes the rest; the entity and
 *    completion receipts count `withdrawn_skipped`; an all-withdrawn group
 *    commits a no-op receipt; a replay under the same request id costs no
 *    model call; purge tombstones still refuse (`purged_content`) at
 *    preparation and at locked validation; `remember` and the explicit fence
 *    writers keep the refusal; a withdrawal committed between preparation and
 *    the locked validation is a terminal `revision_conflict` whose detail
 *    names the withdrawal, with nothing published.
 * 2. Fails when: the withdrawn candidate refuses the group (master), the skip
 *    leaks into explicit writers, the purge check is skipped, the flag is
 *    stored as a JSON scalar, or the race publishes around the withdrawal.
 * 3. test/managed-facts-backstop.test.ts covers the managed contract cases
 *    without withdrawals; test/managed-facts-withdrawal-recovery-6506.test.ts
 *    covers the follow-up route for batches that already failed.
 * 4. Seams: gateway test transports and the persistence fault hook.
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const SLUG = 'people/alice-example';
const WITHDRAWN = 'Alice-example agreed to provide twelve sample kits for the synthetic workshop.';
const NOVEL = 'Alice-example will verify the synthetic room booking in November.';
const PURGED = 'Alice-example holds a synthetic obsolete workshop credential.';

const engines: BrainEngine[] = [];
const dbDir = mkdtempSync(join(tmpdir(), 'gbrain-withdrawn-skip-db-'));
let closePostgres: (() => Promise<void>) | undefined;
let calls = 0;
let extracted: string[] = [];

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    calls++;
    return { text: JSON.stringify({ facts: extracted.map(fact => ({ fact, entity: SLUG, kind: 'fact', confidence: 1, notability: 'medium' })) }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
  });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array(1536).fill(0.01)) })) as never);
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: dbDir });
      await engine.initSchema();
      engines.push(engine);
    } else {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(isolated.engine);
      closePostgres = isolated.close;
    }
  }
}, 120_000);

afterEach(() => { installFaultHook(undefined); });

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dbDir, { recursive: true, force: true });
});

/**
 * A managed, database-only source with one entity page; every test gets its own
 * source. Withdrawals and purge tombstones are seeded before the brain turns
 * managed (a managed brain refuses direct fact inserts).
 */
async function managedSource(engine: BrainEngine, seed: { withdraw?: string[]; purge?: string[] } = {}) {
  const sourceId = `w6506-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example\n\nFictional person for the regression.\n' }, { sourceId });
  for (const fact of seed.withdraw ?? []) {
    const saved = await engine.insertFact({ fact, entity_slug: SLUG, visibility: 'world', kind: 'fact', source: 'fixture' }, { source_id: sourceId });
    expect((await recordFactWithdrawal(engine, saved.id, sourceId, false, { semanticReview: false })).withdrawn).toBe(true);
  }
  for (const fact of seed.purge ?? []) await purge(engine, sourceId, fact);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, remote: false as const, sourceId, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  const page = async () => (await engine.getPage(SLUG, { sourceId }))!.compiled_truth;
  const active = () => engine.executeRaw<{ id: number; fact: string }>('SELECT id,fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY id', [sourceId])
    .then(rows => rows.map(row => ({ id: Number(row.id), fact: row.fact })));
  const quiet = () => waitFor(async () => (await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')`, [sourceId]))[0].n === 0,
  { timeoutMs: 30_000, label: 'fact requests settled' });
  const journal = async () => {
    await quiet();
    return engine.executeRaw<{ slug: string; state: string; error_code: string | null; error_detail: unknown; outcome: Record<string, unknown> | null; intent: Record<string, unknown> | null }>(
      `SELECT slug,state,error_code,error_detail,outcome,intent FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence`, [sourceId]);
  };
  const flagTypes = () => engine.executeRaw<{ kind: string; flag: string | null; value: string | null }>(
    `SELECT intent->>'kind' AS kind, jsonb_typeof(intent->'withdrawn') AS flag, intent->>'withdrawn' AS value FROM persistence_requests
       WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence`, [sourceId]);
  const extract = (facts: string[], requestId: string) => {
    extracted = facts;
    return operationsByName.extract_facts.handler(ctx, { turn_text: `A synthetic workshop record. ${WITHDRAWN} ${NOVEL}`, visibility: 'world', request_id: requestId }) as
      Promise<{ inserted: number; duplicate: number; fact_ids: number[]; withdrawn_skipped?: number }>;
  };
  return { sourceId, ctx, page, active, journal, flagTypes, extract };
}

/** A purge tombstone for `fact` about the entity, the row `purge_fact` leaves behind. */
function purge(engine: BrainEngine, sourceId: string, fact: string) {
  return engine.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,actor,reason) VALUES($1,'world',$2,gbrain_fact_fingerprint($3),'fixture','regression')
    ON CONFLICT DO NOTHING`, [sourceId, SLUG, fact]);
}

async function onEachEngine(label: string, body: (engine: BrainEngine) => Promise<void>) {
  for (const engine of engines) {
    const home = mkdtempSync(join(tmpdir(), `gbrain-withdrawn-skip-${label}-`));
    calls = 0;
    try {
      await withEnv({ GBRAIN_HOME: home }, () => body(engine));
    } finally {
      installFaultHook(undefined);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(home, { recursive: true, force: true });
    }
  }
}

describe('managed automatic extraction meets a withdrawn claim (#6506)', () => {
  test('a withdrawn candidate is skipped and counted while the novel claim publishes; the replay costs no model call', async () => {
    await onEachEngine('mixed', async engine => {
      const s = await managedSource(engine, { withdraw: [WITHDRAWN] });
      const fenceBefore = await s.page();
      const requestId = randomUUID();
      const first = await s.extract([WITHDRAWN, NOVEL], requestId);
      expect(first).toMatchObject({ inserted: 1, duplicate: 0, withdrawn_skipped: 1 });
      const active = await s.active();
      expect(active.map(row => row.fact)).toEqual([NOVEL]);
      expect(first.fact_ids.map(Number)).toEqual(active.map(row => row.id));
      expect(await s.page()).not.toBe(fenceBefore);
      expect(await s.page()).toContain(NOVEL);
      expect(await s.page()).not.toContain(WITHDRAWN);
      const journal = await s.journal();
      expect(journal.map(row => [row.slug, row.state, row.outcome?.withdrawn_skipped])).toEqual([[SLUG, 'committed', 1], ['__managed_facts_complete__', 'committed', 1]]);
      expect(await s.flagTypes()).toEqual([{ kind: 'managed_facts_entity', flag: 'string', value: 'skip' }, { kind: 'managed_facts_complete', flag: null, value: null }]);
      expect(calls).toBe(1);
      const replay = await s.extract([WITHDRAWN, NOVEL], requestId);
      expect(replay).toEqual(first);
      expect(calls).toBe(1);
      expect(await s.active()).toEqual(active);

      await expect(operationsByName.remember.handler(s.ctx, { fact: WITHDRAWN, entity: SLUG, visibility: 'world', provenance: 'Synthetic withdrawal regression.' }))
        .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('fact_withdrawn') });
      expect(await s.active()).toEqual(active);
    });
  }, 180_000);

  test('an all-withdrawn group commits a no-op entity receipt and leaves the page untouched', async () => {
    await onEachEngine('all', async engine => {
      const s = await managedSource(engine, { withdraw: [WITHDRAWN] });
      const fenceBefore = await s.page();
      const result = await s.extract([WITHDRAWN], randomUUID());
      expect(result).toMatchObject({ inserted: 0, duplicate: 0, withdrawn_skipped: 1, fact_ids: [] });
      expect(await s.active()).toEqual([]);
      expect(await s.page()).toBe(fenceBefore);
      const journal = await s.journal();
      expect(journal.map(row => [row.slug, row.state, row.error_code, row.outcome?.inserted, row.outcome?.withdrawn_skipped]))
        .toEqual([[SLUG, 'committed', null, 0, 1], ['__managed_facts_complete__', 'committed', null, 0, 1]]);
      expect(calls).toBe(1);
    });
  }, 180_000);

  test('explicit fence writers never carry the skip flag and remember still refuses', async () => {
    await onEachEngine('explicit', async engine => {
      const s = await managedSource(engine, { withdraw: [WITHDRAWN] });
      const result = await writeFactsToFence(engine, { sourceId: s.sourceId, slug: SLUG, localPath: null, resolutionSource: 'exact_page' }, [
        { fact: WITHDRAWN, kind: 'fact', source: 'fixture', visibility: 'world', notability: 'medium', embedding: null, sessionId: null },
        { fact: NOVEL, kind: 'fact', source: 'fixture', visibility: 'world', notability: 'medium', embedding: null, sessionId: null },
      ]);
      expect(result).toMatchObject({ inserted: 1, withdrawnSkipped: 1 });
      expect((await s.active()).map(row => row.fact)).toEqual([NOVEL]);
      expect(result.ids).toEqual((await s.active()).map(row => row.id));
      expect((await s.flagTypes()).map(row => row.flag)).toEqual([null, null]);
      expect(await s.journal()).toHaveLength(2);
    });
  }, 180_000);

  test('a purge tombstone still refuses the group at preparation', async () => {
    await onEachEngine('purged', async engine => {
      const s = await managedSource(engine, { purge: [PURGED] });
      const fenceBefore = await s.page();
      await expect(s.extract([PURGED, NOVEL], randomUUID())).rejects.toMatchObject({ code: 'purged_content' });
      expect(await s.active()).toEqual([]);
      expect(await s.page()).toBe(fenceBefore);
      const journal = await s.journal();
      expect(journal.map(row => [row.slug, row.state, row.error_code])).toEqual([[SLUG, 'failed', 'purged_content'], ['__managed_facts_complete__', 'conflict', 'revision_conflict']]);
    });
  }, 180_000);

  test('a purge tombstone written between preparation and locked validation still refuses purged_content', async () => {
    await onEachEngine('purged-race', async engine => {
      const s = await managedSource(engine);
      const fenceBefore = await s.page();
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:prepared' || detail.operation !== 'extract_facts' || detail.sourceId !== s.sourceId) return;
        await purge(engine, s.sourceId, NOVEL);
      });
      await expect(s.extract([NOVEL], randomUUID())).rejects.toMatchObject({ code: 'purged_content' });
      expect(await s.active()).toEqual([]);
      expect(await s.page()).toBe(fenceBefore);
      expect((await s.journal()).map(row => [row.slug, row.state, row.error_code])).toEqual([[SLUG, 'failed', 'purged_content'], ['__managed_facts_complete__', 'conflict', 'revision_conflict']]);
    });
  }, 180_000);

  test('a withdrawal committed between preparation and locked validation is a terminal revision_conflict naming the withdrawal', async () => {
    await onEachEngine('race', async engine => {
      const s = await managedSource(engine);
      const fenceBefore = await s.page();
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:prepared' || detail.operation !== 'extract_facts' || detail.sourceId !== s.sourceId) return;
        await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES($1,'world',$2,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING`,
          [s.sourceId, SLUG, WITHDRAWN]);
      });
      await expect(s.extract([WITHDRAWN, NOVEL], randomUUID())).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(await s.active()).toEqual([]);
      expect(await s.page()).toBe(fenceBefore);
      const journal = await s.journal();
      expect(journal.map(row => [row.slug, row.state, row.error_code])).toEqual([[SLUG, 'conflict', 'revision_conflict'], ['__managed_facts_complete__', 'conflict', 'revision_conflict']]);
      expect(journal[0].error_detail).toMatchObject({ origin: 'withdrawal', withdrawn: { subject: SLUG, visibility: 'world' } });
      expect((journal[0].intent as { facts: unknown[] }).facts).toHaveLength(2);
      expect(calls).toBe(1);
    });
  }, 180_000);
});

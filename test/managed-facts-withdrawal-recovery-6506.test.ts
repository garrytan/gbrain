/**
 * #6506 (UC1): a managed facts batch keyed by its input (sync import of an
 * unchanged page: no request id) whose entity request was refused for a
 * withdrawn claim replayed that stored refusal on every later run, with zero
 * model calls and zero facts, forever.
 *
 * 1. Protects: a stored batch whose entity request failed on a withdrawal
 *    (the pre-detail receipt shape `invalid_params` + the fact_withdrawn
 *    message, and the typed `error_detail.origin = 'withdrawal'` shape) is
 *    followed by a batch under `digest([batchKey, 'withdrawal-retry', n])`
 *    that re-admits the retained facts with `withdrawn: 'skip'`; the novel
 *    claim publishes once, the withdrawn claim stays absent, no model call
 *    runs, the historical receipts stay byte-identical, the completion is
 *    honest; at most three follow-ups, then the refusal stands; an origin page
 *    edited in between refuses and publishes nothing; a batch admitted under a
 *    request id replays its receipt instead.
 * 2. Fails when: the refusal replays forever (master), a follow-up re-runs the
 *    model, a refusal of another kind or without retained facts is followed,
 *    the cap is exceeded, or the historical receipts change.
 * 3. test/managed-facts-withdrawn-skip-6506.test.ts covers new batches;
 *    test/managed-sweep-refused-window-retry.test.ts covers the file-check
 *    follow-up route the recovery mirrors.
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
import { runFactsBackstop, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { FACT_WITHDRAWN_MESSAGE, recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { prepareManagedFactsSession, type FrozenExtractedFact, type ManagedFactIntent } from '../src/core/persistence/facts-maintenance.ts';
import { admitWriteInTransaction } from '../src/core/persistence/journal.ts';
import { digest } from '../src/core/persistence/digest.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const ENTITY = 'people/alice-example';
const ORIGIN = 'meetings/synthetic-workshop';
const COMPLETE = '__managed_facts_complete__';
const WITHDRAWN = 'Alice-example agreed to provide twelve sample kits for the synthetic workshop.';
const NOVEL = 'Alice-example will verify the synthetic room booking in November.';
const BODY = `# Synthetic workshop\n\nNotes from the synthetic workshop planning call, kept for the regression. ${WITHDRAWN} ${NOVEL}\n`;

const engines: BrainEngine[] = [];
const dbDir = mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-recovery-db-'));
let closePostgres: (() => Promise<void>) | undefined;
let calls = 0;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    calls++;
    return { text: JSON.stringify({ facts: [WITHDRAWN, NOVEL].map(fact => ({ fact, entity: ENTITY, kind: 'fact', confidence: 1, notability: 'high' })) }),
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
 * A managed, database-only source with an entity page, an origin page whose body
 * the sync import extracts, and the withdrawn claim already forgotten. The
 * extraction runs like sync's post-import hook: inline, keyed by its input.
 */
async function recoverySource(engine: BrainEngine) {
  const sourceId = `w6506r-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example\n\nFictional person for the regression.\n' }, { sourceId });
  await engine.putPage(ORIGIN, { type: 'meeting', title: 'Synthetic workshop', compiled_truth: BODY }, { sourceId });
  const saved = await engine.insertFact({ fact: WITHDRAWN, entity_slug: ENTITY, visibility: 'world', kind: 'fact', source: 'fixture' }, { source_id: sourceId });
  expect((await recordFactWithdrawal(engine, saved.id, sourceId, false, { semanticReview: false })).withdrawn).toBe(true);
  await engine.setConfig('facts.default_visibility', 'world');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx: FactsBackstopCtx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, sessionId: `sync:${ORIGIN}`,
    source: 'sync:import', mode: 'inline', notabilityFilter: 'high-only', remote: false, visibility: 'world' };
  const page = () => engine.getPage(ORIGIN, { sourceId }).then(p => p!);
  const run = async (as: FactsBackstopCtx = ctx) => {
    const parsed = await page();
    return runFactsBackstop({ slug: ORIGIN, type: parsed.type, compiled_truth: parsed.compiled_truth, frontmatter: parsed.frontmatter ?? {} }, as) as
      Promise<{ inserted: number; duplicate: number; fact_ids: number[]; withdrawn_skipped?: number; write_requests?: Array<{ request_id: string; state: string }> }>;
  };
  const quiet = () => waitFor(async () => (await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')`, [sourceId]))[0].n === 0,
  { timeoutMs: 30_000, label: 'fact requests settled' });
  const journal = async () => {
    await quiet();
    return engine.executeRaw<{ id: string; slug: string; state: string; error_code: string | null; error_message: string | null; error_detail: unknown;
      batch_key: string; flag: string | null; outcome: Record<string, unknown> | null }>(
    `SELECT id,slug,state,error_code,error_message,error_detail,COALESCE(intent->>'batchKey',outcome->>'batch_key') AS batch_key,
       intent->>'withdrawn' AS flag,outcome FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence`, [sourceId]);
  };
  const summary = async () => (await journal()).map(row => `${row.slug}:${row.state}${row.error_code ? `:${row.error_code}` : ''}${row.flag ? `:${row.flag}` : ''}`);
  const receipts = (ids: string[]) => engine.executeRaw<{ row: string }>(
    `SELECT to_jsonb(r)::text AS row FROM persistence_requests r WHERE id = ANY($1::uuid[]) ORDER BY sequence`, [ids]).then(rows => rows.map(row => row.row));
  const active = () => engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY id', [sourceId]).then(rows => rows.map(row => row.fact));
  const activeWithVisibility = () => engine.executeRaw<{ fact: string; visibility: string }>('SELECT fact,visibility FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY id', [sourceId])
    .then(rows => rows.map(row => `${row.fact}:${row.visibility}`));
  const entityFence = async () => (await engine.getPage(ENTITY, { sourceId }))!.compiled_truth;
  /**
   * The batch master left behind: the input-keyed session's batch key and completion id,
   * entity and completion requests admitted with the retained facts and no skip flag.
   */
  const seedLegacyBatch = async (as: FactsBackstopCtx = ctx) => {
    const session = (await prepareManagedFactsSession(as, { turnText: BODY, pageSlug: ORIGIN }))!;
    const origin = await engine.readPageSnapshot(ORIGIN, { sourceId });
    const entity = await engine.readPageSnapshot(ENTITY, { sourceId });
    const facts: FrozenExtractedFact[] = [WITHDRAWN, NOVEL].map(fact => ({ fact, entity_slug: ENTITY, visibility: 'world', kind: 'fact', source: 'sync:import',
      notability: 'high', confidence: 1, context: ORIGIN, source_session: `sync:${ORIGIN}`, embedding: null, valid_from: new Date().toISOString(), valid_until: null }));
    const shared = { batchKey: session.batchKey, inputDigest: session.inputDigest, origin: { slug: ORIGIN, pageId: origin!.page.id, revision: origin!.revision }, originalRequestId: null };
    const admission = { principal: session.authority.principal, authority: session.authority, operation: 'extract_facts', sourceId, sourceIncarnation: session.authority.sourceIncarnation };
    await engine.transaction(async tx => {
      const entityIntent: ManagedFactIntent = { kind: 'managed_facts_entity', ...shared, embedding: null, expected_revision: entity!.revision, facts };
      const row = await admitWriteInTransaction(tx, { ...admission, requestId: randomUUID(), slug: ENTITY, pageId: entity!.page.id, callerIntent: entityIntent, intent: entityIntent });
      const completion: ManagedFactIntent = { kind: 'managed_facts_complete', ...shared, children: [row.id] };
      await admitWriteInTransaction(tx, { ...admission, requestId: session.completionRequestId, slug: COMPLETE, pageId: null, callerIntent: completion, intent: completion });
    });
    return session;
  };
  return { sourceId, ctx, run, journal, summary, receipts, active, activeWithVisibility, entityFence, seedLegacyBatch, quiet };
}

async function onEachEngine(label: string, body: (engine: BrainEngine) => Promise<void>) {
  for (const engine of engines) {
    const home = mkdtempSync(join(tmpdir(), `gbrain-withdrawal-recovery-${label}-`));
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

const legacyRefusal = [`${ENTITY}:failed:invalid_params`, `${COMPLETE}:conflict:revision_conflict`];

describe('a stored facts batch refused for a withdrawn claim (#6506, UC1)', () => {
  for (const shape of ['typed detail', 'pre-detail receipt'] as const) {
    test(`${shape}: the next run follows up with the retained facts, skipping the withdrawn claim, with no model call`, async () => {
      await onEachEngine(shape === 'typed detail' ? 'typed' : 'legacy', async engine => {
        const s = await recoverySource(engine);
        const session = await s.seedLegacyBatch();
        await expect(s.run()).rejects.toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
        expect(await s.summary()).toEqual(legacyRefusal);
        expect(calls).toBe(0);
        if (shape === 'pre-detail receipt') await engine.executeRaw('UPDATE persistence_requests SET error_detail=NULL WHERE source_id=$1 AND slug=$2', [s.sourceId, ENTITY]);
        const legacy = await s.journal();
        expect(legacy[0].error_message).toBe(FACT_WITHDRAWN_MESSAGE);
        expect(legacy[0].error_detail).toEqual(shape === 'typed detail' ? expect.objectContaining({ origin: 'withdrawal' }) : null);
        const legacyRows = await s.receipts(legacy.map(row => row.id));
        const fenceBefore = await s.entityFence();

        const recovered = await s.run();
        expect(recovered).toMatchObject({ inserted: 1, duplicate: 0, withdrawn_skipped: 1 });
        expect(recovered.fact_ids).toHaveLength(1);
        expect(await s.active()).toEqual([NOVEL]);
        expect(await s.entityFence()).toContain(NOVEL);
        expect(await s.entityFence()).not.toBe(fenceBefore);
        expect(calls).toBe(0);
        const after = await s.journal();
        expect(after.map(row => `${row.slug}:${row.state}${row.error_code ? `:${row.error_code}` : ''}${row.flag ? `:${row.flag}` : ''}`))
          .toEqual([...legacyRefusal, `${ENTITY}:committed:skip`, `${COMPLETE}:committed`]);
        expect(await s.receipts(legacy.map(row => row.id))).toEqual(legacyRows);
        const followUpKey = digest([session.batchKey, 'withdrawal-retry', 1]);
        expect(after.slice(2).map(row => row.batch_key)).toEqual([followUpKey, followUpKey]);
        expect(after[2].outcome).toMatchObject({ inserted: 1, withdrawn_skipped: 1 });
        expect(after[3].outcome).toMatchObject({ status: 'completed', inserted: 1, withdrawn_skipped: 1, entity_requests: 1 });

        const replay = await s.run();
        expect(replay).toEqual(recovered);
        expect(calls).toBe(0);
        expect(await s.journal()).toHaveLength(4);
      });
    }, 180_000);
  }

  test('a default visibility narrowed to private since the refusal narrows the novel claim but never re-saves the forgotten one', async () => {
    await onEachEngine('narrow', async engine => {
      const s = await recoverySource(engine);
      await s.seedLegacyBatch();
      await expect(s.run()).rejects.toMatchObject({ code: 'invalid_params' });
      expect(await s.summary()).toEqual(legacyRefusal);
      await engine.setConfig('facts.default_visibility', 'private');
      const recovered = await s.run();
      expect(recovered).toMatchObject({ inserted: 1, withdrawn_skipped: 1 });
      expect(await s.activeWithVisibility()).toEqual([`${NOVEL}:private`]);
      expect(await s.summary()).toEqual([...legacyRefusal, `${ENTITY}:committed:skip`, `${COMPLETE}:committed`]);
      expect(calls).toBe(0);
    });
  }, 180_000);

  test('a follow-up that keeps racing a withdrawal gets three attempts, then the refusal stands with nothing published', async () => {
    await onEachEngine('cap', async engine => {
      const s = await recoverySource(engine);
      await s.seedLegacyBatch();
      await expect(s.run()).rejects.toMatchObject({ code: 'invalid_params' });
      expect(await s.summary()).toEqual(legacyRefusal);
      const unforget = () => engine.executeRaw(`DELETE FROM fact_withdrawals WHERE source_id=$1 AND fact_hash=gbrain_fact_fingerprint($2)`, [s.sourceId, NOVEL]);
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:prepared' || detail.operation !== 'extract_facts' || detail.sourceId !== s.sourceId) return;
        await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES($1,'world',$2,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING`,
          [s.sourceId, ENTITY, NOVEL]);
      });
      const fenceBefore = await s.entityFence();
      for (let followUps = 1; followUps <= 3; followUps++) {
        await expect(s.run()).rejects.toMatchObject({ code: 'revision_conflict' });
        const journal = await s.journal();
        expect(journal).toHaveLength(2 * (followUps + 1));
        expect(journal.slice(-2).map(row => `${row.slug}:${row.state}:${row.error_code}`)).toEqual([`${ENTITY}:conflict:revision_conflict`, `${COMPLETE}:conflict:revision_conflict`]);
        expect(journal.at(-2)!.error_detail).toMatchObject({ origin: 'withdrawal', withdrawn: { subject: ENTITY, visibility: 'world' } });
        await unforget();
      }
      installFaultHook(undefined);
      await expect(s.run()).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(await s.journal()).toHaveLength(8);
      expect(await s.active()).toEqual([]);
      expect(await s.entityFence()).toBe(fenceBefore);
      expect(calls).toBe(0);
    });
  }, 240_000);

  test('an origin page whose revision moved since the refusal admits the follow-up but publishes nothing from the stale text', async () => {
    await onEachEngine('origin', async engine => {
      const s = await recoverySource(engine);
      await s.seedLegacyBatch();
      await expect(s.run()).rejects.toMatchObject({ code: 'invalid_params' });
      expect(await s.summary()).toEqual(legacyRefusal);
      // A title change moves the page revision while the extracted body stays the same, so the input digest (and the batch) is unchanged.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.putPage(ORIGIN, { type: 'meeting', title: 'Synthetic workshop (renamed)', compiled_truth: BODY }, { sourceId: s.sourceId });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const fenceBefore = await s.entityFence();
      await expect(s.run()).rejects.toMatchObject({ code: 'revision_conflict' });
      const journal = await s.journal();
      expect(journal.map(row => `${row.slug}:${row.state}:${row.error_code}`)).toEqual([...legacyRefusal, `${ENTITY}:conflict:revision_conflict`, `${COMPLETE}:conflict:revision_conflict`]);
      expect(journal[2].error_message).toContain('source page changed');
      expect(journal[2].flag).toBe('skip');
      expect(await s.active()).toEqual([]);
      expect(await s.entityFence()).toBe(fenceBefore);
      expect(calls).toBe(0);
    });
  }, 180_000);

  test('a refusal of another kind, or one without retained facts, is not followed up', async () => {
    await onEachEngine('other', async engine => {
      for (const tamper of [`error_code='invalid_params', error_message='invalid_params: something else', error_detail=NULL`, `intent = intent - 'facts'`]) {
        const s = await recoverySource(engine);
        await s.seedLegacyBatch();
        await expect(s.run()).rejects.toMatchObject({ code: 'invalid_params' });
        expect(await s.summary()).toEqual(legacyRefusal);
        await engine.executeRaw(`UPDATE persistence_requests SET ${tamper} WHERE source_id=$1 AND slug=$2`, [s.sourceId, ENTITY]);
        const before = await s.receipts((await s.journal()).map(row => row.id));
        await expect(s.run()).rejects.toMatchObject({ code: 'invalid_params' });
        expect(await s.summary()).toEqual(legacyRefusal);
        expect(await s.receipts((await s.journal()).map(row => row.id))).toEqual(before);
        expect(await s.active()).toEqual([]);
        expect(calls).toBe(0);
      }
    });
  }, 240_000);

  test('a batch admitted under a request id replays its receipt; the follow-up route is for input-keyed batches', async () => {
    await onEachEngine('keyed', async engine => {
      const s = await recoverySource(engine);
      const keyed: FactsBackstopCtx = { ...s.ctx, requestId: randomUUID() };
      await s.seedLegacyBatch(keyed);
      await expect(s.run(keyed)).rejects.toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
      expect(await s.summary()).toEqual(legacyRefusal);
      const before = await s.receipts((await s.journal()).map(row => row.id));
      await expect(s.run(keyed)).rejects.toMatchObject({ code: 'invalid_params', message: FACT_WITHDRAWN_MESSAGE });
      expect(await s.summary()).toEqual(legacyRefusal);
      expect(await s.receipts((await s.journal()).map(row => row.id))).toEqual(before);
      expect(await s.active()).toEqual([]);
      expect(calls).toBe(0);
    });
  }, 180_000);
});

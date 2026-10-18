/**
 * GBRA-130 A-36: a managed facts batch whose one entity request ended terminal on a code other than
 * `source_changed` or a withdrawal refusal (here `revision_conflict`: the entity page changed between
 * admission and publication) used to throw on the first uncommitted row (`collectManagedFacts` called
 * `writeResponse` per row). The first run threw, every replay under the same request id threw again, and a
 * facts-absorb job dead-lettered after five attempts, although the other entity's facts committed and stayed.
 *
 * Automatic extraction now collects every row: committed entities are counted, an entity refused for its own
 * page is reported under `refused` (slug, code, request id), and the batch's completion receipt (refused as
 * incomplete) is not an error of its own. A run-scoped failure, or a write still pending, throws after the
 * collection. Explicit fact writers (remember, the fence writers) keep the refusal.
 *
 * Seam: the persistence fault hook runs another coordinated write on entity B as B's fact request is prepared,
 * which is what any write landing on B between admission and publication does. PGLite; Postgres when
 * DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { publishManagedEntityFacts } from '../../src/core/facts/managed-fact-write.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, runScopedErrors, snapshotItems } from './harness.ts';

const A = 'people/alice-example';
const B = 'companies/acme-example';
const BYSTANDER = 'notes/a36-bystander';
const COMPLETE = '__managed_facts_complete__';
let extractions = 0;

beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    extractions++;
    return { text: JSON.stringify({ facts: [
      { fact: 'Alice Example leads the platform team.', kind: 'fact', entity: A, confidence: 1, notability: 'high' },
      { fact: 'Acme Example opened a second office.', kind: 'fact', entity: B, confidence: 1, notability: 'high' },
    ] }), blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
  });
});
afterEach(() => { installFaultHook(undefined); });
afterAll(() => { __setChatTransportForTests(null); resetGateway(); });

type AtB = (engine: BrainEngine, sourceId: string) => Promise<void>;
interface Source { sourceId: string; ctx: OperationContext; reachedB: () => number }

/** A managed, database-only source holding both entity pages and a bystander; `atB` runs once as B's first fact request is prepared. */
async function managedSource(engine: BrainEngine, atB: AtB, run: (s: Source) => Promise<void>) {
  const sourceId = `a36-${Math.random().toString(36).slice(2, 10)}`;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-a36-'));
  let reached = 0;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage(A, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example is a person.', timeline: '', frontmatter: {} }, { sourceId });
      await engine.putPage(B, { type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example is a company.', timeline: '', frontmatter: {} }, { sourceId });
      await engine.putPage(BYSTANDER, { type: 'note', title: 'Bystander', compiled_truth: 'An unrelated note.', timeline: '', frontmatter: {} }, { sourceId });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:preparing' || detail.sourceId !== sourceId || detail.operation !== 'extract_facts' || reached) return;
        const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE id=$1::uuid', [detail.writeId]);
        if (row?.slug !== B) return;
        reached++;
        await atB(engine, sourceId);
      });
      const ctx = { engine, config: { engine: engine.kind }, remote: false as const, sourceId, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      await run({ sourceId, ctx, reachedB: () => reached });
    });
  } finally {
    installFaultHook(undefined);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(home, { recursive: true, force: true });
  }
}

/** Another coordinated write lands on B between the batch's admission and its publication. */
const editB: AtB = (engine, sourceId) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.putPage(B, { type: 'company', title: 'Acme Example',
  compiled_truth: 'Acme Example is a company. It moved offices.', timeline: '', frontmatter: {} }, { sourceId }), { requestId: null, principal: { kind: 'local_cli', id: 'a36-editor' } })).then(() => undefined);

/**
 * The fixture's pages are written before the brain turns managed, so the consumer's chunk projection catches them up
 * whenever it next runs; chunk counts are left out of the comparison here, content, liveness and links are not.
 */
async function settledItems(engine: BrainEngine, sourceId: string) {
  return new Map([...await snapshotItems(engine, sourceId)].map(([slug, { chunks: _chunks, ...row }]) => [slug, { ...row, chunks: 0 }]));
}

const requests = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ slug: string; state: string; error_code: string | null }>(
  "SELECT slug, state, error_code FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence", [sourceId]);
const factEntities = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ entity_slug: string }>(
  'SELECT entity_slug FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY entity_slug', [sourceId])).map(row => row.entity_slug);

// testBackends() directly (not pathologicalArms()): check:postgres-lanes registers a Postgres arm only from this call.
for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`A-36 managed facts batch with one refused entity (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const dbDir = mkdtempSync(join(tmpdir(), 'gbrain-a36-db-'));
    beforeAll(async () => {
      if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({ database_path: dbDir });
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); rmSync(dbDir, { recursive: true, force: true }); });

    test('A-36 item: an entity refused for its own page is reported, the committed entity is counted, and the replay returns the same without a model call', async () => {
      await managedSource(engine, editB, async ({ sourceId, ctx, reachedB }) => {
        extractions = 0;
        const requestId = randomUUID();
        const extract = () => operationsByName.extract_facts.handler(ctx, { turn_text: 'Synthetic meeting record about Alice Example and Acme Example.',
          visibility: 'world', request_id: requestId }) as Promise<{ inserted: number; refused?: Array<{ slug: string; code: string; request_id: string }> }>;
        const before = await settledItems(engine, sourceId);
        const first = await expectUnitNotAborted(extract);
        expect(reachedB()).toBe(1);
        expect(first.inserted).toBe(1);
        expect(first.refused).toHaveLength(1);
        expectItemFailure({ ...first.refused![0], key: first.refused![0]!.slug }, { key: B, code: 'revision_conflict' });
        expect(await requests(engine, sourceId)).toEqual([
          { slug: A, state: 'committed', error_code: null },
          { slug: B, state: 'conflict', error_code: 'revision_conflict' },
          { slug: COMPLETE, state: 'conflict', error_code: 'revision_conflict' },
        ]);
        expect(await factEntities(engine, sourceId)).toEqual([A]);
        expectOthersUnchanged(before, await settledItems(engine, sourceId), { changed: [A, B] });
        const replay = await expectUnitNotAborted(extract);
        expect(replay).toMatchObject({ inserted: 1, refused: first.refused });
        expect(extractions).toBe(1);
      });
    }, 180_000);

    for (const { name, error } of runScopedErrors()) {
      test(`A-36 run: a run-scoped failure at an entity's publication is never reported as that entity's refusal (${name})`, async () => {
        await managedSource(engine, async () => { throw error(); }, async ({ sourceId, ctx, reachedB }) => {
          const before = await settledItems(engine, sourceId);
          const outcome = await (operationsByName.extract_facts.handler(ctx, { turn_text: 'Synthetic meeting record about Alice Example and Acme Example.',
            visibility: 'world', request_id: randomUUID() }) as Promise<{ refused?: unknown }>).then(result => ({ result }), (thrown: Error) => ({ thrown }));
          expect(reachedB()).toBe(1);
          const b = (await requests(engine, sourceId)).find(row => row.slug === B)!;
          const after = await settledItems(engine, sourceId);
          // The extraction stops on the failure and B is left as it was, or the consumer retried the transient one and B committed; never a refusal.
          if ('result' in outcome) expect({ refused: outcome.result.refused ?? null, b: b.state }).toEqual({ refused: null, b: 'committed' });
          else expect({ b: b.state === 'committed', content: after.get(B)?.content_hash === before.get(B)?.content_hash }).toEqual({ b: false, content: true });
          expectOthersUnchanged(before, after, { changed: [A, B] });
        });
      }, 180_000);
    }

    test('A-36 explicit: a fact writer that names its entity still refuses when that entity changed after admission', async () => {
      await managedSource(engine, editB, async ({ sourceId, reachedB }) => {
        const facts = [{ fact: 'Acme Example hired a new CFO.', kind: 'fact', source: 'test', notability: 'high', sessionId: null, visibility: 'world', confidence: 1 }];
        const refusal = await publishManagedEntityFacts(engine, sourceId, B, facts as never).then(() => null, (thrown: { code?: string }) => thrown);
        expect(reachedB()).toBe(1);
        expect(refusal).toMatchObject({ code: 'revision_conflict' });
      });
    }, 180_000);
  });
}

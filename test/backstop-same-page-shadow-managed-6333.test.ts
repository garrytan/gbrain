/**
 * #6333 (wave 16 G2.5, T2/R30): the same-page rewording shadow counter lived
 * only in the unmanaged backstop loop; on a managed brain
 * (`persistence_brain.enabled`) extraction publishes through
 * `publishManagedFacts` and `facts-prepare.ts`, so the counter never fired
 * and the measurement the parked rule waits for could not accumulate on a
 * managed brain. The managed preparer now mirrors the predicate: a rewording
 * is counted as `would_dedup_same_page` on the entity receipt, the completion
 * receipt and the extraction result, and named on stderr; both facts are kept.
 *
 * Negatives (0): another visibility, another lane, another session. A replay
 * under the same request id reports the frozen count with no model call. No dedup
 * behaviour changes; zero model calls (stub transports). PGLite and Postgres.
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
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const ENTITY = 'people/alice-example';
const LONG_BODY = 'this is a real meeting note longer than 80 chars '.repeat(3);

const engines: BrainEngine[] = [];
const dbDir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-managed-db-'));
let closePostgres: (() => Promise<void>) | undefined;
let calls = 0;

/** Unit vectors at cosine exactly 0.9 within one page and orthogonal across pages (as in the unmanaged test). */
let nextDim = 0;
const pageDim = new Map<string, number>();
function vectorFor(key: string): number[] {
  if (!pageDim.has(key)) pageDim.set(key, nextDim++);
  const v = new Array<number>(DIMS).fill(0);
  v[pageDim.get(key)!] = Math.sqrt(0.9);
  v[nextDim++] = Math.sqrt(0.1);
  return v;
}

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
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
afterEach(() => { __setChatTransportForTests(null); __setEmbedTransportForTests(null); });
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dbDir, { recursive: true, force: true });
});

function stub(fact: string, vector: number[]) {
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    calls++;
    return { text: JSON.stringify({ facts: [{ fact, kind: 'fact', entity: ENTITY, confidence: 1, notability: 'high' }] }),
      blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' };
  });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => vector) })) as never);
}

type Extracted = { inserted: number; duplicate: number; would_dedup_same_page?: number };
type Seed = { fact: string; visibility?: 'world' | 'private'; source?: string; session?: string | null };

/**
 * A managed, database-only source with the entity page and, optionally, earlier facts about it (seeded before the
 * brain turns managed, each with the page vector so it is the nearest candidate of the next extraction).
 */
async function managedSource(engine: BrainEngine, seeds: Seed[] = []) {
  const sourceId = `w6333-${Math.random().toString(36).slice(2, 10)}`;
  const session = `sync:${sourceId}`;
  const vector = () => Float32Array.from(vectorFor(sourceId));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example is a person.', timeline: '', frontmatter: {} }, { sourceId });
  for (const seed of seeds) {
    await engine.insertFact({ fact: seed.fact, entity_slug: ENTITY, kind: 'fact', visibility: seed.visibility ?? 'world', source: seed.source ?? 'mcp:extract_facts',
      source_session: seed.session === undefined ? session : seed.session, embedding: vector(), embedding_model: 'openai:text-embedding-3-small' }, { source_id: sourceId });
  }
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx = { engine, config: { engine: engine.kind }, remote: false as const, sourceId, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  const extract = async (fact: string, requestId?: string): Promise<Extracted> => {
    stub(fact, vectorFor(sourceId));
    return operationsByName.extract_facts.handler(ctx, { turn_text: `Synthetic meeting record. ${fact}`, visibility: 'world', session_id: session,
      ...(requestId ? { request_id: requestId } : {}) }) as Promise<Extracted>;
  };
  const rows = () => engine.executeRaw<{ id: number; fact: string }>(
    'SELECT id, fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY id', [sourceId]);
  const receipts = () => engine.executeRaw<{ slug: string; state: string; shadow: string | null }>(
    `SELECT slug, state, outcome->>'would_dedup_same_page' AS shadow FROM persistence_requests WHERE source_id=$1 AND operation='extract_facts' ORDER BY sequence`, [sourceId]);
  return { sourceId, session, extract, rows, receipts };
}

async function onEachEngine(body: (engine: BrainEngine) => Promise<void>) {
  for (const engine of engines) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-managed-'));
    calls = 0;
    try { await withEnv({ GBRAIN_HOME: home }, () => body(engine)); }
    finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(home, { recursive: true, force: true });
    }
  }
}

describe('#6333 shadow counter on a managed brain', () => {
  test('a same-page rewording is counted once on the entity receipt, the completion and the result; both facts are kept; the replay reports the frozen count', async () => {
    await onEachEngine(async engine => {
      const s = await managedSource(engine);
      const warned: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
      try {
        const first = await s.extract('Alice Example leads the platform team at the example company');
        expect(first.inserted).toBe(1);
        expect(first.would_dedup_same_page ?? 0).toBe(0);
        const requestId = randomUUID();
        const second = await s.extract('Alice Example is the lead of the example company platform team', requestId);
        expect(second.would_dedup_same_page).toBe(1);
        expect(second.inserted).toBe(1);
        expect(second.duplicate).toBe(0);
        const rows = await s.rows();
        expect(rows.map(row => row.fact)).toEqual([
          'Alice Example leads the platform team at the example company',
          'Alice Example is the lead of the example company platform team',
        ]);
        expect(warned.filter(line => line.includes('#6333 shadow'))).toEqual([
          `[facts-backstop] #6333 shadow: new fact in session ${s.session} rewords fact ${rows[0].id} (cosine 0.900); both kept`,
        ]);
        const receipts = await s.receipts();
        expect(receipts.map(row => [row.slug, row.state, row.shadow])).toEqual([
          [ENTITY, 'committed', null], ['__managed_facts_complete__', 'committed', null],
          [ENTITY, 'committed', '1'], ['__managed_facts_complete__', 'committed', '1'],
        ]);
        expect(calls).toBe(2);

        const replay = await s.extract('Alice Example is the lead of the example company platform team', requestId);
        expect(replay.would_dedup_same_page).toBe(1);
        expect(replay.inserted).toBe(1);
        expect(calls).toBe(2);
        expect(await s.rows()).toEqual(rows);
        expect(await s.receipts()).toEqual(receipts);
        expect(warned.filter(line => line.includes('#6333 shadow'))).toHaveLength(1);
      } finally { console.warn = original; }
    });
  }, 120_000);

  test('another visibility, another lane and another session are never counted; every fact is kept', async () => {
    await onEachEngine(async engine => {
      for (const [label, seed] of [
        ['visibility', { fact: 'Alice Example moved the weekly sync to Tuesday mornings', visibility: 'private' as const }],
        ['lane', { fact: 'Alice Example moved the weekly sync to Tuesday mornings', source: 'fixture:import' }],
        ['session', { fact: 'Alice Example moved the weekly sync to Tuesday mornings', session: 'sync:another-example' }],
      ] as const) {
        const s = await managedSource(engine, [seed]);
        const r = await s.extract('Alice Example shifted the weekly sync to Tuesday mornings');
        expect(r.would_dedup_same_page ?? 0, label).toBe(0);
        expect(r.inserted, label).toBe(1);
        expect((await s.rows()).map(row => row.fact), label).toEqual([seed.fact, 'Alice Example shifted the weekly sync to Tuesday mornings']);
        expect((await s.receipts()).map(row => row.shadow), label).toEqual([null, null]);
      }
      const same = await managedSource(engine, [{ fact: 'Alice Example moved the weekly sync to Tuesday mornings' }]);
      const counted = await same.extract('Alice Example shifted the weekly sync to Tuesday mornings');
      expect(counted.would_dedup_same_page).toBe(1);
      expect(await same.rows()).toHaveLength(2);
    });
  }, 120_000);
});

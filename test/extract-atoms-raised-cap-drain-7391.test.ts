/**
 * #7391: a drain under a raised `cycle.extract_atoms.max_input_chars` reported
 * drained with zero batches while pages cut at a lower cap waited. The drain
 * counts its backlog before each batch, `countExtractAtomsBacklog` skipped every
 * partial disposition, and the raised-cap release runs only inside
 * `runPhaseExtractAtoms`, which a zero count never reaches.
 *
 * Protects: the backlog count offers a partial disposition recorded below the
 * current cap (the release condition the phase applies), so the drain runs a
 * batch that reads the whole page and records completion; at an unchanged cap
 * the page stays skipped and the drain does no model work; another source's
 * partial page is neither released nor processed; counting writes nothing.
 * Seams: the gateway chat transport (no provider call); PGLite always,
 * Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const KNOB = 'cycle.extract_atoms.max_input_chars';
const CAP = 2_000;
const SLUG = 'notes/launch-decision';
const BODY = 'The team decided to measure every launch against clear exit criteria. '.repeat(40)
  + 'TAIL: the launch also needs an independent review.';

let prompts: string[] = [];

async function seed(engine: BrainEngine, sourceId: string): Promise<void> {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
  await engine.putPage(SLUG, { type: 'note', title: 'Launch decision', compiled_truth: BODY, timeline: '' }, { sourceId });
}

/** One phase run at the current cap: the page is cut and gets a partial disposition. */
async function cutOnce(engine: BrainEngine, sourceId: string): Promise<void> {
  const result = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [] });
  expect(result.details.input_truncated).toBe(1);
}

const pageState = (engine: BrainEngine, sourceId: string) =>
  engine.executeRaw<{ tombstoned: boolean; partial_input_chars: number | null }>(
    `SELECT scan.tombstoned, scan.partial_input_chars FROM extract_atoms_page_state scan
      JOIN pages p ON p.id=scan.page_id AND scan.content_hash=p.content_hash WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, SLUG]);

const drain = (engine: BrainEngine, sourceId: string) =>
  runExtractAtomsDrainForSource(engine, { sourceId, windowSeconds: 60, maxBatches: 3 });

describe('extract_atoms drain under a raised input cap (#7391)', () => {
  const engines: Array<{ backend: string; engine: BrainEngine; close: () => Promise<void> }> = [];

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    __setChatTransportForTests(async opts => {
      prompts.push(JSON.stringify(opts.messages));
      const text = JSON.stringify([{ title: 'Measure every launch', atom_type: 'insight', body: 'Measure every launch against clear exit criteria.' }]);
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model!, providerId: 'anthropic' };
    });
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine, close: () => engine.disconnect() });
      } else {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engines.push({ backend, engine: isolated.engine, close: isolated.close });
      }
    }
  }, 120_000);
  afterAll(async () => {
    __setChatTransportForTests(null);
    resetGateway();
    for (const { engine, close } of engines) { await disposePersistenceConsumer(engine); await close(); }
  });

  test('a raised cap turns a zero ordinary backlog into one batch that completes the page; other sources stay put', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-raised-cap' }, async () => {
      for (const { backend, engine } of engines) {
        await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
        await engine.setConfig('generations.shrink_floor', '0.05');
        await engine.setConfig(KNOB, String(CAP));
        const sourceId = `raised-${backend}`;
        const sibling = `sibling-${backend}`;
        await seed(engine, sourceId);
        await seed(engine, sibling);
        await cutOnce(engine, sourceId);
        await cutOnce(engine, sibling);
        expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);

        prompts = [];
        const unchanged = await drain(engine, sourceId);
        expect(unchanged.stopped, backend).toBe('drained');
        expect(unchanged.batches, backend).toBe(0);
        expect(prompts, backend).toHaveLength(0);

        await engine.setConfig(KNOB, String(CAP * 2));
        const raised = await drain(engine, sourceId);
        expect(raised.stopped, backend).toBe('drained');
        expect(raised.batches, backend).toBe(1);
        expect(raised.input_truncated, backend).toBe(0);
        expect(raised.remaining, backend).toBe(0);
        expect(prompts, backend).toHaveLength(1);
        expect(prompts[0], backend).toContain('TAIL:');
        expect(await pageState(engine, sourceId), backend).toEqual([{ tombstoned: true, partial_input_chars: null }]);
        expect((await drain(engine, sourceId)).batches, backend).toBe(0);

        expect(await countExtractAtomsBacklog(engine, sibling), backend).toBe(1);
        expect(await pageState(engine, sibling), backend).toEqual([{ tombstoned: false, partial_input_chars: CAP }]);
        expect(prompts, backend).toHaveLength(1);
      }
    });
  }, 120_000);

  test('managed: a raised cap offers the partial checkpoint and the drain completes it through the coordinator', async () => {
    for (const backend of testBackends()) {
      const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
      await managedBrain(async ({ engine }) => {
        await withEnv({ ANTHROPIC_API_KEY: 'sk-test-raised-cap' }, async () => {
          await cutOnce(engine, 'default');
          await disposePersistenceConsumer(engine);
          expect(await countExtractAtomsBacklog(engine, 'default'), backend).toBe(0);
          prompts = [];
          expect((await drain(engine, 'default')).batches, backend).toBe(0);
          expect(prompts, backend).toHaveLength(0);

          await engine.setConfig(KNOB, String(CAP * 2));
          const raised = await drain(engine, 'default');
          await disposePersistenceConsumer(engine);
          expect(raised.batches, backend).toBe(1);
          expect(raised.remaining, backend).toBe(0);
          expect(prompts, backend).toHaveLength(1);
          expect(prompts[0], backend).toContain('TAIL:');
          expect((await engine.executeRaw<{ status: string }>(
            "SELECT outcome->>'status' AS status FROM persistence_requests WHERE slug='__managed_atom_complete__' ORDER BY sequence"))
            .map(row => row.status), backend).toEqual(['partial', 'completed']);
          expect(await countExtractAtomsBacklog(engine, 'default'), backend).toBe(0);
        });
      }, { databaseUrl, setup: async ({ engine }) => {
        await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
        await engine.setConfig('generations.shrink_floor', '0.05');
        await engine.setConfig(KNOB, String(CAP));
        await seed(engine, 'default');
      } });
    }
  }, 180_000);
});

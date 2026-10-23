/** #7391: the pre-batch count must see partial inputs eligible under a raised cap,
 * without clearing their dispositions before the phase's writer preflight.
 * Existing truncation tests call the phase directly, bypassing the drain's
 * initial zero-count short circuit. No new production test seam is required. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const KNOB = 'cycle.extract_atoms.max_input_chars';
const CAP = 2_000;
const body = 'The team decided to measure every launch against clear exit criteria. '.repeat(40)
  + 'TAIL: the launch also requires an independent review.';
const backends = testBackends();
const postgresUrl = backends.includes('postgres') ? requirePostgresTestDatabase() : undefined;
const fixtures: Array<{ backend: string; engine: BrainEngine; close?: () => Promise<void> }> = [];
let prompts: string[] = [];

async function seed(engine: BrainEngine, sourceId: string) {
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
  await engine.putPage('notes/decision', { type: 'note', title: 'Launch decision', compiled_truth: body }, { sourceId });
  await engine.setConfig(KNOB, String(CAP));
  await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
}
async function partial(engine: BrainEngine, sourceId: string) {
  const result = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [] });
  expect(result.details.input_truncated).toBe(1);
  expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
}
const scan = (engine: BrainEngine, sourceId: string) => engine.executeRaw(
  `SELECT scan.tombstoned, scan.partial_input_chars FROM extract_atoms_page_state scan
   JOIN pages p ON p.id=scan.page_id WHERE p.source_id=$1 AND p.slug='notes/decision'`, [sourceId]);
const drain = (engine: BrainEngine, sourceId: string, opts: { signal?: AbortSignal; deadlineAtMs?: number } = {}) =>
  runExtractAtomsDrainForSource(engine, { sourceId, windowSeconds: 60, maxBatches: 3, ...opts });

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  __setChatTransportForTests(async opts => {
    prompts.push(JSON.stringify(opts.messages));
    const text = '[]';
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model!, providerId: 'anthropic' };
  });
  for (const backend of backends) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      fixtures.push({ backend, engine });
    } else {
      const isolated = await isolatedPersistencePostgres(postgresUrl!);
      fixtures.push({ backend, engine: isolated.engine, close: isolated.close });
    }
  }
}, 120_000);
afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  for (const { engine, close } of fixtures) {
    await disposePersistenceConsumer(engine);
    if (close) await close(); else await engine.disconnect();
  }
});

describe('raised-cap drain eligibility (#7391)', () => {
  test('zero ordinary backlog becomes one real batch; counting is read-only and source scoped', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
      for (const { backend, engine } of fixtures) {
        const sourceId = `raised-${backend}`;
        const sibling = `sibling-${backend}`;
        await seed(engine, sourceId);
        await seed(engine, sibling);
        await partial(engine, sourceId);
        await partial(engine, sibling);
        const before = await scan(engine, sourceId);
        await engine.setConfig(KNOB, '4000');
        // This count must not release state: only the authorized phase may do so.
        expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(1);
        expect(await countExtractAtomsBacklog(engine), backend).toBe(2);
        expect(await scan(engine, sourceId), backend).toEqual(before);
        prompts = [];
        const result = await drain(engine, sourceId);
        expect(result.stopped, backend).toBe('drained');
        expect(result.batches, backend).toBe(1);
        expect(result.remaining, backend).toBe(0);
        expect(prompts, backend).toHaveLength(1);
        expect(prompts[0], backend).toContain('TAIL:');
        expect(await scan(engine, sourceId), backend).toEqual([{ tombstoned: true, partial_input_chars: null }]);
        expect(await scan(engine, sibling), backend).toEqual([{ tombstoned: false, partial_input_chars: CAP }]);
        expect(await countExtractAtomsBacklog(engine, sibling), backend).toBe(1);
        expect(await countExtractAtomsBacklog(engine), backend).toBe(1);
        expect((await drain(engine, sourceId)).batches, backend).toBe(0);
        await engine.setConfig(KNOB, '6000');
        expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);
      }
    });
  }, 120_000);

  test('unchanged and lower caps remain skipped; an insufficient raise is attempted only once', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
      for (const { backend, engine } of fixtures) {
        const sourceId = `unchanged-${backend}`;
        await seed(engine, sourceId);
        await partial(engine, sourceId);
        prompts = [];
        expect((await drain(engine, sourceId)).batches, backend).toBe(0);
        await engine.setConfig(KNOB, '1000');
        expect((await drain(engine, sourceId)).batches, backend).toBe(0);
        expect(prompts, backend).toHaveLength(0);
        await engine.setConfig(KNOB, '2100');
        const result = await drain(engine, sourceId);
        expect(result.batches, backend).toBe(1);
        expect(result.input_truncated, backend).toBe(1);
        expect(prompts, backend).toHaveLength(1);
        expect((await drain(engine, sourceId)).batches, backend).toBe(0);
      }
    });
  }, 120_000);

  test('cancelled drains retain partial state and do no model work', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
      for (const { backend, engine } of fixtures) {
        const sourceId = `cancelled-${backend}`;
        await seed(engine, sourceId);
        await partial(engine, sourceId);
        await engine.setConfig(KNOB, '4000');
        const before = await scan(engine, sourceId);
        prompts = [];
        expect((await drain(engine, sourceId, { signal: AbortSignal.abort() })).stopped, backend).toBe('aborted');
        expect(prompts, backend).toHaveLength(0);
        expect(await scan(engine, sourceId), backend).toEqual(before);
      }
    });
  }, 120_000);

  test('managed partial checkpoint is counted without mutation and completed through the normal coordinator', async () => {
    for (const backend of backends) {
      await managedBrain(async ({ engine }) => {
        await withEnv({ ANTHROPIC_API_KEY: 'test-key' }, async () => {
          await partial(engine, 'default');
          await disposePersistenceConsumer(engine);
          const checkpoint = await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-atoms'");
          expect(checkpoint).toHaveLength(1);
          await engine.setConfig(KNOB, '4000');
          expect(await countExtractAtomsBacklog(engine, 'default'), backend).toBe(1);
          expect(await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-atoms'"), backend).toEqual(checkpoint);
          prompts = [];
          await expect(withSubmissionAuthority({ version: 1, kind: 'remote_agent',
            principal: { kind: 'oauth_client', id: 'example-client' },
            grant: { scopes: ['admin'], sourceId: 'default', sourceCreatedAt: new Date().toISOString(), allowedTools: ['put_page'], allowedSlugPrefixes: ['*'] },
            payloadHash: '0'.repeat(64) }, () => drain(engine, 'default'))).rejects.toMatchObject({ code: 'permission_denied' });
          expect(prompts, backend).toHaveLength(0);
          expect(await engine.executeRaw("SELECT completed_keys FROM op_checkpoints WHERE op='managed-atoms'"), backend).toEqual(checkpoint);
          const result = await drain(engine, 'default');
          await disposePersistenceConsumer(engine);
          expect(result.batches, backend).toBe(1);
          expect(result.remaining, backend).toBe(0);
          expect(prompts, backend).toHaveLength(1);
          expect(prompts[0], backend).toContain('TAIL:');
          const outcomes = await engine.executeRaw<{ status: string }>(
            "SELECT outcome->>'status' AS status FROM persistence_requests WHERE slug='__managed_atom_complete__' ORDER BY sequence");
          expect(outcomes.map(row => row.status), backend).toEqual(['partial', 'completed']);
          expect((await drain(engine, 'default')).batches, backend).toBe(0);
          await engine.setConfig(KNOB, '6000');
          expect(await countExtractAtomsBacklog(engine, 'default'), backend).toBe(0);
        });
      }, { databaseUrl: backend === 'postgres' ? postgresUrl : undefined, setup: async ({ engine }) => seed(engine, 'default') });
    }
  }, 180_000);
});

/**
 * Fix wave 3 (CEO E2 / Eng E-D15): cycle phase containment.
 *
 * Contract: a phase that throws returns a `fail` phase result carrying the
 * typed error and later phases in the same job still run; the job still
 * reports the failure. Cancellation, a lost cycle lease and budget exhaustion
 * are never contained. A contained failure after paid model calls counts in
 * doctor's dream_paid_loop check.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { timeContainedPhase } from '../src/core/cycle/phase-containment.ts';
import { countDeadDreamSubmissions, resetDreamBreakerKey } from '../src/core/cycle/dream-breaker.ts';
import { dreamPaidLoopCheck } from '../src/commands/doctor/checks/dream-breaker.ts';
import { LockStolenError } from '../src/core/db-lock.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import { chat, configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-containment-db-'));
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  __setChatTransportForTests(null);
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'dream.breaker.%'");
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
});

const containment = () => ({ engine, sourceId: 'default' });
const paidCall = async () => {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: 'ok', blocks: [], stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'stub:stub', providerId: 'stub' }));
  try { await chat({ messages: [{ role: 'user', content: 'x' }] }); } finally { __setChatTransportForTests(null); }
};

test('a throwing phase becomes a fail result carrying its typed error', async () => {
  const { result } = await timeContainedPhase(containment(), 'synthesize_concepts', async () => {
    throw Object.assign(new Error('This source has no designated canonical owner.'), { code: 'owner_unavailable' });
  });
  expect(result).toMatchObject({ phase: 'synthesize_concepts', status: 'fail',
    details: { contained: true, paid_model_calls: 0, paid_loop_recorded: false }, error: { code: 'owner_unavailable' } });
  expect(await countDeadDreamSubmissions(engine)).toEqual([]);
});

test('abort, a lost lease and budget exhaustion are never contained', async () => {
  const aborted = new AbortController(); aborted.abort();
  await expect(timeContainedPhase({ ...containment(), signal: aborted.signal }, 'embed', async () => { throw new Error('stopped'); }))
    .rejects.toThrow('stopped');
  const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await expect(timeContainedPhase(containment(), 'embed', async () => { throw abortError; })).rejects.toBe(abortError);
  await expect(timeContainedPhase(containment(), 'sync', async () => { throw new LockStolenError('cycle-lock'); }))
    .rejects.toBeInstanceOf(LockStolenError);
  await expect(timeContainedPhase(containment(), 'consolidate', async () => {
    throw new BudgetExhausted('cap reached', { reason: 'cost', spent: 1, cap: 1 });
  })).rejects.toBeInstanceOf(BudgetExhausted);
});

test('a contained failure after paid model calls counts in dream_paid_loop until reset', async () => {
  for (let i = 0; i < 3; i++) {
    const { result } = await timeContainedPhase(containment(), 'synthesize_concepts', async () => {
      await paidCall();
      throw new Error('publication refused after synthesis');
    });
    expect(result.details).toMatchObject({ contained: true, paid_model_calls: 1, paid_loop_recorded: true });
  }
  expect(await countDeadDreamSubmissions(engine)).toMatchObject([{ base_key: 'dream:phase:synthesize_concepts:default', dead_submissions: 3 }]);
  const check = await dreamPaidLoopCheck(engine);
  expect(check.status).toBe('warn');
  expect(check.message).toContain('dream:phase:synthesize_concepts:default (3x)');
  await resetDreamBreakerKey(engine, 'dream:phase:synthesize_concepts:default');
  expect((await dreamPaidLoopCheck(engine)).status).toBe('ok');
});

test('runCycle: a refused synthesize_concepts no longer kills the job; the next phase runs and the job reports the failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-containment-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `contain-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_SCHEMA_PACK: 'gbrain-creator', OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'false');
      for (const n of [1, 2]) {
        await submitPageMutation({ engine, sourceId, remote: false, config: { engine: 'pglite', embedding_disabled: true } as never,
          dryRun: false, logger: { info() {}, warn() {}, error() {} } }, { operation: 'put_page', params: { slug: `atoms/idea-${n}`,
          request_id: randomUUID(), content: `---\ntitle: Idea ${n}\ntype: atom\nvisibility: world\nconcepts: [moats]\n---\nAtom ${n}.` } });
      }
      // Write-through on with a filesystem root and no canonical owner: the
      // managed maintenance preflight refuses before any model work.
      await engine.setConfig('sync.write_through', 'true');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const report = await runCycle(engine, { brainDir: root, sourceId, phases: ['synthesize_concepts', 'purge'] });
      const concepts = report.phases.find(p => p.phase === 'synthesize_concepts');
      expect(concepts).toMatchObject({ status: 'fail', details: { contained: true }, error: { code: 'owner_unavailable' } });
      expect(report.phases.find(p => p.phase === 'purge')?.status).toBe('ok');
      expect(report.status).toBe('partial');
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.setConfig('sync.write_through', 'true');
    rmSync(dir, { recursive: true, force: true });
  }
});

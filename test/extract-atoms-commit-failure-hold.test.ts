/**
 * #7514: a managed atom batch whose page write ends without committing is a
 * write failure, not a provider failure. Each record names the write's request
 * id and its refusal code; the drain does not report provider_failure for it;
 * after MAX_DETERMINISTIC_FAILURES strikes on the same content the page is
 * held (doctor extract_atoms_held_failed, receipt and retry commands), and no
 * model call is made for it, before or while it is held.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, MAX_DETERMINISTIC_FAILURES } from '../src/core/cycle/extract-atoms.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { drainOutcome } from '../src/core/cycle/extract-atoms-drain-outcome.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { retryManagedAtomBatch } from '../src/core/persistence/atom-retry.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { atomHeldFailedEntry } from '../src/commands/doctor/checks/atom-holds.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await stopPersistenceConsumer(engine); await resetPgliteState(engine); });
afterAll(async () => { __setChatTransportForTests(null); await engine.disconnect(); resetGateway(); });

const atom = (title: string, body: string) => ({ title, atom_type: 'insight', body });
const ONE = JSON.stringify([atom('Measured progress', 'Measure progress against clear exit criteria.')]);
const setManaged = (on: boolean) => engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [on]);

/** The engine as the drain sees it: every provenance link write of an atom page refuses, so its publication ends in conflict. */
function refusingLinks(target: BrainEngine): BrainEngine {
  return new Proxy(target, {
    get(current, key) {
      if (key === 'addLinksBatch') return async () => { throw new OperationError('revision_conflict', 'Fixture atom publication conflict'); };
      if (key === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => current.transaction(tx => fn(refusingLinks(tx)));
      const value = Reflect.get(current, key);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
}

type Drain = (maxBatches?: number) => ReturnType<typeof runExtractAtomsDrainForSource>;
async function scenario(opts: { reply: string; refuse: boolean }, work: (ctx: { calls: () => number; drain: Drain }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-atom-commit-hold-'));
  const observed = opts.refuse ? refusingLinks(engine) : engine;
  let calls = 0;
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    calls++;
    return { text: opts.reply, blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  });
  try {
    await withEnv({ GBRAIN_HOME: home, ANTHROPIC_API_KEY: 'sk-test-atom-commit-hold' }, async () => {
      await engine.putPage('notes/2026-01-01-example', { type: 'source', title: 'Example', compiled_truth: 'A careful project record. '.repeat(40) }, { sourceId: 'default' });
      await setManaged(true);
      await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
      const drain = async (maxBatches = 10) => {
        const result = await runExtractAtomsDrainForSource(observed, { sourceId: 'default', windowSeconds: 120, maxBatches });
        await disposePersistenceConsumer(observed);
        return result;
      };
      await work({ calls: () => calls, drain });
    });
  } finally {
    __setChatTransportForTests(null);
    await disposePersistenceConsumer(observed);
    await stopPersistenceConsumer(engine);
    await setManaged(false);
    rmSync(home, { recursive: true, force: true });
  }
}

const doctorHeld = async () => (await atomHeldFailedEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!;
const uncommitted = () => engine.executeRaw<{ request_id: string; error_code: string }>(
  "SELECT request_id::text AS request_id, error_code FROM persistence_requests WHERE source_id='default' AND state IN ('conflict','failed','cancelled') ORDER BY sequence");

test('an atom batch that does not commit is a write failure: request id and code on the record, not provider_failure', async () => {
  await scenario({ reply: ONE, refuse: true }, async ({ calls, drain }) => {
    const first = await drain();
    expect(calls()).toBe(1);
    const failed = await uncommitted();
    expect(failed.length).toBeGreaterThan(0);
    expect(first.status).not.toBe('provider_failure');
    expect(first.provider_failure_class).toBeUndefined();
    expect(drainOutcome(first).code).not.toBe('atom_drain_provider_failure');
    expect(first.failures.length).toBeGreaterThan(0);
    for (const failure of first.failures) {
      expect(failed.map(row => row.request_id)).toContain(failure.request_id!);
      expect(failure.code).toBe('revision_conflict');
    }
  });
}, 90_000);

test('a repeated commit failure is held after MAX_DETERMINISTIC_FAILURES strikes, with no model call before or while held', async () => {
  await scenario({ reply: ONE, refuse: true }, async ({ calls, drain }) => {
    const first = await drain();
    expect(calls()).toBe(1);
    expect(first.failure_count).toBe(MAX_DETERMINISTIC_FAILURES);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    const doctor = await doctorHeld();
    expect(doctor.status).toBe('warn');
    const items = doctor.details?.items as Array<{ request_id: string; locator: string; failure: string; receipt_command: string; retry_command: string; attempts: number }>;
    expect(items).toHaveLength(1);
    expect(items[0].locator).toBe('notes/2026-01-01-example');
    expect(items[0].attempts).toBe(MAX_DETERMINISTIC_FAILURES);
    expect(items[0].failure).toContain('revision_conflict');
    expect(items[0].receipt_command).toBe(`gbrain write-request -- ${items[0].request_id}`);
    expect(items[0].retry_command).toContain(items[0].request_id);
    for (let window = 0; window < 2; window++) {
      const held = await drain();
      expect(calls()).toBe(1);
      expect(held.status).toBe('ok');
      expect(held.failure_count).toBe(0);
      expect(held.stopped).toBe('drained');
    }
    // The reviewed retry the hold names runs one paid extraction and clears it once the write can commit.
    expect(await retryManagedAtomBatch(engine, 'default', items[0].request_id, 'job:7514')).toMatchObject({ model_rerun: true });
    expect(calls()).toBe(2);
    await disposePersistenceConsumer(engine);
    expect((await doctorHeld()).status).toBe('ok');
    expect(await engine.executeRaw("SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL")).toHaveLength(1);
  });
}, 120_000);

test('after receipt compaction the record still names the request and its refusal code', async () => {
  await scenario({ reply: ONE, refuse: true }, async ({ calls, drain }) => {
    await drain(1);
    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE source_id='default' AND state IN ('conflict','failed')");
    expect(await compactWriteReceipts(engine)).toBeGreaterThan(0);
    const replay = await drain(1);
    expect(calls()).toBe(1);
    expect(replay.status).not.toBe('provider_failure');
    const [record] = replay.failures;
    expect(record.reason).toContain('The write did not commit.');
    expect(record.code).toBe('revision_conflict');
    expect((await uncommitted()).map(row => row.request_id)).toContain(record.request_id!);
  });
}, 120_000);

test('two atoms with one title publish as one atom instead of failing the generation', async () => {
  await scenario({ reply: JSON.stringify([atom('Measured progress', 'First body.'), atom('Measured progress', 'Second body.')]), refuse: false }, async ({ calls, drain }) => {
    const result = await drain();
    expect(calls()).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.extracted).toBe(1);
    expect(result.stopped).toBe('drained');
    expect(await uncommitted()).toEqual([]);
    expect(await engine.executeRaw("SELECT compiled_truth FROM pages WHERE type='atom' AND deleted_at IS NULL")).toEqual([{ compiled_truth: 'First body.' }]);
  });
}, 90_000);

/**
 * The storage shelf holds archive records, not pages to extract atoms from. A page of an extractable type on the shelf
 * (a stray file a hosted shelf's sync imported, say) must not be extracted: every atom write into the shelf is refused,
 * so the drain struck it until doctor extract_atoms_held_failed named the shelf. The phase skips the shelf, and the
 * check never names it.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { ensureStorageSource } from '../src/core/storage-manifest/source.ts';
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
beforeEach(async () => { await stopPersistenceConsumer(engine); await resetPgliteState(engine); await engine.unsetConfig('sync.repo_path'); });
afterAll(async () => { __setChatTransportForTests(null); await engine.disconnect(); resetGateway(); });

const REPLY = JSON.stringify([{ title: 'Measured progress', atom_type: 'insight', body: 'Measure progress against clear exit criteria.' }]);

test('the atom drain never extracts from the storage shelf, and doctor extract_atoms_held_failed never names it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-atom-shelf-'));
  let calls = 0;
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    calls++;
    return { text: REPLY, blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  });
  try {
    await withEnv({ GBRAIN_HOME: home, ANTHROPIC_API_KEY: '[redacted]' }, async () => {
      await ensureStorageSource(engine);
      await engine.putPage('notes/2026-01-01-shelf-readme', { type: 'source', title: 'Shelf readme', compiled_truth: 'A careful archive record. '.repeat(40) }, { sourceId: 'storage' });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await engine.setConfig('models.dream.extract_atoms', 'anthropic:claude-haiku-4-5');
      const result = await runExtractAtomsDrainForSource(engine, { sourceId: 'storage', windowSeconds: 120, maxBatches: 10 });
      await disposePersistenceConsumer(engine);
      expect(calls).toBe(0);
      expect(result.failure_count).toBe(0);
      const doctor = (await atomHeldFailedEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!;
      expect(doctor.status).toBe('ok');
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id='storage' AND type='atom'")).toEqual([]);
    });
  } finally {
    __setChatTransportForTests(null);
    await disposePersistenceConsumer(engine);
    await stopPersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

test('a held atom origin an earlier release left on the storage shelf is not named; one on an ordinary source still is', async () => {
  await ensureStorageSource(engine);
  const seed = async (sourceId: string, requestId: string) => {
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw("INSERT INTO op_checkpoints(op, fingerprint, completed_keys) VALUES ('managed-atoms', $1, $2::text::jsonb)", [`fixture-${sourceId}`,
      JSON.stringify([{ sourceId, incarnation, kind: 'transcript', locator: 'transcripts/2026-01-01.txt', requestId, failure: 'revision_conflict', attempts: 3, held: true, contentHash: 'c'.repeat(64) }])]);
  };
  await seed('storage', '00000000-0000-4000-8000-000000000001');
  await seed('default', '00000000-0000-4000-8000-000000000002');
  const doctor = (await atomHeldFailedEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!;
  expect(doctor.status).toBe('warn');
  expect((doctor.details?.items as Array<{ source_id: string }>).map((item) => item.source_id)).toEqual(['default']);
}, 60_000);

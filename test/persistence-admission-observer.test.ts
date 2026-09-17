import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { observeAdmissionTransactions } from '../scripts/persistence/read-admission.ts';
import { admitWrite, claimNextWrite, getWriteRequest, type WriteAdmission } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

interface Fixture { engine: BrainEngine; observations: { requestId: string; at: number }[]; }
const fixtures: Fixture[] = [];
const sourceId = 'admission-observer-example';
const hostId = randomUUID();
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema();
  const engines: BrainEngine[] = [lite];
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const original of engines) {
    const observations: Fixture['observations'] = [];
    const engine = observeAdmissionTransactions(original, (requestId, at) => observations.push({ requestId, at }));
    fixtures.push({ engine, observations });
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await registerLocalWriter(engine, 'cli');
    expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
  }
}, 120_000);
afterAll(async () => {
  await fixtures[0]?.engine.disconnect(); await closePostgres?.();
});

async function admission(engine: BrainEngine, slug: string): Promise<WriteAdmission> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const context: OperationContext = { engine, sourceId, remote: false, dryRun: false,
    config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(context, 'put_page', sourceId, source.incarnation, slug);
  const content = '---\ntitle: Admission timing example\ntype: note\n---\nCanonical publication follows durable admission.\n';
  return { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: source.incarnation,
    slug, pageId: null, requestId: randomUUID(), callerIntent: { slug, content }, intent: { slug, content }, authority };
}

test('nested admission followed by outer rollback never emits durable completion', async () => {
  for (const { engine, observations } of fixtures) {
    observations.length = 0;
    const input = await admission(engine, 'notes/rolled-back');
    await expect(engine.transaction(async tx => {
      const nested = await admitWrite(tx, input);
      expect(nested.state).toBe('queued');
      expect(observations).toEqual([]);
      throw new Error('rollback after successful nested admission');
    })).rejects.toThrow('rollback after successful nested admission');
    expect(observations).toEqual([]);
    expect(await getWriteRequest(engine, input.principal, input.requestId!)).toBeNull();
    expect(await engine.readPageSnapshot(input.slug, { sourceId })).toBeNull();
  }
});

test('admission timing precedes actual publication and survives transaction warmup', async () => {
  for (const { engine, observations } of fixtures) {
    // Warm the wrapper with real ordinary transactions, then reset the recorder.
    // No method replacement or captured recording false→true branch is used.
    for (let i = 0; i < 500; i++) await engine.transaction(async tx => {
      await tx.executeRaw('SELECT 1');
    });
    expect(observations).toHaveLength(0);
    observations.length = 0;
    const input = await admission(engine, 'notes/committed');
    const started = performance.now();
    const row = await admitWrite(engine, input);
    const admitted = observations[0];
    expect(observations).toHaveLength(1);
    expect(admitted.requestId).toBe(input.requestId!);
    expect(admitted.at).toBeGreaterThanOrEqual(started);
    expect(admitted.at).toBeLessThanOrEqual(performance.now());
    expect((await getWriteRequest(engine, input.principal, input.requestId!))?.state).toBe('queued');
    expect(await engine.readPageSnapshot(input.slug, { sourceId })).toBeNull();
    const claimed = (await claimNextWrite(engine, hostId))!;
    expect(claimed.id).toBe(row.id);
    const prepared = await preparePageMutation(engine, claimed, { engine: engine.kind });
    const committed = await publishMutation(engine, claimed, prepared, hostId);
    expect(committed.state).toBe('committed');
    expect(performance.now()).toBeGreaterThan(admitted.at);
    expect(observations).toHaveLength(1);
    expect((await engine.readPageSnapshot(input.slug, { sourceId }))?.revision).toBe(String(committed.outcome?.revision));
  }
}, 120_000);

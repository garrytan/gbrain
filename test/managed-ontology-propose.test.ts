/**
 * ontology_propose on a managed brain (eval wave N1-1).
 *
 * `gbrain init` turns managed persistence on, and the managed writer guard
 * refuses direct `facts` writes. An ontology observation is a database-only
 * fact row, so ontology_propose commits it as a coordinated write holding the
 * source capability and the entity's page key, like manual links. A direct
 * engine write stays refused, and the current-value read and revert chain
 * work through the coordinator.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-managed-ontology-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {} };
const ctxFor = (engine: BrainEngine, sourceId: string): OperationContext =>
  ({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger });

async function managed(run: (engine: BrainEngine, sourceId: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-ontology-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `onto-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, sourceId);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const E = 'people/alice-example';
const propose = (engine: BrainEngine, sourceId: string, p: Record<string, unknown>) =>
  operationsByName.ontology_propose.handler(ctxFor(engine, sourceId), { entity: E, dimension: 'location', visibility: 'world', ...p }) as Promise<{ action: string }>;
const location = async (engine: BrainEngine, sourceId: string, asof?: string) =>
  ((await operationsByName.ontology_get.handler(ctxFor(engine, sourceId), { entity: E, ...(asof ? { asof } : {}) })) as Array<{ dimension: string; value: string }>)
    .find(r => r.dimension === 'location')?.value ?? null;

test('ontology_propose commits through the coordinator on a managed brain; a direct write stays refused', async () => {
  await managed(async (engine, sourceId) => {
    await expect(engine.mergeOntologyFact({ entitySlug: E, dimension: 'location', value: 'Direct', source: 'manual', sourceId }))
      .rejects.toThrow(/writer_coordinator_required/);
    expect((await propose(engine, sourceId, { value: 'Lisbon' })).action).toBe('inserted');
    expect(await location(engine, sourceId)).toBe('Lisbon');
    expect((await propose(engine, sourceId, { value: 'Lisbon' })).action).toBe('noop');
  });
});

test('a same-provenance revert chain resolves through the coordinator', async () => {
  await managed(async (engine, sourceId) => {
    for (const [value, valid_from] of [['Lisbon', '2020-01-01'], ['Porto', '2022-01-01'], ['Lisbon', '2024-01-01']]) {
      await propose(engine, sourceId, { value, valid_from });
    }
    expect(await location(engine, sourceId)).toBe('Lisbon');
    expect(await location(engine, sourceId, '2023-06-01')).toBe('Porto');
  });
});

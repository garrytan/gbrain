/**
 * Wave 12 W4.11: a `remember` replay refused with `source_changed` (the page's
 * file and database differ) used to come back as `replay` in every preview and
 * fail the same way on every apply. It is now classified `file_database_drift`
 * with the reconcile command, in the apply outcome and in later previews,
 * until the page is written again.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../src/core/persistence/writer-guard-schema.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-replay-w411-db-'));
const logger = { info() {}, warn() {}, error() {} };
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
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
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

test('a replay refused because the page file drifted is classified file_database_drift, not replayed again and again', async () => {
  for (const engine of engines) await driftCase(engine);
}, 240_000);

async function driftCase(engine: BrainEngine): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-w411-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `w411-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/bob-example', content: '---\ntitle: Bob Example\ntype: person\n---\nBob.', request_id: randomUUID() } });
      // A remember the managed writer guard refused (stored as writer_coordinator_required); the fault hook stands in for the guard.
      installFaultHook(async point => { if (point === 'consumer:prepared') throw new Error('guard refusal stand-in'); });
      await submitRememberMutation(ctx, { fact: 'Bob prefers morning meetings', entity: 'people/bob-example', provenance: 'test', visibility: 'world', request_id: randomUUID() }).catch(() => undefined);
      installFaultHook(undefined);
      await engine.executeRaw(`UPDATE persistence_requests SET error_code='writer_coordinator_required' WHERE source_id=$1 AND operation='remember' AND state='failed'`, [sourceId]);
      // The user edits the page's file by hand; the database still holds the old body.
      const file = join(root, 'people', 'bob-example.md');
      expect(existsSync(file)).toBe(true);
      appendFileSync(file, '\nEdited in the file only.\n');

      const scope = await resolveRepairScope(engine, sourceId);
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      expect((preview.listing ?? []).map(entry => entry.class)).toEqual(['replay']);
      const applied = await (await repairRunner(engine, { apply: true, logger })).run('failed-writes', scope,
        { explicit: true, sourceFlag: sourceId, expect: preview.apply_command.split('--expect ')[1] });
      expect(applied.outcomes).toEqual({ file_database_drift: 1 });

      const again = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      expect(again.affected).toBe(0);
      expect(again.residuals).toEqual({ file_database_drift: 1 });
      const [entry] = again.listing ?? [];
      expect(entry?.class).toBe('file_database_drift');
      expect(entry?.detail).toContain(`gbrain sources reconcile ${sourceId} people/bob-example --preview`);

      // Once the page is written again (a reconcile commits a new revision), the write is a replay candidate again.
      await engine.executeRaw(`ALTER TABLE pages DISABLE TRIGGER USER`);
      await engine.executeRaw(`UPDATE pages SET updated_at = now() + interval '1 minute' WHERE source_id=$1 AND slug='people/bob-example'`, [sourceId]);
      await engine.executeRaw(`ALTER TABLE pages ENABLE TRIGGER USER`);
      const after = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      expect((after.listing ?? []).map(e => e.class)).toEqual(['replay']);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}

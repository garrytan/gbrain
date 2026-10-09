/**
 * `gbrain repair failed-writes` (#5983): caller writes the pre-fix managed
 * writer guard refused are replayed from their failed receipts' intent once
 * the guard is fixed, exactly once, and never over a later write of the page.
 * Runs on PGLite and, through test/e2e, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
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
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { installPre5983Guard } from './helpers/pre-5983-guard.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-replay-5983-db-'));
let closePostgres: (() => Promise<void>) | undefined;
const logger = { info() {}, warn() {}, error() {} };

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
  for (const engine of engines) {
    for (const table of ['tags', 'timeline_entries', 'takes']) await engine.executeRaw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_id TEXT`);
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

const ctxFor = (engine: BrainEngine, sourceId: string) =>
  ({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger }) as OperationContext;
const page = (title: string, tags: string[], body: string) => `---\ntitle: ${title}\ntype: person\ntags: [${tags.join(', ')}]\n---\n${body}`;

async function attempt(engine: BrainEngine, sourceId: string, operation: string, params: Record<string, unknown>, remote = false) {
  const ctx = { ...ctxFor(engine, sourceId), remote };
  const submit = operation === 'remember' ? submitRememberMutation(ctx, { ...params, request_id: randomUUID() })
    : submitPageMutation(ctx, { operation, params: { ...params, request_id: randomUUID() } });
  await submit.catch(() => undefined);
}

test('refused caller writes replay once from their failed receipts; later writes of the page are never overwritten', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-5983-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `r5983-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const ctx = ctxFor(engine, sourceId);
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/bob-example', content: page('Bob Example', [], 'Bob.'), request_id: randomUUID() } });
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/dana-example', content: page('Dana Example', ['v0'], 'Dana v0.'), request_id: randomUUID() } });

        await installPre5983Guard(engine);
        await attempt(engine, sourceId, 'put_page', { slug: 'people/alice-example', content: page('Alice Example', ['founder'], 'Alice builds things.') });
        await attempt(engine, sourceId, 'put_page', { slug: 'people/carol-example', content: page('Carol Example', ['old'], 'Old Carol.') });
        await attempt(engine, sourceId, 'add_timeline_entry', { slug: 'people/bob-example', date: '2026-09-30', summary: 'Met at demo day' });
        await attempt(engine, sourceId, 'add_timeline_entry', { slug: 'people/bob-example', date: '2026-09-30', summary: 'Met at demo day' });
        await attempt(engine, sourceId, 'put_page', { slug: 'people/dana-example', content: page('Dana Example', ['v1'], 'Dana v1.'), force: true });
        await attempt(engine, sourceId, 'put_page', { slug: 'people/dana-example', content: page('Dana Example', ['v2'], 'Dana v2.'), force: true });
        await attempt(engine, sourceId, 'add_timeline_entry', { slug: 'people/dana-example', date: '2026-10-01', summary: 'Remote note' }, true);
        const refused = await engine.executeRaw<{ operation: string; n: number }>(
          `SELECT operation, count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state='failed' AND error_code='writer_coordinator_required' AND error_detail->>'origin'='database_guard' GROUP BY 1 ORDER BY 1`, [sourceId]);
        expect(refused).toEqual([{ operation: 'add_timeline_entry', n: 3 }, { operation: 'put_page', n: 4 }]);
        // Receipts written before #5982 classified refusals carry the opaque storage_error shape; the selector still replays them.
        await engine.executeRaw(`UPDATE persistence_requests SET error_code='storage_error',
          error_message='Publication failed (P0001). Inspect owner diagnostics.', error_detail=NULL
          WHERE id=(SELECT id FROM persistence_requests WHERE source_id=$1 AND slug='people/alice-example' AND state='failed')`, [sourceId]);

        await engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/carol-example', content: page('Carol Example', ['new'], 'New Carol.'), request_id: randomUUID() } });

        const scope = await resolveRepairScope(engine, sourceId);
        const preview = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
        expect((preview.listing ?? []).map(entry => `${entry.item.split(' ').slice(0, 2).join(' ')} ${entry.class}`)).toEqual([
          `${sourceId}:people/alice-example put_page replay`,
          `${sourceId}:people/carol-example put_page superseded`,
          `${sourceId}:people/bob-example add_timeline_entry duplicate`,
          `${sourceId}:people/bob-example add_timeline_entry replay`,
          `${sourceId}:people/dana-example put_page superseded`,
          `${sourceId}:people/dana-example put_page replay`,
          `${sourceId}:people/dana-example add_timeline_entry replay`,
        ]);
        expect(preview.residuals).toEqual({ superseded: 2, duplicate: 1 });
        expect(preview.apply_command).toMatch(new RegExp(`^gbrain repair failed-writes --source ${sourceId} --apply --expect [0-9a-f]+$`));

        await expect((await repairRunner(engine, { apply: true, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId }))
          .rejects.toThrow(/replays only the set a preview printed/);
        const applied = await (await repairRunner(engine, { apply: true, logger })).run('failed-writes', scope,
          { explicit: true, sourceFlag: sourceId, expect: preview.apply_command!.split('--expect ')[1] });
        expect(applied.outcomes).toEqual({ replayed: 4 });

        expect((await engine.getTags('people/alice-example', { sourceId }))).toEqual(['founder']);
        expect((await engine.getTags('people/carol-example', { sourceId }))).toEqual(['new']);
        expect((await engine.getTimeline('people/bob-example', { sourceId })).map(entry => entry.summary)).toEqual(['Met at demo day']);
        expect((await engine.getPage('people/dana-example', { sourceId }))?.compiled_truth).toContain('Dana v2.');
        expect(await engine.getTags('people/dana-example', { sourceId })).toContain('v2');
        expect(await engine.getTags('people/dana-example', { sourceId })).not.toContain('v1');
        expect((await engine.getTimeline('people/dana-example', { sourceId })).map(entry => entry.summary)).toEqual(['Remote note']);
        const replays = await engine.executeRaw<{ operation: string; principal_kind: string; remote: boolean }>(
          `SELECT operation, principal_kind, (authority->>'remote')::boolean AS remote FROM persistence_requests
            WHERE source_id=$1 AND slug='people/dana-example' AND state='committed' AND operation='add_timeline_entry'`, [sourceId]);
        expect(replays).toEqual([{ operation: 'add_timeline_entry', principal_kind: 'local_stdio', remote: true }]);
        expect((await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state='failed'`, [sourceId]))[0].n).toBe(7);

        const again = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
        expect(again.affected).toBe(0);
        expect(again.residuals).toEqual({ already_written: 5, superseded: 2 });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw(MANAGED_WRITER_GUARD_FUNCTION_SQL);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);

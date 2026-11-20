/**
 * #9742: a consented manual purge (gbrain pages purge-deleted --yes, the purge_deleted_pages op) whose delete_page was
 * accepted but had not committed when its publish wait ended used to count that page as failed, report
 * managed_purge_failed and add a park strike, so after PURGE_PARK_LIMIT such runs the page was parked even though every
 * request commits later. A still-pending purge is now reported as pending with its request id: not a failure, no park.
 * It is deferred like the automatic purge's (#7587): later runs hold its source and resubmit nothing until it settles.
 * With dream.write_deferral.enabled=false it is still reported pending, code write_pending, and never parked.
 *
 * Managed repo brain on PGLite and, with DATABASE_URL, Postgres. The source's writer lock is held so the purge stays
 * pending past a short publish wait. Synthetic data only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { PURGE_PARK_LIMIT } from '../src/core/persistence/purge-parks.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { DREAM_WRITE_DEFERRAL_ENABLED_KEY, DREAM_WRITE_DEFERRALS_KEY } from '../src/core/cycle/dream-write-deferral.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-9742-db-'));
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

const logger = { info() {}, warn() {}, error() {} };
const ctxFor = (engine: BrainEngine, sourceId: string): OperationContext =>
  ({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger });

const purgeRequests = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ request_id: string; state: string }>(
  "SELECT request_id::text, state FROM persistence_requests WHERE source_id=$1 AND operation='delete_page' AND jsonb_path_exists(intent::jsonb, '$.** ? (@.purge == true)') ORDER BY sequence", [sourceId]);

async function waitSettled(engine: BrainEngine, sourceId: string) {
  for (let i = 0; i < 300; i++) {
    const rows = await purgeRequests(engine, sourceId);
    if (rows.length && rows.every(row => ['committed', 'failed', 'conflict', 'cancelled'].includes(row.state))) return rows;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('purge requests did not settle');
}

for (const [index, kind] of backends.entries()) for (const deferral of [true, false]) test(`a consented purge still pending after its wait is reported pending with its request id, never failed or parked (${kind}, deferral ${deferral ? 'on' : 'off'})`, async () => {
  {
    const engine = engines[index]!;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-9742-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `p9742-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        const ctx = ctxFor(engine, sourceId);
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/old-a', content: '---\ntitle: T\ntype: note\n---\nBody.', request_id: randomUUID() } });
        const snapshot = await engine.readPageSnapshot('notes/old-a', { sourceId });
        await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/old-a', expected_revision: snapshot!.revision, request_id: randomUUID() } });
        await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug='notes/old-a'", [sourceId]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

        if (!deferral) await engine.setConfig(DREAM_WRITE_DEFERRAL_ENABLED_KEY, 'false');
        __setMaintenanceWriteWaitForTests(300);
        const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
        try {
          for (let run = 0; run <= PURGE_PARK_LIMIT; run++) {
            const result = await purgeDeletedPagesCoordinated(engine, 72);
            expect(result.failed).toBe(0);
            expect(result.error).toBeUndefined();
            expect(result.parked).toBe(0);
            const requests = await purgeRequests(engine, sourceId);
            expect(requests.length).toBeGreaterThan(0);
            const pending = result.blocked.filter(b => b.slug === 'notes/old-a');
            expect(pending).toHaveLength(1);
            expect(pending[0]!.code).toBe(deferral ? 'dream_write_deferred' : 'write_pending');
            expect(pending[0]!.reason).toContain(requests.at(-1)!.request_id);
            if (deferral) expect(requests).toHaveLength(1);
          }
          expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='purge-deleted-park'")).toHaveLength(0);
        } finally { await lock.release(); }

        const settled = await waitSettled(engine, sourceId);
        expect(settled.filter(row => row.state === 'committed')).toHaveLength(1);
        expect(await engine.readPageSnapshot('notes/old-a', { sourceId, includeDeleted: true })).toBeNull();
      });
    } finally {
      __setMaintenanceWriteWaitForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
      await engine.executeRaw('DELETE FROM config WHERE key = ANY($1::text[])', [[DREAM_WRITE_DEFERRALS_KEY, DREAM_WRITE_DEFERRAL_ENABLED_KEY]]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 240_000);

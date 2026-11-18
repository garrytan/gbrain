/**
 * #9742: a consented (non-automatic) managed purge whose accepted delete_page is still pending after
 * the publish wait is deferred with its request id, not failed and not parked.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'manual-pending-9742';
let engine: PGLiteEngine;
let dir: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); dir = mkdtempSync(join(tmpdir(), 'gb-9742-')); }, 120_000);
afterAll(async () => { __setMaintenanceWriteWaitForTests(null); await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });

test('manual purge: a still-pending purge is deferred with its request id, not failed or parked', async () => {
  const root = join(dir, 'brain'); mkdirSync(root);
  const ctx: OperationContext = { engine, sourceId: SOURCE, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} },
    config: { engine: engine.kind, embedding_disabled: true } as never };
  const outcome = await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
    await engine.setConfig('sync.write_through', 'true');
    await claimWorktree(engine, SOURCE, root);
    const slug = 'notes/old';
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: '---\ntitle: T\ntype: note\n---\nBody.', request_id: randomUUID() } });
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: SOURCE });
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
    await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1", [SOURCE]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    __setMaintenanceWriteWaitForTests(300);
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, SOURCE))!, 1000))!;
    try {
      const result = await purgeDeletedPagesCoordinated(engine, 72);
      const parks = await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='purge-deleted-park'");
      return { result, parks: parks.length };
    } finally { await lock.release(); }
  });
  expect(outcome.result.failed).toBe(0);
  expect(outcome.result.error).toBeUndefined();
  expect(outcome.result.blocked.map(b => b.code)).toEqual(['dream_write_deferred']);
  expect(outcome.result.blocked[0]!.reason).toMatch(/request_id [0-9a-f-]{36}/);
  expect(outcome.parks).toBe(0);
}, 60_000);

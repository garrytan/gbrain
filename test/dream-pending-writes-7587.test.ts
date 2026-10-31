/**
 * Protects warning outcomes and eventual publication for slow dream writes.
 * The baseline fails consolidation containment and counts pending purges as
 * failures. Existing tests expect direct consolidation to throw, rather than
 * checking its dream outcome. Uses native locks and existing wait seams only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { timeContainedPhase } from '../src/core/cycle/phase-containment.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { acquireWorktree, claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated, purgePhaseNote, purgePhaseStatus } from '../src/core/persistence/purge-deleted.ts';
import { readPurgeParks } from '../src/core/persistence/purge-parks.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

for (const phase of ['consolidate', 'purge'] as const) {
  test(`${phase} warns for an accepted write which later commits exactly once`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-pending-'));
    const root = join(dir, 'brain');
    mkdirSync(root);
    const sourceId = `pending-${phase}`, slug = 'notes/example';
    const restore = __setMaintenanceWriteWaitForTests(100);
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        const binding = await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, dryRun: false,
          config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } };
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug,
          content: '---\ntitle: Example\ntype: note\n---\nExample evidence.', request_id: randomUUID() } });
        if (phase === 'purge') {
          const snapshot = await engine.readPageSnapshot(slug, { sourceId });
          await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
          await engine.executeRaw("UPDATE pages SET deleted_at=now()-interval '100 hours' WHERE source_id=$1", [sourceId]);
        } else {
          const vector = `[${[1, ...Array(1535).fill(0)].join(',')}]`;
          for (const word of ['alpha', 'beta', 'gamma']) {
            await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,confidence,valid_from,embedding,embedding_model,embedded_text_hash)
              VALUES($1,$2,$3,'fact','test','world',0.9,now()-interval '30 hours',$4::vector,'openai:text-embedding-3-large',md5($3))`,
            [sourceId, slug, `Example claim ${word}`, vector]);
          }
        }
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const lock = await acquireWorktree(binding, 1000);
        expect(lock).not.toBeNull();
        let row: WriteRequest;
        try {
          if (phase === 'consolidate') {
            const { result } = await timeContainedPhase({ engine, sourceId }, phase,
              () => runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 }));
            expect(result.status).toBe('warn');
            expect(result.details.contained).not.toBe(true);
            expect(result.code).toBe('write_pending');
            expect(result.summary).toContain('gbrain write-request');
            expect(await engine.executeRaw('SELECT t.id FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1', [sourceId])).toHaveLength(0);
          } else {
            const result = await purgeDeletedPagesCoordinated(engine, 72, { automatic: true });
            expect(result).toMatchObject({ count: 0, failed: 0, deferred: 1 });
            expect(result.error).toBeUndefined();
            expect(purgePhaseStatus(result)).toBe('warn');
            expect(purgePhaseNote(result)).toContain('gbrain write-request');
            expect((await readPurgeParks(engine)).size).toBe(0);
            expect(await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true })).not.toBeNull();
          }
          const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests WHERE source_id=$1
            AND (intent->>'kind'='managed_maintenance_consolidate' OR intent->>'purge'='true')`, [sourceId]);
          expect(rows).toHaveLength(1);
          row = rows[0]!;
          expect(['queued', 'running', 'recovering']).toContain(row.state);
        } finally { await lock?.release(); }
        expect((await waitForWrite(engine, row!, ctx.config, 15_000)).state).toBe('committed');
        if (phase === 'consolidate') {
          expect(await engine.executeRaw('SELECT t.id FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1', [sourceId])).toHaveLength(1);
          expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_at IS NOT NULL', [sourceId])).toHaveLength(3);
          expect((await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).details.facts_consolidated).toBe(0);
        } else {
          expect(await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true })).toBeNull();
          expect((await purgeDeletedPagesCoordinated(engine, 72)).count).toBe(0);
        }
      });
    } finally {
      restore();
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
}

test('missing or terminal receipts remain failures and cancellation still escapes containment', async () => {
  for (const state of [null, 'failed', 'committed'] as const) {
    const error = new OperationError('write_pending', 'Pending text alone is insufficient.');
    if (state) error.writeRequest = { request_id: randomUUID(), state, retry_after_ms: null };
    const { result } = await timeContainedPhase({ engine: null, sourceId: 'default' }, 'consolidate', async () => { throw error; });
    expect(result.status).toBe('fail');
  }
  const controller = new AbortController();
  controller.abort();
  const error = new OperationError('write_pending', 'Accepted.');
  error.writeRequest = { request_id: randomUUID(), state: 'queued', retry_after_ms: 100 };
  await expect(timeContainedPhase({ engine: null, sourceId: 'default', signal: controller.signal }, 'consolidate', async () => { throw error; }))
    .rejects.toBe(error);
});

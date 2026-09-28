import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
const stores: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
beforeAll(async () => {
  const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  stores.push({ engine, close: () => engine.disconnect() });
  if (process.env.DATABASE_URL) stores.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
}, 120_000);
afterAll(async () => { for (const store of stores) await store.close(); });
test('writer inspection fingerprints actual manifest contents, nulls, and every topology field on both engines', async () => {
  for (const { engine } of stores) {
    await engine.executeRaw(`INSERT INTO persistence_worktrees(id,owner_host_id,manifest) VALUES
      ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
       '{"digest":"unchanged-cached-digest","files":{"note.md":{"hash":"original"}}}')`);
    await engine.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id)
      SELECT id,incarnation,'11111111-1111-4111-8111-111111111111' FROM sources WHERE id='default'`);
    await engine.executeRaw(`INSERT INTO persistence_host_bindings VALUES
      ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','/synthetic/root','/synthetic/coord')`);
    await engine.executeRaw(`INSERT INTO config(key,value) VALUES('sync.repo_path','/synthetic/root') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    await engine.executeRaw(`INSERT INTO persistence_writer_protocols(worktree_id,host_id,owner_epoch,protocol_version)
      VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,2)`);
    await engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,ttl_expires_at)
      VALUES('synthetic-lock',123,'synthetic',now()+interval '1 hour')`);
    await engine.executeRaw(`INSERT INTO persistence_worktrees(id) VALUES('33333333-3333-4333-8333-333333333333')`);
    const mutations = [
      `UPDATE persistence_worktrees SET id='44444444-4444-4444-8444-444444444444' WHERE id='33333333-3333-4333-8333-333333333333'`,
      `UPDATE persistence_source_bindings SET worktree_id='33333333-3333-4333-8333-333333333333'`,
      `UPDATE persistence_host_bindings SET worktree_id='33333333-3333-4333-8333-333333333333'`,
      `UPDATE gbrain_cycle_locks SET id='different-lock'`,
      `UPDATE gbrain_cycle_locks SET holder_pid=456`,
      `UPDATE gbrain_cycle_locks SET holder_host='different-host'`,
      `UPDATE gbrain_cycle_locks SET acquisition_token=gen_random_uuid()`,
      `UPDATE gbrain_cycle_locks SET acquired_at=acquired_at+interval '1 second'`,
      `UPDATE persistence_worktrees SET manifest=jsonb_set(manifest,'{files,note.md,hash}','"changed-with-same-digest"')`,
      `UPDATE persistence_worktrees SET manifest=NULL`,
      `UPDATE persistence_worktrees SET manifest='{}'`,
      `UPDATE persistence_worktrees SET owner_host_id=gen_random_uuid()`,
      `UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1`,
      `UPDATE persistence_worktrees SET topology_generation=topology_generation+1`,
      `UPDATE persistence_worktrees SET state='draining'`,
      `UPDATE persistence_brain SET brain_id=gen_random_uuid()`,
      `UPDATE persistence_brain SET enabled=NOT enabled`,
      `UPDATE persistence_brain SET enabled=true, skill_bundles_enabled=true, writer_protocol_floor=2`,
      `UPDATE sources SET id='renamed' WHERE id='default'`,
      `UPDATE sources SET incarnation=gen_random_uuid() WHERE id='default'`,
      `UPDATE sources SET archived=NOT archived WHERE id='default'`,
      `UPDATE sources SET local_path='/synthetic/changed' WHERE id='default'`,
      `UPDATE sources SET config=jsonb_set(config,'{kind}','"synthetic"') WHERE id='default'`,
      `UPDATE config SET value='/synthetic/changed' WHERE key='sync.repo_path'`,
      `UPDATE persistence_source_bindings SET source_id='other'`,
      `UPDATE persistence_source_bindings SET source_incarnation=gen_random_uuid()`,
      `UPDATE persistence_source_bindings SET relative_path='changed'`,
      `UPDATE persistence_source_bindings SET topology_generation=topology_generation+1`,
      `UPDATE persistence_host_bindings SET host_id=gen_random_uuid()`,
      `UPDATE persistence_host_bindings SET local_path='/synthetic/changed'`,
      `UPDATE persistence_host_bindings SET coordination_path='/synthetic/changed'`,
    ];
    for (const sql of mutations) {
      const before = await writerAdminState(engine);
      const rollback = new Error('rollback synthetic mutation');
      await expect(engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
        await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true), set_config('gbrain.writer_quiesced','true',true)");
        await tx.executeRaw(sql);
        expect(await writerAdminState(tx)).not.toBe(before);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await writerAdminState(engine)).toBe(before);
    }
  }
}, 120_000);

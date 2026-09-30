/** #5732 source-binding cleanup suite, shared by the PGLite unit file and the Postgres E2E file. */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSources } from '../../src/commands/sources.ts';
import { removeSource } from '../../src/core/sources-ops.ts';
import { purgeExpiredSources } from '../../src/core/destructive-guard.ts';
import { resolveSyncPersistenceMode } from '../../src/core/persistence/sync-authority.ts';
import { checkUnboundSource } from '../../src/commands/doctor/checks/unbound-source.ts';
import { withEnv } from './with-env.ts';

export function sourceBindingsSuite(label: string, getEngine: () => BrainEngine): void {
  async function addSource(id: string): Promise<string> {
    const [row] = await getEngine().executeRaw<{ incarnation: string }>(
      'INSERT INTO sources (id, name) VALUES ($1, $1) RETURNING incarnation', [id]);
    return row.incarnation;
  }

  async function bind(id: string, incarnation: string): Promise<void> {
    const [worktree] = await getEngine().executeRaw<{ id: string }>('INSERT INTO persistence_worktrees DEFAULT VALUES RETURNING id');
    await getEngine().executeRaw(
      'INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id) VALUES ($1, $2::uuid, $3::uuid)',
      [id, incarnation, worktree.id]);
  }

  async function bindings(id: string): Promise<number> {
    return (await getEngine().executeRaw('SELECT 1 FROM persistence_source_bindings WHERE source_id = $1', [id])).length;
  }

  async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const log = console.log, err = console.error;
    console.log = () => {}; console.error = () => {};
    try { return await fn(); } finally { console.log = log; console.error = err; }
  }

  describe(`${label}: source deletes drop the removed incarnation's binding (#5732)`, () => {
    test('`sources remove` drops the binding and a same-id re-add syncs unclaimed', async () => {
      await bind('remove-a', await addSource('remove-a'));
      await quiet(() => runSources(getEngine(), ['remove', 'remove-a', '--yes']));
      expect(await bindings('remove-a')).toBe(0);
      await addSource('remove-a');
      expect(await resolveSyncPersistenceMode(getEngine(), { sourceId: 'remove-a' } as never)).toBe(false);
    });

    test('`sources purge <id> --confirm-destructive` drops the binding', async () => {
      await bind('purge-a', await addSource('purge-a'));
      await quiet(() => runSources(getEngine(), ['purge', 'purge-a', '--confirm-destructive']));
      expect(await bindings('purge-a')).toBe(0);
    });

    test('the sources_remove operation path drops the binding', async () => {
      await bind('op-remove-a', await addSource('op-remove-a'));
      await quiet(() => removeSource(getEngine(), { id: 'op-remove-a', confirmDestructive: true, yes: true }));
      expect(await bindings('op-remove-a')).toBe(0);
    });

    test('purging an expired archive drops the binding', async () => {
      await bind('expired-a', await addSource('expired-a'));
      await getEngine().executeRaw("UPDATE sources SET archived = true, archive_expires_at = now() - interval '1 day' WHERE id = 'expired-a'");
      await withEnv({ GBRAIN_HOME: '/tmp/gbrain-5732-no-clones' }, () => quiet(() => purgeExpiredSources(getEngine())));
      expect(await bindings('expired-a')).toBe(0);
    });

    test('a binding left by an earlier incarnation does not claim a re-added source', async () => {
      const old = await addSource('orphan-a');
      await bind('orphan-a', old);
      await getEngine().executeRaw("DELETE FROM sources WHERE id = 'orphan-a'");
      await addSource('orphan-a');
      expect(await resolveSyncPersistenceMode(getEngine(), { sourceId: 'orphan-a' } as never)).toBe(false);
    });

    test('doctor unbound_source does not treat an earlier incarnation\'s binding as bound', async () => {
      const old = await addSource('unbound-a');
      await bind('unbound-a', old);
      await getEngine().executeRaw("DELETE FROM sources WHERE id = 'unbound-a'");
      await addSource('unbound-a');
      await getEngine().executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, database_only_reason)
        VALUES ('unbound-a', 'notes/x', 'note', 'x', 'body', 'unbound_source')`);
      const check = await checkUnboundSource(getEngine());
      expect(check.details?.sources).toEqual([{ source_id: 'unbound-a', pages: 1, bound: false }]);
      expect(check.status).toBe('ok');
    });
  });

  describe(`${label}: orphan_persistence_bindings and gbrain repair orphan-bindings (#5732)`, () => {
    test('doctor reports an orphan binding of a removed source and the repair removes it', async () => {
      const { checkOrphanBindings } = await import('../../src/commands/doctor/checks/orphan-bindings.ts');
      const { repairRunner } = await import('../../src/core/repair/registry.ts');
      const { resolveRepairScope } = await import('../../src/core/repair/core.ts');
      const old = await addSource('orphan-r');
      await bind('orphan-r', old);
      await getEngine().executeRaw("DELETE FROM sources WHERE id = 'orphan-r'");
      await addSource('kept-r');
      await bind('kept-r', (await getEngine().executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='kept-r'"))[0].incarnation);

      const before = await checkOrphanBindings(getEngine());
      expect(before.status).toBe('warn');
      expect(before.details?.bindings).toEqual([expect.objectContaining({ source_id: 'orphan-r', source_incarnation: old, reason: 'source_removed' })]);
      expect(before.message).toContain('gbrain repair orphan-bindings --apply');

      const scope = await resolveRepairScope(getEngine(), 'kept-r');
      const preview = await quiet(async () => (await repairRunner(getEngine(), { apply: false })).run('orphan-bindings', scope));
      expect(preview.affected).toBe(1);
      expect(preview.sample).toEqual([`orphan-r:binding:${old}`]);
      expect(await bindings('orphan-r')).toBe(1);

      const applied = await quiet(async () => (await repairRunner(getEngine(), { apply: true })).run('orphan-bindings', scope));
      expect(applied.applied).toBe(1);
      expect(await bindings('orphan-r')).toBe(0);
      expect(await bindings('kept-r')).toBe(1);
      expect((await checkOrphanBindings(getEngine())).status).toBe('ok');
    });

    test('a binding of an earlier incarnation is removed and a pending request keeps it', async () => {
      const { orphanBindingsRepair } = await import('../../src/core/repair/orphan-bindings.ts');
      const old = await addSource('replaced-r');
      await bind('replaced-r', old);
      await getEngine().executeRaw("DELETE FROM sources WHERE id = 'replaced-r'");
      await addSource('replaced-r');
      const plan = await orphanBindingsRepair.plan(getEngine(), { brain_id: 'host', source_ids: [] }, null);
      expect(plan.items.map(item => item.action)).toEqual(['delete_incarnation_replaced']);

      await getEngine().executeRaw(`INSERT INTO persistence_requests (principal_kind, principal_id, request_id, operation, source_id, source_incarnation,
          slug, digest, authority, intent_bytes, terminal_reservation, state)
        VALUES ('local_cli', 'p', gen_random_uuid(), 'put_page', 'replaced-r', $1::uuid, 'notes/x', 'd', '{}'::jsonb, 0, 0, 'queued')`, [old]);
      const held = await orphanBindingsRepair.plan(getEngine(), { brain_id: 'host', source_ids: [] }, null);
      expect(held.items).toEqual([]);
      expect(held.residuals).toEqual({ pending_requests: 1 });
      expect(await orphanBindingsRepair.apply({ engine: getEngine() } as never, plan.items[0])).toBe(false);
      expect(await bindings('replaced-r')).toBe(1);
    });
  });
}

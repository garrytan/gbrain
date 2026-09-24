import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { ownedContentFreshness } from '../src/core/shared-skills/content-freshness.ts';
import { checkCanonicalContentWrites } from '../src/commands/doctor/checks/canonical-content.ts';
import { checkSyncFreshness } from '../src/commands/doctor/checks/extraction-sync.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const home = mkdtempSync(join(tmpdir(), 'owned-content-freshness-'));
const engines: BrainEngine[] = [];
let closePg: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePg = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePg?.();
  rmSync(home, { recursive: true, force: true });
});
async function fixture(engine: BrainEngine) {
  const sourceId = `content-${randomUUID().slice(0, 8)}`, root = join(home, sourceId); mkdirSync(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  const binding = await claimWorktree(engine, sourceId, root);
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  const receipt = { version: 1, brain_id: brain.brain_id, source_id: sourceId, source_incarnation: binding.source_incarnation,
    root, owned_root: true, repository_kind: 'content_directory', status: 'ready', stage: 'complete' };
  const key = `shared_skills.content.v1.${sourceId}.${binding.source_incarnation}`;
  await engine.setConfig(key, JSON.stringify(receipt));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { sourceId, root, binding, key, receipt };
}

test('receipt-proven content roots are explicitly writer-owned without inventing sync timestamps', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine);
    expect(await ownedContentFreshness(engine, [f.sourceId])).toEqual([{ sourceId: f.sourceId, pending: 0, recovering: 0 }]);
    expect(await checkSyncFreshness(engine)).toMatchObject({ status: 'ok', details: { writer_owned_count: 1, stale_count: 0 } });
    expect((await checkSyncFreshness(engine, { localOnly: true })).message).toContain('upstream sync is not applicable');
    expect(await engine.executeRaw('SELECT last_sync_at,last_commit FROM sources WHERE id=$1', [f.sourceId])).toEqual([{ last_sync_at: null, last_commit: null }]);
    expect(await checkCanonicalContentWrites(engine, [f.sourceId])).toMatchObject({ status: 'ok', details: { writer_owned_count: 1, pending_count: 0, recovering_count: 0 } });
    await engine.setConfig(f.key, JSON.stringify({ ...f.receipt, repository_kind: 'git' }));
    expect(await ownedContentFreshness(engine, [f.sourceId])).toEqual([{ sourceId: f.sourceId, pending: 0, recovering: 0 }]);
  }
}), 120_000);

test('external roots and absent, incomplete, unowned or mismatched receipts still fail never-synced health', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine);
    for (const receipt of [null, '{broken', { ...f.receipt, owned_root: false }, { ...f.receipt, stage: 'owner' },
      { ...f.receipt, status: 'action_required' }, { ...f.receipt, brain_id: randomUUID() }, { ...f.receipt, source_id: 'other' },
      { ...f.receipt, source_incarnation: randomUUID() }, { ...f.receipt, root: join(home, 'different-root') }, { ...f.receipt, repository_kind: 'remote' }]) {
      await engine.setConfig(f.key, typeof receipt === 'string' ? receipt : JSON.stringify(receipt));
      expect(await ownedContentFreshness(engine, [f.sourceId])).toEqual([]);
      const check = await checkSyncFreshness(engine);
      expect(check.status).toBe('fail');
      expect(check.message).toContain(`'${f.sourceId}' has never been synced`);
    }
    await engine.setConfig(f.key, JSON.stringify(f.receipt));
    for (const config of [{ kind: 'google' }, { remote_url: 'https://example.invalid/repo' }, { managed_clone: true }, { company_brain: {} }, 'invalid-policy']) {
      await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [f.sourceId, JSON.stringify(config)]);
      expect(await ownedContentFreshness(engine, [f.sourceId])).toEqual([]);
      expect((await checkSyncFreshness(engine)).message).toContain(`'${f.sourceId}' has never been synced`);
    }
    await withManagedFixtureWrite(engine, [f.sourceId], tx => tx.executeRaw("UPDATE sources SET config='{}',last_commit=$2 WHERE id=$1", [f.sourceId, 'a'.repeat(40)]));
    expect(await ownedContentFreshness(engine, [f.sourceId])).toEqual([]);
  }
}), 120_000);

test('source incarnation and canonical host-binding changes invalidate the owned-root proof', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine);
    await engine.executeRaw('UPDATE persistence_host_bindings SET local_path=$2 WHERE worktree_id=$1::uuid', [f.binding.worktree_id, join(home, 'moved')]);
    expect(await ownedContentFreshness(engine, [f.sourceId])).toEqual([]);
    expect((await checkSyncFreshness(engine)).message).toContain(`'${f.sourceId}' has never been synced`);
    await engine.executeRaw('UPDATE persistence_host_bindings SET local_path=$2 WHERE worktree_id=$1::uuid', [f.binding.worktree_id, f.root]);
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
      await tx.executeRaw('UPDATE sources SET incarnation=$2::uuid WHERE id=$1', [f.sourceId, randomUUID()]);
    });
    expect(await ownedContentFreshness(engine, [f.sourceId])).toEqual([]);
  }
}), 120_000);

test('pending and recovering canonical writes remain visible separately and remote checks never read filesystem paths', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine);
    const authority = await submissionAuthority({ engine, remote: false, sourceId: f.sourceId } as OperationContext,
      'put_page', f.sourceId, f.binding.source_incarnation, 'note');
    const row = await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId: f.sourceId,
      sourceIncarnation: f.binding.source_incarnation, slug: 'note', pageId: null, requestId: randomUUID(),
      callerIntent: { content: 'pending content' }, intent: { content: 'pending content' }, authority,
      worktreeId: f.binding.worktree_id, topologyGeneration: f.binding.topology_generation });
    expect(await checkCanonicalContentWrites(engine, [f.sourceId])).toMatchObject({ status: 'warn', details: { pending_count: 1, recovering_count: 0 } });
    await engine.executeRaw("UPDATE persistence_requests SET state='recovering' WHERE id=$1::uuid", [row.id]);
    expect(await checkCanonicalContentWrites(engine, [f.sourceId])).toMatchObject({ status: 'fail', details: { pending_count: 0, recovering_count: 1 } });
    expect(await checkCanonicalContentWrites(engine, ['not-authorized'])).toBeNull();
    rmSync(f.root, { recursive: true, force: true });
    expect(await ownedContentFreshness(engine, [f.sourceId])).toEqual([{ sourceId: f.sourceId, pending: 0, recovering: 1 }]);
    const remote = await checkCanonicalContentWrites(engine, [f.sourceId]);
    expect(JSON.stringify(remote)).not.toContain(f.root);
    expect(remote?.status).toBe('fail');
  }
}), 120_000);

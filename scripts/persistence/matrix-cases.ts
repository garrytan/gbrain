import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { publicationConcurrency } from '../../src/core/persistence/pool-capacity.ts';
import { admitWrite, claimNextWrite, renewWriteClaim } from '../../src/core/persistence/journal.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { acceptWriterTransfer, getWorktreeBinding, prepareWriterTransfer } from '../../src/core/persistence/ownership.ts';
import { tryAcquireNativeLock } from '../../src/core/persistence/native-lock.ts';
import { admission, assertCommittedSnapshot, assertConservation, deferred, fixtures, openEngine, prepared, selectFixtureHost, type HarnessConfig } from './harness.ts';

export interface RuntimeCase extends HarnessConfig { rls: boolean; dual: boolean; role: string; route: 'direct' | 'pgbouncer'; }
async function bounded<T>(work: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not make progress`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
export async function runtimeCase(config: RuntimeCase) {
  const engine = await openEngine(config) as PostgresEngine; const sources = await fixtures(engine, config);
  const releases: (() => void)[] = []; const holds: Promise<unknown>[] = []; const errors: string[] = [];
  try {
    assert.equal(engine.sql.options.max, config.poolSize);
    assert.equal(engine.connectionManager!.isDualPoolActive(), config.dual);
    const direct = await engine.connectionManager!.ddl();
    assert.equal(direct === engine.sql, !config.dual);
    if (config.dual) assert.equal(direct.options.max, 1, 'one direct control connection is sufficient');
    const a = admission(config, sources[0], 'capacity', 'capacity-value'); await admitWrite(engine, a);
    if (config.poolSize === 1) {
      assert.equal(publicationConcurrency(engine), 0);
      const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_e, row) => prepared(row, sources, null, true),
        { hostId: config.hostId, onError: error => errors.push(String(error)) });
      await consumer.tick(); await consumer.stop();
      const [row] = await engine.executeRaw<any>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [a.requestId]);
      assert.equal(row.state, 'queued'); assert.equal(row.blocked_reason, 'writer_pool_capacity');
      assert.equal(await engine.getPage(a.slug, { sourceId: a.sourceId }), null);
      assert.equal(existsSync(join(sources[0].root, 'capacity.md')), false);
    } else {
      // This is the production bulk-reservation API, including direct-size-one fallback.
      for (let i = 0; i < config.poolSize! - 1; i++) {
        const acquired = deferred(); const release = deferred(); releases.push(release.resolve);
        holds.push(engine.withReservedConnection(async connection => { await connection.executeRaw('SELECT 1'); acquired.resolve(); await release.promise; }));
        await bounded(acquired.promise, 'bulk reservation');
      }
      await assert.rejects(engine.withReservedConnection(async () => {}), { code: 'writer_pool_capacity' });
      assert.equal((await bounded(engine.executeRawDirect<{ n: number }>('SELECT 1 AS n'), 'direct control read'))[0].n, 1);
      const claim = await bounded(claimNextWrite(engine, config.hostId), 'claim with saturated bulk budget'); assert(claim);
      assert.equal(await bounded(renewWriteClaim({ executeRaw: engine.executeRawDirect.bind(engine) }, claim.id, claim.execution_token!), 'claim renewal'), true);
      const queued = await bounded(publishMutation(engine, claim, prepared(claim, sources, null, true), config.hostId), 'publication capacity refusal');
      assert.equal(queued.state, 'queued'); assert.equal(queued.blocked_reason, 'writer_pool_capacity');
      assert.equal(existsSync(join(sources[0].root, 'capacity.md')), false);
      for (const release of releases) release(); await Promise.all(holds);
      const retry = await claimNextWrite(engine, config.hostId); assert(retry); assert.equal(retry.id, claim.id);
      await assertCommittedSnapshot(engine, await publishMutation(engine, retry, prepared(retry, sources, null, true), config.hostId));
    }
    assert.deepEqual(errors, []); await assertConservation(engine);
    // Probe actual RLS under a non-superuser/non-bypass role, through scoped reads.
    await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${config.role}`);
    await engine.executeRaw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${config.role}`);
    for (const table of ['sources', 'tags', 'fact_withdrawals', 'slug_aliases']) {
      await engine.executeRaw(`CREATE POLICY persistence_fixture_read ON ${table} FOR SELECT TO ${config.role} USING (true)`);
    }
    await engine.executeRaw(`CREATE POLICY persistence_fixture_scope ON pages FOR SELECT TO ${config.role}
      USING (current_setting('app.scopes',true)='*' OR source_id=ANY(string_to_array(current_setting('app.scopes',true),',')))`);
    await engine.executeRaw(`ALTER TABLE pages ${config.rls ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`);
    await engine.transaction(async tx => {
      await tx.executeRaw(`SET LOCAL ROLE ${config.role}`);
      const [role] = await tx.executeRaw<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
      assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
      await tx.executeRaw("SELECT set_config('app.scopes',$1,true)", [sources[0].id]);
      const visible = await tx.executeRaw<{ source_id: string }>("SELECT source_id FROM pages WHERE slug='rls-probe' ORDER BY source_id");
      assert.equal(visible.length, config.rls ? 1 : 2, 'RLS probe must enforce the configured table policy');
      const snapshot = await tx.readPageSnapshot('rls-probe', { sourceId: sources[1].id }); assert(snapshot);
      assert.equal(snapshot.page.compiled_truth, sources[1].id);
      const [scope] = await tx.executeRaw<{ value: string }>("SELECT current_setting('app.scopes') AS value");
      assert.equal(scope.value, sources[0].id, 'nested scoped read must restore the enclosing transaction setting');
    });
    return { route: config.route, rls: config.rls, ordinary_pool: config.poolSize, direct_pool: config.dual ? 1 : null,
      dual_pool: config.dual, actual_rls_role: true, capacity: config.poolSize === 1 ? 'queued_with_guidance' : 'committed_after_bulk_drain',
      control_progress: true, counters_conserved: true };
  } finally { for (const release of releases) release(); await Promise.allSettled(holds); await engine.disconnect(); }
}

export async function ownershipCases(config: HarnessConfig) {
  const engine = await openEngine(config); const sources = await fixtures(engine, config); const source = sources[0];
  const successor = randomUUID(); const successorRoot = join(config.root, 'successor'); const originalPath = join(source.root, 'owner.md');
  writeFileSync(originalPath, 'original'); mkdirSync(successorRoot); cpSync(source.root, successorRoot, { recursive: true });
  try {
    const input = admission(config, source, 'owner', 'replacement'); const accepted = await admitWrite(engine, input);
    assert.equal(await claimNextWrite(engine, successor), null, 'nonowner accepts durable work but cannot execute it');
    const offer = await prepareWriterTransfer(engine, source.id, config.hostId);
    selectFixtureHost(successor);
    writeFileSync(join(successorRoot, 'owner.md'), 'wrong-checkout');
    await assert.rejects(acceptWriterTransfer(engine, source.id, successorRoot, offer.owner_epoch, offer.manifest.digest, successor), { code: 'writer_manifest_mismatch' });
    writeFileSync(join(successorRoot, 'owner.md'), 'original');
    await acceptWriterTransfer(engine, source.id, successorRoot, offer.owner_epoch, offer.manifest.digest, successor);
    assert.equal(await claimNextWrite(engine, config.hostId), null, 'returning old owner cannot claim queued work');
    const row = await claimNextWrite(engine, successor); assert(row); assert.equal(row.id, accepted.id);
    const rebound = await getWorktreeBinding(engine, source.id, successor); assert(rebound);
    assert.equal(Number(rebound.owner_epoch), Number(offer.owner_epoch) + 1);
    const movedSources = sources.map(s => s.id === source.id ? { ...s, root: successorRoot, binding: rebound } : s);
    const stale = await publishMutation(engine, row, prepared(row, sources, null, true), config.hostId);
    assert.equal(stale.state, 'queued'); assert.equal(readFileSync(originalPath, 'utf8'), 'original');
    const next = await claimNextWrite(engine, successor); assert(next);
    await assertCommittedSnapshot(engine, await publishMutation(engine, next, prepared(next, movedSources, null, true), successor));
    assert.equal(readFileSync(join(successorRoot, 'owner.md'), 'utf8'), 'replacement'); assert.equal(readFileSync(originalPath, 'utf8'), 'original');
    // The external coordination inode survives directory replacement, while
    // the physical-root stamp refuses publication into the substituted copy.
    const coordinationPath = rebound.coordination_path!;
    const held = await tryAcquireNativeLock(coordinationPath); assert(held);
    try {
      renameSync(successorRoot, `${successorRoot}-retired`); mkdirSync(successorRoot);
      cpSync(`${successorRoot}-retired`, successorRoot, { recursive: true });
      assert.equal(await tryAcquireNativeLock(coordinationPath), null, 'replacing the root must not create a second kernel lock');
    } finally { await held.release(); }
    assert.equal((await getWorktreeBinding(engine, source.id, successor))!.coordination_path, coordinationPath);
    await admitWrite(engine, admission(config, source, 'after-replacement', 'preserved-owner'));
    const replacement = await claimNextWrite(engine, successor); assert(replacement);
    const refused = await publishMutation(engine, replacement, prepared(replacement, movedSources, null, true), successor);
    assert.equal(refused.state, 'failed'); assert.equal(refused.error_code, 'recovery_required');
    assert.equal(existsSync(join(successorRoot, 'after-replacement.md')), false);
    assert.equal(readFileSync(join(successorRoot, 'owner.md'), 'utf8'), 'replacement');
    // Restore the original inode without discarding the unexpected copy.
    const restoreLock = await tryAcquireNativeLock(coordinationPath); assert(restoreLock);
    try {
      renameSync(successorRoot, `${successorRoot}-substituted`);
      renameSync(`${successorRoot}-retired`, successorRoot);
    } finally { await restoreLock.release(); }
    await admitWrite(engine, admission(config, source, 'after-restoration', 'preserved-owner'));
    const restored = await claimNextWrite(engine, successor); assert(restored);
    await assertCommittedSnapshot(engine, await publishMutation(engine, restored, prepared(restored, movedSources, null, true), successor));
    const oldSource = sources[1]; const obsolete = admission(config, oldSource, 'recreated', 'obsolete'); await admitWrite(engine, obsolete);
    await assert.rejects(engine.executeRaw('DELETE FROM sources WHERE id=$1', [oldSource.id]), /writer_coordinator_required/);
    // Explicit database-administrator fault injection: ordinary topology writes
    // remain refused, while incarnation checks still fence a privileged recreate.
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true),set_config('gbrain.write_sources',$1,true)", [JSON.stringify([oldSource.id])]);
      await tx.executeRaw('DELETE FROM sources WHERE id=$1', [oldSource.id]);
      await tx.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [oldSource.id, oldSource.root]);
    });
    selectFixtureHost(config.hostId);
    const obsoleteClaim = await claimNextWrite(engine, config.hostId); assert(obsoleteClaim);
    const rejected = await publishMutation(engine, obsoleteClaim, prepared(obsoleteClaim, sources), config.hostId);
    assert.equal(rejected.state, 'conflict'); assert.equal(rejected.error_code, 'source_changed');
    assert.equal(await engine.getPage('recreated', { sourceId: oldSource.id }), null);
    await assertConservation(engine);
    return { nonowner_admission: true, manifest_mismatch_refused: true, owner_transfer: true, stale_owner_refused: true,
      root_replacement_retains_lock_path: true, substituted_root_refused: true, original_inode_restoration_resumes: true,
      ordinary_topology_write_refused: true, source_incarnation_fenced: true,
      source_recreate_fault: 'fixture database administrator transaction with explicit topology and source capability', counters_conserved: true };
  } finally { await engine.disconnect(); }
}

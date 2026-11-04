import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { hostIdFor, persistenceHome, registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { physicalRootReservationPath, readPhysicalRootStamp, reservePhysicalRootRecord, writePhysicalRootStamp } from '../src/core/persistence/physical-root-record.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine?.disconnect(); });

async function fixture(run: (f: { root: string; old: string; home: string; id: string; params: Record<string, unknown>; call: (p: Record<string, unknown>) => Promise<Record<string, unknown>> }) => Promise<void>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bind-existing-')));
  try { await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    await resetPgliteState(engine);
    const registration = await registerLocalWriter(engine, 'cli'), host = hostIdFor(engine);
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const old = join(home, 'historical'), root = join(home, 'current'), id = randomUUID();
    mkdirSync(old); execFileSync('git', ['init', '--quiet', old]);
    writeFileSync(join(old, 'note.md'), 'Canonical bytes\n');
    execFileSync('git', ['-C', old, 'add', 'note.md']);
    execFileSync('git', ['-C', old, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const coordinationPath = join(home, 'locks', 'existing.lock'); mkdirSync(join(home, 'locks'));
    const reservation = reservePhysicalRootRecord(old, { brainId: brain.brain_id, worktreeId: id, hostId: host, coordinationPath });
    writePhysicalRootStamp(old, reservation);
    await engine.executeRaw("INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,topology_generation) VALUES($1::uuid,$2::uuid,1,8)", [id, host]);
    await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)', [id, host, old, coordinationPath]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    renameSync(old, root);
    const params = { source_id: 'existing-fixture', path: root, worktree_id: id, reservation_file: physicalRootReservationPath(old), expected_epoch: '1', expected_generation: '8', request_id: randomUUID() };
    const call = (p: Record<string, unknown>) => withVerifiedLocalRegistration(engine, registration, () => runPersistenceAdministration(engine, 'writer_bind_existing' as never, p));
    await run({ root, old, home, id, params, call });
  }); } finally { rmSync(home, { recursive: true, force: true }); }
}

test('binds moved reservation without replacing logical worktree', () => fixture(async ({ root, old, id, params, call }) => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString(), body = readFileSync(join(root, 'note.md'), 'utf8');
  const preview = await call({ ...params, dry_run: true });
  expect(preview).toMatchObject({ eligible: true, dry_run: true });
  const result = await call({ ...params, admin_intent: 'writer_bind_existing', expected_state: preview.expected_admin_state, expect: preview.plan_hash });
  expect(result).toMatchObject({ state: 'committed', worktree_id: id, owner_epoch: '1', topology_generation: '9' });
  expect(readPhysicalRootStamp(root)?.worktreeId).toBe(id); expect(readPhysicalRootStamp(root)?.root).toBe(root);
  expect(existsSync(physicalRootReservationPath(root))).toBe(true); expect(existsSync(physicalRootReservationPath(old))).toBe(false);
  expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe(body); expect(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString()).toBe(head);
  const [owner] = await engine.executeRaw<{ id: string; owner_epoch: string; topology_generation: string; state: string }>('SELECT id,owner_epoch::text,topology_generation::text,state FROM persistence_worktrees WHERE id=$1::uuid', [id]);
  expect(owner).toEqual({ id, owner_epoch: '1', topology_generation: '9', state: 'active' });
}), 60_000);

test('missing historical path is not required to be an alias', () => fixture(async ({ old, params, call }) => {
  expect(existsSync(old)).toBe(false); expect((await call({ ...params, dry_run: true })).eligible).toBe(true); expect(existsSync(old)).toBe(false);
}), 60_000);

test('locks unbound worktree by uuid and compares full host binding', () => fixture(async ({ id, params, call }) => {
  await engine.executeRaw('UPDATE persistence_host_bindings SET local_path=$2 WHERE worktree_id=$1::uuid', [id, '/unrelated/changed']);
  const before = await writerAdminState(engine), preview = await call({ ...params, dry_run: true });
  expect(preview.eligible).toBe(false); expect(preview.blockers).not.toEqual([]); expect(await writerAdminState(engine)).toBe(before);
  expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes')).toHaveLength(0);
}), 60_000);

test('preview has no side effects and predicts all apply refusals', () => fixture(async ({ root, params, call }) => {
  const state = await writerAdminState(engine), stamp = readFileSync(join(root, '.gbrain-owner.json'));
  expect((await call({ ...params, dry_run: true })).eligible).toBe(true);
  expect(await writerAdminState(engine)).toBe(state); expect(readFileSync(join(root, '.gbrain-owner.json'))).toEqual(stamp);
  expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes')).toHaveLength(0);
  await expect(call(params)).rejects.toMatchObject({ code: 'writer_admin_intent_required' });
  expect(await writerAdminState(engine)).toBe(state);
}), 60_000);

test('preview refuses missing existing host without minting an identity', () => fixture(async ({ params, call }) => {
  const path = join(persistenceHome(), 'host.json'); rmSync(path);
  expect((await call({ ...params, dry_run: true })).eligible).toBe(false);
  expect(existsSync(path)).toBe(false);
}), 60_000);

for (const hazard of ['missing-host', 'extra-host', 'source-present', 'source-archived', 'existing-member', 'prepared-transfer']) {
  test(`locks unbound worktree by uuid and compares full host binding: ${hazard}`, () => fixture(async ({ params, call, id, root }) => {
    if (hazard === 'missing-host') await engine.executeRaw('DELETE FROM persistence_host_bindings WHERE worktree_id=$1::uuid', [id]);
    else if (hazard === 'extra-host') await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) SELECT worktree_id,$2::uuid,local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid', [id, randomUUID()]);
    else if (hazard === 'prepared-transfer') await engine.executeRaw('UPDATE persistence_worktrees SET manifest=$2::text::jsonb WHERE id=$1::uuid', [id, JSON.stringify({ prepared_at: '2026-01-01T00:00:00Z' })]);
    else {
      const incarnation = randomUUID(), source = hazard === 'existing-member' ? 'another-member' : String(params.source_id);
      await engine.transaction(async tx => { await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)"); await tx.executeRaw('INSERT INTO sources(id,name,local_path,incarnation,archived) VALUES($1,$1,$2,$3::uuid,$4)', [source, root, incarnation, hazard === 'source-archived']); });
      if (hazard === 'existing-member') await engine.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,$2::uuid,$3::uuid)', [source, incarnation, id]);
    }
    const before = await writerAdminState(engine);
    expect((await call({ ...params, dry_run: true })).eligible).toBe(false);
    expect(await writerAdminState(engine)).toBe(before); expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes')).toHaveLength(0);
  }), 60_000);
}

for (const host of ['current', 'foreign']) for (const state of ['active', 'draining', 'recovering']) for (const relation of ['equal', 'ancestor', 'descendant']) {
  test(`overlap isolation uses the verified host: ${host} ${state} ${relation}`, () => fixture(async ({ root, home, params, call }) => {
    const otherId = randomUUID(), hostId = host === 'current' ? hostIdFor(engine) : randomUUID();
    const path = relation === 'equal' ? root : relation === 'ancestor' ? home : join(root, 'nested');
    await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,topology_generation,state) VALUES($1::uuid,$2::uuid,1,1,$3)', [otherId, hostId, state]);
    await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)', [otherId, hostId, path, join(home, 'locks', 'other.lock')]);
    const before = await writerAdminState(engine), stamp = readFileSync(join(root, '.gbrain-owner.json'));
    const preview = await call({ ...params, dry_run: true });
    expect(preview.eligible).toBe(host === 'foreign');
    expect(await writerAdminState(engine)).toBe(before);
    expect(readFileSync(join(root, '.gbrain-owner.json'))).toEqual(stamp);
    if (host === 'foreign') {
      expect(await call({ ...params, admin_intent: 'writer_bind_existing', expected_state: preview.expected_admin_state, expect: preview.plan_hash })).toMatchObject({ state: 'committed' });
      expect(await engine.executeRaw('SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid', [otherId])).toEqual([{ local_path: path }]);
    } else {
      expect(preview.blockers).not.toEqual([]);
      expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes')).toHaveLength(0);
    }
  }), 60_000);
}

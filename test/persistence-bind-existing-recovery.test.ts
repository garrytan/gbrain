import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { persistenceSocketPathForConfig, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { hostIdFor, readLocalWriter, registerLocalWriter, revokeLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { physicalRootReservationPath, reservePhysicalRootRecord, writePhysicalRootStamp } from '../src/core/persistence/physical-root-record.ts';
import { recordManagedRoots, registeredManagedRoots } from '../src/core/persistence/root-registry.ts';
import { recoverSourceTopologies } from '../src/core/persistence/topology-recovery.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BindExistingHooks } from '../src/core/persistence/bind-existing.ts';

let engine: PGLiteEngine;
const fixtures: { engines: PGLiteEngine[] }[] = [];
beforeAll(() => {
  for (const fixture of fixtures) fixture.engines = [new PGLiteEngine(), new PGLiteEngine()];
});
afterAll(async () => {
  for (const fixture of fixtures) for (const instance of fixture.engines) await instance.disconnect();
});
function fixture(run: (f: { root: string; old: string; home: string; id: string; principal: string; params: Record<string, unknown>; restart: () => Promise<void>; apply: (hooks?: BindExistingHooks) => Promise<Record<string, unknown>>; call: (p: Record<string, unknown>) => Promise<Record<string, unknown>> }) => Promise<void>, options: { longPath?: boolean; classic?: boolean } = {}): () => Promise<void> {
  const context = { engines: [] as PGLiteEngine[] };
  fixtures.push(context);
  return async () => {
  const instances = context.engines.values();
  const nextEngine = () => {
    const next = instances.next();
    if (next.done) throw new Error('Fixture exhausted its fresh engine instances');
    return next.value;
  };
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bind-recovery-')));
  try { await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const datastore = join(home, 'datastore');
    engine = nextEngine(); await engine.connect({ database_path: datastore });
    try {
    await engine.initSchema(); await resetPgliteState(engine);
    const registration = await registerLocalWriter(engine, 'cli'), host = hostIdFor(engine);
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const parent = options.longPath ? join(home, ...Array.from({ length: 3 }, () => '\\'.repeat(174) + 'quote\"')) : home;
    mkdirSync(parent, { recursive: true });
    const old = join(parent, 'historical'), root = join(parent, 'current'), id = randomUUID();
    mkdirSync(old); execFileSync('git', ['init', '--quiet', old]); writeFileSync(join(old, 'note.md'), 'Canonical bytes\n');
    execFileSync('git', ['-C', old, 'add', 'note.md']); execFileSync('git', ['-C', old, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const coordinationPath = join(home, 'locks', 'existing.lock'); mkdirSync(join(home, 'locks'));
    const reservation = reservePhysicalRootRecord(old, { brainId: brain.brain_id, worktreeId: id, hostId: host, coordinationPath }); writePhysicalRootStamp(old, reservation);
    recordManagedRoots(brain.brain_id, [{ local_path: old, worktree_id: id, topology_generation: '8' }]);
    await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,topology_generation) VALUES($1::uuid,$2::uuid,1,8)', [id, host]);
    await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)', [id, host, old, coordinationPath]);
    if (!options.classic) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); renameSync(old, root);
    const base = { source_id: 'existing-recovery', path: root, worktree_id: id, reservation_file: physicalRootReservationPath(old), expected_epoch: '1', expected_generation: '8', request_id: randomUUID() };
    const call = (p: Record<string, unknown>) => withVerifiedLocalRegistration(engine, registration, () => runPersistenceAdministration(engine, 'writer_bind_existing' as never, p));
    const preview = await call({ ...base, dry_run: true }); expect(preview.eligible).toBe(true);
    const params = { ...base, admin_intent: 'writer_bind_existing', expected_state: preview.expected_admin_state, expect: preview.plan_hash };
    const apply = async (hooks: BindExistingHooks = {}) => withVerifiedLocalRegistration(engine, registration, async () => (await import('../src/core/persistence/bind-existing.ts')).bindExistingWorktree(engine, params, hooks));
    const restart = async () => { await engine.disconnect(); engine = nextEngine(); await engine.connect({ database_path: datastore }); };
    await run({ root, old, home, id, params, principal: registration.id, apply, call, restart });
    } finally { await engine.disconnect(); }
  }); } finally { rmSync(home, { recursive: true, force: true }); }
  };
}

for (const boundary of ['before_reserved', 'reserved', 'publication_prepared', 'reservation_linked', 'reservation_created', 'stamp_published', 'physical_ready', 'before_sql_commit', 'sql_committed', 'historical_removed', 'before_cleanup', 'cleaned']) {
  test(`every durable boundary converges or retains conflict: ${boundary}`, fixture(async ({ root, id, apply, params, call, old, restart }) => {
    await expect(apply({ boundary(name) { if (name === boundary) throw new Error('synthetic crash'); } })).rejects.toThrow('synthetic crash');
    await restart();
    if (boundary === 'before_reserved') {
      expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes')).toHaveLength(0);
      expect(existsSync(physicalRootReservationPath(root))).toBe(false);
      expect((await apply()).state).toBe('committed');
    } else {
      await recoverSourceTopologies(engine, { limit: 16 });
      expect((await call(params)).state).toBe('committed');
    }
    const [owner] = await engine.executeRaw<{ owner_epoch: string; topology_generation: string; state: string }>('SELECT owner_epoch::text,topology_generation::text,state FROM persistence_worktrees WHERE id=$1::uuid', [id]);
    expect(owner).toEqual({ owner_epoch: '1', topology_generation: '9', state: 'active' });
    expect(await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE worktree_id=$1::uuid', [id])).toHaveLength(1);
    expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('Canonical bytes\n');
    expect(existsSync(old)).toBe(false); expect(registeredManagedRoots()).toContain(old);
    for (const counter of await engine.executeRaw<{ outstanding_count: string; recovery_bytes: string; intent_bytes: string }>('SELECT outstanding_count::text,recovery_bytes::text,intent_bytes::text FROM persistence_counters')) {
      expect(counter.outstanding_count).toBe('0'); expect(counter.recovery_bytes).toBe('0'); expect(counter.intent_bytes).toBe('0');
    }
  }), 60_000);
}

test('replay cannot advance generation twice', fixture(async ({ params, call, apply, id }) => {
  const first = await apply(); expect(await call(params)).toEqual(first);
  await expect(call({ ...params, path: '/different/intent' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  expect((await engine.executeRaw<{ value: string }>('SELECT topology_generation::text AS value FROM persistence_worktrees WHERE id=$1::uuid', [id]))[0].value).toBe('9');
}), 60_000);

test('crash reservation blocks competing source id at another directory', fixture(async ({ params, home, apply, call }) => {
  await expect(apply({ boundary(name) { if (name === 'reserved') throw new Error('synthetic crash'); } })).rejects.toThrow();
  const other = join(home, 'other'); mkdirSync(other);
  await expect(runManagedSourceLifecycle(engine, { operation: 'add', sourceId: String(params.source_id), path: other, requestId: randomUUID() })).rejects.toMatchObject({ code: 'recovery_required' });
  expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [params.source_id])).toHaveLength(0);
  await recoverSourceTopologies(engine); expect((await call(params)).state).toBe('committed');
}), 60_000);

test('retains unexpected bytes and legacy fences', fixture(async ({ root, old, apply }) => {
  const marker = join(root, '.gbrain-owner.json');
  await expect(apply({ boundary(name) { if (name === 'physical_ready') { const bytes = readFileSync(marker); renameSync(marker, marker + '.retained'); writeFileSync(marker, bytes, { mode: 0o600 }); throw new Error('synthetic crash'); } } })).rejects.toThrow();
  expect(await recoverSourceTopologies(engine)).toBe(0);
  expect(existsSync(marker + '.retained')).toBe(true); expect(registeredManagedRoots()).toContain(old);
  const [row] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes');
  expect(row.state).toBe('recovering'); expect(row.recovery).not.toBeNull();
}), 60_000);

test('pre-commit revocation aborts exact metadata', fixture(async ({ root, old, principal, apply }) => {
    const before = readFileSync(join(root, '.gbrain-owner.json'));
    const result = await apply({ async boundary(name) { if (name === 'physical_ready') await revokeLocalWriter(engine, principal); } });
    expect(result).toMatchObject({ state: 'failed', write_error: 'permission_denied' });
    expect(readFileSync(join(root, '.gbrain-owner.json'))).toEqual(before); expect(existsSync(physicalRootReservationPath(root))).toBe(false); expect(existsSync(physicalRootReservationPath(old))).toBe(true);
}), 60_000);

for (const hazard of ['current-reservation', 'next-stamp', 'same-byte-preimage', 'strict-preimage']) {
  test(`reserved then revoked abort preserves uncheckpointed metadata: ${hazard}`, fixture(async ({ root, old, principal, id, apply, restart }) => {
    const marker = join(root, '.gbrain-owner.json'), current = physicalRootReservationPath(root), historical = physicalRootReservationPath(old);
    await expect(apply({ boundary(name) { if (name === 'reserved') throw new Error('reserved interrupted'); } })).rejects.toThrow('reserved interrupted');
    const [reserved] = await engine.executeRaw<{ recovery: { physical: { published?: unknown; staged?: unknown } } }>('SELECT recovery FROM persistence_topology_changes');
    expect(reserved.recovery.physical.published).toBeUndefined(); expect(reserved.recovery.physical.staged).toBeUndefined();
    if (hazard === 'current-reservation') writeFileSync(current, JSON.stringify({ ...JSON.parse(readFileSync(historical, 'utf8')), root }), { mode: 0o600 });
    if (hazard === 'next-stamp' || hazard === 'same-byte-preimage') {
      const bytes = readFileSync(marker, 'utf8'); renameSync(marker, marker + '.retained');
      writeFileSync(marker, hazard === 'next-stamp' ? JSON.stringify({ ...JSON.parse(bytes), root }) : bytes, { mode: 0o600 });
    }
    const paths = [historical, marker, ...(existsSync(current) ? [current] : []), ...(existsSync(marker + '.retained') ? [marker + '.retained'] : [])];
    const before = paths.map(path => ({ path, bytes: readFileSync(path), inode: lstatSync(path, { bigint: true }).ino }));
    await revokeLocalWriter(engine, principal); await restart();
    expect(await recoverSourceTopologies(engine)).toBe(hazard === 'strict-preimage' ? 1 : 0);
    for (const file of before) {
      expect(existsSync(file.path)).toBe(true);
      expect(readFileSync(file.path)).toEqual(file.bytes);
      expect(lstatSync(file.path, { bigint: true }).ino).toBe(file.inode);
    }
    const [row] = await engine.executeRaw<{ state: string; recovery: unknown; outcome: { write_error?: string } }>('SELECT state,recovery,outcome FROM persistence_topology_changes');
    const [owner] = await engine.executeRaw<{ state: string; topology_generation: string }>('SELECT state,topology_generation::text FROM persistence_worktrees WHERE id=$1::uuid', [id]);
    if (hazard === 'strict-preimage') {
      expect(row.state).toBe('failed'); expect(row.recovery).toBeNull(); expect(row.outcome.write_error).toBe('permission_denied');
      expect(owner).toEqual({ state: 'active', topology_generation: '8' });
      expect(existsSync(current)).toBe(false);
    } else {
      expect(row.state).toBe('recovering'); expect(row.recovery).not.toBeNull();
      expect(owner).toEqual({ state: 'recovering', topology_generation: '8' });
      for (const counter of await engine.executeRaw<{ outstanding_count: string; recovery_bytes: string }>("SELECT outstanding_count::text,recovery_bytes::text FROM persistence_counters WHERE key='brain'")) {
        expect(BigInt(counter.outstanding_count)).toBeGreaterThan(0n); expect(BigInt(counter.recovery_bytes)).toBeGreaterThan(0n);
      }
    }
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['existing-recovery'])).toHaveLength(0);
  }), 60_000);
}

test('post-commit revocation only finishes cleanup', fixture(async ({ principal, apply, id }) => {
    await expect(apply({ async boundary(name) { if (name === 'sql_committed') { await revokeLocalWriter(engine, principal); throw new Error('synthetic crash'); } } })).rejects.toThrow();
    expect(await recoverSourceTopologies(engine)).toBe(1);
    expect((await engine.executeRaw<{ value: string }>('SELECT topology_generation::text AS value FROM persistence_worktrees WHERE id=$1::uuid', [id]))[0].value).toBe('9');
}), 60_000);

for (const boundary of ['abort_prepared', 'abort_stamp_restored', 'abort_reservation_removed', 'before_abort_cleanup']) {
  test(`abort restart preserves the exact recorded stamp inode: ${boundary}`, fixture(async ({ root, old, principal, apply, restart }) => {
    const marker = join(root, '.gbrain-owner.json'), before = readFileSync(marker);
    await expect(apply({ async boundary(name) {
      if (name === 'physical_ready') await revokeLocalWriter(engine, principal);
      if (name === boundary) throw new Error('abort interrupted');
    } })).rejects.toThrow('abort interrupted');
    await restart();
    expect(await recoverSourceTopologies(engine)).toBe(1);
    expect(await recoverSourceTopologies(engine)).toBe(0);
    expect(readFileSync(marker)).toEqual(before);
    expect(existsSync(physicalRootReservationPath(root))).toBe(false);
    expect(existsSync(physicalRootReservationPath(old))).toBe(true);
    const [row] = await engine.executeRaw<{ state: string; recovery: unknown; outcome: Record<string, unknown> }>('SELECT state,recovery,outcome FROM persistence_topology_changes');
    expect(row.state).toBe('failed'); expect(row.recovery).toBeNull(); expect(row.outcome.write_error).toBe('permission_denied');
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['existing-recovery'])).toHaveLength(0);
  }), 60_000);
}

test('abort recovers after final SQL rolls back with the restored stamp already renamed', fixture(async ({ root, principal, apply, restart }) => {
  const marker = join(root, '.gbrain-owner.json'), before = readFileSync(marker), actual = engine;
  engine = new Proxy(actual, { get(target, property) {
    if (property === 'transaction') return (run: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => run(new Proxy(tx, { get(inner, key) {
      if (key === 'executeRaw') return (sql: string, values?: unknown[]) => {
        if (sql.includes("SET state='failed'")) throw new Error('abort final SQL interrupted');
        return inner.executeRaw(sql, values);
      };
      const value = Reflect.get(inner, key); return typeof value === 'function' ? value.bind(inner) : value;
    } })));
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    await expect(apply({ async boundary(name) { if (name === 'physical_ready') await revokeLocalWriter(engine, principal); } })).rejects.toThrow('abort final SQL interrupted');
  } finally { engine = actual; }
  expect(readFileSync(marker)).toEqual(before);
  await restart();
  expect(await recoverSourceTopologies(engine)).toBe(1);
  const [row] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes');
  expect(row).toEqual({ state: 'failed', recovery: null });
}), 60_000);

for (const boundary of ['abort_prepared', 'abort_stamp_restored']) {
  test(`abort refuses a same-byte substituted stamp inode: ${boundary}`, fixture(async ({ root, principal, apply, restart }) => {
    let retained = '';
    await expect(apply({ async boundary(name) {
      if (name === 'physical_ready') await revokeLocalWriter(engine, principal);
      if (name === boundary) {
        const [row] = await engine.executeRaw<{ recovery: { physical: { abortStamp: { path: string } } } }>('SELECT recovery FROM persistence_topology_changes');
        const path = boundary === 'abort_prepared' ? row.recovery.physical.abortStamp.path : join(root, '.gbrain-owner.json');
        const bytes = readFileSync(path); retained = path + '.retained'; renameSync(path, retained); writeFileSync(path, bytes, { mode: 0o600 });
        throw new Error('substituted abort stamp');
      }
    } })).rejects.toThrow('substituted abort stamp');
    await restart(); expect(await recoverSourceTopologies(engine)).toBe(0);
    expect(existsSync(retained)).toBe(true); expect(existsSync(physicalRootReservationPath(root))).toBe(true);
    const [row] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes');
    expect(row.state).toBe('recovering'); expect(row.recovery).not.toBeNull();
  }), 60_000);
}

for (const hazard of ['same-byte-inode', 'third-bytes', 'current-reservation']) {
  test(`abort terminal refuses a changed physical afterimage: ${hazard}`, fixture(async ({ root, old, principal, apply, restart }) => {
    const marker = join(root, '.gbrain-owner.json');
    await expect(apply({ async boundary(name) {
      if (name === 'physical_ready') await revokeLocalWriter(engine, principal);
      if (name === 'before_abort_cleanup') {
        if (hazard === 'current-reservation') writeFileSync(physicalRootReservationPath(root), readFileSync(physicalRootReservationPath(old)), { mode: 0o600 });
        else {
          const before = readFileSync(marker); renameSync(marker, marker + '.retained');
          writeFileSync(marker, hazard === 'same-byte-inode' ? before : JSON.stringify({ ...JSON.parse(before.toString()), root: old + '-changed' }), { mode: 0o600 });
        }
      }
    } })).rejects.toMatchObject({ code: 'recovery_required' });
    await restart(); expect(await recoverSourceTopologies(engine)).toBe(0);
    const [row] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes');
    expect(row.state).toBe('recovering'); expect(row.recovery).not.toBeNull();
  }), 60_000);
}

for (const boundary of ['reservation_created', 'stamp_published']) {
  test(`forward recovery refuses an unrecorded replacement inode: ${boundary}`, fixture(async ({ root, apply, restart }) => {
    const path = boundary === 'reservation_created' ? physicalRootReservationPath(root) : join(root, '.gbrain-owner.json');
    await expect(apply({ boundary(name) {
      if (name === boundary) { const bytes = readFileSync(path); renameSync(path, path + '.retained'); writeFileSync(path, bytes, { mode: 0o600 }); throw new Error('substituted forward inode'); }
    } })).rejects.toThrow('substituted forward inode');
    await restart(); expect(await recoverSourceTopologies(engine)).toBe(0);
    expect(existsSync(path + '.retained')).toBe(true);
    const [row] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes');
    expect(row.state).toBe('recovering'); expect(row.recovery).not.toBeNull();
  }), 60_000);
}

test('a rolled-back abort checkpoint removes only its unreferenced staged inode', fixture(async ({ root, principal, apply, restart }) => {
  const actual = engine;
  engine = new Proxy(actual, { get(target, property) {
    if (property === 'transaction') return (run: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => run(new Proxy(tx, { get(inner, key) {
      if (key === 'executeRaw') return (sql: string, values?: unknown[]) => {
        if (sql.includes('SET recovery=') && String(values?.[1]).includes('"abortStamp"')) throw new Error('abort checkpoint rolled back');
        return inner.executeRaw(sql, values);
      };
      const value = Reflect.get(inner, key); return typeof value === 'function' ? value.bind(inner) : value;
    } })));
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    await expect(apply({ async boundary(name) { if (name === 'physical_ready') await revokeLocalWriter(engine, principal); } })).rejects.toThrow('abort checkpoint rolled back');
  } finally { engine = actual; }
  expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  await restart(); expect(await recoverSourceTopologies(engine)).toBe(1);
  expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
}), 60_000);

test('recovery refuses an extra hardlink beyond the recorded publication pair', fixture(async ({ root, apply, restart }) => {
  const path = physicalRootReservationPath(root);
  await expect(apply({ boundary(name) { if (name === 'reservation_linked') { linkSync(path, path + '.third'); throw new Error('unowned third link'); } } })).rejects.toThrow('unowned third link');
  await restart(); expect(await recoverSourceTopologies(engine)).toBe(0);
  expect(existsSync(path + '.third')).toBe(true);
  const [row] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes');
  expect(row.state).toBe('recovering'); expect(row.recovery).not.toBeNull();
}), 60_000);

for (const checkpoint of ['publication', 'abort']) {
  test(`lost commit acknowledgement retains its exact staged inode: ${checkpoint}`, fixture(async ({ root, principal, apply, restart }) => {
    const actual = engine; let lost = false;
    engine = new Proxy(actual, { get(target, property) {
      if (property === 'transaction') return async (run: (tx: BrainEngine) => Promise<unknown>) => {
        let checkpointWritten = false;
        const result = await target.transaction(tx => run(new Proxy(tx, { get(inner, key) {
          if (key === 'executeRaw') return (sql: string, values?: unknown[]) => {
            const recovery = String(values?.[1]);
            if (sql.includes('SET recovery=') && recovery.includes(checkpoint === 'abort' ? '"abortStamp"' : '"staged"')) checkpointWritten = true;
            return inner.executeRaw(sql, values);
          };
          const value = Reflect.get(inner, key); return typeof value === 'function' ? value.bind(inner) : value;
        } })));
        if (checkpointWritten && !lost) { lost = true; throw new Error('lost checkpoint acknowledgement'); }
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await expect(apply({ async boundary(name) { if (checkpoint === 'abort' && name === 'physical_ready') await revokeLocalWriter(engine, principal); } })).rejects.toThrow('lost checkpoint acknowledgement');
    } finally { engine = actual; }
    expect(lost).toBe(true);
    await restart(); expect(await recoverSourceTopologies(engine)).toBe(1);
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
    const [row] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes');
    expect(row).toEqual({ state: checkpoint === 'abort' ? 'failed' : 'committed', recovery: null });
  }), 60_000);
}

for (const phase of ['reserved', 'sql_committed']) {
  test(`retains a source_changed row and recovers the healthy next row in the same batch: ${phase}`, fixture(async ({ home, id, params, call }) => {
    const { bindExistingWorktree } = await import('../src/core/persistence/bind-existing.ts');
    const registration = await readLocalWriter(engine, 'cli');
    const queue = (p: Record<string, unknown>, at: string) => withVerifiedLocalRegistration(engine, registration, () => bindExistingWorktree(engine, p, { boundary(name) { if (name === at) throw new Error('queued recovery'); } }));
    const first = { ...params };
    await expect(queue(first, phase)).rejects.toThrow('queued recovery');
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
    const old = join(home, 'healthy-old'), root = join(home, 'healthy-current'), healthy = randomUUID(), host = hostIdFor(engine);
    mkdirSync(old); execFileSync('git', ['init', '--quiet', old]);
    const coordinationPath = join(home, 'locks', 'healthy.lock');
    const reservation = reservePhysicalRootRecord(old, { brainId: brain.brain_id, worktreeId: healthy, hostId: host, coordinationPath });
    writePhysicalRootStamp(old, reservation);
    await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,topology_generation) VALUES($1::uuid,$2::uuid,1,8)', [healthy, host]);
    await engine.executeRaw('INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)', [healthy, host, old, coordinationPath]);
    renameSync(old, root);
    const second = { ...params, source_id: 'healthy-same-batch', worktree_id: healthy, path: root, reservation_file: physicalRootReservationPath(old), request_id: randomUUID() };
    const preview = await call({ ...second, dry_run: true }); expect(preview.eligible).toBe(true);
    await expect(queue({ ...second, expect: preview.plan_hash, expected_state: preview.expected_admin_state }, 'reserved')).rejects.toThrow('queued recovery');
    await engine.executeRaw("UPDATE persistence_topology_changes SET id=CASE WHEN source_id='existing-recovery' THEN '00000000-0000-4000-8000-000000000001'::uuid ELSE '00000000-0000-4000-8000-000000000002'::uuid END");
    await engine.executeRaw('UPDATE persistence_host_bindings SET local_path=$2 WHERE worktree_id=$1::uuid', [id, join(home, 'conflicting-host-path')]);
    const attempts: [string, boolean][] = [];
    expect(await recoverSourceTopologies(engine, { limit: 2, onAttempt: (key, done) => attempts.push([key, done]) })).toBe(1);
    expect(attempts).toEqual([['00000000-0000-4000-8000-000000000001', false], ['00000000-0000-4000-8000-000000000002', true]]);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['healthy-same-batch'])).toHaveLength(1);
    const [retained] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes WHERE request_id=$1::uuid', [first.request_id]);
    expect(retained.state).toBe('recovering'); expect(retained.recovery).not.toBeNull();
    expect(await recoverSourceTopologies(engine, { limit: 2 })).toBe(0);
  }), 60_000);
}

test('bind-existing CLI exits nonzero with the full failed receipt after pre-commit revocation', fixture(async ({ root, old, home, id, principal, params }) => {
  const before = readFileSync(join(root, '.gbrain-owner.json'));
  const config = { engine: 'pglite' as const, database_path: join(home, 'datastore') };
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  let receipt: Record<string, unknown> | undefined;
  const binding = (await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, {
    brainId: brain.brain_id,
    dispatch: async () => { throw new Error('Unexpected operation envelope'); },
    administer: async request => {
      expect(request.operation).toBe('writer_bind_existing');
      receipt = await withVerifiedLocalRegistration(engine, request.registration, async () => {
        const { bindExistingWorktree } = await import('../src/core/persistence/bind-existing.ts');
        return bindExistingWorktree(engine, request.params, { async boundary(name) {
          if (name === 'physical_ready') await revokeLocalWriter(engine, principal);
        } });
      });
      return receipt;
    },
  }))!;
  let stopChild: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../src/cli.ts'), 'sources', 'writer', 'bind-existing', String(params.source_id),
      '--path', root, '--worktree-id', id, '--reservation-file', String(params.reservation_file), '--expected-epoch', '1', '--expected-generation', '8',
      '--request-id', String(params.request_id), '--admin-intent', 'writer_bind_existing', '--expected-state', String(params.expected_state), '--expect', String(params.expect), '--json'], {
      cwd: home, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', NO_COLOR: '1' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    stopChild = async () => { if (child.exitCode === null) { child.kill(9); await child.exited; } };
    const expiry = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(9); reject(new Error('CLI exceeded fixture deadline')); }, 30_000); });
    const [stdout, stderr, code] = await Promise.race([Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]), expiry]);
    expect(receipt).toMatchObject({ state: 'failed', write_error: 'permission_denied' });
    expect(JSON.parse(stdout)).toEqual(receipt);
    expect({ code, stderr }).toEqual({ code: 1, stderr: '' });
    expect(readFileSync(join(root, '.gbrain-owner.json'))).toEqual(before);
    expect(existsSync(physicalRootReservationPath(root))).toBe(false);
    expect(existsSync(physicalRootReservationPath(old))).toBe(true);
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [params.source_id])).toEqual([]);
  } finally {
    clearTimeout(timer);
    await stopChild?.();
    const closed = once(binding.server, 'close'); binding.close(); await closed;
  }
}), 60_000);

test('P2 escaped long paths reserve publication and abort recovery capacity', fixture(async ({ root, old, principal, apply, id, restart }) => {
  const marker = join(root, '.gbrain-owner.json'), before = readFileSync(marker);
  await expect(apply({ async boundary(name) {
    if (name === 'physical_ready') await revokeLocalWriter(engine, principal);
    if (name === 'abort_prepared') throw new Error('long-path abort interrupted');
  } })).rejects.toThrow('long-path abort interrupted');
  const [pending] = await engine.executeRaw<{ used: number; reserved: number }>(
    'SELECT octet_length(recovery::text) AS used,recovery_bytes AS reserved FROM persistence_topology_changes');
  expect(pending.reserved).toBeGreaterThan(0);
  await restart(); expect(await recoverSourceTopologies(engine)).toBe(1);
  const [row] = await engine.executeRaw<{ state: string; recovery: unknown }>('SELECT state,recovery FROM persistence_topology_changes');
  expect(row).toEqual({ state: 'failed', recovery: null });
  expect(readFileSync(marker)).toEqual(before);
  expect(existsSync(physicalRootReservationPath(old))).toBe(true);
  expect(existsSync(physicalRootReservationPath(root))).toBe(false);
  expect((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_worktrees WHERE id=$1::uuid', [id]))[0].state).toBe('active');
  for (const row of await engine.executeRaw<{ recovery_bytes: string; outstanding_count: string }>('SELECT recovery_bytes::text,outstanding_count::text FROM persistence_counters')) {
    expect(row.recovery_bytes).toBe('0'); expect(row.outstanding_count).toBe('0');
  }
}, { longPath: true }), 60_000);

for (const boundary of ['reserved', 'physical_ready']) for (const kind of ['classic', 'meetings', 'slack'] as const) {
  test(`P2 ${kind} add cannot steal reserved source ID after ${boundary}`, fixture(async ({ params, apply, call, restart }) => {
    await expect(apply({ boundary(name) { if (name === boundary) throw new Error('classic bind interrupted'); } })).rejects.toThrow('classic bind interrupted');
    const opts = { id: String(params.source_id),
      ...(kind === 'meetings' ? { meetings: { provider: 'fireflies' as const, record: 'database' as const, transcript: 'summary' as const, private: false } } : {}),
      ...(kind === 'slack' ? { slack: { channels: ['C_TEST'], record: 'database' as const, private: false } } : {}),
    };
    await expect(addSource(engine, opts)).rejects.toMatchObject({ code: 'recovery_required' });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', [params.source_id])).toHaveLength(0);
    await restart(); expect(await recoverSourceTopologies(engine)).toBe(1);
    expect((await call(params)).state).toBe('committed');
  }, { classic: true }), 60_000);
}

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { assertPhysicalRoot, preparePhysicalRootReplacement, readPhysicalRootReservation, reservePhysicalRoot } from '../src/core/persistence/physical-root.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { hasManagedRootMarker } from '../src/core/persistence/root-registry.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const directory = mkdtempSync(join(tmpdir(), 'gbrain-physical-root-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  const base = join(directory, randomUUID()); mkdirSync(base);
  const root = join(base, 'canonical'); mkdirSync(root); writeFileSync(join(root, 'page.md'), 'Canonical example');
  const homes = [join(base, 'user-a'), join(base, 'user-b')]; for (const home of homes) mkdirSync(home);
  const sources = [`physical-${randomUUID()}`, `physical-${randomUUID()}`];
  for (const source of sources) await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
  const hosts: string[] = [];
  for (const home of homes) hosts.push(await withEnv({ GBRAIN_HOME: home }, () => localHostId()));
  return { base, root, homes, sources, hosts };
}

test('separate homes cannot give the same physical checkout two owner IDs', async () => {
  const f = await fixture();
  const first = await withEnv({ GBRAIN_HOME: f.homes[0] }, () => claimWorktree(engine, f.sources[0], f.root, f.hosts[0]));
  await withEnv({ GBRAIN_HOME: f.homes[1] }, async () => {
    await expect(claimWorktree(engine, f.sources[1], f.root, f.hosts[1])).rejects.toMatchObject({ code: 'recovery_required' });
  });
  expect(await getWorktreeBinding(engine, f.sources[1], f.hosts[1])).toBeNull();
  expect(readPhysicalRootReservation(f.root)?.worktreeId).toBe(first.worktree_id);
  expect(statSync(join(f.root, PHYSICAL_ROOT_MARKER)).mode & 0o777).toBe(0o600);
  expect(statSync(physicalRootReservationPath(f.root)).mode & 0o777).toBe(0o600);
  const lock = await acquireWorktree(first); expect(lock).not.toBeNull(); await lock?.release();
});

test('a prepared claim survives rollback and only its original host can resume its ID', async () => {
  const f = await fixture();
  let reserved!: Awaited<ReturnType<typeof reservePhysicalRoot>>;
  await withEnv({ GBRAIN_HOME: f.homes[0] }, async () => {
    await expect(engine.transaction(async tx => {
      await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
      reserved = await reservePhysicalRoot(tx, f.root, { hostId: f.hosts[0] });
      throw new Error('Interrupted before binding and root stamp');
    })).rejects.toThrow('Interrupted');
  });
  expect(existsSync(join(f.root, PHYSICAL_ROOT_MARKER))).toBe(false);
  expect(hasManagedRootMarker(join(f.root, 'page.md'))).toBe(true);
  await withEnv({ GBRAIN_HOME: f.homes[1] }, async () => {
    await expect(claimWorktree(engine, f.sources[1], f.root, f.hosts[1])).rejects.toMatchObject({ code: 'recovery_required' });
  });
  const resumed = await withEnv({ GBRAIN_HOME: f.homes[0] }, () => claimWorktree(engine, f.sources[0], f.root, f.hosts[0]));
  expect(resumed.worktree_id).toBe(reserved.worktreeId);
  expect(readPhysicalRootReservation(f.root)?.token).toBe(reserved.token);
  const stamp = readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8');
  await withEnv({ GBRAIN_HOME: f.homes[0] }, () => claimWorktree(engine, f.sources[0], f.root, f.hosts[0]));
  expect(readFileSync(join(f.root, PHYSICAL_ROOT_MARKER), 'utf8')).toBe(stamp);
});

test('copying or replacing a checkout cannot create or recover physical ownership', async () => {
  const f = await fixture();
  const binding = await withEnv({ GBRAIN_HOME: f.homes[0] }, () => claimWorktree(engine, f.sources[0], f.root, f.hosts[0]));
  const copy = join(f.base, 'copy'); cpSync(f.root, copy, { recursive: true });
  await withEnv({ GBRAIN_HOME: f.homes[0] }, async () => {
    await expect(claimWorktree(engine, f.sources[1], copy, f.hosts[0])).rejects.toMatchObject({ code: 'recovery_required' });
  });
  const old = join(f.base, 'old'); renameSync(f.root, old); cpSync(old, f.root, { recursive: true });
  await expect(acquireWorktree(binding)).rejects.toMatchObject({ code: 'recovery_required' });
  const released = await tryAcquireNativeLock(binding.coordination_path!); expect(released).not.toBeNull(); await released?.release();
  await withEnv({ GBRAIN_HOME: f.homes[0] }, async () => {
    await expect(claimWorktree(engine, f.sources[0], f.root, f.hosts[0])).rejects.toMatchObject({ code: 'recovery_required' });
  });
  expect(readPhysicalRootReservation(f.root)?.worktreeId).toBe(binding.worktree_id);
});

test('an overlapping ancestor claim is refused across homes and retains the original root', async () => {
  const f = await fixture();
  const child = join(f.root, 'child'); mkdirSync(child);
  const binding = await withEnv({ GBRAIN_HOME: f.homes[0] }, () => claimWorktree(engine, f.sources[0], child, f.hosts[0]));
  await withEnv({ GBRAIN_HOME: f.homes[1] }, async () => {
    await expect(claimWorktree(engine, f.sources[1], f.root, f.hosts[1])).rejects.toMatchObject({ code: 'recovery_required' });
  });
  expect(await getWorktreeBinding(engine, f.sources[1], f.hosts[1])).toBeNull();
  const lock = await acquireWorktree(binding); expect(lock).not.toBeNull(); await lock?.release();
});

test('missing or torn ownership metadata fails closed even for an existing owner', async () => {
  const f = await fixture();
  const binding = await withEnv({ GBRAIN_HOME: f.homes[0] }, () => claimWorktree(engine, f.sources[0], f.root, f.hosts[0]));
  rmSync(join(f.root, PHYSICAL_ROOT_MARKER));
  await expect(acquireWorktree(binding)).rejects.toMatchObject({ code: 'recovery_required' });
  await withEnv({ GBRAIN_HOME: f.homes[0] }, async () => {
    await expect(claimWorktree(engine, f.sources[0], f.root, f.hosts[0])).rejects.toMatchObject({ code: 'recovery_required' });
  });
  writeFileSync(physicalRootReservationPath(f.root), '{torn');
  await expect(acquireWorktree(binding)).rejects.toMatchObject({ code: 'recovery_required' });
});

test('verified staged replacement preserves reservation and validates both sides of the rename crash window', async () => {
  const f = await fixture();
  const binding = await withEnv({ GBRAIN_HOME: f.homes[0] }, () => claimWorktree(engine, f.sources[0], f.root, f.hosts[0]));
  const identity = { hostId: f.hosts[0], worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path! };
  const before = readPhysicalRootReservation(f.root)!;
  const stage = join(f.base, 'stage'); mkdirSync(stage); writeFileSync(join(stage, 'page.md'), 'Canonical example');
  await expect(preparePhysicalRootReplacement(engine, stage, f.root, identity)).rejects.toMatchObject({ code: 'recovery_required' });
  const lock = await acquireWorktree(binding);
  try {
    await engine.transaction(tx => tx.executeRaw("UPDATE persistence_worktrees SET state='recovering' WHERE id=$1::uuid", [binding.worktree_id]).then(() => undefined));
    await engine.transaction(tx => preparePhysicalRootReplacement(tx, stage, f.root, identity));
    assertPhysicalRoot(f.root, identity);
    renameSync(f.root, join(f.base, 'aside'));
    expect(() => assertPhysicalRoot(f.root, identity)).toThrow();
    renameSync(stage, f.root);
    assertPhysicalRoot(f.root, identity);
    expect(readPhysicalRootReservation(f.root)?.token).toBe(before.token);
    expect(readPhysicalRootReservation(f.root)?.worktreeId).toBe(binding.worktree_id);
  } finally { await lock?.release(); }
});

test.skipIf(!process.env.DATABASE_URL)('two real PostgreSQL processes with distinct homes race one first claim', async () => {
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  const f = await fixture();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let release!: () => void;
  let holding: Promise<void> | undefined;
  try {
    const [{ database }] = await pg.engine.executeRaw<{ database: string }>('SELECT current_database() AS database');
    const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`;
    for (const source of f.sources) await pg.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, f.root]);
    let ready!: () => void; const acquired = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    holding = pg.engine.transaction(async tx => { await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE'); ready(); await gate; });
    await acquired;
    for (let index = 0; index < 2; index++) children.push(Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/physical-root-claim-child.ts'), f.sources[index], f.root],
      { env: { ...process.env, GBRAIN_HOME: f.homes[index], DATABASE_URL: url.toString() }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
    const deadline = performance.now() + 30_000;
    while (!f.homes.every(home => existsSync(join(home, 'ready')))) {
      if (performance.now() > deadline) throw new Error('Claim processes did not become ready');
      await delay(20);
    }
    for (const child of children) (child.stdin as import('bun').FileSink).end();
    let blocked = 0;
    while (blocked < 2 && performance.now() < deadline) {
      const [row] = await pg.engine.executeRaw<{ count: number }>(`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`);
      blocked = row.count; if (blocked < 2) await delay(20);
    }
    expect(blocked).toBe(2); release(); await holding;
    const results = await Promise.all(children.map(async child => {
      const output = await new Response(child.stdout as ReadableStream).text();
      const errors = await new Response(child.stderr as ReadableStream).text();
      expect(await child.exited).toBe(0);
      if (!output) throw new Error(errors);
      return JSON.parse(output) as { claimed: boolean; code?: string; worktreeId?: string; hostId: string };
    }));
    expect(results[0].hostId).not.toBe(results[1].hostId);
    expect(results.filter(value => value.claimed)).toHaveLength(1);
    expect(results.find(value => !value.claimed)?.code).toBe('recovery_required');
    expect(await pg.engine.executeRaw('SELECT id FROM persistence_worktrees')).toHaveLength(1);
    expect(await pg.engine.executeRaw('SELECT source_id FROM persistence_source_bindings')).toHaveLength(1);
  } finally { release?.(); for (const child of children) if (child.exitCode === null) child.kill(); await holding; await Promise.allSettled(children.map(child => child.exited)); await pg.close(); }
}, 120_000);

/**
 * #6501: APFS reports a freshly created directory's birth time tens of
 * nanoseconds apart between the process that stamped it and later processes,
 * and the persisted physical-root stamp compared it exactly, so every write
 * to such a root was refused `recovery_required` with no exit named.
 *
 * Fix: persisted birth stamps compare through `samePhysicalBirth` (1 µs
 * tolerance, every other identity field exact, malformed and zero fail
 * closed), and a directory whose inode or birth moved beyond that while the
 * owner token, brain, worktree, root and device still match refuses with the
 * new detail `physical_root_directory_changed`, whose suggestion names the
 * #5914 `transfer prepare/accept --self-transfer --confirm-relocated-root`
 * exit. [R39]: the in-process path-race check, the staging identity and the
 * prepared-record digest CAS stay exact.
 *
 * Honest claim: the drift itself is not reproducible on Linux (ext4/tmpfs
 * report stable values); these tests perturb the persisted stamp.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { assertPhysicalRoot } from '../src/core/persistence/physical-root.ts';
import { inspectPhysicalRootRecovery, repairPhysicalRoot } from '../src/core/persistence/physical-root-recovery.ts';
import { PHYSICAL_BIRTH_TOLERANCE_NS, PHYSICAL_ROOT_MARKER, physicalRootDeviceChange, physicalRootReservationPath, samePhysicalBirth, writePhysicalRootStamp } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const ROOT = join(import.meta.dir, '..');

describe('samePhysicalBirth (#6501)', () => {
  const live = 1_791_731_240_233_986_720n;
  test('tolerates up to 1 µs of drift on a well-formed stamp, refuses beyond it', () => {
    expect(PHYSICAL_BIRTH_TOLERANCE_NS).toBe(1000n);
    expect(samePhysicalBirth(live.toString(), live)).toBe(true);
    expect(samePhysicalBirth((live - 50n).toString(), live)).toBe(true);
    expect(samePhysicalBirth((live + 47n).toString(), live)).toBe(true);
    expect(samePhysicalBirth((live - 1000n).toString(), live)).toBe(true);
    expect(samePhysicalBirth((live + 1000n).toString(), live)).toBe(true);
    expect(samePhysicalBirth((live - 1001n).toString(), live)).toBe(false);
    expect(samePhysicalBirth((live + 1001n).toString(), live)).toBe(false);
    expect(samePhysicalBirth((live - 5_000_000_000n).toString(), live)).toBe(false);
  });
  test('malformed and zero stamps fail closed; an exact zero against a zero filesystem still matches', () => {
    expect(samePhysicalBirth('abc', live)).toBe(false);
    expect(samePhysicalBirth('', live)).toBe(false);
    expect(samePhysicalBirth('-50', live)).toBe(false);
    expect(samePhysicalBirth('1.5', live)).toBe(false);
    expect(samePhysicalBirth(null, live)).toBe(false);
    expect(samePhysicalBirth(undefined, live)).toBe(false);
    expect(samePhysicalBirth('0', live)).toBe(false);
    expect(samePhysicalBirth('0', 5n)).toBe(false);
    expect(samePhysicalBirth('5', 0n)).toBe(false);
    expect(samePhysicalBirth('0', 0n)).toBe(true);
  });
  test('the device door keeps its parity: a 50 ns birth drift still recognizes a device-only change, 1 µs + 1 ns does not', () => {
    const stamp = { version: 1 as const, token: randomUUID(), brainId: randomUUID(), worktreeId: randomUUID(), root: '/example/root', device: '7', inode: '11', birth: live.toString() };
    const reservation = { token: stamp.token, brainId: stamp.brainId, worktreeId: stamp.worktreeId, root: stamp.root };
    const info = (dev: bigint, ino: bigint, birth: bigint) => ({ dev, ino, birthtimeNs: birth });
    expect(physicalRootDeviceChange(stamp, reservation, info(8n, 11n, live + 50n))).toEqual({ from: '7', to: '8' });
    expect(physicalRootDeviceChange(stamp, reservation, info(8n, 11n, live - 1000n))).toEqual({ from: '7', to: '8' });
    expect(physicalRootDeviceChange(stamp, reservation, info(8n, 11n, live - 1001n))).toBeNull();
    expect(physicalRootDeviceChange(stamp, reservation, info(8n, 12n, live + 50n))).toBeNull();
    expect(physicalRootDeviceChange({ ...stamp, birth: '0' }, reservation, info(8n, 11n, 0n))).toBeNull();
  });
  test('writePhysicalRootStamp re-stats after the marker lands: the stamp carries the post-create birth time', () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-restat-')));
    const original = fs.statSync;
    let bigintStats = 0;
    // The creating process reads one value before the marker exists and another after (the reported APFS shape).
    const spy = spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, opts?: { bigint?: boolean }) => {
      const info = original(path, opts as never) as unknown as fs.BigIntStats;
      if (path === dir && opts?.bigint && ++bigintStats === 1) return new Proxy(info, { get: (target, key) => key === 'birthtimeNs' ? target.birthtimeNs - 50n : Reflect.get(target, key) });
      return info;
    }) as typeof fs.statSync);
    try {
      const reservation = { version: 1 as const, token: randomUUID(), brainId: randomUUID(), worktreeId: randomUUID(), hostId: randomUUID(), root: dir,
        coordinationPath: join(tmpdir(), 'unused.lock'), initialDevice: null, initialInode: null, initialBirth: null };
      writePhysicalRootStamp(dir, reservation);
      expect(bigintStats).toBeGreaterThanOrEqual(2);
      expect(readJson(join(dir, PHYSICAL_ROOT_MARKER)).birth).toBe(original(dir, { bigint: true }).birthtimeNs.toString());
    } finally { spy.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('[R39] the in-process path-race check and the staging identity still compare birth exactly', () => {
    // test-reads-source-ok[structural]: [R39] pins that the tolerance stays out of these three exact comparisons; the
    // behaviour (a 50 ns drift refuses) is pinned below, this guards the seam from a later "share the helper" edit.
    const nativeTarget = readFileSync(join(ROOT, 'src/core/persistence/native-file-target.ts'), 'utf8');
    expect(nativeTarget).toContain('current.birthtimeNs !== rootInfo.birthtimeNs');
    expect(nativeTarget).not.toContain('samePhysicalBirth');
    // test-reads-source-ok[structural]: same seam guard as above.
    const topology = readFileSync(join(ROOT, 'src/core/persistence/topology-recovery.ts'), 'utf8');
    expect(topology).toContain('current.birthNs!==expected.birthNs');
    expect(topology).not.toContain('samePhysicalBirth');
    // test-reads-source-ok[structural]: same seam guard as above.
    const recovery = readFileSync(join(ROOT, 'src/core/persistence/physical-root-recovery.ts'), 'utf8');
    expect(recovery).not.toContain('samePhysicalBirth');
  });
});

for (const kind of testBackends()) describe(`physical root birth drift (${kind})`, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-root-birth-')));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine));
    if (close) await close(); else await engine.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  type Fixture = { root: string; source: string; ctx: OperationContext; registration: Awaited<ReturnType<typeof registerLocalWriter>>; marker: string };
  async function fixture(run: (f: Fixture) => Promise<void>) {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `birth-${randomUUID().slice(0, 8)}`;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      await claimWorktree(engine, source, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const registration = await registerLocalWriter(engine, 'cli');
      const ctx: OperationContext = { engine, remote: false, sourceId: source, config: { engine: engine.kind, embedding_disabled: true } as never,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      await run({ root, source, ctx, registration, marker: join(root, PHYSICAL_ROOT_MARKER) });
    });
  }
  const put = (f: Fixture, slug: string) => withVerifiedLocalRegistration(engine, f.registration, () =>
    operationsByName.put_page!.handler(f.ctx, { source_id: f.source, slug, request_id: randomUUID(),
      content: '---\ntype: note\ntitle: Example\n---\nA managed observation on a drifted root.\n' }))
    // The journal keeps code and message: the message names the relocated-root exit; writer status carries the filled commands.
    .then(r => (r as { state: string }).state, (e: { code?: string; message?: string }) =>
      `${e.code}${e.message?.includes('self-transfer that confirms a relocated root') ? '/relocated-root-exit' : ''}`);
  /** The reporter's table: the stamp written by the creating process sits `delta` ns from what later processes read. */
  const drift = (f: Fixture, delta: bigint) => {
    const stamp = readJson(f.marker);
    writeJson(f.marker, { ...stamp, birth: (BigInt(stamp.birth) + delta).toString() });
    return stamp;
  };
  // Waits for this process's lane lease from the previous publication to drain (on Postgres it outlives the receipt), so a
  // null here is a real "busy", never a lock the stamp check did not get to run on.
  const refusal = (binding: NonNullable<Awaited<ReturnType<typeof getWorktreeBinding>>>) =>
    acquireWorktree(binding, 5000, undefined, engine, { yieldLanes: true }).then(lock => lock?.release().then(() => null) ?? null, (error: unknown) => error as { code: string; detail?: string; suggestion?: string });

  test('a stamp −50 ns and +47 ns from the live birth time commits writes and rewrites nothing', () => fixture(async f => {
    expect(await put(f, 'notes/before-drift')).toBe('committed');
    for (const delta of [-50n, 47n, -1000n, 1000n]) {
      const stamped = drift(f, delta);
      expect(await put(f, `notes/drift-${delta}`)).toBe('committed');
      expect(readJson(f.marker)).toEqual({ ...stamped, birth: (BigInt(stamped.birth) + delta).toString() });
      writeJson(f.marker, stamped);
    }
  }), 60_000);

  test('a stamp 1 µs + 1 ns or 5 s away refuses with physical_root_directory_changed and the filled relocated-root exit, marker untouched', () => fixture(async f => {
    expect(await put(f, 'notes/before-drift')).toBe('committed');
    const binding = (await getWorktreeBinding(engine, f.source))!;
    for (const delta of [-1001n, 1001n, -5_000_000_000n]) {
      const stamped = drift(f, delta);
      expect(await put(f, `notes/drift-${delta}`)).toBe('recovery_required/relocated-root-exit');
      const refused = await refusal(binding);
      expect(refused).toMatchObject({ code: 'recovery_required', detail: 'physical_root_directory_changed' });
      expect(refused!.suggestion).toContain(`gbrain sources writer transfer prepare ${f.source} --self-transfer --confirm-relocated-root`);
      expect(refused!.suggestion).toContain(`gbrain sources writer transfer accept ${f.source} --path ${f.root} --expected-epoch ${binding.owner_epoch}`);
      expect(refused!.suggestion).toContain('--self-transfer --confirm-relocated-root --admin-intent writer_transfer_accept');
      expect(readJson(f.marker)).toEqual({ ...stamped, birth: (BigInt(stamped.birth) + delta).toString() });
      writeJson(f.marker, stamped);
    }
    expect(await put(f, 'notes/after-restore')).toBe('committed');
  }), 60_000);

  test('negatives: equal birth with a token, brain, worktree, device or inode mismatch, a malformed or zero birth, still refuse', () => fixture(async f => {
    expect(await put(f, 'notes/before')).toBe('committed');
    const binding = (await getWorktreeBinding(engine, f.source))!;
    const stamped = readJson(f.marker);
    const cases: Array<[Record<string, string>, string | undefined]> = [
      [{ token: randomUUID() }, undefined], [{ brainId: randomUUID() }, undefined], [{ worktreeId: randomUUID() }, undefined],
      [{ root: `${f.root}-other` }, undefined],
      [{ inode: (BigInt(stamped.inode) + 1n).toString() }, 'physical_root_directory_changed'],
      [{ inode: (BigInt(stamped.inode) + 1n).toString(), device: (BigInt(stamped.device) + 1n).toString() }, undefined],
      [{ birth: 'abc' }, undefined], [{ birth: '' }, undefined],
      [{ birth: '0' }, 'physical_root_directory_changed'],
    ];
    for (const [change, detail] of cases) {
      writeJson(f.marker, { ...stamped, ...change });
      const refused = await refusal(binding);
      expect(refused).toMatchObject({ code: 'recovery_required' });
      expect(refused!.detail).toBe(detail);
      expect(await put(f, `notes/${Object.keys(change).join('-')}`)).toBe(`recovery_required${detail ? '/relocated-root-exit' : ''}`);
      expect(readJson(f.marker)).toEqual({ ...stamped, ...change });
      expect(readJson(physicalRootReservationPath(f.root))).toMatchObject({ initialBirth: stamped.birth });
    }
    writeJson(f.marker, stamped);
    expect(await put(f, 'notes/after')).toBe('committed');
  }), 60_000);

  test('a directory recreated at the recorded path refuses with the new detail, and the named relocated-root self-transfer restores writes', () => fixture(async f => {
    expect(await put(f, 'notes/before-recreate')).toBe('committed');
    const binding = (await getWorktreeBinding(engine, f.source))!;
    await disposePersistenceConsumer(engine);
    // A restore from backup: new directory at the same path with the same bytes (new inode, new birth time, same device).
    const previous = `${f.root}.previous`;
    renameSync(f.root, previous); mkdirSync(f.root); cpSync(previous, f.root, { recursive: true }); rmSync(previous, { recursive: true, force: true });
    expect(statSync(f.root, { bigint: true }).ino.toString()).not.toBe(readJson(f.marker).inode);
    const refused = await refusal(binding);
    expect(refused).toMatchObject({ code: 'recovery_required', detail: 'physical_root_directory_changed' });
    expect(refused!.suggestion).toContain('--self-transfer --confirm-relocated-root');
    expect(() => assertPhysicalRoot(f.root, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path }))
      .toThrow(expect.objectContaining({ code: 'recovery_required', detail: 'physical_root_directory_changed' }));
    expect(await put(f, 'notes/while-recreated')).toBe('recovery_required/relocated-root-exit');
    const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
      runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) });
    // Without --confirm-relocated-root the self-transfer still refuses: the waiver is deliberate.
    await expect(administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
    const prepared = await administer('writer_transfer_prepare', { source_id: f.source, self_transfer: true, confirm_relocated_root: true }) as { owner_epoch: string; manifest: { digest: string } };
    await administer('writer_transfer_accept', { source_id: f.source, path: f.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true, confirm_relocated_root: true });
    expect(readJson(f.marker).inode).toBe(statSync(f.root, { bigint: true }).ino.toString());
    expect(await put(f, 'notes/after-relocation')).toBe('committed');
  }), 60_000);

  test('[R39] the prepared-record digest CAS stays exact: a 50 ns drift between prepare and accept refuses the repair', () => fixture(async f => {
    expect(await put(f, 'notes/before')).toBe('committed');
    const binding = (await getWorktreeBinding(engine, f.source))!;
    await disposePersistenceConsumer(engine);
    const reservation = readJson(physicalRootReservationPath(f.root));
    const identity = { brainId: reservation.brainId, worktreeId: binding.worktree_id, hostId: reservation.hostId, coordinationPath: binding.coordination_path! };
    const recovery = inspectPhysicalRootRecovery(f.root, identity);
    const marker = readJson(f.marker);
    expect(() => repairPhysicalRoot(f.root, recovery, identity, true)).not.toThrow();
    const drifted = { ...recovery, stamp: { ...recovery.stamp, birth: (BigInt(recovery.stamp.birth) - 50n).toString() } };
    expect(() => repairPhysicalRoot(f.root, drifted, identity)).toThrow(expect.objectContaining({ code: 'recovery_required' }));
    expect(readJson(f.marker)).toEqual(marker);
  }), 60_000);
});

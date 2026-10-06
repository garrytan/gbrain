/**
 * #5455/#5628: `gbrain sources writer deactivate` converts a managed brain back
 * to classic mode. Markers come from a real claim and activation. Each blocker
 * refuses with its exit; success retires worktrees (receipts keep their
 * foreign keys), bumps mode_epoch and records a committed writer_deactivate
 * change; local markers of the retired epoch are removed on this host and, on
 * connect, on any other host; newer or unknown markers are kept and reported.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { configDir } from '../src/core/config.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { cleanupRetiredManagedMarkers } from '../src/core/persistence/deactivation.ts';
import { assertManagedFilesystemWrite } from '../src/core/persistence/filesystem-guard.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, localHostId } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { performSync } from '../src/commands/sync.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { put } from './helpers/wave-fixture.ts';
import { waitFor } from './helpers/wait-for.ts';

const admin = (engine: BrainEngine, operation: string, params: Record<string, unknown> = {}) =>
  runPersistenceAdministration(engine, operation as never, params) as Promise<Record<string, any>>;
const deactivate = async (engine: BrainEngine, extra: Record<string, unknown> = {}) =>
  admin(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: await writerAdminState(engine), ...extra });
const protocol = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });
// The consumer started by put keeps running its effects. Rewriting effect rows
// while one is in flight lets its completion overwrite the rewrite (a requeued
// embedding effect read back as committed), so settle the source first.
const settleEffects = (engine: BrainEngine) => waitFor(async () => (await engine.executeRaw(
  "SELECT 1 FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.source_id='default' AND e.state IN ('queued','running')")).length === 0,
  { label: `${engine.kind}: default source effects settled` });
const registry = () => { const dir = join(configDir(), 'persistence', 'managed-roots'); return existsSync(dir) ? readdirSync(dir).map(f => join(dir, f)) : []; };
const brainRow = async (engine: BrainEngine) => (await engine.executeRaw<{ brain_id: string; enabled: boolean; mode_epoch: string }>(
  'SELECT brain_id, enabled, mode_epoch::text FROM persistence_brain WHERE singleton=1'))[0];

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`#5455 sources writer deactivate (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('dry run lists every blocker and changes nothing; each blocker refuses with its exit', () => managedBrain(async ({ engine, ctx }) => {
    await put(ctx, 'notes/one', 'Body.');
    await settleEffects(engine);
    const [request] = await engine.executeRaw<{ request_id: string; id: string }>("SELECT request_id::text, id::text FROM persistence_requests WHERE slug='notes/one'");
    await protocol(engine, "UPDATE persistence_effects SET state='committed'");
    await protocol(engine, "UPDATE persistence_effects SET state='queued', next_attempt_at=now()+interval '1 day' WHERE request_id=$1::uuid AND kind='embedding'", [request.id]);
    await admin(engine, 'writer_lock');
    const before = await writerAdminState(engine);
    const dry = await admin(engine, 'writer_deactivate', { dry_run: true });
    expect(dry.mode).toBe('managed');
    expect(dry.dry_run).toBe(true);
    expect(dry.blockers.map((b: { kind: string }) => b.kind)).toEqual(['writer_admin_lock', 'effect']);
    expect(dry.blockers.find((b: { kind: string }) => b.kind === 'effect').exit).toBe('gbrain repair embedding-effects --source default');
    expect(dry.retired_worktrees.length).toBe(1);
    expect(dry.kept).toMatchObject({ skill_bundles_enabled: true, writer_protocol_floor: 2 });
    expect(await writerAdminState(engine)).toBe(before);
    expect((await brainRow(engine)).enabled).toBe(true);

    await expect(deactivate(engine)).rejects.toMatchObject({ code: 'writer_admin_locked' });
    await admin(engine, 'writer_unlock');
    await expect(deactivate(engine)).rejects.toMatchObject({ code: 'writer_not_quiesced',
      suggestion: expect.stringContaining('gbrain repair embedding-effects --source default') });
    await protocol(engine, "UPDATE persistence_effects SET state='committed' WHERE request_id=$1::uuid", [request.id]);
    await protocol(engine, "UPDATE persistence_requests SET state='queued' WHERE id=$1::uuid", [request.id]);
    await expect(deactivate(engine)).rejects.toMatchObject({ code: 'writer_not_quiesced',
      suggestion: expect.stringContaining(`gbrain cancel-write-request ${request.request_id}`) });
    await protocol(engine, "UPDATE persistence_requests SET state='committed' WHERE id=$1::uuid", [request.id]);

    const current = await writerAdminState(engine);
    await expect(admin(engine, 'writer_deactivate', { admin_intent: 'writer_deactivate', expected_state: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'writer_admin_state_changed', suggestion: expect.stringContaining(`The current admin_state is ${current}`) });
    await expect(admin(engine, 'writer_deactivate', { source_id: 'default', dry_run: true })).rejects.toMatchObject({ code: 'invalid_params',
      message: expect.stringContaining('brain-wide') });
    const stdio = await registerLocalWriter(engine, 'stdio');
    await expect(withVerifiedLocalRegistration(engine, stdio, () => deactivate(engine))).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await brainRow(engine)).enabled).toBe(true);
  }, { databaseUrl }));

  test('success: classic mode, retired worktrees keep receipts, markers from the real activation are removed, content unchanged; rerun is a no-op', () => managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, 'notes/one', 'Body one.');
    await settleEffects(engine);
    await protocol(engine, "UPDATE persistence_effects SET state='committed'");
    const file = readFileSync(join(root, 'notes', 'one.md'), 'utf8');
    const page = await engine.getPage('notes/one', { sourceId: 'default' });
    const brain = await brainRow(engine);
    const binding = (await getWorktreeBinding(engine, 'default', localHostId()))!;
    const markers = [join(root, '.gbrain-owner.json'), join(root, '.gbrain-managed')];
    for (const marker of markers) expect(existsSync(marker)).toBe(true);
    expect(registry().length).toBeGreaterThan(0);
    expect(() => assertManagedFilesystemWrite(join(root, 'notes', 'two.md'))).toThrow();

    const done = await deactivate(engine);
    expect(done).toMatchObject({ mode: 'classic', deactivated: true, retired_mode_epoch: Number(brain.mode_epoch), mode_epoch: Number(brain.mode_epoch) + 1,
      local_markers: { state: 'cleared' } });
    expect(done.retired_worktrees).toEqual([{ id: binding.worktree_id, roots: [binding.local_path] }]);
    for (const marker of markers) expect(existsSync(marker)).toBe(false);
    expect(registry().filter(path => path.includes(brain.brain_id))).toEqual([]);
    expect(() => assertManagedFilesystemWrite(join(root, 'notes', 'two.md'))).not.toThrow();
    expect(await engine.executeRaw('SELECT 1 FROM persistence_source_bindings')).toEqual([]);
    expect(await engine.executeRaw('SELECT 1 FROM persistence_host_bindings')).toEqual([]);
    expect((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_worktrees WHERE id=$1::uuid', [binding.worktree_id]))[0].state).toBe('retired');
    expect((await engine.executeRaw('SELECT 1 FROM persistence_requests WHERE worktree_id=$1::uuid', [binding.worktree_id])).length).toBeGreaterThan(0);
    const [change] = await engine.executeRaw<{ state: string; outcome: Record<string, unknown> }>("SELECT state, outcome FROM persistence_topology_changes WHERE operation='writer_deactivate'");
    expect(change).toMatchObject({ state: 'committed', outcome: { brain_id: brain.brain_id, retired_mode_epoch: Number(brain.mode_epoch) } });
    expect(readFileSync(join(root, 'notes', 'one.md'), 'utf8')).toBe(file);
    expect((await engine.getPage('notes/one', { sourceId: 'default' }))?.compiled_truth).toBe(page?.compiled_truth);
    const status = await admin(engine, 'writer_status');
    expect(status).toMatchObject({ mode: 'classic', local_markers: { state: 'cleared' } });

    const again = await deactivate(engine);
    expect(again).toMatchObject({ mode: 'classic', deactivated: false, local_markers: { state: 'cleared' } });
    expect((await engine.executeRaw("SELECT 1 FROM persistence_topology_changes WHERE operation='writer_deactivate'")).length).toBe(1);

    // A classic sync of the former managed checkout imports a new file.
    execFileSync('git', ['-C', root, 'init', '-q']);
    writeFileSync(join(root, 'notes', 'two.md'), '---\ntype: note\ntitle: Two\n---\n\nClassic write.\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'two']);
    await performSync(engine, { repoPath: root, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true } as never);
    expect((await engine.getPage('notes/two', { sourceId: 'default' }))?.compiled_truth).toContain('Classic write.');

    // A live owner's stale binding can no longer admit.
    const authority = await submissionAuthority({ ...ctx } as OperationContext, 'put_page', 'default', binding.source_incarnation, 'notes/three');
    await expect(admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: binding.source_incarnation, slug: 'notes/three', requestId: randomUUID(), callerIntent: {}, intent: {},
      worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation })).rejects.toMatchObject({ code: 'source_changed' });
  }, { databaseUrl }));

  test('another host: retired and pre-wave markers are removed on connect; a restored-backup marker is kept and reported', () => managedBrain(async ({ engine, root }) => {
    const brain = await brainRow(engine);
    const binding = (await getWorktreeBinding(engine, 'default', localHostId()))!;
    await deactivate(engine);
    // What another host still has on disk: a pre-wave registry record and marker (no epoch) and one from a restored newer backup.
    const dir = join(configDir(), 'persistence', 'managed-roots'); mkdirSync(dir, { recursive: true });
    const preWave = join(dir, `${brain.brain_id}.aaaa.json`);
    writeFileSync(preWave, JSON.stringify({ version: 1, brain_id: brain.brain_id, root, local_path: root, worktree_id: binding.worktree_id }), { mode: 0o600 });
    writeFileSync(join(root, '.gbrain-managed'), JSON.stringify({ version: 1, managed: true, brain_id: brain.brain_id }), { mode: 0o600 });
    writeFileSync(join(root, '.gbrain-owner.json'), JSON.stringify({ version: 1, token: randomUUID(), brainId: brain.brain_id, worktreeId: binding.worktree_id }), { mode: 0o600 });
    const otherBrain = join(dir, `${randomUUID()}.bbbb.json`);
    writeFileSync(otherBrain, JSON.stringify({ version: 1, brain_id: 'other', root: '/elsewhere', local_path: '/elsewhere' }), { mode: 0o600 });
    const newer = join(dir, `${brain.brain_id}.cccc.json`);
    writeFileSync(newer, JSON.stringify({ version: 1, brain_id: brain.brain_id, root: join(root, 'x'), local_path: join(root, 'x'), mode_epoch: 99 }), { mode: 0o600 });
    expect(() => assertManagedFilesystemWrite(join(root, 'notes', 'a.md'))).toThrow();

    const report = await cleanupRetiredManagedMarkers(engine);
    expect(report.removed.sort()).toEqual([preWave, join(root, '.gbrain-managed'), join(root, '.gbrain-owner.json')].sort());
    expect(report).toMatchObject({ state: 'pending', pending: [{ path: newer, reason: 'newer_mode_epoch' }] });
    expect(existsSync(otherBrain)).toBe(true);
    expect(existsSync(newer)).toBe(true);
    expect(() => assertManagedFilesystemWrite(join(root, 'notes', 'a.md'))).not.toThrow();
    // A retired reservation beside a checkout that no longer exists is removed too.
    const gone = join(dirname(root), 'gone-checkout');
    const { physicalRootReservationPath } = await import('../src/core/persistence/physical-root-record.ts');
    await engine.executeRaw("UPDATE persistence_topology_changes SET outcome=jsonb_set(outcome,'{source_roots}',to_jsonb(ARRAY[$1::text])) WHERE operation='writer_deactivate'", [gone]);
    const reservation = physicalRootReservationPath(gone);
    writeFileSync(reservation, JSON.stringify({ version: 1, token: randomUUID(), brainId: brain.brain_id, worktreeId: binding.worktree_id }), { mode: 0o600 });
    expect((await cleanupRetiredManagedMarkers(engine)).removed).toContain(reservation);
    expect(existsSync(reservation)).toBe(false);
    expect((await admin(engine, 'writer_status')).local_markers).toMatchObject({ state: 'pending', pending: [{ path: newer }] });
  }, { databaseUrl }));

  test('a host offline across deactivate and reactivation removes only the retired markers', () => managedBrain(async ({ engine, root }) => {
    const brain = await brainRow(engine);
    const old = (await getWorktreeBinding(engine, 'default', localHostId()))!;
    await deactivate(engine);
    await claimWorktree(engine, 'default', root);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    const fresh = (await getWorktreeBinding(engine, 'default', localHostId()))!;
    expect(fresh.worktree_id).not.toBe(old.worktree_id);
    const current = await brainRow(engine);
    expect(Number(current.mode_epoch)).toBe(Number(brain.mode_epoch) + 2);
    const dir = join(configDir(), 'persistence', 'managed-roots');
    const stale = join(dir, `${brain.brain_id}.dddd.json`);
    writeFileSync(stale, JSON.stringify({ version: 1, brain_id: brain.brain_id, root: '/offline/old', local_path: '/offline/old', mode_epoch: Number(brain.mode_epoch) }), { mode: 0o600 });
    const kept = registry().filter(path => path !== stale);
    expect(kept.length).toBeGreaterThan(0);
    const report = await cleanupRetiredManagedMarkers(engine);
    expect(report).toMatchObject({ state: 'cleared', removed: [stale] });
    for (const path of kept) expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, '.gbrain-owner.json'))).toBe(true);
    expect(() => assertManagedFilesystemWrite(join(root, 'notes', 'a.md'))).toThrow();
  }, { databaseUrl }));
});

/**
 * #10260: a managed source whose ownership reservation beside the checkout (`.gbrain-owner-<hash>.json` in the parent
 * folder) was deleted by something outside gbrain, while the stamp inside the checkout (`.gbrain-owner.json`) survived,
 * was refused `recovery_required` by every write, repair and shared-skill activation with a generic message and no exit;
 * the documented relocated-root self-transfer refused it too.
 *
 * (a) The refusal names the state (detail `ownership_reservation_missing`) and its fix: the plain self-transfer, which
 *     verifies the stamp against this brain, the worktree this host owns and the live directory, takes the worktree lock
 *     and re-creates the reservation. Writer status, the relocated-root self-transfer, a claim of the same path and
 *     shared-skill activation all point at it; it previews first and changes nothing until its admin intent is given.
 * (b) A stamp that no longer identifies this exact directory keeps the generic refusal, and the self-transfer refuses it.
 * (c) A source sync imported from Git whose checkout lost its .git too is refused `checkout_git_missing`, with the
 *     steps to restore it; nothing is prepared. A repository in a folder above the checkout does not count, nor does a
 *     fresh repository without the last imported commit, and a .git lost between prepare and accept refuses at accept.
 *     An archived source's folder is not checked.
 * (d) A checkout that never was a Git repository (a repo-less brain's folder) recovers the same way, also when a source
 *     folder inside it is its own Git repository.
 *
 * Synthetic content only. PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { writerOnboardingPreflight } from '../src/core/persistence/onboarding.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { storedCheckoutRefusal, writeFailureDiagnostic } from '../src/core/persistence/verb-errors.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string) => `---\ntitle: ${title}\ntype: note\n---\nA synthetic observation about ${title}.\n`;
type Refusal = Record<string, any>;

for (const kind of testBackends()) describe(`#10260 lost ownership reservation (${kind})`, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-reservation-10260-')));
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
  const env = () => ({ GBRAIN_HOME: directory, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined });

  /** A managed source claimed on this host under `parent`; `gitRepo: false` leaves the folder without Git, as on a repo-less brain. */
  async function managedSource(gitRepo = true, parent = directory) {
    const id = `res-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(parent, id);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'a.md'), note('A'));
    if (gitRepo) {
      git(root, 'init', '-q'); git(root, 'add', '-A');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    return { id, root, binding: (await getWorktreeBinding(engine, id))! };
  }
  const refused = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as Refusal);
  const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
    runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) });
  const withSyncedCommit = async (sourceId: string, commit: string) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1', [sourceId, commit]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  };

  test('(a) a lost reservation names the plain self-transfer everywhere it refuses, and that self-transfer re-creates it', () => withEnv(env(), async () => {
    const s = await managedSource();
    const stamp = readFileSync(join(s.root, PHYSICAL_ROOT_MARKER), 'utf8');
    const original = JSON.parse(readFileSync(physicalRootReservationPath(s.root), 'utf8'));
    rmSync(physicalRootReservationPath(s.root));

    // Writes and repairs: the worktree lock every coordinated writer takes.
    const refusal = await refused(acquireWorktree(s.binding, 0, undefined, engine));
    expect(refusal).toMatchObject({ code: 'recovery_required', detail: 'ownership_reservation_missing', docs: 'docs/guides/write-refusals.md#ownership_reservation_missing' });
    expect(refusal!.fix).toMatchObject({ actor: 'host_admin', argv: ['gbrain', 'sources', 'writer', 'transfer', 'prepare', s.id, '--self-transfer',
      '--admin-intent', 'writer_transfer_prepare', '--expected-state', '<admin_state>'], preview_argv: ['gbrain', 'sources', 'writer', 'transfer', 'prepare', s.id, '--self-transfer', '--dry-run'] });
    expect(refusal!.fix.then.argv).toEqual(expect.arrayContaining(['gbrain', 'sources', 'writer', 'transfer', 'accept', s.id, '--path', s.root, '--self-transfer']));
    expect([...refusal!.fix.argv, ...refusal!.fix.then.argv]).not.toContain('--confirm-relocated-root');
    // A receipt that kept only the origin replays the same exit.
    expect(storedCheckoutRefusal('ownership_reservation_missing', s.id, 'notes/a')).toMatchObject({ code: 'recovery_required', detail: 'ownership_reservation_missing',
      fix: { argv: expect.arrayContaining(['prepare', s.id, '--self-transfer']) } });

    // A terminal write receipt explains the refusal and asks for a new request_id: the refused one replays its outcome.
    const diagnostic = writeFailureDiagnostic(refusal!.code, refusal!.message);
    expect(diagnostic).toMatchObject({ reason: 'ownership_reservation_missing' });
    expect(diagnostic.suggestion).toContain('new request_id');
    expect(diagnostic.suggestion).not.toContain('--confirm-relocated-root (each');

    // Writer status says why and names the same fix.
    const [status] = (await writerOnboardingPreflight(engine, s.id)).sources as Refusal[];
    expect(status).toMatchObject({ state: 'recovery_required', physical_fix: { argv: expect.arrayContaining(['prepare', s.id, '--self-transfer']) } });
    expect(status.physical_error).toContain('reservation');

    // The relocated-root self-transfer still refuses, now pointing at the plain one.
    const relocated = await refused(administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true, confirm_relocated_root: true }));
    expect(relocated).toMatchObject({ code: 'recovery_required', detail: 'ownership_reservation_missing' });
    expect(relocated!.message).toContain('without --confirm-relocated-root');
    expect(relocated!.fix.argv).not.toContain('--confirm-relocated-root');

    // A claim of the same path refuses the same way and claims nothing.
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await expect(claimWorktree(engine, s.id, s.root)).rejects.toMatchObject({ code: 'recovery_required', detail: 'ownership_reservation_missing' });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

    // Shared-skill activation stays all-or-nothing (its database guard needs every canonical owner verified), and names the source and fix.
    const activation = await refused(activateSharedSkillPersistence(engine, { confirmQuiesced: true, dryRun: true }));
    expect(activation).toMatchObject({ code: 'recovery_required', detail: 'ownership_reservation_missing', fix: { argv: expect.arrayContaining(['prepare', s.id]) } });

    // Nothing above wrote a record.
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(false);
    expect(readFileSync(join(s.root, PHYSICAL_ROOT_MARKER), 'utf8')).toBe(stamp);

    // The fix: preview, then prepare and accept on this host.
    const preview = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: s.id, self_transfer: true, dry_run: true }) as Refusal;
    expect(preview).toMatchObject({ dry_run: true });
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(false);
    expect((await getWorktreeBinding(engine, s.id))!.state).toBe('active');
    const prepared = await administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
    await administer('writer_transfer_accept', { source_id: s.id, path: s.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    const restored = JSON.parse(readFileSync(physicalRootReservationPath(s.root), 'utf8'));
    expect(restored).toMatchObject({ token: original.token, brainId: original.brainId, worktreeId: original.worktreeId, root: s.root, coordinationPath: original.coordinationPath });
    expect(readFileSync(join(s.root, PHYSICAL_ROOT_MARKER), 'utf8')).toBe(stamp);
    const binding = (await getWorktreeBinding(engine, s.id))!;
    const lock = await acquireWorktree(binding, 0, undefined, engine); expect(lock).not.toBeNull(); await lock?.release();
    const [ready] = (await writerOnboardingPreflight(engine, s.id)).sources as Refusal[];
    expect(ready.state).toBe('ready');
    expect(ready.physical_fix).toBeUndefined();
  }), 120_000);

  test('(b) a stamp that no longer identifies this exact directory keeps the generic refusal and no exit', () => withEnv(env(), async () => {
    const s = await managedSource();
    rmSync(physicalRootReservationPath(s.root));
    const stamp = JSON.parse(readFileSync(join(s.root, PHYSICAL_ROOT_MARKER), 'utf8'));
    writeFileSync(join(s.root, PHYSICAL_ROOT_MARKER), JSON.stringify({ ...stamp, inode: '1' }), { mode: 0o600 });
    const refusal = await refused(acquireWorktree(s.binding, 0, undefined, engine));
    expect(refusal).toMatchObject({ code: 'recovery_required' });
    expect(refusal!.detail).toBeUndefined();
    expect(refusal!.fix).toBeUndefined();
    expect((await writerOnboardingPreflight(engine, s.id)).sources[0]).not.toHaveProperty('physical_fix');
    await expect(administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required' });
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(false);
  }), 120_000);

  test('(c) a Git-synced checkout that lost its .git too refuses checkout_git_missing and prepares nothing', () => withEnv(env(), async () => {
    const s = await managedSource();
    const head = git(s.root, 'rev-parse', 'HEAD');
    await withSyncedCommit(s.id, head);
    rmSync(physicalRootReservationPath(s.root));
    rmSync(join(s.root, '.git'), { recursive: true, force: true });
    for (const dryRun of [true, false]) {
      const refusal = await refused(dryRun ? runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: s.id, self_transfer: true, dry_run: true })
        : administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }));
      expect(refusal).toMatchObject({ code: 'recovery_required', detail: 'checkout_git_missing', fix: { ask_user: true, actor: 'user', verify: { argv: ['git', '-C', s.root, 'cat-file', '-e', `${head}^{commit}`] } } });
      expect(refusal!.suggestion).toContain(head);
      expect(refusal!.suggestion).toContain('Git repository');
    }
    expect((await getWorktreeBinding(engine, s.id))!.state).toBe('active');
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(false);
  }), 120_000);

  /** A checkout claimed repo-less whose parent folder became the repository afterwards, so Git's top level is above the root (#8713). */
  async function belowTopLevel() {
    const outer = join(directory, `outer-${randomUUID().slice(0, 8)}`);
    mkdirSync(outer);
    const s = await managedSource(false, outer);
    git(outer, 'init', '-q'); git(outer, 'add', '-A');
    git(outer, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'outer');
    return { ...s, outer };
  }

  test('(c) a repository above the checkout root that holds the last imported commit recovers', () => withEnv(env(), async () => {
    const s = await belowTopLevel();
    await withSyncedCommit(s.id, git(s.outer, 'rev-parse', 'HEAD'));
    rmSync(physicalRootReservationPath(s.root));
    const prepared = await administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
    await administer('writer_transfer_accept', { source_id: s.id, path: s.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(true);
  }), 120_000);

  test('(c) a repository above the checkout root without the last imported commit refuses, and never asks for a .git inside the folder', () => withEnv(env(), async () => {
    const s = await belowTopLevel();
    const elsewhere = join(directory, `elsewhere-${randomUUID().slice(0, 8)}`);
    mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'x.md'), note('X')); git(elsewhere, 'init', '-q'); git(elsewhere, 'add', '-A');
    git(elsewhere, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'elsewhere');
    const commit = git(elsewhere, 'rev-parse', 'HEAD');
    await withSyncedCommit(s.id, commit);
    rmSync(physicalRootReservationPath(s.root));
    const refusal = await refused(administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }));
    expect(refusal).toMatchObject({ code: 'recovery_required', detail: 'checkout_git_missing', fix: { verify: { argv: ['git', '-C', s.root, 'cat-file', '-e', `${commit}^{commit}`] } } });
    expect(`${refusal!.suggestion} ${refusal!.fix.user_message}`).not.toMatch(/\.git (into|in\b)|move its \.git/);
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(false);
  }), 120_000);

  test('(c) a fresh repository without the last imported commit does not stand in for the lost one', () => withEnv(env(), async () => {
    const s = await managedSource();
    await withSyncedCommit(s.id, git(s.root, 'rev-parse', 'HEAD'));
    rmSync(physicalRootReservationPath(s.root));
    rmSync(join(s.root, '.git'), { recursive: true, force: true });
    git(s.root, 'init', '-q'); git(s.root, 'add', '-A');
    git(s.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'replacement');
    await expect(administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true })).rejects.toMatchObject({ code: 'recovery_required', detail: 'checkout_git_missing' });
    expect((await getWorktreeBinding(engine, s.id))!.state).toBe('active');
  }), 120_000);

  test('(c) a source folder\'s .git lost between prepare and accept refuses at accept and re-creates nothing', () => withEnv(env(), async () => {
    // A non-Git root records a tree manifest that skips .git, so only the accept-time Git check sees this.
    const s = await managedSource(false);
    const sub = join(s.root, 'sub'), subId = `${s.id}-sub`;
    mkdirSync(sub); writeFileSync(join(sub, 'b.md'), note('B')); git(sub, 'init', '-q'); git(sub, 'add', '-A');
    git(sub, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [subId, sub, '{}']);
    await claimWorktree(engine, subId, sub);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await withSyncedCommit(subId, git(sub, 'rev-parse', 'HEAD'));
    rmSync(physicalRootReservationPath(s.root));
    const prepared = await administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
    renameSync(join(sub, '.git'), join(directory, `${s.id}-git-aside`));
    const accept = { source_id: s.id, path: s.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true };
    await expect(administer('writer_transfer_accept', accept)).rejects.toMatchObject({ code: 'recovery_required', detail: 'checkout_git_missing' });
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(false);
    renameSync(join(directory, `${s.id}-git-aside`), join(sub, '.git'));
    await administer('writer_transfer_accept', accept);
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(true);
  }), 120_000);

  test('(c) an archived source whose folder is gone does not hold back the active sources of its worktree', () => withEnv(env(), async () => {
    const s = await managedSource(false);
    const sub = join(s.root, 'old'), subId = `${s.id}-old`;
    mkdirSync(sub); writeFileSync(join(sub, 'b.md'), note('B')); git(sub, 'init', '-q'); git(sub, 'add', '-A');
    git(sub, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [subId, sub, '{}']);
    await claimWorktree(engine, subId, sub);
    await engine.executeRaw('UPDATE sources SET last_commit=$2, archived=true WHERE id=$1', [subId, git(sub, 'rev-parse', 'HEAD')]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    rmSync(physicalRootReservationPath(s.root));
    rmSync(sub, { recursive: true, force: true });
    const prepared = await administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
    await administer('writer_transfer_accept', { source_id: s.id, path: s.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(true);
  }), 120_000);

  test('(d) a non-Git checkout holding a Git-synced source folder of its own recovers', () => withEnv(env(), async () => {
    const s = await managedSource(false);
    const sub = join(s.root, 'sub'), subId = `${s.id}-sub`;
    mkdirSync(sub); writeFileSync(join(sub, 'b.md'), note('B')); git(sub, 'init', '-q'); git(sub, 'add', '-A');
    git(sub, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [subId, sub, '{}']);
    await claimWorktree(engine, subId, sub);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await getWorktreeBinding(engine, subId))!.worktree_id).toBe(s.binding.worktree_id);
    await withSyncedCommit(subId, git(sub, 'rev-parse', 'HEAD'));
    rmSync(physicalRootReservationPath(s.root));
    // The source folder that lost its own .git is the one the refusal names, never the root.
    renameSync(join(sub, '.git'), join(s.root, 'sub-git-aside'));
    expect(await refused(administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }))).toMatchObject({ detail: 'checkout_git_missing',
      fix: { verify: { argv: ['git', '-C', sub, 'cat-file', '-e', `${git(join(s.root, 'sub-git-aside'), 'rev-parse', 'HEAD')}^{commit}`] } } });
    renameSync(join(s.root, 'sub-git-aside'), join(sub, '.git'));
    const prepared = await administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
    await administer('writer_transfer_accept', { source_id: s.id, path: s.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(true);
  }), 120_000);

  test('(d) a checkout that never was a Git repository recovers the same way', () => withEnv(env(), async () => {
    const s = await managedSource(false);
    rmSync(physicalRootReservationPath(s.root));
    expect(await refused(acquireWorktree(s.binding, 0, undefined, engine))).toMatchObject({ code: 'recovery_required', detail: 'ownership_reservation_missing' });
    const prepared = await administer('writer_transfer_prepare', { source_id: s.id, self_transfer: true }) as { owner_epoch: string; manifest: { digest: string } };
    await administer('writer_transfer_accept', { source_id: s.id, path: s.root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true });
    expect(existsSync(physicalRootReservationPath(s.root))).toBe(true);
    const lock = await acquireWorktree((await getWorktreeBinding(engine, s.id))!, 0, undefined, engine); expect(lock).not.toBeNull(); await lock?.release();
  }), 120_000);
});

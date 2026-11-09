/**
 * A file a managed sync deleted (its commit removed the file) and Git later put back stays in the brain (GST-2201).
 *
 * Protects: when a commit deletes a Markdown file, sync soft-deletes its page; when the same file comes back (a revert, a
 * branch switch and back, a later commit that re-adds it, with the same or edited bytes), the next sync brings the page
 * back (same page row) instead of settling it as deleted, so search, get and recall see it again and sync status never
 * says synced while the page is missing. A brain an older version left in that state heals on its next plain sync. The
 * retention purge (the cycle purge phase, the purge job and the consented `gbrain pages purge-deleted`) never removes a
 * file that is committed at the source's last commit or at HEAD: a sync-made tombstone whose file is back waits for the
 * sync that restores it; a person's delete undone in Git, and a tombstone gbrain can no longer tell was sync-made, are
 * purged database-only with the file left alone; a person's delete whose file stays gone purges as before.
 *
 * PGLite always; Postgres with DATABASE_URL (test/postgres-unit-arms.txt).
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runCycle } from '../src/core/cycle.ts';
import { makePurgeHandler } from '../src/core/minions/handlers/purge.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { SYNC_DELETE_TOMBSTONE_OP } from '../src/core/persistence/sync-delete-tombstones.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { __resetTreeReuseForTests } from '../src/core/persistence/sync-tree-reuse.ts';
import { runPages } from '../src/commands/pages.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const A = 'notes/doc-a', B = 'notes/doc-b', TWIN = 'notes/twin', COPY = 'notes/twin-copy', USER = 'notes/user', KEEP = 'notes/keep';
const BODY: Record<string, string> = { [A]: note('Doc A', 'Alice-example wrote about topic a.'), [B]: note('Doc B', 'Notes on acme-example, topic b.'),
  [TWIN]: note('Twin', 'The same words in two files.'), [COPY]: note('Twin', 'The same words in two files.'), [USER]: note('User', 'A page a person deletes.'),
  [KEEP]: note('Keep', 'A page nobody touches.') };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q', '-b', 'main');
  for (const [slug, body] of Object.entries(BODY)) writeFileSync(join(root, `${slug}.md`), body);
  commit(root, 'notes');
};
const CONSENT_ENV = { GBRAIN_CONSENT: undefined };

const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: number | string; deleted_at: string | null; compiled_truth: string }>(
  'SELECT id, deleted_at, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug]))[0];
const sync = async (engine: BrainEngine) => { await performManagedSync(engine, OPTS); };
const status = async (engine: BrainEngine) => { const s = await readSyncStatus(engine, 'default', { detail: false }); return { state: s.state, reason: s.reason }; };
const removeAndSync = async (engine: BrainEngine, root: string, slugs: string[]) => {
  git(root, 'rm', '-q', ...slugs.map(slug => `${slug}.md`)); commit(root, 'remove notes');
  await sync(engine);
  for (const slug of slugs) expect((await page(engine, slug))?.deleted_at).not.toBeNull();
};
/** Ages every tombstone (and its sync-deletion record) by `hours`, as time would. A fixture write, outside coordination. */
async function age(engine: BrainEngine, hours: number): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw(`UPDATE pages SET deleted_at = deleted_at - ($1 || ' hours')::interval WHERE source_id='default' AND deleted_at IS NOT NULL`, [String(hours)]);
  await engine.executeRaw(`UPDATE op_checkpoints c SET completed_keys = jsonb_set(c.completed_keys, '{0,deleted_at}', to_jsonb(p.deleted_at)) FROM pages p
    WHERE c.op=$1 AND p.id::text = c.fingerprint`, [SYNC_DELETE_TOMBSTONE_OP]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}
async function cli(engine: BrainEngine, args: string[]): Promise<void> {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try { await withEnv(CONSENT_ENV, () => runPages(engine, args)); }
  finally { log.mockRestore(); err.mockRestore(); }
}
type Purge = 'cycle phase' | 'purge job' | 'CLI purge-deleted';
const PURGES: Purge[] = ['cycle phase', 'purge job', 'CLI purge-deleted'];
async function purge(engine: BrainEngine, root: string, how: Purge): Promise<void> {
  if (how === 'cycle phase') await withEnv(CONSENT_ENV, () => runCycle(engine, { brainDir: root, phases: ['purge'], sourceId: 'default' }));
  else if (how === 'purge job') await withEnv(CONSENT_ENV, () => makePurgeHandler(engine)({ data: { scope: 'pages' } } as never));
  else await cli(engine, ['purge-deleted', '--json', '--yes']);
}
/** The file is on disk with its committed bytes and the checkout has no change to it. */
const fileKept = (root: string, slug: string) => {
  expect(existsSync(join(root, `${slug}.md`))).toBe(true);
  expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(BODY[slug]!);
  expect(git(root, 'status', '--porcelain', '--', `${slug}.md`)).toBe('');
};
/** A person deletes `slug` through delete_page; its write-through publication settles. */
async function personDelete(engine: BrainEngine, ctx: OperationContext, slug: string): Promise<void> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snapshot!.revision, request_id: randomUUID() } });
  await settleManagedGitEffects(engine);
  expect((await page(engine, slug))?.deleted_at).not.toBeNull();
}
/** Commits the removal the delete left in the checkout, then puts `slug`'s original bytes back in a new commit (an undo in Git). */
const restoreInGit = (root: string, slug: string) => {
  if (git(root, 'status', '--porcelain', '--', `${slug}.md`)) commit(root, `remove ${slug}`);
  writeFileSync(join(root, `${slug}.md`), BODY[slug]!); commit(root, `restore ${slug}`);
};

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`${backend}: a file Git restores after a sync deleted its page comes back`, () => {
    test('git revert of the deleting commit: the same page row is live again and status is synced', () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      const before = await page(engine, A);
      await removeAndSync(engine, root, [A]);
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
      await sync(engine);
      const after = await page(engine, A);
      expect(after?.deleted_at).toBeNull();
      expect(String(after?.id)).toBe(String(before?.id));
      expect(after?.compiled_truth).toContain('topic a');
      expect(await status(engine)).toEqual({ state: 'synced', reason: 'nothing_pending' });
      expect((await engine.executeRaw('SELECT 1 FROM op_checkpoints c JOIN pages p ON p.id::text=c.fingerprint WHERE c.op=$1 AND p.deleted_at IS NOT NULL', [SYNC_DELETE_TOMBSTONE_OP])).length).toBe(0);
    }, { setup, databaseUrl }), 300_000);

    test('a sync on a branch without the files, then back on main: the pages are live again', () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      git(root, 'checkout', '-q', '-b', 'side');
      await removeAndSync(engine, root, [A, B]);
      git(root, 'checkout', '-q', 'main');
      await sync(engine);
      for (const slug of [A, B]) expect((await page(engine, slug))?.deleted_at).toBeNull();
      expect(await status(engine)).toEqual({ state: 'synced', reason: 'nothing_pending' });
    }, { setup, databaseUrl }), 300_000);

    test('deleted in one commit, re-added by a later one (same bytes and edited): both pages are live with the committed text', () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      await removeAndSync(engine, root, [A, B]);
      writeFileSync(join(root, `${A}.md`), BODY[A]!);
      writeFileSync(join(root, `${B}.md`), note('Doc B', 'Notes on acme-example, topic b, revised by a collaborator.'));
      commit(root, 're-add notes');
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).toBeNull();
      const b = await page(engine, B);
      expect(b?.deleted_at).toBeNull();
      expect(b?.compiled_truth).toContain('revised by a collaborator');
      expect(await status(engine)).toEqual({ state: 'synced', reason: 'nothing_pending' });
    }, { setup, databaseUrl }), 300_000);

    test('a sync on a detached older commit, then back on main: the page the newest commit added is live again', () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      writeFileSync(join(root, 'notes/new.md'), note('New', 'Added by the newest commit.'));
      commit(root, 'add a note');
      await sync(engine);
      git(root, 'checkout', '-q', '--detach', 'HEAD~1');
      await sync(engine);
      expect((await page(engine, 'notes/new'))?.deleted_at).not.toBeNull();
      git(root, 'checkout', '-q', 'main');
      await sync(engine);
      expect((await page(engine, 'notes/new'))?.deleted_at).toBeNull();
      expect(await status(engine)).toEqual({ state: 'synced', reason: 'nothing_pending' });
    }, { setup, databaseUrl }), 300_000);

    test('a file moved into a dot-folder and back: the page is live again', () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      mkdirSync(join(root, '.parked'));
      git(root, 'mv', `${A}.md`, '.parked/doc-a.md'); commit(root, 'park a note');
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).not.toBeNull();
      git(root, 'mv', '.parked/doc-a.md', `${A}.md`); commit(root, 'unpark the note');
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).toBeNull();
      expect(await status(engine)).toEqual({ state: 'synced', reason: 'nothing_pending' });
    }, { setup, databaseUrl }), 300_000);

    test('working-tree mode: a file missing from disk for one sync and then back is live again', () => managedBrain(async ({ engine, root }) => {
      await engine.setConfig('sync.include_working_tree', 'true');
      await sync(engine);
      const parked = join(root, '..', 'doc-a.parked');
      renameSync(join(root, `${A}.md`), parked);
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).not.toBeNull();
      renameSync(parked, join(root, `${A}.md`));
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).toBeNull();
      fileKept(root, A);
    }, { setup, databaseUrl }), 300_000);

    test('a hold an older version raised over a sync-deleted page whose file came back edited is re-run: the page imports and the hold clears', () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      await removeAndSync(engine, root, [A]);
      // An older version did not read the sync-deletion record: hide it while the edited file comes back, so that pass holds the path.
      const receipts = await engine.executeRaw<{ id: string }>(`SELECT id::text AS id FROM persistence_requests WHERE intent->>'kind'='managed_sync_delete'`);
      const setKind = (kind: string) => engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_requests SET intent = jsonb_set(intent, '{kind}', to_jsonb($2::text)) WHERE id = ANY($1::uuid[])`, [receipts.map(r => r.id), kind]);
      });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('UPDATE op_checkpoints SET op=$2 WHERE op=$1', [SYNC_DELETE_TOMBSTONE_OP, 'hidden-tombstone-record']);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await setKind('hidden');
      __resetTreeReuseForTests();
      writeFileSync(join(root, `${A}.md`), note('Doc A', 'Alice-example wrote about topic a, then edited it.'));
      commit(root, 're-add edited');
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).not.toBeNull();
      expect((await status(engine)).reason).toBe('held_needs_human');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('UPDATE op_checkpoints SET op=$1 WHERE op=$2', [SYNC_DELETE_TOMBSTONE_OP, 'hidden-tombstone-record']);
      // ...and its pass stamped its own fingerprint.
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,obligations,converged,selection_fp}', '"older-version"') WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await setKind('managed_sync_delete');
      __resetTreeReuseForTests();
      await sync(engine);
      const a = await page(engine, A);
      expect(a?.deleted_at).toBeNull();
      expect(a?.compiled_truth).toContain('then edited it');
      expect(await status(engine)).toEqual({ state: 'synced', reason: 'nothing_pending' });
    }, { setup, databaseUrl }), 300_000);

    test('a brain an older version left with the page deleted beside its restored file heals on the next plain sync', () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      await removeAndSync(engine, root, [A]);
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
      // What an older version's pass left: converged at the restored HEAD (it settled the path as deleted_same) under its own fingerprint.
      const head = git(root, 'rev-parse', 'HEAD');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(jsonb_set(completed_keys, '{0,obligations,converged,target}', to_jsonb($2::text)),
        '{0,obligations,converged,selection_fp}', '"older-version"') WHERE op=$1`, [MANAGED_SYNC_PASS_OP, head]);
      await engine.executeRaw("UPDATE sources SET last_commit=$1 WHERE id='default'", [head]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await page(engine, A))?.deleted_at).not.toBeNull();
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).toBeNull();
      expect(await status(engine)).toEqual({ state: 'synced', reason: 'nothing_pending' });
    }, { setup, databaseUrl }), 300_000);

    test("the upgrade's first sync brings back a sync-deleted page but leaves a page a person deleted deleted, though Git holds its file", () => managedBrain(async ({ engine, ctx, root }) => {
      await sync(engine);
      await personDelete(engine, ctx, USER);
      if (git(root, 'status', '--porcelain', '--', `${USER}.md`)) commit(root, `remove ${USER}`);
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', git(root, 'log', '-1', '--format=%H', '--', `${USER}.md`));
      fileKept(root, USER);
      await removeAndSync(engine, root, [A]);
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
      // What an older version's pass left: converged at the restored HEAD under its own fingerprint, both pages deleted beside their files.
      const head = git(root, 'rev-parse', 'HEAD');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys = jsonb_set(jsonb_set(completed_keys, '{0,obligations,converged,target}', to_jsonb($2::text)),
        '{0,obligations,converged,selection_fp}', '"older-version"') WHERE op=$1`, [MANAGED_SYNC_PASS_OP, head]);
      await engine.executeRaw("UPDATE sources SET last_commit=$1 WHERE id='default'", [head]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await page(engine, A))?.deleted_at).not.toBeNull();
      expect((await page(engine, USER))?.deleted_at).not.toBeNull();
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).toBeNull();
      expect((await page(engine, USER))?.deleted_at).not.toBeNull();
      fileKept(root, USER);
    }, { setup, databaseUrl }), 300_000);
  });

  describe(`${backend}: the retention purge never removes a file that is committed`, () => {
    test('working-tree mode: a sync-deleted page whose committed file stays off disk is purged database-only, not deferred forever', () => managedBrain(async ({ engine, root }) => {
      await engine.setConfig('sync.include_working_tree', 'true');
      await sync(engine);
      const parked = join(root, '..', 'doc-a.parked');
      renameSync(join(root, `${A}.md`), parked);
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).not.toBeNull();
      await age(engine, 100);
      await purge(engine, root, 'CLI purge-deleted');
      expect(await page(engine, A)).toBeUndefined();
      expect(git(root, 'ls-tree', '--name-only', 'HEAD', '--', `${A}.md`)).toBe(`${A}.md`);
      renameSync(parked, join(root, `${A}.md`));
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).toBeNull();
      fileKept(root, A);
    }, { setup, databaseUrl }), 300_000);

    test('a sync-made tombstone whose returned file sync holds is refused with the hold, not deferred, and the file stays', () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      await removeAndSync(engine, root, [A]);
      const broken = '---\ntype: concept\ntitle: [unclosed\n---\n\nAlice-example wrote about topic a.\n';
      writeFileSync(join(root, `${A}.md`), broken); commit(root, 're-add with broken frontmatter');
      await sync(engine);
      expect((await page(engine, A))?.deleted_at).not.toBeNull();
      expect((await status(engine)).state).not.toBe('synced');
      await age(engine, 100);
      const { purgeDeletedPagesCoordinated } = await import('../src/core/persistence/purge-deleted.ts');
      const result = await purgeDeletedPagesCoordinated(engine, 72);
      expect({ count: result.count, deferred: result.deferred, codes: result.blocked.map(b => b.code) }).toEqual({ count: 0, deferred: 0, codes: ['source_changed'] });
      expect(result.blocked[0]!.reason).toContain('held by sync (invalid_frontmatter)');
      expect((await page(engine, A))?.deleted_at).not.toBeNull();
      expect(readFileSync(join(root, `${A}.md`), 'utf8')).toBe(broken);
      expect(git(root, 'status', '--porcelain', '--', `${A}.md`)).toBe('');
    }, { setup, databaseUrl }), 300_000);

    test("an old shared-origin delete of the same slug does not exempt a later sync-made tombstone: the restored file stays", () => managedBrain(async ({ engine, ctx, root }) => {
      await sync(engine);
      await personDelete(engine, ctx, USER);
      // That old delete is recorded as one that kept the file because another page shared it (a fixture write); the page is restored.
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_requests SET outcome = jsonb_set(COALESCE(outcome, '{}'::jsonb), '{write_through}', '{"written": false, "skipped": "shared_origin"}')
          WHERE operation='delete_page' AND slug=$1`, [USER]);
      });
      const tombstone = await engine.readPageSnapshot(USER, { sourceId: 'default', includeDeleted: true });
      await submitPageMutation(ctx, { operation: 'restore_page', params: { slug: USER, expected_revision: tombstone!.revision, request_id: randomUUID() } });
      await settleManagedGitEffects(engine);
      if (git(root, 'status', '--porcelain', '--', `${USER}.md`)) commit(root, 'restore user note');
      await sync(engine);
      expect((await page(engine, USER))?.deleted_at).toBeNull();
      await removeAndSync(engine, root, [USER]);
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
      await age(engine, 100);
      await purge(engine, root, 'CLI purge-deleted');
      expect((await page(engine, USER))?.deleted_at).not.toBeNull();
      expect(existsSync(join(root, `${USER}.md`))).toBe(true);
      expect(git(root, 'status', '--porcelain', '--', `${USER}.md`)).toBe('');
    }, { setup, databaseUrl }), 300_000);

    test('a file committed between the purge\'s preparation and its publication is not removed', () => managedBrain(async ({ engine, ctx, root }) => {
      await sync(engine);
      await personDelete(engine, ctx, USER);
      if (git(root, 'status', '--porcelain', '--', `${USER}.md`)) commit(root, 'remove user note');
      await sync(engine);
      writeFileSync(join(root, `${USER}.md`), BODY[USER]!);
      await age(engine, 100);
      let committed = false;
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:prepared' || detail.operation !== 'delete_page' || committed) return;
        committed = true;
        commit(root, 'restore user note');
      });
      const { purgeDeletedPagesCoordinated } = await import('../src/core/persistence/purge-deleted.ts');
      try { await purgeDeletedPagesCoordinated(engine, 72); } finally { installFaultHook(undefined); }
      expect(committed).toBe(true);
      fileKept(root, USER);
      await purgeDeletedPagesCoordinated(engine, 72);
      expect(await page(engine, USER)).toBeUndefined();
      fileKept(root, USER);
    }, { setup, databaseUrl }), 300_000);

    test("an older version purged the page and committed the file's removal; a revert of that commit imports the file as a new page", () => managedBrain(async ({ engine, root }) => {
      await sync(engine);
      const before = await page(engine, A);
      await removeAndSync(engine, root, [A]);
      // What an older version did: the file came back, sync left the page deleted beside it, and the purge removed the page row
      // and the file, committing the removal. Here the file's return and the purge's removal commit land before any sync reads
      // them, and the purge runs on the tombstone with the file gone, as the older version's purge saw it after its write-through.
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
      git(root, 'rm', '-q', `${A}.md`); commit(root, 'purge removes doc-a');
      await sync(engine);
      await age(engine, 100);
      await purge(engine, root, 'CLI purge-deleted');
      expect(await page(engine, A)).toBeUndefined();
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
      await sync(engine);
      const after = await page(engine, A);
      expect(after?.deleted_at).toBeNull();
      expect(String(after?.id)).not.toBe(String(before?.id));
      expect(after?.compiled_truth).toContain('topic a');
      fileKept(root, A);
      expect(await status(engine)).toEqual({ state: 'synced', reason: 'nothing_pending' });
    }, { setup, databaseUrl }), 300_000);

    for (const how of PURGES) {
      test(`${how}: a person's delete undone in Git is purged database-only and the file stays`, () => managedBrain(async ({ engine, ctx, root }) => {
        await sync(engine);
        await personDelete(engine, ctx, USER);
        restoreInGit(root, USER);
        await sync(engine);
        expect((await page(engine, USER))?.deleted_at).not.toBeNull();
        await age(engine, 100);
        await purge(engine, root, how);
        expect(await page(engine, USER)).toBeUndefined();
        fileKept(root, USER);
        await sync(engine);
        fileKept(root, USER);
      }, { setup, databaseUrl }), 300_000);

      test(`${how}: a sync-deleted page with a byte-identical live twin whose file is back waits for the sync that restores it`, () => managedBrain(async ({ engine, root }) => {
        await sync(engine);
        await removeAndSync(engine, root, [TWIN]);
        git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
        await age(engine, 100);
        await purge(engine, root, how);
        expect((await page(engine, TWIN))?.deleted_at).not.toBeNull();
        fileKept(root, TWIN);
        await sync(engine);
        expect((await page(engine, TWIN))?.deleted_at).toBeNull();
        fileKept(root, TWIN);
      }, { setup, databaseUrl }), 300_000);

      test(`${how}: a tombstone with no sync-deletion record and a compacted receipt is purged database-only and its committed file stays`, () => managedBrain(async ({ engine, root }) => {
        await sync(engine);
        await removeAndSync(engine, root, [A]);
        // A tombstone made before 0.60.330.0 whose receipt has since been compacted: nothing marks it as sync-made.
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1', [SYNC_DELETE_TOMBSTONE_OP]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          await tx.executeRaw(`UPDATE persistence_requests SET intent=NULL, compacted=true WHERE intent->>'kind'='managed_sync_delete'`);
        });
        __resetTreeReuseForTests(); // the next sync runs in a new process, as after an upgrade
        git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'revert', '--no-edit', 'HEAD');
        await sync(engine);
        expect((await page(engine, A))?.deleted_at).not.toBeNull();
        await age(engine, 100);
        await purge(engine, root, how);
        expect(await page(engine, A)).toBeUndefined();
        fileKept(root, A);
      }, { setup, databaseUrl }), 300_000);

      test(`${how}: a person's delete whose file stays gone purges as before`, () => managedBrain(async ({ engine, ctx, root }) => {
        await sync(engine);
        await personDelete(engine, ctx, USER);
        if (git(root, 'status', '--porcelain', '--', `${USER}.md`)) commit(root, 'remove user note');
        await sync(engine);
        await age(engine, 100);
        await purge(engine, root, how);
        expect(await page(engine, USER)).toBeUndefined();
        expect(existsSync(join(root, `${USER}.md`))).toBe(false);
        expect((await page(engine, KEEP))?.deleted_at).toBeNull();
      }, { setup, databaseUrl }), 300_000);
    }
  });
}

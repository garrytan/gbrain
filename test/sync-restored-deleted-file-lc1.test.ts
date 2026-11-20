/**
 * LC-1 (audit decision E1): a file restored after `gbrain delete` comes back only through the file-drift step that asks the
 * user first, never silently, and never stays out of the brain for good.
 *   - `gbrain delete` removes the page's file (write-through); a person restores the same bytes (`git checkout -- <path>`);
 *     the next managed sync holds the file `file_drift` on the deleted side (`tombstone_edited`, `restored: true`) instead
 *     of settling it as "Already up to date", and the page stays deleted until `gbrain repair file-drift --held --side
 *     deleted --state tombstone_edited --prefer file` (preview, then --apply --expect) restores it;
 *   - the same after the retention purge (`gbrain pages purge-deleted`), restored before or after it: the file is held
 *     `purged_differs` and imports as a new page only on the user's yes, so purged content never comes back without
 *     consent, and the hold is what `sources status` and doctor list;
 *   - a deletion that stands is unchanged: the delete's own removal not committed yet, a delete that left the file
 *     (`sync.write_through=false`), and an owner purge (its content tombstone refuses the bytes for good) settle
 *     `deleted_same` with no hold.
 * Real PGLite (and Postgres when DATABASE_URL is set), real managed syncs and real Git.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of ['ivy', 'jon', 'kai']) writeFileSync(join(root, `notes/${name}-example.md`), note(`notes/${name}-example`, `The committed body of notes/${name}-example.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
};

async function remove(engine: BrainEngine, ctx: OperationContext, slug: string, purge: boolean) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  const outcome = await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, request_id: randomUUID(), expected_revision: snapshot!.revision, ...(purge ? { purge: true } : {}) }, waitMs: 30_000 });
  expect(outcome.state).toBe('committed');
  await settleManagedGitEffects(engine);
}
async function holds(engine: BrainEngine) {
  const rows = await engine.executeRaw<{ record: { path: string; code: string; meta: Record<string, unknown> } }>("SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold'");
  return Object.fromEntries(rows.map(({ record }) => [record.path, [record.code, record.meta.side ?? null, record.meta.state ?? null, record.meta.restored ?? null]]));
}
async function pageState(engine: BrainEngine, slug: string): Promise<'live' | 'deleted' | 'none'> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return !snapshot ? 'none' : snapshot.page.deleted_at ? 'deleted' : 'live';
}

for (const backend of testBackends()) describe(`[${backend}] LC-1: a file restored after a delete asks first`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const fileDrift = async (engine: BrainEngine, state: string, expectHash?: string) =>
    (await repairRunner(engine, { apply: expectHash !== undefined, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
      { explicit: true, sourceFlag: 'default', held: true, side: 'deleted', state, prefer: 'file', ...(expectHash ? { expect: expectHash } : {}) });
  type Planned = { slug: string; action?: string; verb?: string };

  for (const purge of ['none', 'before restore', 'after restore'] as const) {
    const purged = purge !== 'none', state = purged ? 'purged_differs' : 'tombstone_edited';
    test(`soft delete${purged ? `, retention purge ${purge}` : ''}, the same file restored: sync holds it ${state} and the page comes back only through repair file-drift --prefer file`, () => managedBrain(async ({ engine, ctx, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await remove(engine, ctx, 'notes/ivy-example', false);
      expect(existsSync(join(root, 'notes/ivy-example.md'))).toBe(false);
      if (purge === 'before restore') expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toEqual(['notes/ivy-example']);
      git(root, 'checkout', '--', 'notes/ivy-example.md');
      expect(git(root, 'status', '--porcelain')).toBe('');
      if (purge === 'after restore') {
        // The audit's order: the restore is synced while the page is only soft-deleted, then the retention purge runs.
        await performManagedSync(engine, OPTS);
        expect(await holds(engine)).toEqual({ 'notes/ivy-example.md': ['file_drift', 'deleted', 'tombstone_edited', true] });
        expect((await purgeDeletedPagesCoordinated(engine, 0)).slugs).toEqual(['notes/ivy-example']);
        expect(existsSync(join(root, 'notes/ivy-example.md'))).toBe(true);
      }

      await performManagedSync(engine, OPTS);
      expect(await holds(engine)).toEqual({ 'notes/ivy-example.md': ['file_drift', 'deleted', state, true] });
      expect(await pageState(engine, 'notes/ivy-example')).toBe(purged ? 'none' : 'deleted');
      // A second sync neither imports it nor drops the hold.
      await performManagedSync(engine, OPTS);
      expect(await holds(engine)).toEqual({ 'notes/ivy-example.md': ['file_drift', 'deleted', state, true] });
      expect(await pageState(engine, 'notes/ivy-example')).toBe(purged ? 'none' : 'deleted');

      const preview = await fileDrift(engine, state);
      expect(preview.mode).toBe('dry_run');
      expect((preview.details?.pages ?? []) as Planned[]).toEqual([expect.objectContaining({ slug: 'notes/ivy-example', action: 'import_file',
        verb: purged ? 'import as a new page' : 'restore and import' })]);
      expect(await pageState(engine, 'notes/ivy-example')).toBe(purged ? 'none' : 'deleted');
      await fileDrift(engine, state, preview.preview_hash!);
      expect(await pageState(engine, 'notes/ivy-example')).toBe('live');
      expect((await engine.getPage('notes/ivy-example', { sourceId: 'default' }))?.compiled_truth).toContain('The committed body of notes/ivy-example.');
      await performManagedSync(engine, OPTS);
      expect(await holds(engine)).toEqual({});
      expect(await pageState(engine, 'notes/jon-example')).toBe('live');
    }, { databaseUrl, setup }), 240_000);
  }

  test('a deletion that stands settles with no hold: the delete\'s own removal not committed yet, a delete that left the file, and an owner purge', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await remove(engine, ctx, 'notes/ivy-example', false);
    expect(git(root, 'status', '--porcelain')).toBe('D notes/ivy-example.md');
    await remove(engine, ctx, 'notes/kai-example', true);
    git(root, 'checkout', 'HEAD', '--', 'notes/kai-example.md');
    await engine.setConfig('sync.write_through', 'false');
    await remove(engine, ctx, 'notes/jon-example', true);
    expect(existsSync(join(root, 'notes/jon-example.md'))).toBe(true);
    expect(git(root, 'status', '--porcelain')).toBe('D notes/ivy-example.md');

    await performManagedSync(engine, OPTS);
    expect(await holds(engine)).toEqual({});
    expect(await pageState(engine, 'notes/ivy-example')).toBe('deleted');
    expect(await pageState(engine, 'notes/jon-example')).toBe('none');
    expect(await pageState(engine, 'notes/kai-example')).toBe('none');
  }, { databaseUrl, setup }), 240_000);
});

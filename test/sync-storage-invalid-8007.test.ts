/**
 * #8007: a managed sync decides whether a page whose file is gone is deleted. A page under a declared storage.db_only dir
 * is kept (#7324), so when gbrain.yml's storage section cannot be read (tiers that overlap), declares db_only in a form
 * that resolves no directory (a flow list split over lines), or ignores a deprecated supabase_only list next to canonical keys, sync cannot tell which pages are database-only. On a real
 * managed brain (PGLite, and Postgres through the E2E wrapper), this protects:
 * - the frozen discovery manifest drops every deletion and names it in storageInvalidKept;
 * - a managed sync, incremental and full, deletes nothing: each missing-file page is held (file_drift, reason
 *   storage_invalid, fix `gbrain storage status`) and stays live, and the retention purge removes none of them;
 * - `gbrain repair file-drift --held --prefer file` previews none of these held pages as a soft delete;
 * - `sync.apply_held_deletions` deletes none of them, even from a hold an older gbrain wrote with no reason;
 * - the same holds on a strict (canonical: git) source, where Git's verdict would otherwise delete a committed-then-removed file;
 * - once gbrain.yml is valid again (a one-line flow list, which the parser now reads), the next syncs keep the db_only
 *   pages, delete the removed page outside db_only, and release the storage_invalid holds.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { discoverManagedSync } from '../src/core/persistence/sync-discovery.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { readGitHoldListing } from '../src/core/persistence/sync-holds.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const CARDS = ['library/card-cached', 'library/card-gone'];
const REMOVED = ['library/card-cached.md', 'library/card-gone.md', 'notes/control.md'];
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  for (const slug of [...CARDS, 'notes/keep', 'notes/control']) {
    mkdirSync(join(root, slug, '..'), { recursive: true });
    writeFileSync(join(root, `${slug}.md`), note(slug, `The committed body of ${slug}.`));
  }
  commit(root, 'seed');
};
/** gbrain.yml in the given shape, library/ untracked and ignored (card-gone's file removed too), notes/control.md git rm'd. */
function invalidateAndUntrack(root: string, yml: string) {
  writeFileSync(join(root, 'gbrain.yml'), yml);
  writeFileSync(join(root, '.gitignore'), 'library/\n');
  git(root, 'rm', '-r', '-q', '--cached', 'library');
  git(root, 'rm', '-q', 'notes/control.md');
  rmSync(join(root, 'library/card-gone.md'));
  commit(root, 'untrack library with gbrain.yml');
}
const live = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ live: boolean }>(
  "SELECT deleted_at IS NULL AS live FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]?.live;
const storageHolds = async (engine: BrainEngine) => ((await readGitHoldListing(engine, ['default'], 100))[0]?.holds ?? [])
  .filter(hold => hold.code === 'file_drift' && hold.meta.reason === 'storage_invalid').map(hold => hold.path).sort();

const INVALID = [
  ['tiers that overlap (the storage config cannot load)', 'storage:\n  db_only:\n    - library/\n  db_tracked:\n    - library/\n'],
  ['a db_only flow list split over lines (resolves no directory)', 'storage:\n  db_only: [library/,\n    archive/]\n'],
  ['a deprecated supabase_only list next to a canonical key (ignored)', 'storage:\n  db_only: [archive/]\n  supabase_only:\n    - library/\n'],
] as const;

for (const backend of testBackends()) describe(`[${backend}] #8007: an invalid gbrain.yml never turns a missing file into a deletion`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const strict of [false, true]) for (const [name, yml] of INVALID) test(`${strict ? 'strict (canonical git) source, ' : ''}${name}: discovery and sync hold every missing-file page; the purge removes none; a fixed gbrain.yml settles them`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    if (strict) await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    invalidateAndUntrack(root, yml);

    for (const full of [false, true]) {
      const discovered = await discoverManagedSync(engine, { ...OPTS, full });
      expect(discovered.entries.filter(entry => entry.action === 'delete')).toEqual([]);
      expect([...discovered.storageInvalidKept ?? []].sort()).toEqual(REMOVED);
    }
    await performManagedSync(engine, OPTS);
    await performManagedSync(engine, { ...OPTS, full: true });
    for (const slug of [...CARDS, 'notes/control', 'notes/keep']) expect({ slug, live: await live(engine, slug) }).toEqual({ slug, live: true });
    expect(await storageHolds(engine)).toEqual(REMOVED);
    const hold = ((await readGitHoldListing(engine, ['default'], 100))[0]?.holds ?? []).find(h => h.path === 'notes/control.md')!;
    expect(hold.meta).toMatchObject({ side: 'deleted', state: 'file_gone', reason: 'storage_invalid' });

    const logger = { info() {}, warn() {}, error() {} };
    const repair = await withVerifiedLocalRegistration(engine, await registerLocalWriter(engine, 'cli'), async () =>
      (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, 'default'),
        { explicit: true, sourceFlag: 'default', held: true, prefer: 'file', side: 'deleted', state: 'file_gone' }));
    expect(repair.details!.pages).toEqual([]);
    expect(repair.listing!.map(row => row.class).filter(cls => cls !== 'storage_invalid' && cls !== 'side_changed')).toEqual([]);
    const purged = await purgeDeletedPagesCoordinated(engine, 0);
    for (const slug of [...CARDS, 'notes/control']) expect(purged.slugs).not.toContain(slug);
    for (const slug of [...CARDS, 'notes/control']) expect({ slug, live: await live(engine, slug) }).toEqual({ slug, live: true });

    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only: [library/]\n');
    commit(root, 'fix gbrain.yml');
    await performManagedSync(engine, OPTS);
    await performManagedSync(engine, { ...OPTS, full: true });
    for (const slug of CARDS) expect({ slug, live: await live(engine, slug) }).toEqual({ slug, live: true });
    expect(await live(engine, 'notes/control')).toBe(false);
    expect(await live(engine, 'notes/keep')).toBe(true);
    expect(await storageHolds(engine)).toEqual([]);
  }, { databaseUrl, setup }), 240_000);

  test('sync.apply_held_deletions never deletes a held missing-file page while gbrain.yml is invalid, a hold with no reason included', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    invalidateAndUntrack(root, INVALID[0][1]);
    await performManagedSync(engine, OPTS);
    expect(await storageHolds(engine)).toEqual(REMOVED);
    // An older gbrain wrote file_gone holds with no reason, and those never re-screen.
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,meta}', (completed_keys->0->'meta') - 'reason') WHERE op='sync-hold'");
    await engine.setConfig('sync.apply_held_deletions', 'true');
    await performManagedSync(engine, OPTS);
    await performManagedSync(engine, { ...OPTS, full: true });
    for (const slug of [...CARDS, 'notes/control']) expect({ slug, live: await live(engine, slug) }).toEqual({ slug, live: true });
  }, { databaseUrl, setup }), 240_000);
});

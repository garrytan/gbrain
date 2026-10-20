/**
 * GBRA-133 S-27/S-28 (#6712 PR 4b): a committed file missing from the working tree (deleted and not committed, marked
 * skip-worktree, or outside a sparse checkout) was dropped silently by the 4b managed pass: the committed-mode classifier
 * settled a page-less path whose dirtiness probe said `deleted` as `dirty` with no action, so the file got no page and
 * no hold. Master's managed sync imports it from the commit's blob; so does the pass now (committed mode decides from T).
 *
 * Protects (red before: hidden/b has no page and no hold after the sync): each shape imports hidden/b from the committed
 * blob with the rest of the commit, holds nothing and leaves the working tree as it was, and the next sync has nothing to do; once the deletion is committed
 * the page goes. Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const identity = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, ...identity, 'commit', '-qm', message); };
const note = (title: string) => '---\ntype: concept\ntitle: ' + title + '\n---\n\nThe body of ' + title + '.\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/seed.md'), note('notes/seed'));
  commit(root, 'seed');
};
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
type Shape = 'deleted, not committed' | 'skip-worktree' | 'outside a sparse checkout';
const hide: Record<Shape, (root: string) => void> = {
  'deleted, not committed': root => rmSync(join(root, 'hidden/b.md')),
  'skip-worktree': root => { git(root, 'update-index', '--skip-worktree', 'hidden/b.md'); rmSync(join(root, 'hidden/b.md')); },
  'outside a sparse checkout': root => git(root, 'sparse-checkout', 'set', '--no-cone', '/notes/', '/*.md'),
};

for (const backend of testBackends()) describe('[' + backend + '] GBRA-133 S-27/S-28: a committed file missing from the working tree', () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  for (const shape of Object.keys(hide) as Shape[]) test(shape + ': imported from the committed blob, nothing held, the next sync has nothing to do', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a'));
    mkdirSync(join(root, 'hidden'), { recursive: true });
    writeFileSync(join(root, 'hidden/b.md'), note('hidden/b'));
    commit(root, 'a and b');
    hide[shape](root);
    expect(existsSync(join(root, 'hidden/b.md'))).toBe(false);
    const synced = await performManagedSync(engine, OPTS);
    expect(synced).toMatchObject({ status: 'synced', added: 2, pass: { outcome: 'synced' } });
    expect(await live(engine)).toEqual(['hidden/b', 'notes/a', 'notes/seed']);
    expect((await engine.getPage('hidden/b', { sourceId: 'default' }))?.compiled_truth).toContain('The body of hidden/b.');
    expect((await readSyncStatus(engine, 'default', { detail: false })).holds).toEqual([]);
    expect(existsSync(join(root, 'hidden/b.md'))).toBe(false);
    expect((await performManagedSync(engine, OPTS)).added ?? 0).toBe(0);
    expect(await live(engine)).toEqual(['hidden/b', 'notes/a', 'notes/seed']);
    if (shape !== 'deleted, not committed') return;
    git(root, ...identity, 'rm', '-q', '--cached', 'hidden/b.md'); git(root, ...identity, 'commit', '-qm', 'delete b');
    await performManagedSync(engine, OPTS);
    expect(await live(engine)).toEqual(['notes/a', 'notes/seed']);
  }, { databaseUrl, setup }), 180_000);
});

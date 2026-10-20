/**
 * GBRA-130 (#6712 PR 4b sweep, found converting managed-sync-lanes' "a page edited after its freeze fails alone"):
 * a file edited in the working tree after the pass froze it (uncommitted bytes) is refused at publication
 * `source_changed` ("The imported file changed after sync admission."). The pass passes such a receipt over as the
 * level moving, but an uncommitted edit does not move the committed level: the next round froze the same path at the
 * same level under the same request ID (`passRequestId`), read the same refused receipt and passed it over again, so
 * the pass used its rounds and ended `not_converged` with nothing held, and every later sync of the source repeated it.
 *
 * Protects (red before: the sync ends resumable `not_converged`, no hold): the file is held `worktree_dirty` (its
 * local edit is not overwritten), the other files import, and the pass converges. Runs on PGLite and, with
 * DATABASE_URL, on Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitHold } from '../src/core/persistence/sync-holds.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, word = 'body') => `---\ntype: concept\ntitle: ${title}\n---\n\nThe ${word} of ${title}.\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`));
  commit(root, 'seed');
};

for (const backend of testBackends()) describe(`[${backend}] GBRA-130: an uncommitted edit after the freeze`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  test('the file is held worktree_dirty, the other files import and the pass converges', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`, 'revised body'));
    commit(root, 'revise');
    installFaultHook(async (point, detail) => {
      if (point === 'sync:after_freeze' && detail.path === 'notes/b.md') writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'uncommitted body'));
    });
    try {
      const result = await performManagedSync(engine, OPTS);
      expect(result.status).toBe('synced');
      expect(result.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/b.md', 'worktree_dirty']]);
    } finally { installFaultHook(undefined); }
    for (const name of ['a', 'c']) expect((await engine.getPage(`notes/${name}`, { sourceId: 'default' }))?.compiled_truth).toContain('revised body');
    expect((await engine.getPage('notes/b', { sourceId: 'default' }))?.compiled_truth).toContain('The body of notes/b');
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    expect(await readGitHold(engine, 'default', incarnation, 'notes/b.md')).toMatchObject({ code: 'worktree_dirty' });
  }, { databaseUrl, setup }), 240_000);
});

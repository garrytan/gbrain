/**
 * GBRA-130 A-7 (#6712 PR 4b): one committed file sync cannot read as a regular file inside its root (a symlink, to a
 * file outside the root or inside it, or a mode-000 file) stopped the whole managed sync at its freeze
 * (`readSyncFile` threw `source_changed` / `EACCES` out of freezeEntry), and every later sync stopped at the same file,
 * so the rest of the source never imported.
 *
 * Protects (red before: the first sync rejects at notes/b.md and notes/a.md, notes/c.md never import): the file is held
 * `file_unreadable` (its content is never read or followed), the other files import, and a later sync is not stopped
 * by it. The root-level checks (a root replaced by a symlink) stay run-level. Runs on PGLite and, with DATABASE_URL,
 * on Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitHold } from '../src/core/persistence/sync-holds.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\nThe body of ${title}.\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/seed.md'), note('notes/seed'));
  commit(root, 'seed');
};
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);

for (const backend of testBackends()) describe(`[${backend}] GBRA-130 A-7: one unreadable file`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  for (const kind of ['symlink outside the root', 'symlink inside the root', 'mode-000'] as const) test(`${kind}: held file_unreadable, the other files import, a later sync is not stopped`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/a.md'), note('notes/a'));
    writeFileSync(join(root, 'notes/c.md'), note('notes/c'));
    if (kind === 'symlink outside the root') { writeFileSync(join(root, '..', 'outside.md'), note('outside')); symlinkSync('../../outside.md', join(root, 'notes/b.md')); }
    if (kind === 'symlink inside the root') symlinkSync('seed.md', join(root, 'notes/b.md'));
    if (kind === 'mode-000') writeFileSync(join(root, 'notes/b.md'), note('notes/b'));
    commit(root, 'a b c');
    if (kind === 'mode-000') chmodSync(join(root, 'notes/b.md'), 0o000);
    try {
      const first = await performManagedSync(engine, OPTS);
      expect(first.status).toBe('synced');
      expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/b.md', 'file_unreadable']]);
      expect(await live(engine)).toEqual(['notes/a', 'notes/c', 'notes/seed']);
      const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
      expect(await readGitHold(engine, 'default', incarnation, 'notes/b.md')).toMatchObject({ code: 'file_unreadable' });
      expect((await performManagedSync(engine, OPTS)).status).not.toBe('blocked_by_failures');
    } finally { if (kind === 'mode-000') chmodSync(join(root, 'notes/b.md'), 0o644); }
  }, { databaseUrl, setup }), 240_000);
});

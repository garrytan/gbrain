/**
 * A source whose folder inside its Git checkout is named with two leading dots (`<repo>/..x`) is a normal source root.
 * `originGitPaths` (sync-markers) computed the folder's scope as `relative(gitRoot, root)` and treated any scope starting
 * with `..` as "the checkout cannot be read", so `originCommitted` answered "committed" for every origin of that source,
 * even a file that was never in Git: a retention purge kept it and a deletion marker was written for it needlessly.
 * Protects: for such a source `originCommitted` answers from the real tree (committed file true, never-committed file
 * false), as it does for a folder named `notes`; a binding that points outside its checkout still answers true (fail closed).
 * Authoring gate: (1) whether a purged page's origin is still committed; (2) a startsWith('..') check that is not
 * component-aware; (3) the other sync-marker tests only use a source at the checkout root or a folder named `notes`;
 * (4) no seam, the exported originCommitted on a real PGLite brain with a real claimed worktree.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { originCommitted } from '../src/core/persistence/sync-markers.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });

/** A managed brain whose default source is the folder `folder` inside a Git checkout, with `kept.md` committed there and `draft.md` never committed. */
async function withSourceFolder(folder: string, run: (engine: Awaited<ReturnType<typeof isolatedSharedSkillsEngine>>['engine'], repo: string) => Promise<void>): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-dotdot-origin-')));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine();
      try {
        const repo = join(home, 'repo');
        const root = join(repo, folder);
        mkdirSync(root, { recursive: true });
        git(repo, 'init', '-q', '-b', 'main');
        writeFileSync(join(repo, 'README.md'), 'readme\n');
        writeFileSync(join(root, 'kept.md'), '---\ntitle: Kept\n---\n\nKept.\n');
        git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'seed');
        writeFileSync(join(root, 'draft.md'), '---\ntitle: Draft\n---\n\nNever committed.\n');
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        await run(engine, repo);
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('originCommitted for a source folder inside its checkout', () => {
  for (const folder of ['..x', '..drafts', 'notes']) {
    test(`${folder}: a committed origin is committed and a never-committed origin is not`, () => withSourceFolder(folder, async engine => {
      expect(await originCommitted(engine, 'default', 'kept.md')).toBe(true);
      expect(await originCommitted(engine, 'default', 'draft.md')).toBe(false);
    }), 120_000);
  }

  test('a binding whose folder leaves the checkout answers committed (fail closed): ../outside, and a sibling that shares the checkout name prefix', () => withSourceFolder('notes', async (engine, repo) => {
    for (const relative of ['../outside', '../repo2']) {
      mkdirSync(join(repo, relative), { recursive: true });
      await engine.executeRaw("UPDATE persistence_source_bindings SET relative_path=$1 WHERE source_id='default'", [relative]);
      expect(`${relative}: ${await originCommitted(engine, 'default', 'draft.md')}`).toBe(`${relative}: true`);
    }
    rmSync(join(repo, '..', 'outside'), { recursive: true, force: true });
    rmSync(join(repo, '..', 'repo2'), { recursive: true, force: true });
  }), 120_000);
});

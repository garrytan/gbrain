/**
 * GST-2128: a Git effect whose commit failed left its targets staged in the checkout's shared index, and nothing ever
 * unstaged them. Each parked effect added more, and every `gbrain git commit-push` naming a directory that held one was
 * refused `commit_prestaged_paths`, because the files looked like another writer's work in progress. A failed effect
 * commit now puts the index entries it changed back as they were, so the folder stays committable.
 * Seams: none; the real `commitGitTargets` and `commitAndPush` over a real repository. A lock file on the branch ref
 * makes the effect's commit fail the way a busy or broken ref does, and leaves the index lock free.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = gitChildEnv();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();

/** A checkout whose source folder is `brain/` below the repository root, with two committed pages and a note. */
function checkout(): { top: string; root: string } {
  const top = mkdtempSync(join(tmpdir(), 'gbrain-effect-unstage-'));
  roots.push(top);
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.name', 'Example'); git(top, 'config', 'user.email', 'example@example.invalid'); git(top, 'config', 'commit.gpgsign', 'false');
  const root = join(top, 'brain');
  mkdirSync(join(root, 'people'), { recursive: true });
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, first version.\n');
  writeFileSync(join(root, 'people', 'bob-example.md'), 'Bob, first version.\n');
  writeFileSync(join(root, 'notes.md'), 'A note.\n');
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'seed');
  return { top, root };
}
const index = (top: string) => git(top, 'ls-files', '-s', '-v');
const lockBranch = (top: string) => { const lock = join(top, '.git', 'refs', 'heads', 'main.lock'); writeFileSync(lock, ''); return () => rmSync(lock); };

test("an effect group's failed commit leaves no staged paths: no edit, new file or removal of any target stays staged", async () => {
  const { top, root } = checkout();
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, second version.\n');
  writeFileSync(join(root, 'people', 'carol-example.md'), 'Carol, new.\n');
  rmSync(join(root, 'notes.md'));
  const before = index(top);
  const unlock = lockBranch(top);
  const results = await commitGitTargets(root, ['people/alice-example.md', 'people/carol-example.md', 'notes.md']);
  unlock();
  for (const path of ['people/alice-example.md', 'people/carol-example.md', 'notes.md']) expect(results.get(path)).toMatchObject({ code: 'git_unavailable' });
  expect(git(top, 'diff', '--cached', '--name-only')).toBe('');
  expect(index(top)).toBe(before);
  expect(git(top, 'diff', '--name-only')).toBe('brain/notes.md\nbrain/people/alice-example.md');
  expect(git(top, 'ls-files', '--others', '--exclude-standard')).toBe('brain/people/carol-example.md');
});

test('another writer\'s staging and a flagged entry beside the effect\'s targets are kept', async () => {
  const { top, root } = checkout();
  writeFileSync(join(root, 'people', 'bob-example.md'), 'Bob, staged by another writer.\n');
  git(top, 'add', '--', 'brain/people/bob-example.md');
  git(top, 'update-index', '--skip-worktree', '--', 'brain/notes.md');
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, second version.\n');
  const before = index(top);
  const unlock = lockBranch(top);
  await commitGitTargets(root, ['people/alice-example.md', 'notes.md']);
  unlock();
  expect(index(top)).toBe(before);
  expect(git(top, 'diff', '--cached', '--name-only')).toBe('brain/people/bob-example.md');
});

test('after a parked effect, commit-push naming its folder commits instead of refusing commit_prestaged_paths', async () => {
  const { top, root } = checkout();
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, written by a Git effect.\n');
  const unlock = lockBranch(top);
  expect((await commitGitTargets(root, ['people/alice-example.md'])).get('people/alice-example.md')).toMatchObject({ code: 'git_unavailable' });
  unlock();
  writeFileSync(join(root, 'people', 'dave-example.md'), 'Dave, from an agent job.\n');
  const result = commitAndPush({ repo: root, cwd: root, paths: ['people'], message: 'agent job pages' });
  expect(result.committed).toBeTruthy();
  expect(git(top, 'show', 'HEAD:brain/people/dave-example.md')).toBe('Dave, from an agent job.');
  expect(git(top, 'status', '--porcelain')).toBe('');
});

test('one target tracked under a folder a later ignore rule covers commits with its group instead of parking it', async () => {
  const { top, root } = checkout();
  mkdirSync(join(root, 'archive'));
  writeFileSync(join(root, 'archive', 'carol-example.md'), 'Carol, first version.\n');
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'archive');
  writeFileSync(join(root, '.gitignore'), 'archive/\n');
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'ignore the archive folder');
  for (const name of ['people/alice-example.md', 'people/bob-example.md', 'archive/carol-example.md']) writeFileSync(join(root, name), `${name}, second version.\n`);
  const results = await commitGitTargets(root, ['people/alice-example.md', 'archive/carol-example.md', 'people/bob-example.md']);
  for (const name of ['people/alice-example.md', 'people/bob-example.md', 'archive/carol-example.md']) {
    expect(results.get(name)).toEqual({ git: 'committed' });
    expect(git(top, 'show', `HEAD:brain/${name}`)).toBe(`${name}, second version.`);
  }
  expect(git(top, 'status', '--porcelain')).toBe('');
});

/** A git that runs `command` for real and then exits 1 when `when` (a shell test over "$@") holds; every other run is the real git. */
function failingGit(when: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'gbrain-failing-git-')); roots.push(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif ${when}; then ${realGit} "$@"; exit 1; fi\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}
const has = (word: string) => `case " $* " in *"${word}"*) true ;; *) false ;; esac`;

test('a file git add refuses fails alone: the rest of its group commits, and nothing of it stays staged', async () => {
  const { top, root } = checkout();
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, second version.\n');
  writeFileSync(join(root, 'people', 'bob-example.md'), 'Bob, second version.\n');
  // Stages bob and still exits 1, the way add treats a path it also reports as one it would not add.
  const path = failingGit(`${has(' add ')} && ${has('bob-example.md')}`);
  const results = await withEnv({ PATH: path }, () => commitGitTargets(root, ['people/alice-example.md', 'people/bob-example.md']));
  expect(results.get('people/alice-example.md')).toEqual({ git: 'committed' });
  expect(results.get('people/bob-example.md')).toMatchObject({ code: 'git_unavailable' });
  expect(git(top, 'show', 'HEAD:brain/people/alice-example.md')).toBe('Alice, second version.');
  expect(git(top, 'diff', '--cached', '--name-only')).toBe('');
  expect(git(top, 'diff', '--name-only')).toBe('brain/people/bob-example.md');
});

test('a group step that throws after the add leaves no staged paths', async () => {
  const { top, root } = checkout();
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, second version.\n');
  writeFileSync(join(root, 'people', 'bob-example.md'), 'Bob, second version.\n');
  const path = failingGit(`${has(' diff ')} && ${has(' --cached ')}`);
  await expect(withEnv({ PATH: path }, () => commitGitTargets(root, ['people/alice-example.md', 'people/bob-example.md'])))
    .rejects.toMatchObject({ code: 'git_unavailable' });
  expect(git(top, 'diff', '--cached', '--name-only')).toBe('');
  expect(git(top, 'diff', '--name-only')).toBe('brain/people/alice-example.md\nbrain/people/bob-example.md');
});

test('a commit that lands but reports a failure is not reversed in the index', async () => {
  const { top, root } = checkout();
  // The effect commit lands when update-ref moves the branch; this one moves it and still exits 1.
  const path = failingGit(has(' update-ref '));
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, second version.\n');
  const results = await withEnv({ PATH: path }, () => commitGitTargets(root, ['people/alice-example.md']));
  expect(results.get('people/alice-example.md')).toMatchObject({ code: 'git_unavailable' });
  expect(git(top, 'show', 'HEAD:brain/people/alice-example.md')).toBe('Alice, second version.');
  expect(git(top, 'status', '--porcelain')).toBe('');
});

test('an untracked target an ignore rule covers is never added: it parks git_target_ignored and its group commits', async () => {
  const { top, root } = checkout();
  writeFileSync(join(root, '.gitignore'), 'private/\n');
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'ignore the private folder');
  mkdirSync(join(root, 'private'));
  writeFileSync(join(root, 'private', 'dave-example.md'), 'Kept out of Git.\n');
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, second version.\n');
  const results = await commitGitTargets(root, ['people/alice-example.md', 'private/dave-example.md']);
  expect(results.get('people/alice-example.md')).toEqual({ git: 'committed' });
  expect(results.get('private/dave-example.md')).toMatchObject({ code: 'git_target_ignored', detail: expect.stringContaining('private/') });
  expect(git(top, 'ls-files', '--', 'brain/private')).toBe('');
  expect(git(top, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'brain/private')).toBe('');
  expect(git(top, 'diff', '--cached', '--name-only')).toBe('');
});

test('an untracked target that an ignore rule covers by the time the group adds it is refused alone and never added', async () => {
  const { top, root } = checkout();
  mkdirSync(join(root, 'private'));
  writeFileSync(join(root, 'private', 'dave-example.md'), 'Kept out of Git.\n');
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, second version.\n');
  // The rule lands between the group's status (which listed the file as untracked) and its add.
  const path = failingGit('false');
  writeFileSync(join(path.split(':')[0]!, 'git'), `#!/bin/sh\ncase " $* " in *" add "*) printf 'private/\\n' >> '${join(top, '.git', 'info', 'exclude')}' ;; esac\nexec ${execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()} "$@"\n`, { mode: 0o755 });
  const results = await withEnv({ PATH: path }, () => commitGitTargets(root, ['people/alice-example.md', 'private/dave-example.md']));
  expect(results.get('people/alice-example.md')).toEqual({ git: 'committed' });
  expect(results.get('private/dave-example.md')).toMatchObject({ code: 'git_target_ignored', detail: expect.stringContaining('private/') });
  expect(git(top, 'ls-files', '--', 'brain/private')).toBe('');
  expect(git(top, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'brain/private')).toBe('');
  expect(git(top, 'diff', '--cached', '--name-only')).toBe('');
});

test('a landed commit is not reversed for a file whose name starts with a colon, edited or new', async () => {
  const { top, root } = checkout();
  writeFileSync(join(root, ':colon-example.md'), 'Colon, first version.\n');
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'colon page');
  writeFileSync(join(root, ':colon-example.md'), 'Colon, second version.\n');
  writeFileSync(join(root, ':new-example.md'), 'New.\n');
  const path = failingGit(has(' update-ref '));
  await withEnv({ PATH: path }, () => commitGitTargets(root, [':colon-example.md', ':new-example.md']));
  expect(git(top, 'show', 'HEAD:brain/:colon-example.md')).toBe('Colon, second version.');
  expect(git(top, 'show', 'HEAD:brain/:new-example.md')).toBe('New.');
  expect(git(top, 'status', '--porcelain')).toBe('');
});

test('putting the index back never tracks again a target another writer untracked meanwhile', async () => {
  const { top, root } = checkout();
  mkdirSync(join(root, 'archive'));
  writeFileSync(join(root, 'archive', 'carol-example.md'), 'Carol, first version.\n');
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'archive');
  writeFileSync(join(root, '.gitignore'), 'archive/\n');
  git(top, 'add', '-A'); git(top, 'commit', '-qm', 'ignore the archive folder');
  writeFileSync(join(root, 'people', 'alice-example.md'), 'Alice, second version.\n');
  // While the effect commits, another writer runs git rm --cached on the ignored file; the commit then fails.
  const path = failingGit('false');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(path.split(':')[0]!, 'git'), `#!/bin/sh\n${has(' update-ref ')} && { ${realGit} -C '${top}' rm -q --cached -- brain/archive/carol-example.md; exit 1; }\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  await withEnv({ PATH: path }, () => commitGitTargets(root, ['people/alice-example.md', 'archive/carol-example.md']));
  expect(git(top, 'ls-files', '--', 'brain/archive')).toBe('');
  expect(git(top, 'diff', '--cached', '--name-only')).toBe('brain/archive/carol-example.md');
});

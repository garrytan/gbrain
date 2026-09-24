import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishGitEffect } from '../src/core/persistence/effect-git.ts';
import { git, gitFixture } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

const fixtures: ReturnType<typeof gitFixture>[] = [];
function fixture() { const f = gitFixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

function published(f: ReturnType<typeof fixture>, path: string, content: string) {
  expect(git(f.root, 'show', `HEAD:${path}`)).toBe(content);
  expect(git(f.remote, 'show', `refs/heads/main:${path}`)).toBe(content);
}

test('literal Git pathspecs publish only the bracketed target and preserve the index', async () => {
  const f = fixture();
  for (const name of ['a[1].md', 'a1.md', 'unrelated.md']) writeFileSync(join(f.root, name), `Before ${name}\n`);
  git(f.root, 'add', '.'); git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Tracked files');
  for (const name of ['a[1].md', 'a1.md', 'unrelated.md']) writeFileSync(join(f.root, name), `After ${name}\n`);
  git(f.root, 'add', '--', 'a1.md', 'unrelated.md');
  const beforeIndex = git(f.root, 'ls-files', '--stage', '-z', '--', 'a1.md', 'unrelated.md');
  expect(await withEnv({ GIT_GLOB_PATHSPECS: '1', GIT_ICASE_PATHSPECS: '1' }, () => publishGitEffect(f.root, 'a[1].md')))
    .toEqual({ git: 'committed', push: 'committed' });
  published(f, 'a[1].md', 'After a[1].md\n');
  published(f, 'a1.md', 'Before a1.md\n');
  expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'a1.md', 'unrelated.md')).toBe(beforeIndex);
  expect(git(f.root, 'diff', '--cached', '--name-only', '-z')).toBe('a1.md\0unrelated.md\0');
});

test.skipIf(process.platform === 'win32')('pathspec magic and POSIX backslashes remain literal filenames', async () => {
  const f = fixture();
  for (const name of [':(glob)*.md', 'literal\\name.md']) {
    writeFileSync(join(f.root, name), `Exact ${name}\n`);
    expect(await publishGitEffect(f.root, name)).toEqual({ git: 'committed', push: 'committed' });
    published(f, name, `Exact ${name}\n`);
  }
  expect(git(f.root, 'ls-tree', '--name-only', '-r', '-z', 'HEAD').split('\0').filter(Boolean).sort())
    .toEqual([':(glob)*.md', 'initial.md', 'literal\\name.md']);
});

test('unchanged replay, missing target and tracked deletion keep distinct outcomes', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'Notes', 'page.md'), 'Published\n');
  expect(await publishGitEffect(f.root, 'Notes/page.md')).toEqual({ git: 'committed', push: 'committed' });
  const head = git(f.root, 'rev-parse', 'HEAD');
  expect(await publishGitEffect(f.root, 'Notes/page.md')).toEqual({ git: 'unchanged', push: 'committed' });
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(await publishGitEffect(f.root, 'Notes/missing.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  rmSync(join(f.root, 'Notes', 'page.md'));
  expect(await publishGitEffect(f.root, 'Notes/page.md')).toEqual({ git: 'committed', push: 'committed' });
  expect(git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('initial.md\n');
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
  const deletedHead = git(f.root, 'rev-parse', 'HEAD');
  expect(await publishGitEffect(f.root, 'Notes/page.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(deletedHead);
});

test('push rejection leaves one durable local commit and retries it unchanged', async () => {
  const f = fixture();
  git(f.remote, 'config', 'receive.denyNonFastForwards', 'true');
  const original = git(f.root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(f.root, 'ahead.md'), 'Remote ahead\n');
  git(f.root, 'add', 'ahead.md'); git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Remote ahead');
  git(f.root, 'push'); git(f.root, 'reset', '--hard', original);
  writeFileSync(join(f.root, 'page.md'), 'Local durable\n');
  await expect(publishGitEffect(f.root, 'page.md')).rejects.toMatchObject({ code: 'git_push_unavailable' });
  expect(git(f.root, 'show', 'HEAD:page.md')).toBe('Local durable\n');
  const head = git(f.root, 'rev-parse', 'HEAD');
  git(f.remote, 'update-ref', 'refs/heads/main', original);
  expect(await publishGitEffect(f.root, 'page.md')).toEqual({ git: 'unchanged', push: 'committed' });
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  published(f, 'page.md', 'Local durable\n');
});

test('native path lookup fixes existing aliases but never folds POSIX case-distinct names', async () => {
  const f = fixture();
  if (!f.caseInsensitive) mkdirSync(join(f.root, 'notes'));
  writeFileSync(join(f.root, 'Notes', 'Old.md'), 'Native\n');
  writeFileSync(join(f.root, 'notes', 'new.md'), 'New\n');
  if (f.caseInsensitive) {
    expect(await publishGitEffect(f.root, 'notes/old.md')).toEqual({ git: 'committed', push: 'committed' });
    published(f, 'Notes/Old.md', 'Native\n');
  } else {
    expect(await publishGitEffect(f.root, 'notes/old.md')).toMatchObject({ reason: 'target_absent' });
    expect(await publishGitEffect(f.root, 'Notes/Old.md')).toEqual({ git: 'committed', push: 'committed' });
  }
  expect(await publishGitEffect(f.root, 'notes/new.md')).toEqual({ git: 'committed', push: 'committed' });
  published(f, f.caseInsensitive ? 'Notes/new.md' : 'notes/new.md', 'New\n');
});

test('native ambiguous aliases refuse instead of picking one hardlink name', async () => {
  const f = fixture();
  if (!f.caseInsensitive) return;
  writeFileSync(join(f.root, 'Notes', 'Old.md'), 'Native\n');
  linkSync(join(f.root, 'Notes', 'Old.md'), join(f.root, 'Notes', 'Other.md'));
  const before = git(f.root, 'rev-parse', 'HEAD');
  await expect(publishGitEffect(f.root, 'notes/old.md')).rejects.toMatchObject({ code: 'git_target_unsafe' });
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(before);
});

test('case-distinct directories retain separate files and staged changes', async () => {
  const f = fixture();
  if (f.caseInsensitive) return;
  mkdirSync(join(f.root, 'notes'));
  for (const directory of ['Notes', 'notes']) writeFileSync(join(f.root, directory, 'page.md'), `Before ${directory}\n`);
  git(f.root, 'add', '.'); git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Distinct paths');
  for (const directory of ['Notes', 'notes']) writeFileSync(join(f.root, directory, 'page.md'), `After ${directory}\n`);
  git(f.root, 'add', '--', 'Notes/page.md');
  const index = git(f.root, 'ls-files', '--stage', '-z', '--', 'Notes/page.md');
  expect(await publishGitEffect(f.root, 'notes/page.md')).toEqual({ git: 'committed', push: 'committed' });
  published(f, 'notes/page.md', 'After notes\n');
  published(f, 'Notes/page.md', 'Before Notes\n');
  expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'Notes/page.md')).toBe(index);
});

for (const staged of [false, true]) test(`a missing old spelling cannot hide an indexed deletion (staged=${staged})`, async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'Notes', 'Old.md'), 'Tracked\n');
  git(f.root, 'add', 'Notes/Old.md'); git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Tracked target');
  git(f.root, 'push');
  rmSync(join(f.root, 'Notes', 'Old.md'));
  if (staged) git(f.root, 'add', '-u', '--', 'Notes/Old.md');
  const head = git(f.root, 'rev-parse', 'HEAD');
  const index = readFileSync(join(f.root, '.git', 'index'));
  await expect(publishGitEffect(f.root, 'Notes/old.md')).rejects.toMatchObject({ code: 'git_target_unsafe' });
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index);
  expect(git(f.remote, 'show', 'refs/heads/main:Notes/Old.md')).toBe('Tracked\n');
  expect(await publishGitEffect(f.root, 'Notes/Old.md')).toEqual({ git: 'committed', push: 'committed' });
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
  const deletion = git(f.root, 'rev-parse', 'HEAD');
  expect(await publishGitEffect(f.root, 'Notes/Old.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(deletion);
});

for (const deleted of [false, true]) test(`unborn HEAD preserves a new index while checking absence (deleted=${deleted})`, async () => {
  const f = fixture();
  git(f.root, 'checkout', '--orphan', 'unborn');
  git(f.root, 'rm', '--cached', '--', 'initial.md');
  writeFileSync(join(f.root, 'Notes', 'New.md'), 'New index entry\n');
  git(f.root, 'add', '--', 'Notes/New.md');
  if (deleted) rmSync(join(f.root, 'Notes', 'New.md'));
  const index = readFileSync(join(f.root, '.git', 'index'));
  if (deleted) await expect(publishGitEffect(f.root, 'Notes/new.md')).rejects.toMatchObject({ code: 'git_target_unsafe' });
  else expect(await publishGitEffect(f.root, 'Notes/missing.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index);
  expect(git(f.root, 'ls-files', '-z')).toBe('Notes/New.md\0');
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
});

test('an exact staged deletion commits alone and replays without another commit', async () => {
  const f = fixture();
  rmSync(join(f.root, 'initial.md')); git(f.root, 'add', '-u', '--', 'initial.md');
  writeFileSync(join(f.root, 'unrelated.md'), 'Unrelated staging\n'); git(f.root, 'add', '--', 'unrelated.md');
  const index = git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md');
  expect(await publishGitEffect(f.root, 'initial.md')).toEqual({ git: 'committed', push: 'committed' });
  expect(git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('');
  expect(git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('');
  expect(git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md')).toBe(index);
  const head = git(f.root, 'rev-parse', 'HEAD');
  expect(await publishGitEffect(f.root, 'initial.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
});

test('symlinked root works while escaping descendants and directory targets refuse', async () => {
  const f = fixture();
  const alias = join(f.home, 'alias'); symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(f.root, 'page.md'), 'Exact\n');
  expect(await publishGitEffect(alias, 'page.md')).toEqual({ git: 'committed', push: 'committed' });
  published(f, 'page.md', 'Exact\n');
  const outside = join(f.home, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'page.md'), 'Outside\n');
  symlinkSync(outside, join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = readFileSync(join(f.root, '.git', 'index'));
  await expect(publishGitEffect(f.root, 'escape/page.md')).rejects.toMatchObject({ code: 'git_target_unsafe' });
  await expect(publishGitEffect(f.root, 'Notes')).rejects.toMatchObject({ code: 'git_target_unsafe' });
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(before);
  expect(readFileSync(join(outside, 'page.md'), 'utf8')).toBe('Outside\n');
  expect(existsSync(join(f.root, 'escape', 'page.md'))).toBe(true);
});

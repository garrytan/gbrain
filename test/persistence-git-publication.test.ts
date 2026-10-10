import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishGitEffect } from '../src/core/persistence/effect-git.ts';
import { gitAsync as git, gitFixtureAsync as gitFixture, type GitFixture } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

// Every git call here is awaited on the main loop: this file's dense run of
// `Bun.spawnSync` calls was where oven-sh/bun#34069 landed in CI shard 7
// (three runs out of three), poisoning every later sync spawn in the process.
const fixtures: GitFixture[] = [];
const caseInsensitiveFs = await (async () => { const probe = await gitFixture(); try { return probe.caseInsensitive; } finally { probe.cleanup(); } })();
async function fixture() { const f = await gitFixture(); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

async function published(f: GitFixture, path: string, content: string) {
  expect(await git(f.root, 'show', `HEAD:${path}`)).toBe(content);
  expect(await git(f.remote, 'show', `refs/heads/main:${path}`)).toBe(content);
}

test('literal Git pathspecs publish only the bracketed target and preserve the index', async () => {
  const f = await fixture();
  for (const name of ['a[1].md', 'a1.md', 'unrelated.md']) writeFileSync(join(f.root, name), `Before ${name}\n`);
  await git(f.root, 'add', '.'); await git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Tracked files');
  for (const name of ['a[1].md', 'a1.md', 'unrelated.md']) writeFileSync(join(f.root, name), `After ${name}\n`);
  await git(f.root, 'add', '--', 'a1.md', 'unrelated.md');
  const beforeIndex = await git(f.root, 'ls-files', '--stage', '-z', '--', 'a1.md', 'unrelated.md');
  expect(await withEnv({ GIT_GLOB_PATHSPECS: '1', GIT_ICASE_PATHSPECS: '1' }, () => publishGitEffect(f.root, 'a[1].md')))
    .toEqual({ git: 'committed', push: 'committed' });
  await published(f, 'a[1].md', 'After a[1].md\n');
  await published(f, 'a1.md', 'Before a1.md\n');
  expect(await git(f.root, 'ls-files', '--stage', '-z', '--', 'a1.md', 'unrelated.md')).toBe(beforeIndex);
  expect(await git(f.root, 'diff', '--cached', '--name-only', '-z')).toBe('a1.md\0unrelated.md\0');
});

test.skipIf(process.platform === 'win32')('pathspec magic and POSIX backslashes remain literal filenames', async () => {
  const f = await fixture();
  for (const name of [':(glob)*.md', 'literal\\name.md']) {
    writeFileSync(join(f.root, name), `Exact ${name}\n`);
    expect(await publishGitEffect(f.root, name)).toEqual({ git: 'committed', push: 'committed' });
    await published(f, name, `Exact ${name}\n`);
  }
  expect((await git(f.root, 'ls-tree', '--name-only', '-r', '-z', 'HEAD')).split('\0').filter(Boolean).sort())
    .toEqual([':(glob)*.md', 'initial.md', 'literal\\name.md']);
});

test('unchanged replay, missing target and tracked deletion keep distinct outcomes', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'Notes', 'page.md'), 'Published\n');
  expect(await publishGitEffect(f.root, 'Notes/page.md')).toEqual({ git: 'committed', push: 'committed' });
  const head = await git(f.root, 'rev-parse', 'HEAD');
  expect(await publishGitEffect(f.root, 'Notes/page.md')).toEqual({ git: 'unchanged', push: 'committed' });
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(await publishGitEffect(f.root, 'Notes/missing.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  rmSync(join(f.root, 'Notes', 'page.md'));
  expect(await publishGitEffect(f.root, 'Notes/page.md')).toEqual({ git: 'committed', push: 'committed' });
  expect(await git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('initial.md\n');
  expect(await git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
  const deletedHead = await git(f.root, 'rev-parse', 'HEAD');
  expect(await publishGitEffect(f.root, 'Notes/page.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(deletedHead);
});

test('push rejection leaves one durable local commit and retries it unchanged', async () => {
  const f = await fixture();
  await git(f.remote, 'config', 'receive.denyNonFastForwards', 'true');
  const original = (await git(f.root, 'rev-parse', 'HEAD')).trim();
  writeFileSync(join(f.root, 'ahead.md'), 'Remote ahead\n');
  await git(f.root, 'add', 'ahead.md'); await git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Remote ahead');
  await git(f.root, 'push'); await git(f.root, 'reset', '--hard', original);
  writeFileSync(join(f.root, 'page.md'), 'Local durable\n');
  await expect(publishGitEffect(f.root, 'page.md')).rejects.toMatchObject({ code: 'git_push_unavailable' });
  expect(await git(f.root, 'show', 'HEAD:page.md')).toBe('Local durable\n');
  const head = await git(f.root, 'rev-parse', 'HEAD');
  await git(f.remote, 'update-ref', 'refs/heads/main', original);
  expect(await publishGitEffect(f.root, 'page.md')).toEqual({ git: 'unchanged', push: 'committed' });
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  await published(f, 'page.md', 'Local durable\n');
});

test('native path lookup fixes existing aliases but never folds POSIX case-distinct names', async () => {
  const f = await fixture();
  if (!f.caseInsensitive) mkdirSync(join(f.root, 'notes'));
  writeFileSync(join(f.root, 'Notes', 'Old.md'), 'Native\n');
  writeFileSync(join(f.root, 'notes', 'new.md'), 'New\n');
  if (f.caseInsensitive) {
    expect(await publishGitEffect(f.root, 'notes/old.md')).toEqual({ git: 'committed', push: 'committed' });
    await published(f, 'Notes/Old.md', 'Native\n');
  } else {
    expect(await publishGitEffect(f.root, 'notes/old.md')).toMatchObject({ reason: 'target_absent' });
    expect(await publishGitEffect(f.root, 'Notes/Old.md')).toEqual({ git: 'committed', push: 'committed' });
  }
  expect(await publishGitEffect(f.root, 'notes/new.md')).toEqual({ git: 'committed', push: 'committed' });
  await published(f, f.caseInsensitive ? 'Notes/new.md' : 'notes/new.md', 'New\n');
});

test.skipIf(!caseInsensitiveFs)('native ambiguous aliases refuse instead of picking one hardlink name', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'Notes', 'Old.md'), 'Native\n');
  linkSync(join(f.root, 'Notes', 'Old.md'), join(f.root, 'Notes', 'Other.md'));
  const before = await git(f.root, 'rev-parse', 'HEAD');
  await expect(publishGitEffect(f.root, 'notes/old.md')).rejects.toMatchObject({ code: 'git_target_unsafe' });
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(before);
});

test.skipIf(caseInsensitiveFs)('case-distinct directories retain separate files and staged changes', async () => {
  const f = await fixture();
  mkdirSync(join(f.root, 'notes'));
  for (const directory of ['Notes', 'notes']) writeFileSync(join(f.root, directory, 'page.md'), `Before ${directory}\n`);
  await git(f.root, 'add', '.'); await git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Distinct paths');
  for (const directory of ['Notes', 'notes']) writeFileSync(join(f.root, directory, 'page.md'), `After ${directory}\n`);
  await git(f.root, 'add', '--', 'Notes/page.md');
  const index = await git(f.root, 'ls-files', '--stage', '-z', '--', 'Notes/page.md');
  expect(await publishGitEffect(f.root, 'notes/page.md')).toEqual({ git: 'committed', push: 'committed' });
  await published(f, 'notes/page.md', 'After notes\n');
  await published(f, 'Notes/page.md', 'Before Notes\n');
  expect(await git(f.root, 'ls-files', '--stage', '-z', '--', 'Notes/page.md')).toBe(index);
});

for (const staged of [false, true]) test(`a missing old spelling cannot hide an indexed deletion (staged=${staged})`, async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'Notes', 'Old.md'), 'Tracked\n');
  await git(f.root, 'add', 'Notes/Old.md'); await git(f.root, '-c', 'core.hooksPath=', 'commit', '-m', 'Tracked target');
  await git(f.root, 'push');
  rmSync(join(f.root, 'Notes', 'Old.md'));
  if (staged) await git(f.root, 'add', '-u', '--', 'Notes/Old.md');
  const head = await git(f.root, 'rev-parse', 'HEAD');
  const index = readFileSync(join(f.root, '.git', 'index'));
  await expect(publishGitEffect(f.root, 'Notes/old.md')).rejects.toMatchObject({ code: 'git_target_unsafe' });
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index);
  expect(await git(f.remote, 'show', 'refs/heads/main:Notes/Old.md')).toBe('Tracked\n');
  expect(await publishGitEffect(f.root, 'Notes/Old.md')).toEqual({ git: 'committed', push: 'committed' });
  expect(await git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
  const deletion = await git(f.root, 'rev-parse', 'HEAD');
  expect(await publishGitEffect(f.root, 'Notes/Old.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(deletion);
});

for (const deleted of [false, true]) test(`unborn HEAD preserves a new index while checking absence (deleted=${deleted})`, async () => {
  const f = await fixture();
  await git(f.root, 'checkout', '--orphan', 'unborn');
  await git(f.root, 'rm', '--cached', '--', 'initial.md');
  writeFileSync(join(f.root, 'Notes', 'New.md'), 'New index entry\n');
  await git(f.root, 'add', '--', 'Notes/New.md');
  if (deleted) rmSync(join(f.root, 'Notes', 'New.md'));
  const index = readFileSync(join(f.root, '.git', 'index'));
  if (deleted) await expect(publishGitEffect(f.root, 'Notes/new.md')).rejects.toMatchObject({ code: 'git_target_unsafe' });
  else expect(await publishGitEffect(f.root, 'Notes/missing.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(index);
  expect(await git(f.root, 'ls-files', '-z')).toBe('Notes/New.md\0');
  expect(await git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('initial.md\n');
});

test('an exact staged deletion commits alone and replays without another commit', async () => {
  const f = await fixture();
  rmSync(join(f.root, 'initial.md')); await git(f.root, 'add', '-u', '--', 'initial.md');
  writeFileSync(join(f.root, 'unrelated.md'), 'Unrelated staging\n'); await git(f.root, 'add', '--', 'unrelated.md');
  const index = await git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md');
  expect(await publishGitEffect(f.root, 'initial.md')).toEqual({ git: 'committed', push: 'committed' });
  expect(await git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('');
  expect(await git(f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main')).toBe('');
  expect(await git(f.root, 'ls-files', '--stage', '-z', '--', 'unrelated.md')).toBe(index);
  const head = await git(f.root, 'rev-parse', 'HEAD');
  expect(await publishGitEffect(f.root, 'initial.md')).toEqual({ git: 'skipped', reason: 'target_absent', push: 'skipped' });
  expect(await git(f.root, 'rev-parse', 'HEAD')).toBe(head);
});

test('symlinked root works while escaping descendants and directory targets refuse', async () => {
  const f = await fixture();
  const alias = join(f.home, 'alias'); symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(f.root, 'page.md'), 'Exact\n');
  expect(await publishGitEffect(alias, 'page.md')).toEqual({ git: 'committed', push: 'committed' });
  await published(f, 'page.md', 'Exact\n');
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

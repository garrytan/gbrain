/**
 * The secret gate on automatic publishes (`commitAndPush({ pushOnly, keepCheckout })`, the publish
 * `gbrain sources refresh` runs in its child): it scans, under the publish lock, what the commits it is about to push add.
 * Protects: a value that looks like a secret is found in an added line even when a later commit removed it, in a
 * commit message, and in a merge commit's conflict resolution, named by path, line, rule and commit but never by
 * value, and nothing is pushed; an added line whose text starts with `++` (printed `+++`, like a file header) is
 * still scanned; added text over the scan cap, and a commit in the range that changes .gbrain-scan-allow or a
 * .gitattributes, refuse; a fingerprint in the working tree's .gbrain-scan-allow and a binary file are skipped; a clean
 * range publishes; a remote rewound past a pushed secret (the tracking ref still names
 * it) is fetched and scanned again instead of fast-forwarded over (#8896).
 * Seams: none; real repositories and a bare remote.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { scanRange } from '../src/core/git/range-secret-scan.ts';
import { SCAN_MAX_FILE_BYTES } from '../src/core/secret-scan.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-guarded-publish-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const token = 'ghp_' + 'Zt4q'.repeat(9);

function repo(name: string): { remote: string; root: string; base: string } {
  const remote = join(dir, `${name}.git`), root = join(dir, name);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' });
  git(root, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(root, 'readme.md'), 'start\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init'); git(root, 'push', '-q', '-u', 'origin', 'main');
  return { remote, root, base: git(root, 'rev-parse', 'HEAD') };
}
const commit = (root: string, file: string, content: string | Buffer, message = `edit ${file}`) => {
  writeFileSync(join(root, file), content); git(root, 'add', file); git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
};
const publish = (root: string) => commitAndPush({ repo: root, cwd: root, paths: [], pushOnly: true, keepCheckout: true });
const refused = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e as { code: string; message: string; detail?: string; fix?: { user_message?: string } }; }
  throw new Error('expected publish_secret_found');
};
const remoteTip = (r: { remote: string }) => git(r.remote, 'rev-parse', 'refs/heads/main');

test('a secret an unpushed commit added is refused even after a later commit removed it, named without its value', () => {
  const r = repo('removed');
  const added = commit(r.root, 'notes.md', `line one\nDeploy token ${token}\n`);
  commit(r.root, 'notes.md', 'line one\nredacted\n');
  const error = refused(() => publish(r.root));
  expect(error.code).toBe('publish_secret_found');
  expect(error.message).toContain(`notes.md:2 (`);
  expect(error.message).toContain(added.slice(0, 7));
  expect(JSON.stringify(error)).not.toContain(token);
  expect(remoteTip(r)).toBe(r.base);
});

test('a secret in a commit message is refused', () => {
  const r = repo('message');
  commit(r.root, 'page.md', 'a page\n', `rotate ${token}`);
  const error = refused(() => publish(r.root));
  expect(error.message).toContain('(commit message):1 (');
  expect(remoteTip(r)).toBe(r.base);
});

test('a secret typed into a merge commit\'s conflict resolution is refused', () => {
  const r = repo('merge');
  git(r.root, 'checkout', '-q', '-b', 'side');
  commit(r.root, 'readme.md', 'side version\n');
  git(r.root, 'checkout', '-q', 'main');
  commit(r.root, 'readme.md', 'main version\n');
  try { git(r.root, 'merge', '-q', 'side'); } catch { /* conflict expected */ }
  writeFileSync(join(r.root, 'readme.md'), `resolved with ${token}\n`);
  git(r.root, 'add', 'readme.md'); git(r.root, 'commit', '-qm', 'merge side');
  const error = refused(() => publish(r.root));
  expect(error.message).toContain('readme.md:1 (');
  expect(remoteTip(r)).toBe(r.base);
});

test('an allowlisted fingerprint and a binary file are skipped and the clean range publishes', () => {
  const r = repo('allow');
  commit(r.root, 'data.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(token)]));
  commit(r.root, 'notes.md', `Deploy token ${token}\n`);
  const error = refused(() => publish(r.root));
  const fingerprint = (JSON.parse(error.detail!) as { findings: Array<{ path: string; fingerprint: string }> }).findings.find(f => f.path === 'notes.md')!.fingerprint;
  expect((JSON.parse(error.detail!) as { findings: unknown[] }).findings).toHaveLength(1);
  writeFileSync(join(r.root, '.gbrain-scan-allow'), `${fingerprint}\n`);
  expect(publish(r.root)).toMatchObject({ outcome: 'pushed', checkout: 'unchanged' });
  expect(remoteTip(r)).toBe(git(r.root, 'rev-parse', 'HEAD'));
});


test('an added line whose text starts with ++ is scanned, not read as a file header', () => {
  const r = repo('plusplus');
  commit(r.root, 'notes.md', `intro\n++ ${token}\nafter\n`);
  const error = refused(() => publish(r.root));
  expect(error.code).toBe('publish_secret_found');
  expect(error.message).toContain('notes.md:2 (');
  expect(remoteTip(r)).toBe(r.base);
});

test('added text over the scan cap refuses as unscanned', () => {
  const r = repo('big');
  commit(r.root, 'big.md', `${'x'.repeat(SCAN_MAX_FILE_BYTES + 10)}\n`);
  const error = refused(() => publish(r.root));
  expect(error.code).toBe('publish_secret_found');
  expect(error.message).toContain('big.md (too large to scan, ');
  expect(remoteTip(r)).toBe(r.base);
});

test('an unpublished commit that widens .gbrain-scan-allow or turns a file binary with .gitattributes refuses', () => {
  const r = repo('gate');
  commit(r.root, '.gbrain-scan-allow', '**\n');
  commit(r.root, 'notes.md', `Deploy token ${token}\n`);
  const allow = refused(() => publish(r.root));
  expect(allow.code).toBe('publish_secret_found');
  expect(allow.message).toContain('.gbrain-scan-allow (changes what the scan sees, ');
  expect(remoteTip(r)).toBe(r.base);

  const attrs = repo('attrs');
  commit(attrs.root, '.gitattributes', '* -diff\n');
  commit(attrs.root, 'notes.md', `Deploy token ${token}\n`);
  const hidden = refused(() => publish(attrs.root));
  expect(hidden.message).toContain('.gitattributes (changes what the scan sees, ');
  expect(remoteTip(attrs)).toBe(attrs.base);
});

test('attributes outside the range and diff settings never hide a secret or a gate change', () => {
  const worktree = repo('wt-attrs');
  commit(worktree.root, 'notes.md', `Deploy token ${token}\n`);
  writeFileSync(join(worktree.root, '.gitattributes'), '* -diff\n');
  writeFileSync(join(worktree.root, '.git', 'info', 'attributes'), '* binary\n');
  expect(refused(() => publish(worktree.root)).message).toContain('notes.md:1 (');
  expect(remoteTip(worktree)).toBe(worktree.base);

  const noprefix = repo('noprefix');
  git(noprefix.root, 'config', 'diff.noprefix', 'true');
  git(noprefix.root, 'config', 'core.bigFileThreshold', '1');
  commit(noprefix.root, '.gbrain-scan-allow', '**\n');
  const widened = refused(() => publish(noprefix.root));
  expect(widened.message).toContain('.gbrain-scan-allow (changes what the scan sees, ');
  expect(remoteTip(noprefix)).toBe(noprefix.base);
});

test('a remote rewound past a pushed secret is not published again through a stale tracking ref', () => {
  const r = repo('rewound');
  commit(r.root, 'notes.md', `Deploy token ${token}\n`);
  git(r.root, 'push', '-q');
  git(r.remote, 'update-ref', 'refs/heads/main', r.base);
  commit(r.root, 'page.md', 'a clean page\n');
  const error = refused(() => publish(r.root));
  expect(error.message).toContain('notes.md:1 (');
  expect(remoteTip(r)).toBe(r.base);
});

test('a NUL byte past the first 8000 bytes of a text file never hides a secret in it', () => {
  const r = repo('late-nul');
  commit(r.root, 'notes.md', `Deploy token ${token}\n${'x'.repeat(10_000)}\0tail\n`);
  const error = refused(() => publish(r.root));
  expect(error.code).toBe('publish_secret_found');
  expect(error.message).toContain('notes.md:1 (');
  expect(remoteTip(r)).toBe(r.base);
});

test('a repository log encoding never hides a secret in a commit message', () => {
  const r = repo('encoding');
  git(r.root, 'config', 'i18n.logOutputEncoding', 'UTF-16LE');
  commit(r.root, 'page.md', 'a page\n', `rotate ${token}`);
  expect(refused(() => publish(r.root)).message).toContain('(commit message):1 (');
  expect(remoteTip(r)).toBe(r.base);
});

test('a root commit merged in from unrelated history is scanned whatever log.showRoot says', () => {
  const r = repo('showroot');
  git(r.root, 'config', 'log.showRoot', 'false');
  git(r.root, 'checkout', '-q', '--orphan', 'imported');
  git(r.root, 'rm', '-rqf', '.');
  commit(r.root, 'imported.md', `Deploy token ${token}\n`);
  git(r.root, 'checkout', '-q', 'main');
  git(r.root, 'merge', '-q', '--allow-unrelated-histories', '--no-edit', 'imported');
  expect(refused(() => publish(r.root)).message).toContain('imported.md:1 (');
  expect(remoteTip(r)).toBe(r.base);
});

test('commits the scan cannot read refuse with their own code, not as secrets to remove', () => {
  const r = repo('unreadable');
  commit(r.root, 'notes.md', 'plain text\n');
  const blob = git(r.root, 'rev-parse', 'HEAD:notes.md');
  git(r.root, 'rm', '-q', 'notes.md'); git(r.root, 'commit', '-qm', 'drop notes');
  rmSync(join(r.root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const error = refused(() => publish(r.root));
  expect(error.code).toBe('publish_scan_unreadable');
  expect(error.message).toContain('Nothing was pushed.');
  expect(error.message).not.toContain('look like secrets');
  expect(remoteTip(r)).toBe(r.base);
});

test('a token in a commit message that declares UTF-16 is still found in its raw bytes', () => {
  const r = repo('utf16-message');
  git(r.root, 'config', 'i18n.commitEncoding', 'UTF-16LE');
  commit(r.root, 'page.md', 'a page\n', `rotate ${token}`);
  expect(refused(() => publish(r.root)).message).toContain('(commit message):1 (');
  expect(remoteTip(r)).toBe(r.base);
});

test('a commit message in an encoding the scan cannot decode refuses as unreadable, not as too large', () => {
  const r = repo('utf7-message');
  git(r.root, 'config', 'i18n.commitEncoding', 'UTF-7');
  commit(r.root, 'page.md', 'a page\n', 'plain message');
  const error = refused(() => publish(r.root));
  expect(error.code).toBe('publish_scan_unreadable');
  expect(error.message).not.toContain('too large to scan');
  expect(remoteTip(r)).toBe(r.base);
});

test('every git call the scan makes ignores the system gitattributes file', async () => {
  const r = repo('nosystem');
  commit(r.root, 'notes.md', 'plain\n');
  const bin = join(dir, 'git-spy'), log = join(dir, 'git-spy.log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "\${GIT_ATTR_NOSYSTEM:-unset}" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const scan = await withEnv({ PATH: `${bin}:${process.env.PATH}` }, async () => scanRange(r.root, 'refs/remotes/origin/main', 'HEAD'));
  expect(scan.unreadable).toBeUndefined();
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  expect(calls.length).toBeGreaterThan(3);
  expect(calls.filter(value => value !== '1')).toEqual([]);
});

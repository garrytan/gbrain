/**
 * Guards on an automatic publish of commits gbrain did not write: the commit-range secret scan
 * (scanCommitRange) and the pre-push hook on a keep-checkout publish that is a plain fast-forward.
 * Protects: a value that looks like a secret in any blob a local commit added is found even when a later
 * commit removed it, with the path, line and rule but never the value; a fingerprint in .gbrain-scan-allow
 * and binary blobs are skipped; a keep-checkout publish of HEAD itself runs the checkout's pre-push hook, so
 * a refusing hook stops the push.
 * Seams: none; real repositories and a bare remote.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { scanCommitRange } from '../src/core/git/range-secret-scan.ts';

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
const commit = (root: string, file: string, content: string | Buffer) => {
  writeFileSync(join(root, file), content); git(root, 'add', file); git(root, 'commit', '-qm', `edit ${file}`);
  return git(root, 'rev-parse', 'HEAD');
};

test('a secret a local commit added is found even after a later commit removed it, without its value', async () => {
  const r = repo('scan');
  const added = commit(r.root, 'notes.md', `line one\nDeploy token ${token}\n`);
  commit(r.root, 'notes.md', 'line one\nredacted\n');
  commit(r.root, 'clean.md', 'nothing here\n');
  const findings = await scanCommitRange(r.root, r.base, 'HEAD');
  expect(findings).toHaveLength(1);
  expect(findings![0]).toMatchObject({ path: 'notes.md', commit: added, line: 2 });
  expect(JSON.stringify(findings)).not.toContain(token);
  expect(await scanCommitRange(r.root, 'HEAD', 'HEAD')).toEqual([]);
});

test('a fingerprint in .gbrain-scan-allow and a binary blob are skipped; an unreadable range is null', async () => {
  const r = repo('allow');
  commit(r.root, 'data.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(token)]));
  commit(r.root, 'notes.md', `Deploy token ${token}\n`);
  const [finding] = (await scanCommitRange(r.root, r.base, 'HEAD'))!;
  expect(finding.path).toBe('notes.md');
  writeFileSync(join(r.root, '.gbrain-scan-allow'), `${finding.fingerprint}\n`);
  expect(await scanCommitRange(r.root, r.base, 'HEAD')).toEqual([]);
  expect(await scanCommitRange(r.root, r.base, 'no-such-ref')).toBeNull();
});

test('a keep-checkout publish of HEAD runs the pre-push hook, and a refusing hook stops the push', () => {
  const r = repo('hook');
  const marker = join(dir, 'hook-ran');
  const hook = join(r.root, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); chmodSync(hook, 0o755);
  commit(r.root, 'page.md', 'a page\n');
  expect(() => commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true, keepCheckout: true })).toThrow(/no push to origin\/main was confirmed/);
  expect(existsSync(marker)).toBe(true);
  expect(git(r.remote, 'rev-parse', 'refs/heads/main')).toBe(r.base);
  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  expect(commitAndPush({ repo: r.root, cwd: r.root, paths: [], pushOnly: true, keepCheckout: true })).toMatchObject({ outcome: 'pushed', checkout: 'unchanged' });
  expect(git(r.remote, 'rev-parse', 'refs/heads/main')).toBe(git(r.root, 'rev-parse', 'HEAD'));
});

/**
 * #7338: a managed pass probed every unrecorded legacy page on every pass, reading and hashing each one and running
 * `hash-object` and `check-attr` over all of them, so a commit's latency grew with the pages the bounded legacy sweep had
 * not recorded yet (the nightly freshness gate's managed cells). Committed mode now reuses a `clean` probe while the
 * path's lstat key and tree entry are the ones it was vouched under, with the working stat cache's freshness contract:
 * racy files are rehashed, an edit with a restored mtime is a change, a moved tree entry or a staged index entry is
 * probed again.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDirtiness, readIndexLevel, readTreeLevel } from '../src/core/persistence/sync-git-stream.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const blobOid = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Past the 2 s racy window, so a probe made now is vouched. */
const RACY_WAIT_MS = 2_100;

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-clean-reuse-'));
  dirs.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'user.name', 'Writer Example');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

async function probe(root: string, paths: string[]) {
  return probeDirtiness(root, root, paths, await readTreeLevel(root, 'HEAD', ''), await readIndexLevel(root));
}

/** Runs `fn` with the repository's Git directory moved away, so any path probed again (attributes, raw OIDs) reads `unknown`. */
async function withoutGit<T>(root: string, fn: () => Promise<T>): Promise<T> {
  renameSync(join(root, '.git'), join(root, '.git-away'));
  try { return await fn(); } finally { renameSync(join(root, '.git-away'), join(root, '.git')); }
}

describe('#7338: committed mode reuses a vouched clean probe', () => {
  test('an unchanged clean file past the racy window is not read or hashed again', async () => {
    const root = repo({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' });
    const tree = await readTreeLevel(root, 'HEAD', '');
    const index = await readIndexLevel(root);
    await sleep(RACY_WAIT_MS);
    const first = await probeDirtiness(root, root, ['a.md', 'b.md'], tree, index);
    expect(first.get('a.md')).toEqual({ dp: 'clean', rawOid: blobOid('alpha\n'), rawSha256: sha256('alpha\n') });
    const again = await withoutGit(root, () => probeDirtiness(root, root, ['a.md', 'b.md'], tree, index));
    expect(again.get('a.md')).toEqual({ dp: 'clean', rawOid: blobOid('alpha\n'), rawSha256: sha256('alpha\n') });
    expect(again.get('b.md')).toEqual({ dp: 'clean', rawOid: blobOid('bravo\n'), rawSha256: sha256('bravo\n') });
  }, 30_000);

  test('a file probed inside the racy window is probed again', async () => {
    const root = repo({ 'a.md': 'alpha\n' });
    expect((await probe(root, ['a.md'])).get('a.md')?.dp).toBe('clean');
    const tree = await readTreeLevel(root, 'HEAD', ''), index = await readIndexLevel(root);
    expect((await withoutGit(root, () => probeDirtiness(root, root, ['a.md'], tree, index))).get('a.md')?.dp).toBe('unknown');
  }, 30_000);

  test('a same-inode, same-size edit with a restored mtime is a change', async () => {
    const root = repo({ 'a.md': 'alpha one\n' });
    const past = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(join(root, 'a.md'), past, past);
    await sleep(RACY_WAIT_MS);
    expect((await probe(root, ['a.md'])).get('a.md')?.dp).toBe('clean');
    const before = statSync(join(root, 'a.md'), { bigint: true });
    const fd = openSync(join(root, 'a.md'), 'r+');
    try { writeSync(fd, 'alpha two\n', 0); } finally { closeSync(fd); }
    utimesSync(join(root, 'a.md'), past, past);
    const after = statSync(join(root, 'a.md'), { bigint: true });
    expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
    expect((await probe(root, ['a.md'])).get('a.md')).toEqual({ dp: 'modified', rawOid: blobOid('alpha two\n'), rawSha256: sha256('alpha two\n') });
  }, 30_000);

  test('a moved tree entry or a staged index entry is probed again', async () => {
    const root = repo({ 'a.md': 'alpha\n' });
    await sleep(RACY_WAIT_MS);
    const tree = await readTreeLevel(root, 'HEAD', '');
    expect((await probe(root, ['a.md'])).get('a.md')?.dp).toBe('clean');
    const moved = new Map(tree);
    moved.set('a.md', { ...tree.get('a.md')!, oid: blobOid('alpha moved\n') });
    const index = new Map([...await readIndexLevel(root)].map(([path, entry]) => [path, { ...entry, oid: blobOid('alpha moved\n') }]));
    expect((await probeDirtiness(root, root, ['a.md'], moved, index)).get('a.md')?.dp).toBe('modified');
    const staged = new Map([...await readIndexLevel(root)].map(([path, entry]) => [path, { ...entry, oid: blobOid('alpha staged\n') }]));
    expect((await probeDirtiness(root, root, ['a.md'], tree, staged)).get('a.md')?.dp).toBe('staged');
  }, 30_000);
});

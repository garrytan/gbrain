/**
 * #6712 PR 4b (design v3.2 §2.1): the working stat cache follows Git's freshness contract (key dev, ino, mode, uid,
 * size, mtime_ns, ctime_ns; racy entries rehashed; hash-then-restat; uncertainty is a change). Probe 42: a same-inode, same-size edit with a restored `mtime` on a warm
 * cache, and an edit while the file is hashed, are both seen by the next working pass.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashWorkingLevel, parseWorkingStatCache, readTreeLevel, recallWorkingStatCache, rememberWorkingStatCache,
  workingChanged, workingStatKey, type WorkingStatCache } from '../src/core/persistence/sync-git-stream.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const blobOid = (content: string | Buffer) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Past Git's 2 s racy window, so entries written now are trusted on the next pass. */
const RACY_WAIT_MS = 2_100;

function repo(files: Record<string, string | Buffer>, attributes?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-working-level-'));
  dirs.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'user.name', 'Writer Example');
  if (attributes) writeFileSync(join(root, '.gitattributes'), attributes);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

/** Overwrites `path` in place (same inode, same size) and restores its atime and mtime to whole seconds `at`. */
function sameSizeEdit(path: string, content: string, at: number): void {
  const fd = openSync(path, 'r+');
  try { writeSync(fd, content, 0); } finally { closeSync(fd); }
  utimesSync(path, at, at);
}

describe('probe 42: the working stat cache follows Git\'s freshness contract', () => {
  const past = Math.floor(Date.now() / 1000) - 3600;

  test('a same-inode, same-size edit with a restored mtime on a warm cache is a change', async () => {
    const root = repo({ 'a.md': 'alpha one\n', 'b.md': 'bravo\n' });
    utimesSync(join(root, 'a.md'), past, past);
    await sleep(RACY_WAIT_MS);
    const tree = await readTreeLevel(root, 'HEAD', '');
    const { cache } = await hashWorkingLevel(root, root, ['a.md', 'b.md', 'gone.md'], tree);
    expect(Object.keys(cache!.entries).sort()).toEqual(['a.md', 'b.md', 'gone.md']);
    expect(workingChanged(cache, ['a.md', 'b.md', 'gone.md']).changed).toEqual([]);

    const before = statSync(join(root, 'a.md'), { bigint: true });
    sameSizeEdit(join(root, 'a.md'), 'alpha two\n', past);
    const after = statSync(join(root, 'a.md'), { bigint: true });
    expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs]);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    const next = workingChanged(cache, ['a.md', 'b.md', 'gone.md']);
    expect(next.changed).toEqual(['a.md']);
    expect(Object.keys(next.cache!.entries).sort()).toEqual(['b.md', 'gone.md']);
    const rehashed = await hashWorkingLevel(root, root, next.changed, tree);
    expect(rehashed.probes.get('a.md')).toEqual({ dp: 'modified', rawOid: blobOid('alpha two\n'), rawSha256: sha256('alpha two\n') });
  }, 30_000);

  test('an edit while the file is hashed is rehashed in the pass and never cached as the old bytes', async () => {
    const root = repo({ 'a.md': 'alpha one\n' });
    utimesSync(join(root, 'a.md'), past, past);
    await sleep(RACY_WAIT_MS);
    const tree = await readTreeLevel(root, 'HEAD', '');
    let edits = 0;
    const once = await hashWorkingLevel(root, root, ['a.md'], tree, { afterHash: () => { if (edits++ === 0) sameSizeEdit(join(root, 'a.md'), 'alpha two\n', past); } });
    expect(edits).toBe(2);
    expect(once.probes.get('a.md')).toEqual({ dp: 'modified', rawOid: blobOid('alpha two\n'), rawSha256: sha256('alpha two\n') });
    expect(workingChanged(once.cache, ['a.md']).changed).toEqual(['a.md']);

    let n = 0;
    const always = await hashWorkingLevel(root, root, ['a.md'], tree, { afterHash: () => { sameSizeEdit(join(root, 'a.md'), n++ % 2 ? 'alpha one\n' : 'alpha six\n', past); } });
    expect(n).toBe(3);
    expect(always.cache!.entries['a.md']).toBeUndefined();
    expect(workingChanged(always.cache, ['a.md']).changed).toEqual(['a.md']);
  }, 30_000);

  test('a racy entry is rehashed on the next pass; once it ages past the window the cache trusts it', async () => {
    const root = repo({ 'a.md': 'alpha\n' });
    writeFileSync(join(root, 'a.md'), 'alpha now\n');
    const tree = await readTreeLevel(root, 'HEAD', '');
    const fresh = await hashWorkingLevel(root, root, ['a.md'], tree);
    expect(fresh.cache!.entries['a.md']).toBeUndefined();
    expect(workingChanged(fresh.cache, ['a.md']).changed).toEqual(['a.md']);
    await sleep(RACY_WAIT_MS);
    const aged = await hashWorkingLevel(root, root, ['a.md'], tree);
    expect(aged.cache!.entries['a.md']).toBeDefined();
    expect(workingChanged(aged.cache, ['a.md']).changed).toEqual([]);
  }, 30_000);

  test('new, vanished, replaced and unstat-able paths are changes; uncertainty is never "no change"', async () => {
    const root = repo({ 'a.md': 'alpha\n', 'b.md': 'bravo\n', 'c.md': 'charlie\n' });
    for (const name of ['a.md', 'b.md', 'c.md']) utimesSync(join(root, name), past, past);
    await sleep(RACY_WAIT_MS);
    const { cache } = await hashWorkingLevel(root, root, ['a.md', 'b.md', 'c.md', 'gone.md'], await readTreeLevel(root, 'HEAD', ''));
    unlinkSync(join(root, 'b.md'));
    writeFileSync(join(root, 'gone.md'), 'back\n');
    unlinkSync(join(root, 'c.md'));
    symlinkSync('a.md', join(root, 'c.md'));
    expect(workingChanged(cache, ['a.md', 'new.md', 'a.md/inside']).changed).toEqual(['a.md/inside', 'b.md', 'c.md', 'gone.md', 'new.md']);
    expect(workingChanged(null, ['a.md']).changed).toEqual(['a.md']);
    expect(parseWorkingStatCache({ v: 1, root, entries: { 'a.md': 7 } })).toBeNull();
    expect(parseWorkingStatCache('junk')).toBeNull();
    expect(parseWorkingStatCache(JSON.parse(JSON.stringify(cache)))).toEqual(cache);
    expect(workingChanged({ ...cache!, root: join(root, 'elsewhere') }, ['a.md']).changed).toEqual(['a.md']);
    const stats = statSync(join(root, 'a.md'), { bigint: true });
    expect(workingStatKey(stats)).toMatch(/^\d+:\d+:\d+:\d+:\d+:\d+:\d+$/);
    expect(workingStatKey({ ...stats, ctimeNs: 0n })).toBeNull();
    expect(workingStatKey(null)).toBeNull();
  }, 30_000);

  test('the cache is bounded, JSON-able, and remembered per process', async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`n${i}.md`, `note ${i}\n`]));
    const root = repo(files);
    for (const name of Object.keys(files)) utimesSync(join(root, name), past, past);
    await sleep(RACY_WAIT_MS);
    const { cache } = await hashWorkingLevel(root, root, Object.keys(files), await readTreeLevel(root, 'HEAD', ''), { maxEntries: 4 });
    expect(Object.keys(cache!.entries)).toEqual(['n0.md', 'n1.md', 'n2.md', 'n3.md']);
    expect(workingChanged(cache, Object.keys(files)).changed).toEqual(['n4.md', 'n5.md']);
    rememberWorkingStatCache('default:1', cache!);
    expect(recallWorkingStatCache('default:1')).toEqual(cache as WorkingStatCache);
    expect(recallWorkingStatCache('default:2')).toBeNull();
  }, 30_000);
});

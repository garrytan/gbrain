/**
 * #6712 PR 4a: the async hardened Git stream, its allow-list additions, the
 * chunked level reads (`T`, `X`, rename hints, blobs) and the batched
 * dirtiness probe (`Dp`). The forced probe (design probe 28) proves that none of
 * these reads runs the checkout's clean/process filter or textconv, while
 * porcelain on the same checkout does.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertHardenedGitArgs, hardenedGitStream, hardenedStreamComplete, NulRecordSplitter, type HardenedGitStreamResult } from '../src/core/hardened-git.ts';
import { __setSyncGitStreamForTests, probeDirtiness, readBlobs, readIndexLevel, readRenameHints, readTreeLevel, SyncTreeReadIncomplete } from '../src/core/persistence/sync-git-stream.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => __setSyncGitStreamForTests());

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gbrain-git-stream-${label}-`));
  dirs.push(dir);
  return dir;
}

/** A checkout with `files` committed (and whatever `extra` does before the commit). */
function repo(files: Record<string, string>, extra?: (root: string) => void): string {
  const root = tempDir('repo');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'config', 'user.name', 'Writer Example');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  extra?.(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

const blobOid = (content: string | Buffer) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

async function probe(root: string, paths: string[], batch?: number) {
  const tree = await readTreeLevel(root, 'HEAD', '');
  const index = await readIndexLevel(root);
  return probeDirtiness(root, root, paths, tree, index, batch === undefined ? {} : { batch });
}

describe('allow-list additions', () => {
  test('each new option passes', () => {
    for (const args of [
      ['hash-object', '--no-filters', '--stdin-paths'], ['hash-object', '--stdin-paths', '--no-filters'],
      ['check-attr', '-z', '--stdin', 'filter', 'text', 'eol', 'working-tree-encoding'],
      ['diff-tree', '-r', '-z', '--no-renames', 'a', 'b'], ['diff-tree', '--no-renames', '-z', '-r', 'a', 'b', '--', 'notes'],
      ['cat-file', '--batch'], ['cat-file', 'blob', 'abc'],
    ]) expect(() => assertHardenedGitArgs(args)).not.toThrow();
  });

  test('each dangerous neighbour refuses', () => {
    for (const args of [
      ['hash-object', '--stdin-paths'], ['hash-object', '--stdin-paths', '-w', '--no-filters'], ['hash-object', '--no-filters', '--stdin'],
      ['hash-object', '--no-filters', '--path=x', '--stdin-paths'],
      ['check-attr', '--stdin', '-a'], ['check-attr', '--all', '-z'], ['check-attr', '--source=HEAD', '--stdin', 'filter'],
      ['diff-tree', '-r', '-z', 'a', 'b'], ['diff-tree', '-z', '--no-renames', 'a', 'b'], ['diff-tree', '-r', '--no-renames', 'a', 'b'],
      ['diff-tree', '-r', '-z', '--no-renames', '-p', 'a', 'b'], ['diff-tree', '-r', '-z', '--no-renames', '--textconv', 'a', 'b'],
      ['diff-tree', '-r', '-z', '--no-renames', '--ext-diff', 'a', 'b'], ['diff-tree', '-r', '-z', '--no-renames', '-M', 'a', 'b'],
      ['diff-tree', '-r', '-z', '--no-renames', '--find-renames', 'a', 'b'], ['diff-tree', '-r', '-z', '--no-renames', '--stat', 'a', 'b'],
      ['diff-tree', '-r', '-z', '--no-renames', '--stdin'], ['diff-tree', '-r', '-z', '--no-renames', '-C', 'a', 'b'],
      ['cat-file', '--filters', 'HEAD:a'], ['cat-file', '--textconv', 'HEAD:a'], ['cat-file', '--batch-command'],
      ['cat-file', '--batch-all-objects', '--batch'], ['cat-file', '--batch', '--filters'], ['cat-file', '--batch', '--textconv'],
      ['cat-file', '--batch=%(objectname)'], ['cat-file', '--batch-check'],
    ]) expect(() => assertHardenedGitArgs(args)).toThrow(/hardened git refuses/);
  });
});

describe('hardenedGitStream', () => {
  test('streams output, reports a NUL ending, and refuses before spawning', async () => {
    const root = repo({ 'a.md': 'a\n' });
    const chunks: Buffer[] = [];
    const result = await hardenedGitStream(root, ['ls-files', '-z'], { timeoutMs: 10_000, onChunk: chunk => { chunks.push(chunk); } });
    expect(result).toEqual({ ok: true, exitCode: 0, signal: null, bytes: 5, endsWithNul: true });
    expect(Buffer.concat(chunks).toString()).toBe('a.md\0');
    const lined = await hardenedGitStream(root, ['ls-files'], { timeoutMs: 10_000 });
    expect(lined.ok && lined.endsWithNul).toBe(false);
    expect(hardenedStreamComplete(lined)).toBe(false);
    await expect(hardenedGitStream(root, ['status', '--porcelain'], { timeoutMs: 10_000 })).rejects.toThrow(/hardened git refuses/);
  });

  test('a non-zero exit, a byte cap, a timeout and an external signal are each reported as such', async () => {
    const root = repo({ 'a.md': 'a\n' });
    expect(await hardenedGitStream(root, ['ls-tree', '-r', '-z', 'no-such-ref'], { timeoutMs: 10_000 })).toEqual({ ok: false, reason: 'exit', status: 128 });
    expect(await hardenedGitStream(root, ['ls-files', '-z'], { timeoutMs: 10_000, maxBytes: 2 })).toEqual({ ok: false, reason: 'too_large' });
    async function* forever(): AsyncGenerator<Buffer> { yield Buffer.from(`${blobOid('a\n')}\n`); await new Promise(() => {}); }
    expect(await hardenedGitStream(root, ['cat-file', '--batch'], { timeoutMs: 300, stdin: forever() })).toEqual({ ok: false, reason: 'timeout' });
    let answered = false;
    const signalled = hardenedGitStream(root, ['cat-file', '--batch'], { timeoutMs: 20_000, stdin: forever(), onChunk: () => { answered = true; } });
    while (!answered) await new Promise(resolve => setTimeout(resolve, 10));
    execFileSync('pkill', ['-TERM', '-f', `${root} cat-file --batch`]);
    expect(await signalled).toEqual({ ok: false, reason: 'signal', signal: 'SIGTERM' });
  });

  test('a throw from onChunk or from the stdin iterable rejects instead of reporting success', async () => {
    const root = repo({ 'a.md': 'a\n' });
    await expect(hardenedGitStream(root, ['ls-files', '-z'], { timeoutMs: 10_000, onChunk: () => { throw new Error('consumer broke'); } })).rejects.toThrow('consumer broke');
    async function* broken(): AsyncGenerator<Buffer> { yield Buffer.from(`${blobOid('a\n')}\n`); throw new Error('input broke'); }
    await expect(hardenedGitStream(root, ['cat-file', '--batch'], { timeoutMs: 10_000, stdin: broken() })).rejects.toThrow('input broke');
  });
});

describe('NUL records and completeness', () => {
  test('records split across chunks are reassembled; a trailing partial record is not a boundary', () => {
    const splitter = new NulRecordSplitter();
    expect(splitter.atRecordBoundary).toBe(true);
    expect(splitter.push(Buffer.from('ab')).map(String)).toEqual([]);
    expect(splitter.atRecordBoundary).toBe(false);
    expect(splitter.push(Buffer.from('c\0d')).map(String)).toEqual(['abc']);
    expect(splitter.push(Buffer.from('\0\0e\0')).map(String)).toEqual(['d', '', 'e']);
    expect(splitter.atRecordBoundary).toBe(true);
    expect(splitter.push(Buffer.from('tail')).map(String)).toEqual([]);
    expect(splitter.atRecordBoundary).toBe(false);
  });

  test('complete only on exit 0 with a NUL ending or no output', () => {
    const cases: Array<[HardenedGitStreamResult, boolean]> = [
      [{ ok: true, exitCode: 0, signal: null, bytes: 0, endsWithNul: false }, true],
      [{ ok: true, exitCode: 0, signal: null, bytes: 9, endsWithNul: true }, true],
      [{ ok: true, exitCode: 0, signal: null, bytes: 9, endsWithNul: false }, false],
      [{ ok: false, reason: 'exit', status: 1 }, false], [{ ok: false, reason: 'signal', signal: 'SIGTERM' }, false],
      [{ ok: false, reason: 'timeout' }, false], [{ ok: false, reason: 'too_large' }, false], [{ ok: false, reason: 'unavailable' }, false],
    ];
    for (const [result, complete] of cases) expect(hardenedStreamComplete(result)).toBe(complete);
  });

  test('readTreeLevel throws on a truncated stream, a signal and a non-zero exit', async () => {
    const root = repo({ 'a.md': 'a\n' });
    const record = `100644 blob ${blobOid('a\n')}\ta.md`;
    __setSyncGitStreamForTests(async (_root, _args, opts) => { opts.onChunk?.(Buffer.from(`${record}\0${record.slice(0, 20)}`)); return { ok: true, exitCode: 0, signal: null, bytes: 99, endsWithNul: false }; });
    await expect(readTreeLevel(root, 'HEAD', '')).rejects.toBeInstanceOf(SyncTreeReadIncomplete);
    __setSyncGitStreamForTests(async (_root, _args, opts) => { opts.onChunk?.(Buffer.from(`${record}\0`)); return { ok: false, reason: 'signal', signal: 'SIGKILL' }; });
    await expect(readTreeLevel(root, 'HEAD', '')).rejects.toMatchObject({ code: 'reconcile_read_incomplete' });
    __setSyncGitStreamForTests();
    await expect(readTreeLevel(root, 'no-such-ref', '')).rejects.toMatchObject({ code: 'reconcile_read_incomplete', name: 'SyncTreeReadIncomplete' });
    await expect(readIndexLevel(tempDir('plain'))).rejects.toBeInstanceOf(SyncTreeReadIncomplete);
  });
});

describe('level reads', () => {
  test('readTreeLevel lists blobs under a scope, keeping symlinks and gitlinks with their mode', async () => {
    const root = repo({ 'top.md': 'top\n' }, r => {
      execFileSync('mkdir', ['-p', join(r, 'notes', 'deep')]);
      writeFileSync(join(r, 'notes', 'one.md'), 'one\n');
      writeFileSync(join(r, 'notes', 'deep', 'two.md'), 'two\n');
      symlinkSync('one.md', join(r, 'notes', 'link.md'));
    });
    const gitlink = 'f'.repeat(40);
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${gitlink},notes/sub`);
    git(root, 'commit', '-qm', 'gitlink');
    const whole = await readTreeLevel(root, 'HEAD', '');
    expect([...whole.keys()].sort()).toEqual(['notes/deep/two.md', 'notes/link.md', 'notes/one.md', 'notes/sub', 'top.md']);
    expect(whole.get('top.md')).toEqual({ mode: '100644', oid: blobOid('top\n') });
    expect(whole.get('notes/link.md')?.mode).toBe('120000');
    expect(whole.get('notes/sub')).toEqual({ mode: '160000', oid: gitlink });
    expect([...(await readTreeLevel(root, 'HEAD', 'notes/deep')).keys()]).toEqual(['notes/deep/two.md']);
    expect((await readTreeLevel(root, 'HEAD', 'missing')).size).toBe(0);
  });

  test('readIndexLevel reads the index only and keeps a conflicted path\'s non-zero stage', async () => {
    const root = repo({ 'c.md': 'base\n', 'k.md': 'keep\n' });
    git(root, 'checkout', '-qb', 'side');
    writeFileSync(join(root, 'c.md'), 'side\n');
    git(root, 'commit', '-qam', 'side');
    git(root, 'checkout', '-q', '-');
    writeFileSync(join(root, 'c.md'), 'main\n');
    git(root, 'commit', '-qam', 'main');
    try { git(root, 'merge', '-q', 'side'); } catch {}
    writeFileSync(join(root, 'k.md'), 'edited on disk only\n');
    const index = await readIndexLevel(root);
    expect(index.get('c.md')?.stage).toBe(3);
    expect(index.get('k.md')).toEqual({ mode: '100644', oid: blobOid('keep\n'), stage: 0 });
  });

  test('readRenameHints pairs a delete and an add only when their blob is unique', async () => {
    const root = repo({ 'a.md': 'alpha\n', 'twin1.md': 'twin\n', 'twin2.md': 'twin\n', 'x.md': 'x\n' });
    const from = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'mv', 'a.md', 'b.md');
    git(root, 'mv', 'twin1.md', 'twin3.md');
    git(root, 'mv', 'twin2.md', 'twin4.md');
    writeFileSync(join(root, 'x.md'), 'x changed\n');
    git(root, 'commit', '-qam', 'renames');
    expect(await readRenameHints(root, from, 'HEAD')).toEqual([{ from: 'a.md', to: 'b.md', oid: blobOid('alpha\n') }]);
  });

  test('readBlobs reads contents, skips oversized and missing objects, and bounds the total', async () => {
    const big = 'b'.repeat(5000);
    const root = repo({ 'small.md': 'small\n', 'big.md': big, 'other.md': 'other\n' });
    const missing = '0123456789abcdef0123456789abcdef01234567';
    const blobs = await readBlobs(root, [blobOid(big), blobOid('small\n'), missing, blobOid('other\n')], 1024);
    expect([...blobs.keys()].sort()).toEqual([blobOid('other\n'), blobOid('small\n')].sort());
    expect(blobs.get(blobOid('small\n'))?.toString()).toBe('small\n');
    const bounded = await readBlobs(root, [blobOid('small\n'), blobOid('other\n')], 1024, 8);
    expect([...bounded.keys()]).toEqual([blobOid('small\n')]);
    await expect(readBlobs(root, ['HEAD:small.md'], 1024)).rejects.toThrow(/full hexadecimal/);
    await expect(readBlobs(join(root, 'nowhere'), [blobOid('small\n')], 1024)).rejects.toBeInstanceOf(SyncTreeReadIncomplete);
  });
});

describe('probeDirtiness verdicts', () => {
  test('clean, modified, deleted, untracked and each staged shape', async () => {
    const root = repo({ 'clean.md': 'same\n', 'mod.md': 'old\n', 'gone.md': 'g\n', 'staged.md': 's\n', 'cached.md': 'c\n' });
    writeFileSync(join(root, 'mod.md'), 'new\n');
    unlinkSync(join(root, 'gone.md'));
    writeFileSync(join(root, 'loose.md'), 'loose\n');
    writeFileSync(join(root, 'staged.md'), 'staged edit\n');
    git(root, 'add', 'staged.md');
    writeFileSync(join(root, 'added.md'), 'added\n');
    git(root, 'add', 'added.md');
    git(root, 'rm', '-q', '--cached', 'cached.md');
    const result = await probe(root, ['clean.md', 'mod.md', 'gone.md', 'loose.md', 'staged.md', 'added.md', 'cached.md'], 2);
    expect(result.get('clean.md')).toEqual({ dp: 'clean', rawOid: blobOid('same\n'), rawSha256: sha256('same\n') });
    expect(result.get('mod.md')).toEqual({ dp: 'modified', rawOid: blobOid('new\n'), rawSha256: sha256('new\n') });
    expect(result.get('gone.md')).toEqual({ dp: 'deleted', rawOid: null, rawSha256: null });
    expect(result.get('loose.md')).toEqual({ dp: 'untracked', rawOid: blobOid('loose\n'), rawSha256: sha256('loose\n') });
    expect(result.get('staged.md')).toEqual({ dp: 'staged', rawOid: blobOid('staged edit\n'), rawSha256: sha256('staged edit\n') });
    expect(result.get('added.md')).toEqual({ dp: 'staged', rawOid: blobOid('added\n'), rawSha256: sha256('added\n') });
    expect(result.get('cached.md')).toEqual({ dp: 'staged', rawOid: blobOid('c\n'), rawSha256: sha256('c\n') });
  });

  test('CRLF under a text attribute is clean_eol; the same bytes with no attribute are unknown', async () => {
    const root = repo({ 'eol.md': 'a\nb\n', 'plain.md': 'a\nb\n', 'eolmod.md': 'a\n' }, r => writeFileSync(join(r, '.gitattributes'), 'eol.md text\neolmod.md eol=crlf\n'));
    writeFileSync(join(root, 'eol.md'), 'a\r\nb\r\n');
    writeFileSync(join(root, 'plain.md'), 'a\r\nb\r\n');
    writeFileSync(join(root, 'eolmod.md'), 'z\r\n');
    const result = await probe(root, ['eol.md', 'plain.md', 'eolmod.md']);
    expect(result.get('eol.md')).toEqual({ dp: 'clean_eol', rawOid: blobOid('a\r\nb\r\n'), rawSha256: sha256('a\r\nb\r\n') });
    expect(result.get('plain.md')?.dp).toBe('unknown');
    expect(result.get('eolmod.md')?.dp).toBe('modified');
  });

  test('an LFS pointer with matching smudged bytes is clean_lfs; other bytes are modified', async () => {
    const content = Buffer.from('large binary payload\n'.repeat(50));
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(content)}\nsize ${content.length}\n`;
    const root = repo({ 'big.bin': pointer, 'other.bin': pointer }, r => writeFileSync(join(r, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n'));
    writeFileSync(join(root, 'big.bin'), content);
    writeFileSync(join(root, 'other.bin'), 'not the payload\n');
    const result = await probe(root, ['big.bin', 'other.bin']);
    expect(result.get('big.bin')).toEqual({ dp: 'clean_lfs', rawOid: blobOid(content), rawSha256: sha256(content) });
    expect(result.get('other.bin')?.dp).toBe('modified');
  });

  test('symlinks, executable-bit-only changes, custom filters, encodings and Git failures are unknown', async () => {
    const root = repo({ 'target.md': 't\n', 'exec.md': 'e\n', 'custom.md': 'c\n', 'enc.md': 'w\n', 'swapped.md': 's\n', 'quiet.md': 'q\n' },
      r => symlinkSync('target.md', join(r, 'link.md')));
    writeFileSync(join(root, '.gitattributes'), 'custom.md filter=custom\nenc.md working-tree-encoding=UTF-16\n');
    chmodSync(join(root, 'exec.md'), 0o755);
    writeFileSync(join(root, 'custom.md'), 'c changed\n');
    writeFileSync(join(root, 'enc.md'), 'w changed\n');
    unlinkSync(join(root, 'swapped.md'));
    symlinkSync('target.md', join(root, 'swapped.md'));
    const result = await probe(root, ['link.md', 'exec.md', 'custom.md', 'enc.md', 'swapped.md']);
    for (const path of ['link.md', 'exec.md', 'custom.md', 'enc.md', 'swapped.md']) expect([path, result.get(path)?.dp]).toEqual([path, 'unknown']);
    const tree = await readTreeLevel(root, 'HEAD', '');
    const index = await readIndexLevel(root);
    __setSyncGitStreamForTests((r, args, opts) => args[0] === 'hash-object' ? Promise.resolve({ ok: false, reason: 'exit', status: 128 }) : hardenedGitStream(r, args, opts));
    const failed = await probeDirtiness(root, root, ['quiet.md', 'target.md'], tree, index);
    expect(failed.get('quiet.md')).toEqual({ dp: 'unknown', rawOid: null, rawSha256: sha256('q\n') });
    expect(failed.get('target.md')?.dp).toBe('unknown');
  });

  test('a source root below the Git root reads the right files', async () => {
    const root = repo({}, r => { execFileSync('mkdir', ['-p', join(r, 'brain')]); writeFileSync(join(r, 'brain', 'p.md'), 'p\n'); });
    writeFileSync(join(root, 'brain', 'p.md'), 'p edited\n');
    const tree = await readTreeLevel(root, 'HEAD', 'brain');
    const result = await probeDirtiness(join(root, 'brain'), root, ['brain/p.md'], tree, await readIndexLevel(root));
    expect(result.get('brain/p.md')).toEqual({ dp: 'modified', rawOid: blobOid('p edited\n'), rawSha256: sha256('p edited\n') });
  });
});

describe('forced probe: repository filters and textconv never run (design probe 28)', () => {
  test('1,000 passes of every read leave no marker, while porcelain on the same checkout leaves one', async () => {
    const root = repo({ 'a.md': 'alpha\n', 'b.md': 'bravo\n', 'c.md': 'charlie\r\n' });
    const from = git(root, 'rev-parse', 'HEAD').trim();
    git(root, 'mv', 'a.md', 'renamed.md');
    git(root, 'commit', '-qm', 'rename');
    const markers = tempDir('markers');
    const script = (name: string, tail: string) => {
      const path = join(markers, `${name}.sh`);
      writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, `${name}-ran`)}'\n${tail}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    git(root, 'config', 'filter.x.clean', script('clean', 'cat'));
    git(root, 'config', 'filter.x.process', script('process', 'exit 1'));
    git(root, 'config', 'diff.x.textconv', script('textconv', 'cat "$1"'));
    writeFileSync(join(root, '.gitattributes'), '* filter=x diff=x\n');
    writeFileSync(join(root, 'b.md'), 'bravo edited\n');
    writeFileSync(join(root, 'c.md'), 'charlie\n');
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(root, 'renamed.md'), later, later);
    const ran = () => ['clean', 'process', 'textconv'].filter(name => existsSync(join(markers, `${name}-ran`)));
    const paths = ['renamed.md', 'b.md', 'c.md', '.gitattributes', 'missing.md'];
    const blobs = [blobOid('alpha\n'), blobOid('bravo\n')];
    const pass = async () => {
      const tree = await readTreeLevel(root, 'HEAD', '');
      const index = await readIndexLevel(root);
      const [hints, read, verdicts] = await Promise.all([readRenameHints(root, from, 'HEAD'), readBlobs(root, blobs, 1024), probeDirtiness(root, root, paths, tree, index)]);
      return { hints, read, verdicts };
    };
    const first = await pass();
    expect(first.hints).toEqual([{ from: 'a.md', to: 'renamed.md', oid: blobOid('alpha\n') }]);
    expect(first.read.size).toBe(2);
    expect(Object.fromEntries([...first.verdicts].map(([path, probe]) => [path, probe.dp])))
      .toEqual({ 'renamed.md': 'clean', 'b.md': 'unknown', 'c.md': 'unknown', '.gitattributes': 'untracked', 'missing.md': 'untracked' });
    for (let done = 1; done < 1000; done += 8) await Promise.all(Array.from({ length: Math.min(8, 1000 - done) }, pass));
    expect(ran()).toEqual([]);

    try { execFileSync('git', ['-C', root, 'status', '--porcelain'], { env: GIT_ENV, stdio: 'ignore' }); } catch {}
    expect(ran().some(name => name === 'clean' || name === 'process')).toBe(true);
    try { execFileSync('git', ['-C', root, '-c', 'filter.x.process=', 'diff', '--', 'b.md'], { env: GIT_ENV, stdio: 'ignore' }); } catch {}
    expect(ran()).toContain('textconv');
  }, 60_000);
});

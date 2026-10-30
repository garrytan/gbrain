/**
 * GBRA-133 wave 4: a fresh process (a CLI \x60gbrain sync\x60, a sync job) had no vouched clean probes (#7338 keeps them in the
 * process), so its pass read and hashed every candidate file again: about 250 ms per pass at 10k pages, linear in the brain.
 * With \x60persist\x60 (\x60sync.level_reuse\x60) a new process starts from the probes the last one saved under this machine's gbrain
 * home, each still checked against the path's lstat key and tree entry; anything doubtful in the file is ignored whole, and
 * \x60verify\x60 (the level-reuse oracle) still reads every reused path and reports the first that differs.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetCleanProbesForTests, cleanProbeFile, probeDirtiness, readIndexLevel, readTreeLevel } from '../src/core/persistence/sync-git-stream.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
afterAll(() => { __resetCleanProbesForTests(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const blobOid = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const RACY_WAIT_MS = 2_100;

function temp(prefix: string): string { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }

function repo(files: Record<string, string>): string {
  const root = temp('gbrain-probe-persist-');
  git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=writer@example.invalid', '-c', 'user.name=Writer Example', 'commit', '-qm', 'init');
  return root;
}

/** Runs \x60fn\x60 with the Git directory moved away, so a path probed again (attributes, raw OIDs) reads \x60unknown\x60. */
async function withoutGit<T>(root: string, fn: () => Promise<T>): Promise<T> {
  renameSync(join(root, '.git'), join(root, '.git-away'));
  try { return await fn(); } finally { renameSync(join(root, '.git-away'), join(root, '.git')); }
}

/** A repository past the racy window, its levels, and a probe run as a new process would (no probes in memory). */
async function vouchedRepo(files: Record<string, string>) {
  const root = repo(files);
  const tree = await readTreeLevel(root, 'HEAD', ''), index = await readIndexLevel(root);
  await sleep(RACY_WAIT_MS);
  const paths = Object.keys(files);
  const fresh = (opts: Parameters<typeof probeDirtiness>[5] = {}) => { __resetCleanProbesForTests(); return probeDirtiness(root, root, paths, tree, index, opts); };
  const real = realpathSync.native(root);
  return { root, tree, index, paths, fresh, file: cleanProbeFile(`${real}\0${real}`) };
}

describe('GBRA-133 wave 4: vouched clean probes outlive the process with persist', () => {
  test('a new process reuses the probes the last one saved, without reading or hashing the files', () => withEnv({ GBRAIN_HOME: temp('gbrain-home-') }, async () => {
    const r = await vouchedRepo({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' });
    expect((await r.fresh({ persist: true })).get('a.md')).toEqual({ dp: 'clean', rawOid: blobOid('alpha\n'), rawSha256: sha256('alpha\n') });
    expect(existsSync(r.file)).toBe(true);
    expect((statSync(r.file).mode & 0o777)).toBe(0o600);
    const again = await withoutGit(r.root, () => r.fresh({ persist: true }));
    expect(again.get('a.md')).toEqual({ dp: 'clean', rawOid: blobOid('alpha\n'), rawSha256: sha256('alpha\n') });
    expect(again.get('b.md')).toEqual({ dp: 'clean', rawOid: blobOid('bravo\n'), rawSha256: sha256('bravo\n') });
  }), 30_000);

  test('without persist a new process neither reads nor writes the file', () => withEnv({ GBRAIN_HOME: temp('gbrain-home-') }, async () => {
    const r = await vouchedRepo({ 'a.md': 'alpha\n' });
    expect((await r.fresh()).get('a.md')?.dp).toBe('clean');
    expect(existsSync(r.file)).toBe(false);
    expect((await r.fresh({ persist: true })).get('a.md')?.dp).toBe('clean');
    expect((await withoutGit(r.root, () => r.fresh())).get('a.md')?.dp).toBe('unknown');
  }), 30_000);

  test('a file with one malformed entry, or saved for another root, is ignored whole', () => withEnv({ GBRAIN_HOME: temp('gbrain-home-') }, async () => {
    const r = await vouchedRepo({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' });
    await r.fresh({ persist: true });
    const saved = JSON.parse(readFileSync(r.file, 'utf8')) as { v: number; key: string; entries: Record<string, string> };
    writeFileSync(r.file, JSON.stringify({ ...saved, entries: { ...saved.entries, 'b.md': 'not a probe' } }));
    expect((await withoutGit(r.root, () => r.fresh({ persist: true }))).get('a.md')?.dp).toBe('unknown');
    writeFileSync(r.file, JSON.stringify({ ...saved, key: 'another root' }));
    expect((await withoutGit(r.root, () => r.fresh({ persist: true }))).get('a.md')?.dp).toBe('unknown');
    writeFileSync(r.file, '{"v":1,');
    expect((await withoutGit(r.root, () => r.fresh({ persist: true }))).get('a.md')?.dp).toBe('unknown');
  }), 30_000);

  test('a same-inode, same-size edit with a restored mtime after the save is a change', () => withEnv({ GBRAIN_HOME: temp('gbrain-home-') }, async () => {
    const root = repo({ 'a.md': 'alpha one\n' });
    const past = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(join(root, 'a.md'), past, past);
    const tree = await readTreeLevel(root, 'HEAD', ''), index = await readIndexLevel(root);
    await sleep(RACY_WAIT_MS);
    __resetCleanProbesForTests();
    expect((await probeDirtiness(root, root, ['a.md'], tree, index, { persist: true })).get('a.md')?.dp).toBe('clean');
    const fd = openSync(join(root, 'a.md'), 'r+');
    try { writeSync(fd, 'alpha two\n', 0); } finally { closeSync(fd); }
    utimesSync(join(root, 'a.md'), past, past);
    __resetCleanProbesForTests();
    expect((await probeDirtiness(root, root, ['a.md'], tree, index, { persist: true })).get('a.md')).toEqual({ dp: 'modified', rawOid: blobOid('alpha two\n'), rawSha256: sha256('alpha two\n') });
  }), 30_000);

  test('verify reads every reused probe and names the first that differs (a saved hash that is not the file)', () => withEnv({ GBRAIN_HOME: temp('gbrain-home-') }, async () => {
    const r = await vouchedRepo({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' });
    await r.fresh({ persist: true });
    const checks: Array<[number, string | null]> = [];
    const verify = (reused: number, differs: string | null) => { checks.push([reused, differs]); };
    expect((await r.fresh({ persist: true, verify })).get('a.md')?.dp).toBe('clean');
    expect(checks).toEqual([[2, null]]);
    const saved = JSON.parse(readFileSync(r.file, 'utf8')) as { v: number; key: string; entries: Record<string, string> };
    const forged = saved.entries['a.md']!.replace(/[0-9a-f]{64}$/, sha256('not alpha\n'));
    writeFileSync(r.file, JSON.stringify({ ...saved, entries: { ...saved.entries, 'a.md': forged } }));
    checks.length = 0;
    expect((await r.fresh({ persist: true, verify })).get('a.md')).toEqual({ dp: 'clean', rawOid: blobOid('alpha\n'), rawSha256: sha256('alpha\n') });
    expect(checks.length).toBe(1);
    expect(checks[0]![0]).toBe(2);
    expect(checks[0]![1]).toContain('a.md');
  }), 30_000);
});

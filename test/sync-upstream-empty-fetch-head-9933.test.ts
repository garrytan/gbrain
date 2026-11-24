/**
 * #9933: a fetch that fails (remote gone) leaves FETCH_HEAD empty with a fresh
 * mtime. That is no observation of the upstream, so upstream_checked_at must
 * keep the last real one (the tracking ref's reflog) instead of reading fresh.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeUpstream, recordUpstreamObservation } from '../src/core/sync-upstream.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const HOUR = 3_600_000;
let dir = '';
let remote = '';
let work = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-upstream-9933-'));
  remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'a.md'), 'a\n');
  git(seed, 'add', 'a.md');
  git(seed, 'commit', '-q', '-m', 'one');
  git(seed, 'push', '-q', remote, 'main');
  execFileSync('git', ['clone', '-q', remote, work]);
  writeFileSync(join(seed, 'b.md'), 'b\n');
  git(seed, 'add', 'b.md');
  git(seed, 'commit', '-q', '-m', 'two');
  git(seed, 'push', '-q', remote, 'main');
  git(work, 'fetch', '-q');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const age = (files: string[], ms: number) => { const t = new Date(Date.now() - ms); for (const f of files) utimesSync(f, t, t); };

describe('upstream observation after a failed fetch (#9933)', () => {
  test('a successful fetch of an unchanged commit counts as a fresh observation', async () => {
    const fetchHead = join(work, '.git', 'FETCH_HEAD');
    const reflog = join(work, '.git', 'logs', 'refs', 'remotes', 'origin', 'main');
    age([fetchHead, reflog], 48 * HOUR);
    git(work, 'fetch', '-q');
    const seen = await observeUpstream(work, null);
    expect(Date.now() - seen!.checkedAt.getTime()).toBeLessThan(HOUR);
  });

  test('an empty FETCH_HEAD left by a failed fetch falls back to the reflog time', async () => {
    const fetchHead = join(work, '.git', 'FETCH_HEAD');
    const reflog = join(work, '.git', 'logs', 'refs', 'remotes', 'origin', 'main');
    age([fetchHead, reflog], 48 * HOUR);
    renameSync(remote, `${remote}.gone`);
    try {
      expect(spawnSync('git', ['-C', work, 'fetch', '-q'], { stdio: 'ignore' }).status).not.toBe(0);
    } finally {
      renameSync(`${remote}.gone`, remote);
    }
    expect(statSync(fetchHead).size).toBe(0);
    const seen = await observeUpstream(work, null);
    expect(seen).not.toBeNull();
    expect(Date.now() - seen!.checkedAt.getTime()).toBeGreaterThan(47 * HOUR);
  });

  test('with both files empty there is no observation', async () => {
    const fetchHead = join(work, '.git', 'FETCH_HEAD');
    const reflog = join(work, '.git', 'logs', 'refs', 'remotes', 'origin', 'main');
    writeFileSync(fetchHead, '');
    writeFileSync(reflog, '');
    expect(await observeUpstream(work, null)).toBeNull();
  });
});

describe('a recorded observation never moves back for the same upstream commit (#9933)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a failed fetch after a recorded no-change fetch keeps the newer check time', async () => {
    const fetchHead = join(work, '.git', 'FETCH_HEAD');
    const reflog = join(work, '.git', 'logs', 'refs', 'remotes', 'origin', 'main');
    await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('source-a', 'source-a', $1)", [work]);
    const checkedAt = async () => (await engine.executeRaw<{ upstream_checked_at: Date }>(
      "SELECT upstream_checked_at FROM sources WHERE id = 'source-a'"))[0]!.upstream_checked_at;
    const seed = join(dir, 'seed');
    writeFileSync(join(seed, 'c.md'), 'c\n');
    git(seed, 'add', 'c.md');
    git(seed, 'commit', '-q', '-m', 'three');
    git(seed, 'push', '-q', remote, 'main');
    git(work, 'fetch', '-q');
    expect(statSync(reflog).size).toBeGreaterThan(0);
    age([fetchHead, reflog], 48 * HOUR);
    git(work, 'fetch', '-q');
    await recordUpstreamObservation(engine, 'source-a');
    const recorded = new Date(await checkedAt()).getTime();
    expect(Date.now() - recorded).toBeLessThan(HOUR);
    renameSync(remote, `${remote}.gone`);
    try {
      expect(spawnSync('git', ['-C', work, 'fetch', '-q'], { stdio: 'ignore' }).status).not.toBe(0);
    } finally {
      renameSync(`${remote}.gone`, remote);
    }
    expect(statSync(fetchHead).size).toBe(0);
    await recordUpstreamObservation(engine, 'source-a');
    expect(new Date(await checkedAt()).getTime()).toBe(recorded);
  }, 60_000);
});

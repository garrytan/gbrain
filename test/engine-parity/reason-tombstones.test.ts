/**
 * BrainEngine parity — the purged change-reason members (`insertReasonPurgeTombstones`, `readReasonPurgeTombstones`)
 * that `src/core/facts/purge-reasons.ts`, `src/core/reason-trailers.ts`, `src/core/repair/purged-change-reasons.ts`
 * and `src/core/page-state/versions.ts` call instead of raw SQL, so a purge's tombstones hold on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a write stores each (commit, path) pair once and returns how many it added; a pair written again adds
 *    nothing; no pairs add nothing; an unknown source throws and stores nothing. A read returns the source's pairs
 *    (never another source's), or only the asked pair when it is stored. A sync's reason scan drops the reason of a
 *    tombstoned pair and keeps the others.
 *    A purge advances the source's purge epoch (`bumpSourcePurgeEpoch`, through `bumpPurgeEpoch`), so the next
 *    cached reason scan of the same range scans again and drops the reason the purge tombstoned.
 *  - Regression: an engine that forgets a tombstone (a later sync then stamps the purged reason again), counts a
 *    duplicate as added, leaks another source's pairs into the scan, or refuses the read (the Rust engine refused it
 *    as raw SQL, which stopped every incremental sync). An engine whose purge epoch stays put (the Rust engine read
 *    it as 0 always), so a sync after a purge reuses the scan cached before it and stamps the purged reason.
 *  - Why existing coverage misses it: the reason-trailer tests run on PGLite and Postgres only.
 *  - Seam: none. Real engines, typed members only, and a real temp Git repository for the scan.
 */
import { afterAll, describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bumpPurgeEpoch } from '../../src/core/belief/purge.ts';
import { cachedSyncReasonScan, clearReasonScanCache, scanSyncReasons } from '../../src/core/reason-trailers.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const home = mkdtempSync(join(tmpdir(), 'gbrain-reason-tombstones-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with one commit that changes two notes, each with its own reason trailer. */
function repoWithReasons(): { root: string; sha: string } {
  const root = mkdtempSync(join(home, 'repo-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes/a.md'), '# A\n');
  writeFileSync(join(root, 'notes/b.md'), '# B\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '-m', 'notes',
    '-m', 'gbrain-reason: notes/a.md: Rewrote the intro.\ngbrain-reason: notes/b.md: Added the second note.');
  return { root, sha: git(root, 'rev-parse', 'HEAD') };
}

/** Writes (commit, path) pairs through the typed member, which takes the commits and the paths as two parallel lists. */
const writeTombstones = (engine: BrainEngine, sourceId: string, rows: Array<{ commit_sha: string; path: string }>): Promise<number> =>
  engine.insertReasonPurgeTombstones(sourceId, rows.map(r => r.commit_sha), rows.map(r => r.path));

const pairs = (rows: Array<{ commit_sha: string; path: string }>) =>
  sorted(rows.map(r => ({ commit_sha: r.commit_sha, path: r.path })), r => `${r.commit_sha}\0${r.path}`);

describe('engine parity: purged change-reason tombstones', () => {
  parityTest('insertReasonPurgeTombstones stores each pair once and readReasonPurgeTombstones reads them back by source or pair', { methods: ['insertReasonPurgeTombstones', 'readReasonPurgeTombstones'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
    await createSource(engine, backend, 'repo-2', {}, '/srv/brain/repo-2');
    const added = await writeTombstones(engine, 'repo', [
      { commit_sha: 'bbbb222', path: 'notes/a.md' },
      { commit_sha: 'aaaa111', path: 'notes/b.md' },
      { commit_sha: 'bbbb222', path: 'notes/a.md' },
    ]);
    const again = await writeTombstones(engine, 'repo', [{ commit_sha: 'aaaa111', path: 'notes/b.md' }, { commit_sha: 'cccc333', path: 'notes/c.md' }]);
    const none = await writeTombstones(engine, 'repo', []);
    const other = await writeTombstones(engine, 'repo-2', [{ commit_sha: 'dddd444', path: 'notes/d.md' }]);
    let unknown: string;
    try {
      await writeTombstones(engine, 'missing', [{ commit_sha: 'eeee555', path: 'notes/e.md' }]);
      unknown = 'stored';
    } catch {
      unknown = 'threw';
    }
    const result = {
      added, again, none, other, unknown,
      all: pairs(await engine.readReasonPurgeTombstones('repo')),
      second: pairs(await engine.readReasonPurgeTombstones('repo-2')),
      missing: pairs(await engine.readReasonPurgeTombstones('missing')),
      hit: pairs(await engine.readReasonPurgeTombstones('repo', { commit_sha: 'bbbb222', path: 'notes/a.md' })),
      miss: pairs(await engine.readReasonPurgeTombstones('repo', { commit_sha: 'bbbb222', path: 'notes/b.md' })),
      elsewhere: pairs(await engine.readReasonPurgeTombstones('repo', { commit_sha: 'dddd444', path: 'notes/d.md' })),
    };
    expect(result).toEqual({
      added: 2, again: 1, none: 0, other: 1, unknown: 'threw',
      all: [{ commit_sha: 'aaaa111', path: 'notes/b.md' }, { commit_sha: 'bbbb222', path: 'notes/a.md' }, { commit_sha: 'cccc333', path: 'notes/c.md' }],
      second: [{ commit_sha: 'dddd444', path: 'notes/d.md' }],
      missing: [],
      hit: [{ commit_sha: 'bbbb222', path: 'notes/a.md' }],
      miss: [],
      elsewhere: [],
    });
    return result;
  });

  parityTest('a sync reason scan drops the reason of a tombstoned (commit, path) and keeps the others', { methods: ['insertReasonPurgeTombstones', 'readReasonPurgeTombstones'] }, async (engine, backend) => {
    const { root, sha } = repoWithReasons();
    await createSource(engine, backend, 'repo', {}, root);
    await createSource(engine, backend, 'repo-2', {}, '/srv/brain/repo-2');
    await writeTombstones(engine, 'repo', [{ commit_sha: sha, path: 'notes/a.md' }]);
    await writeTombstones(engine, 'repo-2', [{ commit_sha: sha, path: 'notes/b.md' }]);
    const scan = await scanSyncReasons(engine, { sourceId: 'repo', sourceRoot: root, from: null, to: sha });
    const reasons = Object.fromEntries([...(scan?.byPath ?? new Map()).entries()].map(([path, d]) => [path, d.reason]));
    const result = { status: scan?.status ?? null, reasons };
    expect(result).toEqual({ status: 'complete', reasons: { 'notes/a.md': null, 'notes/b.md': 'Added the second note.' } });
    return result;
  });

  parityTest('a purge between two syncs advances the purge epoch, so the second sync scans again and drops the purged reason', {
    methods: ['bumpSourcePurgeEpoch', 'readSourcePurgeEpoch', 'insertReasonPurgeTombstones', 'readReasonPurgeTombstones'],
  }, async (engine, backend) => {
    clearReasonScanCache();
    const { root, sha } = repoWithReasons();
    await createSource(engine, backend, 'repo', {}, root);
    const reasonsOf = async () => {
      const scan = await cachedSyncReasonScan(engine, { sourceId: 'repo', sourceRoot: root, from: null, to: sha });
      return Object.fromEntries([...(scan?.byPath ?? new Map()).entries()].map(([path, d]) => [path, d.reason]));
    };
    const epochOf = async (id: string) => { const epoch = await engine.readSourcePurgeEpoch(id); return epoch === null ? null : Number(epoch); };
    const before = { epoch: await epochOf('repo'), reasons: await reasonsOf() };
    // The purge's storage effects, as facts/purge.ts makes them in one transaction: the epoch bump, then the tombstone.
    const bumped = await bumpPurgeEpoch(engine, 'repo');
    await writeTombstones(engine, 'repo', [{ commit_sha: sha, path: 'notes/a.md' }]);
    const after = { epoch: await epochOf('repo'), reasons: await reasonsOf() };
    const result = { before, bumped, after, again: await bumpPurgeEpoch(engine, 'repo'), unknown: await bumpPurgeEpoch(engine, 'missing'), unknownEpoch: await epochOf('missing') };
    expect(result).toEqual({
      before: { epoch: 0, reasons: { 'notes/a.md': 'Rewrote the intro.', 'notes/b.md': 'Added the second note.' } },
      bumped: 1,
      after: { epoch: 1, reasons: { 'notes/a.md': null, 'notes/b.md': 'Added the second note.' } },
      again: 2, unknown: 0, unknownEpoch: null,
    });
    return result;
  });
});

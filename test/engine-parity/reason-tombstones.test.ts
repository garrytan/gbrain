/**
 * BrainEngine parity — the purged change-reason members (`writeReasonPurgeTombstones`, `readReasonPurgeTombstones`)
 * that `src/core/facts/purge-reasons.ts`, `src/core/reason-trailers.ts`, `src/core/repair/purged-change-reasons.ts`
 * and `src/core/page-state/versions.ts` call instead of raw SQL, so a purge's tombstones hold on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a write stores each (commit, path) pair once and returns how many it added; a pair written again adds
 *    nothing; no pairs add nothing; an unknown source throws and stores nothing. A read returns the source's pairs
 *    (never another source's), or only the asked pair when it is stored. A sync's reason scan drops the reason of a
 *    tombstoned pair and keeps the others.
 *  - Regression: an engine that forgets a tombstone (a later sync then stamps the purged reason again), counts a
 *    duplicate as added, leaks another source's pairs into the scan, or refuses the read (the Rust engine refused it
 *    as raw SQL, which stopped every incremental sync).
 *  - Why existing coverage misses it: the reason-trailer tests run on PGLite and Postgres only.
 *  - Seam: none. Real engines, typed members only, and a real temp Git repository for the scan.
 */
import { afterAll, describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSyncReasons } from '../../src/core/reason-trailers.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

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

const pairs = (rows: Array<{ commit_sha: string; path: string }>) =>
  sorted(rows.map(r => ({ commit_sha: r.commit_sha, path: r.path })), r => `${r.commit_sha}\0${r.path}`);

describe('engine parity: purged change-reason tombstones', () => {
  parityTest('writeReasonPurgeTombstones stores each pair once and readReasonPurgeTombstones reads them back by source or pair', { methods: ['writeReasonPurgeTombstones', 'readReasonPurgeTombstones'] }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', {}, '/srv/brain/repo');
    await createSource(engine, backend, 'repo-2', {}, '/srv/brain/repo-2');
    const added = await engine.writeReasonPurgeTombstones('repo', [
      { commit_sha: 'bbbb222', path: 'notes/a.md' },
      { commit_sha: 'aaaa111', path: 'notes/b.md' },
      { commit_sha: 'bbbb222', path: 'notes/a.md' },
    ]);
    const again = await engine.writeReasonPurgeTombstones('repo', [{ commit_sha: 'aaaa111', path: 'notes/b.md' }, { commit_sha: 'cccc333', path: 'notes/c.md' }]);
    const none = await engine.writeReasonPurgeTombstones('repo', []);
    const other = await engine.writeReasonPurgeTombstones('repo-2', [{ commit_sha: 'dddd444', path: 'notes/d.md' }]);
    let unknown: string;
    try {
      await engine.writeReasonPurgeTombstones('missing', [{ commit_sha: 'eeee555', path: 'notes/e.md' }]);
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

  parityTest('a sync reason scan drops the reason of a tombstoned (commit, path) and keeps the others', { methods: ['writeReasonPurgeTombstones', 'readReasonPurgeTombstones'] }, async (engine, backend) => {
    const { root, sha } = repoWithReasons();
    await createSource(engine, backend, 'repo', {}, root);
    await createSource(engine, backend, 'repo-2', {}, '/srv/brain/repo-2');
    await engine.writeReasonPurgeTombstones('repo', [{ commit_sha: sha, path: 'notes/a.md' }]);
    await engine.writeReasonPurgeTombstones('repo-2', [{ commit_sha: sha, path: 'notes/b.md' }]);
    const scan = await scanSyncReasons(engine, { sourceId: 'repo', sourceRoot: root, from: null, to: sha });
    const reasons = Object.fromEntries([...(scan?.byPath ?? new Map()).entries()].map(([path, d]) => [path, d.reason]));
    const result = { status: scan?.status ?? null, reasons };
    expect(result).toEqual({ status: 'complete', reasons: { 'notes/a.md': null, 'notes/b.md': 'Added the second note.' } });
    return result;
  });
});

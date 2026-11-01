/**
 * GBRA-135 x GBRA-133: `assertSyncEntryOrigin` proves a committed delete is gone from the pinned target by walking its
 * path one `git ls-tree` per level. The freeze, the claim and the publish each run it, so 10,000 committed deletes in one
 * directory spawned about 30,000 listings of the same immutable trees. Tree listings are memoized by object id: a pass
 * lists each tree once. A `git` shim on PATH counts the listings over a real repository; the verdicts stay the same.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSyncEntryOrigin } from '../src/core/persistence/sync-discovery.ts';
import { withEnv } from './helpers/with-env.ts';

describe('GBRA-135: committed-delete origin checks list each Git tree once', () => {
  let dir = '', repo = '', shim = '', log = '', target = '';
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbra135-ls-tree-'));
    repo = join(dir, 'repo'); shim = join(dir, 'bin'); log = join(dir, 'git.log');
    mkdirSync(join(repo, 'notes', 'deep'), { recursive: true }); mkdirSync(shim);
    git('init', '-q'); git('config', 'user.email', 'a@example.com'); git('config', 'user.name', 'a');
    for (let i = 0; i < 40; i++) writeFileSync(join(repo, 'notes', 'deep', `p${i}.md`), `# p${i}\n`);
    writeFileSync(join(repo, 'notes', 'deep', 'kept.md'), '# kept\n');
    git('add', '.'); git('commit', '-qm', 'one');
    for (let i = 0; i < 40; i++) rmSync(join(repo, 'notes', 'deep', `p${i}.md`));
    git('add', '-A'); git('commit', '-qm', 'delete');
    target = git('rev-parse', 'HEAD');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'git'), `#!/bin/sh\ncase " $* " in *" ls-tree "*) echo ls-tree >> '${log}';; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(shim, 'git'), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const listings = () => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

  test('freeze, claim and publish of 40 deletes in one directory list its three trees once', async () => {
    const context = { root: repo, gitRoot: repo, target, slugMode: 'git-root' as const };
    await withEnv({ PATH: `${shim}:${process.env.PATH}` }, () => {
      for (let pass = 0; pass < 3; pass++) for (let i = 0; i < 40; i++) {
        const path = `notes/deep/p${i}.md`;
        assertSyncEntryOrigin(context, { path, sourcePath: path, action: 'delete', working: false });
      }
    });
    expect(listings()).toBe(3);
  });

  test('a path the target still holds is refused as before, from the memoized listing', async () => {
    const context = { root: repo, gitRoot: repo, target, slugMode: 'git-root' as const };
    await withEnv({ PATH: `${shim}:${process.env.PATH}` }, () => {
      expect(() => assertSyncEntryOrigin(context, { path: 'notes/deep/kept.md', sourcePath: 'notes/deep/kept.md', action: 'delete', working: false }))
        .toThrow('The pinned Git target still contains or aliases the origin selected for deletion.');
    });
    expect(listings()).toBe(3);
  });
});

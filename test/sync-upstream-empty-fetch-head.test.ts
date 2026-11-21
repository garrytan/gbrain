import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeUpstream } from '../src/core/sync-upstream.ts';

let dir = '';
let work = '';
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const HOUR = 3600_000;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-fh-'));
  const bare = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  git(dir, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'a.md'), 'a');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'one');
  git(seed, 'push', '-q', bare, 'main');
  git(dir, 'clone', '-q', bare, work);
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('observeUpstream with an empty FETCH_HEAD', () => {
  test('an empty FETCH_HEAD is not an observation; a non-empty one is', async () => {
    const old = new Date(Date.now() - 48 * HOUR);
    const fh = join(work, '.git', 'FETCH_HEAD');
    const log = join(work, '.git', 'logs', 'refs', 'remotes', 'origin', 'main');
    if (existsSync(log)) utimesSync(log, old, old);
    writeFileSync(fh, '');
    const empty = await observeUpstream(work, null);
    expect(empty).toBeNull();
    writeFileSync(fh, 'x\t\tbranch main of remote\n');
    const full = await observeUpstream(work, null);
    expect(full).not.toBeNull();
    expect(Date.now() - (full?.checkedAt.getTime() ?? 0)).toBeLessThan(HOUR);
  });
});

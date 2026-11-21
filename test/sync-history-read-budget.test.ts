/**
 * GST-3328 follow-up: the history read behind a file-drift re-screen (`pathBlobHistories`) stays bounded on a deep
 * repository. Real Git repositories; the stream seam only delays, cuts or replays a real read.
 *   - a group whose read is cut short keeps the blobs it already read;
 *   - no group starts once the deadline has passed;
 *   - the caller hears a beat while a long group read streams, not only when it ends;
 *   - a path listed twice still ends its group's walk early, and a blob counts once however often it recurs.
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenedGitStream } from '../src/core/hardened-git.ts';
import { __setSyncGitStreamForTests, pathBlobHistories } from '../src/core/persistence/sync-git-stream.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => __setSyncGitStreamForTests());

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository whose `notes/a.md` held each of `bodies` in turn (one commit each), plus `others` files committed first. */
function repo(bodies: string[], others = 0): { root: string; head: string; blobs: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-history-read-'));
  dirs.push(root);
  git(root, 'init', '-q');
  execFileSync('mkdir', ['-p', join(root, 'notes')]);
  for (let i = 0; i < others; i++) writeFileSync(join(root, 'notes', `other-${i}.md`), `Other note ${i}.\n`);
  if (others) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'others'); }
  const blobs: string[] = [];
  for (const body of bodies) {
    writeFileSync(join(root, 'notes/a.md'), body);
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'edit');
    blobs.push(git(root, 'rev-parse', 'HEAD:notes/a.md'));
  }
  return { root, head: git(root, 'rev-parse', 'HEAD'), blobs };
}

test('a history read that is cut short keeps the versions it already read', async () => {
  const { root, head, blobs } = repo(['One.\n', 'Two.\n', 'Three.\n']);
  __setSyncGitStreamForTests(async (gitRoot, args, opts) => {
    const result = await hardenedGitStream(gitRoot, args, opts);
    return args[0] === 'log' ? { ok: false, reason: 'timeout' } : result;
  });
  const read = await pathBlobHistories(root, head, ['notes/a.md', 'notes/missing.md'], 5);
  expect(read.get('notes/a.md')).toEqual([...blobs].reverse());
  expect(read.has('notes/missing.md')).toBe(false);
});

test('no history group starts once the deadline has passed, and a group read before it keeps its versions', async () => {
  const { root, head, blobs } = repo(['One.\n', 'Two.\n'], 100);
  const groups: number[] = [];
  __setSyncGitStreamForTests(async (gitRoot, args, opts) => {
    if (args[0] === 'log') { groups.push(args.length); await new Promise(resolve => setTimeout(resolve, 300)); }
    return hardenedGitStream(gitRoot, args, opts);
  });
  const paths = ['notes/a.md', ...Array.from({ length: 100 }, (_, i) => `notes/other-${i}.md`)];
  const read = await pathBlobHistories(root, head, paths, 5, undefined, { deadline: Date.now() + 100 });
  expect(groups).toHaveLength(1);
  expect(read.get('notes/a.md')).toEqual([...blobs].reverse());
  expect(read.has('notes/other-99.md')).toBe(false);
  expect(await pathBlobHistories(root, head, paths, 5, undefined, { deadline: Date.now() - 1 })).toEqual(new Map());
});

test('a long history read beats while it streams, not only when it ends', async () => {
  const { root, head } = repo(['One.\n', 'Two.\n', 'Three.\n']);
  const events: string[] = [];
  __setSyncGitStreamForTests(async (gitRoot, args, opts) => {
    if (args[0] !== 'log') return hardenedGitStream(gitRoot, args, opts);
    const chunks: Buffer[] = [];
    const result = await hardenedGitStream(gitRoot, args, { ...opts, onChunk: chunk => { chunks.push(Buffer.from(chunk)); } });
    const all = Buffer.concat(chunks);
    for (const part of [all.subarray(0, 1), all.subarray(1)]) {
      await new Promise(resolve => setTimeout(resolve, 1_100));
      await opts.onChunk?.(part);
    }
    events.push('read ended');
    return result;
  });
  await pathBlobHistories(root, head, ['notes/a.md'], 5, () => events.push('path'), { beat: () => events.push('beat') });
  expect(events.indexOf('beat')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('beat')).toBeLessThan(events.indexOf('read ended'));
});

test('a path listed twice still ends its group\'s walk early, and a recurring blob counts once', async () => {
  const { root, head, blobs } = repo(['One.\n', 'Two.\n', 'One.\n', 'Three.\n']);
  let stoppedEarly = false;
  __setSyncGitStreamForTests(async (gitRoot, args, opts) => hardenedGitStream(gitRoot, args, opts).catch((error: unknown) => {
    if (args[0] === 'log') stoppedEarly = true;
    throw error;
  }));
  expect((await pathBlobHistories(root, head, ['notes/a.md', 'notes/a.md'], 2)).get('notes/a.md')).toEqual([blobs[3], blobs[2]]);
  expect(stoppedEarly).toBe(true);
  stoppedEarly = false;
  expect((await pathBlobHistories(root, head, ['notes/a.md'], 5)).get('notes/a.md')).toEqual([blobs[3], blobs[2], blobs[1]]);
  expect(stoppedEarly).toBe(false);
});

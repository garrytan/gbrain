/**
 * Managed sync freezes a group's followers four at a time (`freezeFollowers`, Promise.all), so their pinned content reads
 * reach `readPinnedContent` in whatever order the freezes finish; with lanes the group sizes and admit-ahead timing come
 * from measured lane apply times, so that order changes from run to run. A window's `cat-file --batch` slices are cut by
 * window position and the byte budget only, so the number of Git processes no longer depends on that order.
 * This pins the interleaving that made `managed-sync-pinned-reads` count 5: a held head that reads no content (it
 * creates the window), then a follower batch finishing last-first, then a second round read in order.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { __setPinnedWindowForTests, readPinnedBlob, readPinnedContent } from '../src/core/persistence/sync-blobs.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pinned-order-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim();

function repo(name: string, files: Record<string, string>): { root: string; head: string } {
  const root = join(home, name);
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'seed');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
}

/** A `git` on PATH that logs each call's arguments, then runs the real git. */
function counter(): { path: string; catFiles: () => number } {
  const bin = join(home, 'bin'), log = join(home, 'git.log'), real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { path: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    catFiles: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => / cat-file --batch$/.test(line)).length : 0 };
}

describe.skipIf(process.platform === 'win32')('pinned content reads in a window', () => {
  test('a follower batch that finishes last-first costs the same cat-file processes as one read in order', async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `notes/n${i}.md`);
    const first = repo('first', Object.fromEntries(paths.map((path, i) => [path, `# Note ${i}\n\nbody ${i}\n`])));
    const second = repo('second', Object.fromEntries(paths.map((path, i) => [path, `# Second ${i}\n\nbody ${i}\n`])));
    const shim = counter();
    const restore = __setPinnedWindowForTests(null);
    try {
      await withEnv({ PATH: shim.path }, async () => {
        const upcoming = (from: number) => () => paths.slice(from);
        // Round 0 (sequential freeze): every entry reads in manifest order.
        for (const [i, path] of paths.entries()) expect(readPinnedContent(first.root, first.head, path, upcoming(i))).toBe(`# Note ${i}\n\nbody ${i}\n`);
        // Round 1: the head is held without reading content, then its followers finish freezing last-first.
        expect(readPinnedBlob(second.root, second.head, paths[0]!, upcoming(0))).not.toBeNull();
        for (const i of [4, 3, 2, 1, 5]) expect(readPinnedContent(second.root, second.head, paths[i]!, upcoming(i))).toBe(`# Second ${i}\n\nbody ${i}\n`);
        // A re-freeze of an entry already read (a follower frozen again as the next head) reads no Git process either.
        expect(readPinnedContent(second.root, second.head, paths[2]!, upcoming(2))).toBe('# Second 2\n\nbody 2\n');
      });
      // One window per round, each inside one byte slice: one cat-file per round, whatever the follower order.
      expect(shim.catFiles()).toBe(2);
    } finally { restore(); }
  });
});

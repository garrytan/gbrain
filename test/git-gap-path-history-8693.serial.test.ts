/**
 * #8693 item 1 and #8687: the direction-evidence history read (persistence/git-gap.ts readPathHistory).
 * It lists a path's blobs newest first in ancestry order even when commit clocks are skewed, and it asks Git
 * only for the paths it needs, as literal pathspecs on stdin, so unrelated history is never streamed.
 * Serial: one case wraps the process-wide hardenedGitStream export to count the bytes Git streamed.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as hardened from '../src/core/hardened-git.ts';
import { readPathHistory } from '../src/core/persistence/git-gap.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-path-history-'));
  dirs.push(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[], date?: string) => execFileSync('git', ['-C', root, '-c', 'user.name=Writer Example', '-c', 'user.email=writer@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env }).trim();
  git(['init', '-q', '-b', 'main']);
  const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const commit = (message: string, date?: string) => { git(['add', '-A']); git(['commit', '-qm', message], date); return git(['rev-parse', 'HEAD']); };
  const blob = (path: string) => git(['rev-parse', `HEAD:${path}`]);
  return { root, git, put, commit, blob };
}

async function streamed(fn: () => Promise<unknown>) {
  const original = hardened.hardenedGitStream;
  const seen = { calls: 0, bytes: 0 };
  const spy = spyOn(hardened, 'hardenedGitStream').mockImplementation(async (root, args, opts) => {
    seen.calls++;
    const result = await original(root, args, opts);
    if (result.ok) seen.bytes += result.bytes;
    return result;
  });
  try { return { value: await fn(), ...seen }; } finally { spy.mockRestore(); }
}

describe('readPathHistory', () => {
  test('a skewed commit clock never lists an ancestor before its descendant (#8693 item 1)', async () => {
    const r = checkout();
    r.put('notes/page.md', 'A'); r.commit('A', '2026-01-20T12:00:00Z');
    const a = r.blob('notes/page.md');
    r.git(['branch', 'side']);
    r.put('notes/page.md', 'C'); r.commit('C', '2026-01-10T12:00:00Z');
    const c = r.blob('notes/page.md');
    r.git(['checkout', '-q', 'side']);
    r.put('notes/page.md', 'B'); r.commit('B', '2026-01-05T12:00:00Z');
    const b = r.blob('notes/page.md');
    r.git(['checkout', '-q', 'main']);
    r.git(['merge', '-q', '--no-ff', '-s', 'ours', 'side', '-m', 'keep C'], '2026-01-21T12:00:00Z');
    const history = await readPathHistory(r.root, 'HEAD', '', new Set(['notes/page.md']));
    const order = history!.get('notes/page.md')!.map(entry => entry.oid);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set([a, b, c]));
    // A is the ancestor of both B and C, so it is the oldest state whatever its clock says.
    expect(order.at(-1)).toBe(a);
  }, 60_000);

  test('one page streams its own history, not every unrelated path in the source (#8687)', async () => {
    const r = checkout();
    r.put('notes/wanted.md', 'first'); r.commit('first');
    const first = r.blob('notes/wanted.md');
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 20; j++) r.put(`notes/noise-${j}.md`, `${i}:${j}`);
      r.commit(`noise ${i}`);
    }
    r.put('notes/wanted.md', 'second'); r.commit('second');
    const second = r.blob('notes/wanted.md');
    const seen = await streamed(() => readPathHistory(r.root, 'HEAD', 'notes', new Set(['notes/wanted.md'])));
    expect((seen.value as Map<string, { oid: string }[]>).get('notes/wanted.md')!.map(entry => entry.oid)).toEqual([second, first]);
    expect(seen.calls).toBe(1);
    // Two commits touch the page; the whole-scope walk streams all 42 commits and every noise blob (tens of KB).
    expect(seen.bytes).toBeLessThan(2_048);
  }, 60_000);

  test('names that look like pathspec magic, options or globs are read literally, and other scopes are left out', async () => {
    const r = checkout();
    const paths = ['notes/plain.md', 'notes/*.md', 'notes/:(glob)x.md', 'notes/--all', 'notes/-n1', 'notes/\u65e5\u672c.md', 'notes/quote".md', 'notes/back\\slash.md'];
    for (const path of [...paths, 'other/plain.md']) r.put(path, 'one');
    r.commit('one');
    const one = new Map(paths.map(path => [path, r.blob(path)]));
    for (const path of [...paths, 'other/plain.md']) r.put(path, `two ${path}`);
    r.commit('two');
    const two = new Map(paths.map(path => [path, r.blob(path)]));
    for (const path of paths) r.put(path, 'one');
    r.commit('revert');
    const history = await readPathHistory(r.root, 'HEAD', 'notes', new Set([...paths, 'other/plain.md']));
    expect([...history!.keys()].sort()).toEqual([...paths].sort());
    for (const path of paths) expect(history!.get(path)!.map(entry => entry.oid)).toEqual([one.get(path)!, two.get(path)!, one.get(path)!]);
  }, 60_000);

  test('a name with CR or LF falls back to the whole-scope walk with the same answer', async () => {
    const r = checkout();
    const odd = 'notes/line\nbreak.md', cr = 'notes/carriage\rreturn.md';
    r.put(odd, 'one'); r.put(cr, 'one'); r.put('notes/plain.md', 'one'); r.commit('one');
    const one = r.blob(odd);
    r.put(odd, 'two'); r.put(cr, 'two'); r.commit('two');
    const history = await readPathHistory(r.root, 'HEAD', 'notes', new Set([odd, cr, 'notes/plain.md']));
    expect(history!.get(odd)!.map(entry => entry.oid)).toEqual([r.blob(odd), one]);
    expect(history!.get(cr)).toHaveLength(2);
    expect(history!.get('notes/plain.md')).toHaveLength(1);
  }, 60_000);

  test('a large interest set walks the whole scope, which is cheaper than matching every entry against every path', async () => {
    const r = checkout();
    const paths = Array.from({ length: 40 }, (_, i) => `notes/page-${i}.md`);
    for (const path of paths) r.put(path, 'one');
    r.put('other/page.md', 'one'); r.commit('one');
    for (const path of paths) r.put(path, `two ${path}`);
    r.commit('two');
    const seen: string[][] = [];
    const original = hardened.hardenedGitStream;
    const spy = spyOn(hardened, 'hardenedGitStream').mockImplementation(async (root, args, opts) => { seen.push([...args]); return original(root, args, opts); });
    let history: Awaited<ReturnType<typeof readPathHistory>>;
    try { history = await readPathHistory(r.root, 'HEAD', 'notes', new Set([...paths, 'other/page.md'])); } finally { spy.mockRestore(); }
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('--stdin');
    expect(seen[0]!.slice(-2)).toEqual(['--', ':(literal)notes']);
    expect([...history!.keys()].sort()).toEqual([...paths].sort());
    for (const path of paths) expect(history!.get(path)).toHaveLength(2);
  }, 60_000);

  test('merge history keeps full-history entries and first-parent merge diffs', async () => {
    const r = checkout();
    r.put('notes/main.md', 'base'); r.put('notes/side.md', 'base'); r.commit('base');
    const base = r.blob('notes/main.md');
    r.git(['checkout', '-qb', 'side']);
    r.put('notes/side.md', 'side'); r.commit('side');
    const side = r.blob('notes/side.md');
    r.git(['checkout', '-q', 'main']);
    r.put('notes/main.md', 'main'); r.commit('main');
    const main = r.blob('notes/main.md');
    r.git(['merge', '-q', '--no-ff', 'side', '-m', 'merge']);
    const history = await readPathHistory(r.root, 'HEAD', '', new Set(['notes/main.md', 'notes/side.md']));
    expect(history!.get('notes/main.md')!.map(entry => entry.oid)).toEqual([main, base]);
    expect(history!.get('notes/side.md')!.map(entry => entry.oid)).toEqual([side, base]);
  }, 60_000);

  test('an interest set with nothing under the scope runs no Git at all', async () => {
    const r = checkout();
    r.put('other/plain.md', 'one'); r.commit('one');
    const seen = await streamed(() => readPathHistory(r.root, 'HEAD', 'notes', new Set(['other/plain.md', 'notes'])));
    expect((seen.value as Map<string, unknown>).size).toBe(0);
    expect(seen.calls).toBe(0);
  });
});

describe('hardened history log shape', () => {
  const tail = ['--end-of-options', 'HEAD', '--'];
  test('the history walk requires topological order and allows stdin pathspecs only in its own full shape', () => {
    expect(hardened.HISTORY_LOG_OPTIONS).toContain('--topo-order');
    expect(() => hardened.assertHardenedGitArgs(['log', ...hardened.HISTORY_LOG_OPTIONS, ...tail])).not.toThrow();
    expect(() => hardened.assertHardenedGitArgs(['log', ...hardened.HISTORY_LOG_OPTIONS, '--stdin', ...tail])).not.toThrow();
    expect(() => hardened.assertHardenedGitArgs(['log', ...hardened.HISTORY_LOG_OPTIONS.filter(arg => arg !== '--topo-order'), ...tail])).toThrow(/hardened git refuses/);
    expect(() => hardened.assertHardenedGitArgs(['log', ...hardened.REASON_LOG_OPTIONS, '--stdin', ...tail])).toThrow(/hardened git refuses/);
    expect(() => hardened.assertHardenedGitArgs(['log', '--raw', '--stdin', ...tail])).toThrow(/hardened git refuses/);
    expect(() => hardened.assertHardenedGitArgs(['log', ...hardened.HISTORY_LOG_OPTIONS, '--stdin', '--ext-diff', ...tail])).toThrow(/hardened git refuses/);
    expect(() => hardened.assertHardenedGitArgs(['log', ...hardened.REASON_LOG_OPTIONS, ...tail])).not.toThrow();
  });
});

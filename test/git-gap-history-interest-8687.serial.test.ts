/**
 * #8687: direction evidence must not transfer every unrelated historical path
 * for one unrecorded page. Real Git fixtures assert streamed bytes, complete blob
 * history (including reverts/merges), literal path handling and bounded argv.
 * Serial: wraps the process-wide hardenedGitStream export to observe real bytes.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as hardened from '../src/core/hardened-git.ts';
import { readPathHistory } from '../src/core/persistence/git-gap.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'history-interest-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const commit = (message: string) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  return { root, git, write, commit };
}
async function observed(root: string, tip: string, scope: string, paths: Set<string>) {
  const original = hardened.hardenedGitStream;
  let bytes = 0;
  let calls = 0;
  let argvBytes = 0;
  const spy = spyOn(hardened, 'hardenedGitStream').mockImplementation(async (root, args, limits) => {
    calls++;
    argvBytes = Math.max(argvBytes, Buffer.byteLength(args.join('\0')));
    const result = await original(root, args, limits);
    if (result.ok) bytes += result.bytes;
    return result;
  });
  try { return { history: await readPathHistory(root, tip, scope, paths), bytes, calls, argvBytes }; }
  finally { spy.mockRestore(); }
}

test('one page streams only its history, not the unrelated source history', async () => {
  const r = repo();
  r.write('notes/wanted.md', 'first'); r.commit('first');
  const first = r.git('rev-parse', 'HEAD:notes/wanted.md');
  for (let i = 0; i < 45; i++) {
    for (let j = 0; j < 25; j++) r.write(`noise/${j}.md`, `${i}:${j}`);
    r.commit(`noise ${i}`);
  }
  r.write('notes/wanted.md', 'second'); r.commit('second');
  const second = r.git('rev-parse', 'HEAD:notes/wanted.md');
  const result = await observed(r.root, 'HEAD', '', new Set(['notes/wanted.md']));
  expect(result.history?.get('notes/wanted.md')?.map(e => e.oid)).toEqual([second, first]);
  expect(result.calls).toBe(1);
  expect(result.bytes).toBeLessThan(4_096);
}, 30_000);

test('literal, newline, Unicode and out-of-scope paths preserve the same evidence', async () => {
  const r = repo();
  const paths = ['scope/plain.md', 'scope/line\nbreak.md', 'scope/carriage\rreturn.md', 'scope/日本.md', 'scope/:(glob)*.md', 'scope/a\\b.md', 'scope/quote".md', 'scope/--all'];
  for (const path of [...paths, 'outside/other.md']) r.write(path, 'first');
  r.commit('first');
  const first = new Map(paths.map(path => [path, r.git('rev-parse', `HEAD:${path}`)]));
  for (const path of paths) r.write(path, 'second');
  r.commit('second');
  const second = new Map(paths.map(path => [path, r.git('rev-parse', `HEAD:${path}`)]));
  for (const path of paths) r.write(path, 'first');
  r.commit('revert');
  const result = await observed(r.root, 'HEAD', 'scope', new Set([...paths, 'outside/other.md']));
  expect([...result.history!.keys()].sort()).toEqual([...paths].sort());
  for (const path of paths) expect(result.history!.get(path)!.map(e => e.oid)).toEqual([first.get(path)!, second.get(path)!, first.get(path)!]);
  expect(result.calls).toBe(1);
}, 30_000);

test('merged branch evidence retains full-history, first-parent merge diffs and reverts', async () => {
  const r = repo();
  r.write('scope/main.md', 'original'); r.write('scope/side.md', 'original'); r.commit('root');
  const initial = r.git('rev-parse', 'HEAD:scope/main.md');
  const main = r.git('symbolic-ref', '--short', 'HEAD');
  r.git('checkout', '-qb', 'side');
  r.write('scope/side.md', 'side'); r.commit('side edit');
  const side = r.git('rev-parse', 'HEAD:scope/side.md');
  r.git('checkout', '-q', main);
  r.write('scope/main.md', 'main'); r.commit('main edit');
  const changed = r.git('rev-parse', 'HEAD:scope/main.md');
  r.git('merge', '--no-ff', '-qm', 'merge', 'side');
  r.write('scope/main.md', 'original'); r.commit('revert main');
  const result = await observed(r.root, 'HEAD', 'scope', new Set(['scope/main.md', 'scope/side.md']));
  expect(result.history?.get('scope/main.md')?.map(e => e.oid)).toEqual([initial, changed, initial]);
  expect(result.history?.get('scope/side.md')?.map(e => e.oid)).toEqual([side, initial]);
  expect(result.calls).toBe(1);
}, 30_000);

test('empty scoped interest does no Git work; excessive newline argv falls back conservatively', async () => {
  const r = repo(); r.write('scope/line\nbreak.md', 'first'); r.write('outside.md', 'outside'); r.commit('first');
  const empty = await observed(r.root, 'HEAD', 'scope', new Set(['outside.md']));
  expect(empty.history?.size).toBe(0); expect(empty.calls).toBe(0);
  const newlineOnly = await observed(r.root, 'HEAD', 'scope', new Set(['scope/line\nbreak.md']));
  expect([...newlineOnly.history!.keys()]).toEqual(['scope/line\nbreak.md']);
  expect(newlineOnly.calls).toBe(1);
  const paths = new Set(['scope/line\nbreak.md', 'outside.md', ...Array.from({ length: 500 }, (_, i) => `scope/${i}\n${'x'.repeat(80)}.md`)]);
  const result = await observed(r.root, 'HEAD', 'scope', paths);
  expect([...result.history!.keys()]).toEqual(['scope/line\nbreak.md']);
  expect(result.calls).toBe(1); expect(result.argvBytes).toBeLessThan(4_096);
}, 30_000);

test('stdin is permitted only with the complete raw history option shape', () => {
  expect(() => hardened.assertHardenedGitArgs(['log', ...hardened.HISTORY_LOG_OPTIONS, '--stdin', '--end-of-options', 'HEAD', '--'])).not.toThrow();
  expect(() => hardened.assertHardenedGitArgs(['log', ...hardened.REASON_LOG_OPTIONS, '--stdin', '--end-of-options', 'HEAD', '--'])).toThrow(/hardened git refuses/);
  expect(() => hardened.assertHardenedGitArgs(['log', '--raw', '--stdin', '--end-of-options', 'HEAD', '--'])).toThrow(/hardened git refuses/);
});

test('large interest lists do not become unbounded argv or split the history order', async () => {
  const r = repo(); r.write('notes/wanted.md', 'first'); r.commit('first');
  const interest = new Set(['notes/wanted.md', ...Array.from({ length: 2_000 }, (_, i) => `notes/${i}-${'x'.repeat(80)}.md`)]);
  const result = await observed(r.root, 'HEAD', '', interest);
  expect(result.history?.get('notes/wanted.md')).toHaveLength(1);
  expect(result.calls).toBe(1);
  expect(result.argvBytes).toBeLessThan(4_096);
}, 30_000);

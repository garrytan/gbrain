/**
 * #9430: a `.git` directory above a root that is not a repository (an empty
 * `$HOME/.git` another tool left behind) was kept as the root's checkout:
 * `git rev-parse` exits 128 there, and only exit 1 meant "not tracked". gbrain
 * then wrote its managed-root marker into that directory, and every path under
 * `$HOME` (connector clones included) refused `writer_coordinator_required`.
 * An enclosing `.git` that is not a repository is no checkout: the root is
 * marked in its own directory, and a marker an older release left there reads
 * as the stale enclosing marker the refusal already names (#7988). The same
 * holds for the root's own `.git`: one that is not a repository (an empty
 * directory, or a gitdir file pointing nowhere, where recording the root
 * failed with ENOENT) is no checkout either.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleEnclosingMarker } from '../src/core/persistence/filesystem-guard.ts';
import { checkoutGitMetadata, managedRootMarkerFor, recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

const bases: string[] = [];
afterAll(() => { for (const base of bases) rmSync(base, { recursive: true, force: true }); });

/** A home whose `.git` is `kind`, with a connector clone directory under `.gbrain/clones`. */
function home(kind: 'empty-dir' | 'dangling-gitdir-file') {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-9430-'));
  bases.push(base);
  const dir = join(base, 'user-home'), connector = join(dir, '.gbrain', 'clones', 'source-a-google');
  mkdirSync(connector, { recursive: true });
  if (kind === 'empty-dir') mkdirSync(join(dir, '.git'));
  else writeFileSync(join(dir, '.git'), `gitdir: ${join(base, 'missing', '.git')}\n`);
  return { base, dir, connector };
}

for (const kind of ['empty-dir', 'dangling-gitdir-file'] as const) {
  test(`an enclosing .git that is not a repository (${kind}) is not the root's checkout`, async () => {
    const h = home(kind);
    expect(checkoutGitMetadata(h.connector)).toBeNull();
    await withEnv({ GBRAIN_HOME: join(h.base, 'gbrain-home') }, () => {
      recordManagedRoots(randomUUID(), [{ local_path: h.connector, source_id: 'source-a' }]);
    });
    expect(existsSync(join(h.dir, '.git', 'gbrain-managed.json'))).toBe(false);
    expect(existsSync(join(h.connector, '.gbrain-managed'))).toBe(true);
    expect(managedRootMarkerFor(join(h.dir, 'notes', 'todo.md'))).toBeNull();
    expect(managedRootMarkerFor(join(h.connector, 'mail.md'))?.root).toBe(h.connector);
  });
}

for (const kind of ['empty-dir', 'dangling-gitdir-file'] as const) {
  test(`a root's own .git that is not a repository (${kind}) is not its checkout`, async () => {
    const base = mkdtempSync(join(tmpdir(), 'gbrain-9430-own-'));
    bases.push(base);
    const root = join(base, 'source-a');
    mkdirSync(root);
    if (kind === 'empty-dir') mkdirSync(join(root, '.git'));
    else writeFileSync(join(root, '.git'), `gitdir: ${join(base, 'missing', '.git')}\n`);
    expect(checkoutGitMetadata(root)).toBeNull();
    await withEnv({ GBRAIN_HOME: join(base, 'gbrain-home') }, () => {
      recordManagedRoots(randomUUID(), [{ local_path: root, source_id: 'source-a' }]);
    });
    expect(existsSync(join(root, '.gbrain-managed'))).toBe(true);
    expect(managedRootMarkerFor(join(root, 'mail.md'))?.root).toBe(root);
  });
}

test('control: a tracked directory holding a stray empty .git still belongs to the repository that tracks it', () => {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-9430-stray-'));
  bases.push(base);
  const wiki = join(base, 'repo', 'wiki');
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, 'alice-example.md'), 'Notes.\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', join(base, 'repo'), ...args], { stdio: 'ignore' });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'wiki');
  mkdirSync(join(wiki, '.git'));
  expect(checkoutGitMetadata(wiki)).toBe(join(base, 'repo', '.git'));
});

test('a marker an older release wrote into an invalid enclosing .git reads as a stale enclosing marker', async () => {
  const h = home('empty-dir');
  const marker = join(h.dir, '.git', 'gbrain-managed.json');
  writeFileSync(marker, JSON.stringify({ version: 1, managed: true, brain_id: randomUUID() }));
  await withEnv({ GBRAIN_HOME: join(h.base, 'gbrain-home') }, () => {
    recordManagedRoots(randomUUID(), [{ local_path: h.connector, source_id: 'source-a' }]);
    expect(managedRootMarkerFor(join(h.dir, 'notes', 'todo.md'))).toEqual({ root: h.dir, marker });
    expect(staleEnclosingMarker({ root: h.dir, evidence: marker })).toBe(true);
  });
});

test('control: a real repository that tracks the root stays its checkout', () => {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-9430-repo-'));
  bases.push(base);
  const wiki = join(base, 'repo', 'wiki');
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, 'alice-example.md'), 'Notes.\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', join(base, 'repo'), ...args], { stdio: 'ignore' });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'wiki');
  expect(checkoutGitMetadata(wiki)).toBe(join(base, 'repo', '.git'));
});

/**
 * Checkout walks that race a concurrent pruner (#B1: `foresights sources add`
 * crashed with `internal_error: ENOENT … scandir '<repo>/.git/objects/06'`
 * when git's detached auto-gc pruned loose-object directories mid-walk).
 *
 * Protects:
 *   - assertNoPhysicalRootOverlap and topologyDirectoryBytes skip a
 *     subdirectory that vanishes or becomes a file between listing and
 *     descent, and still refuse on errors at the root and on EACCES.
 *   - The overlap walk keeps descending into `.git`, so a reservation marker
 *     nested there is still found after a sibling vanished.
 * Fails when: the walk loses its ENOENT/ENOTDIR tolerance below the root (the
 * vanished-subdir cases throw), the tolerance widens to the root or to other
 * errors (the refusal cases resolve), or the walk starts skipping `.git`
 * (the nested-marker case resolves).
 * Why new: test/persistence-physical-root.test.ts covers ownership claims over
 * stable trees; nothing raced the walk. The 20k-file CLI case in
 * test/large-brain-ceilings.test.ts hit the race only by chance.
 * Seam: none. The race is injected by wrapping node:fs (restored after each
 * test), the same listing-then-descent window git's gc opens.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoPhysicalRootOverlap, physicalRootReservationPath, PHYSICAL_ROOT_MARKER } from '../src/core/persistence/physical-root-record.ts';
import { topologyDirectoryBytes } from '../src/core/persistence/topology-filesystem.ts';
import { writeLargeWorktree } from './helpers/large-worktree.ts';
import { testWaitMs } from './helpers/wait-for.ts';

let directory: string;
let counter = 0;
const restores: Array<() => void> = [];
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'gbrain-root-walk-')); });
afterEach(() => { while (restores.length) restores.pop()!(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function checkout(): string {
  const root = join(directory, `repo-${++counter}`);
  mkdirSync(join(root, '.git', 'objects', '06'), { recursive: true });
  mkdirSync(join(root, '.git', 'objects', 'pack'), { recursive: true });
  writeFileSync(join(root, '.git', 'objects', '06', 'loose'), 'x');
  writeFileSync(join(root, 'page.md'), 'Example page');
  return root;
}
function errno(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated, scandir '${path}'`), { code });
}

/** Runs `onList(directory)` right after the real listing of each directory returns. */
function afterSyncListing(onList: (directory: string) => void): void {
  const real = fs.readdirSync;
  const spy = spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, options?: unknown) => {
    const entries = (real as (p: fs.PathLike, o?: unknown) => unknown)(path, options);
    onList(String(path));
    return entries;
  }) as typeof fs.readdirSync);
  restores.push(() => spy.mockRestore());
}
function failSyncListing(target: string, code: string): void {
  const real = fs.readdirSync;
  const spy = spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, options?: unknown) => {
    if (String(path) === target) throw errno(code, target);
    return (real as (p: fs.PathLike, o?: unknown) => unknown)(path, options);
  }) as typeof fs.readdirSync);
  restores.push(() => spy.mockRestore());
}
/** Runs `onStat(path)` right after the real lstat of each path resolves, before its readdir. */
function afterAsyncStat(onStat: (path: string) => void): void {
  const real = fsp.lstat;
  const spy = spyOn(fsp, 'lstat').mockImplementation((async (path: fs.PathLike, options?: unknown) => {
    const info = await (real as (p: fs.PathLike, o?: unknown) => Promise<unknown>)(path, options);
    onStat(String(path));
    return info;
  }) as typeof fsp.lstat);
  restores.push(() => spy.mockRestore());
}
function failAsyncListing(target: string, code: string): void {
  const real = fsp.readdir;
  const spy = spyOn(fsp, 'readdir').mockImplementation((async (path: fs.PathLike, options?: unknown) => {
    if (String(path) === target) throw errno(code, target);
    return (real as (p: fs.PathLike, o?: unknown) => Promise<unknown>)(path, options);
  }) as typeof fsp.readdir);
  restores.push(() => spy.mockRestore());
}

describe('assertNoPhysicalRootOverlap walk', () => {
  test('a subdirectory pruned between listing and descent is skipped', () => {
    const root = checkout();
    afterSyncListing(path => { if (path === join(root, '.git', 'objects')) rmSync(join(root, '.git', 'objects', '06'), { recursive: true }); });
    expect(() => assertNoPhysicalRootOverlap(root)).not.toThrow();
  });

  test('a subdirectory replaced by a file between listing and descent is skipped', () => {
    const root = checkout();
    const target = join(root, '.git', 'objects', '06');
    afterSyncListing(path => {
      if (path !== join(root, '.git', 'objects')) return;
      rmSync(target, { recursive: true }); writeFileSync(target, 'now a file');
    });
    expect(() => assertNoPhysicalRootOverlap(root)).not.toThrow();
  });

  test('a reservation nested under .git is still found after a sibling vanished', () => {
    const root = checkout();
    const nested = join(root, '.git', 'objects', 'pack', 'child');
    mkdirSync(nested);
    writeFileSync(physicalRootReservationPath(nested), '{}');
    afterSyncListing(path => { if (path === join(root, '.git', 'objects')) rmSync(join(root, '.git', 'objects', '06'), { recursive: true }); });
    expect(() => assertNoPhysicalRootOverlap(root)).toThrow('contains another reserved canonical root');
  });

  test('a nested ownership stamp under .git is found', () => {
    const root = checkout();
    const nested = join(root, '.git', 'child');
    mkdirSync(nested);
    writeFileSync(join(nested, PHYSICAL_ROOT_MARKER), '{}');
    expect(() => assertNoPhysicalRootOverlap(root)).toThrow('contains another reserved canonical root');
  });

  test('a root that vanishes after the existence check still throws', () => {
    const root = checkout();
    failSyncListing(root, 'ENOENT');
    expect(() => assertNoPhysicalRootOverlap(root)).toThrow('ENOENT');
  });

  test('an unreadable subdirectory still throws', () => {
    const root = checkout();
    failSyncListing(join(root, '.git', 'objects', '06'), 'EACCES');
    expect(() => assertNoPhysicalRootOverlap(root)).toThrow('EACCES');
  });

  test('walks a 20,000-file checkout within its budget', () => {
    const root = checkout();
    writeLargeWorktree(root, 20_000);
    const started = performance.now();
    assertNoPhysicalRootOverlap(root);
    const elapsed = performance.now() - started;
    console.log(`[physical-root-walk] 20,000-file overlap walk took ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThan(testWaitMs(10_000));
  }, 120_000);
});

describe('topologyDirectoryBytes walk', () => {
  test('a subdirectory pruned between lstat and readdir is counted and skipped', async () => {
    const root = checkout();
    const target = join(root, '.git', 'objects', '06');
    afterAsyncStat(path => { if (path === target) rmSync(target, { recursive: true }); });
    expect(await topologyDirectoryBytes(root)).toBeGreaterThan(0);
  });

  test('a subdirectory replaced by a file between lstat and readdir is skipped', async () => {
    const root = checkout();
    const target = join(root, '.git', 'objects', '06');
    afterAsyncStat(path => { if (path === target) { rmSync(target, { recursive: true }); writeFileSync(target, 'now a file'); } });
    expect(await topologyDirectoryBytes(root)).toBeGreaterThan(0);
  });

  test('a root that vanishes after lstat still throws', async () => {
    const root = checkout();
    failAsyncListing(root, 'ENOENT');
    await expect(topologyDirectoryBytes(root)).rejects.toThrow('ENOENT');
  });

  test('an unreadable subdirectory still throws', async () => {
    const root = checkout();
    failAsyncListing(join(root, '.git', 'objects', '06'), 'EACCES');
    await expect(topologyDirectoryBytes(root)).rejects.toThrow('EACCES');
  });
});

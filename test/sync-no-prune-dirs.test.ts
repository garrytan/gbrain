/**
 * GBRAIN_NO_PRUNE_DIRS — escape hatch to un-prune a content dir (e.g. `ops/`)
 * that's otherwise in PRUNE_DIR_NAMES. Dot-dirs + submodules stay pruned.
 */
import { test, expect, afterEach } from 'bun:test';
import { pruneDir, parseNoPruneDirs } from '../src/core/sync.ts';

afterEach(() => { delete process.env.GBRAIN_NO_PRUNE_DIRS; });

test('parseNoPruneDirs: trims, drops empties/dupes, empty when unset', () => {
  expect([...parseNoPruneDirs('ops')]).toEqual(['ops']);
  expect([...parseNoPruneDirs(' ops , foo ,, ')].sort()).toEqual(['foo', 'ops']);
  expect([...parseNoPruneDirs('ops,ops')]).toEqual(['ops']);
  expect([...parseNoPruneDirs(undefined)]).toEqual([]);
  expect([...parseNoPruneDirs('')]).toEqual([]);
});

test('default: ops/node_modules/.raw pruned, normal dirs kept', () => {
  delete process.env.GBRAIN_NO_PRUNE_DIRS;
  expect(pruneDir('ops')).toBe(false);
  expect(pruneDir('node_modules')).toBe(false);
  expect(pruneDir('foo.raw')).toBe(false);
  expect(pruneDir('people')).toBe(true);
  expect(pruneDir('operations')).toBe(true);
});

test('GBRAIN_NO_PRUNE_DIRS=ops un-prunes ops, leaves the rest pruned', () => {
  process.env.GBRAIN_NO_PRUNE_DIRS = 'ops';
  expect(pruneDir('ops')).toBe(true);          // now synced
  expect(pruneDir('node_modules')).toBe(false); // still pruned
  expect(pruneDir('.git')).toBe(false);         // dot-dirs ALWAYS pruned
  expect(pruneDir('.obsidian')).toBe(false);
});

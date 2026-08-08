/**
 * Unit tests for src/core/pglite-leftovers-check.ts (#3856).
 *
 * Tmp-dir fixtures only — fake store dirs with real files, no engine, no
 * network. Mirrors npm-squat-check.test.ts's shape (#505).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessPgliteLeftovers,
  isMigrationLeftoverName,
  SIZE_WALK_MAX_ENTRIES,
} from '../src/core/pglite-leftovers-check.ts';

let root: string;

/** A gbrain-home fixture; returns its path. */
function makeHome(name: string): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return home;
}

/** Lay down a fake pglite store dir with a few sized files. */
function makeStore(home: string, dirName: string, fileBytes: number[]): string {
  const dir = join(home, dirName);
  mkdirSync(join(dir, 'nested'), { recursive: true });
  fileBytes.forEach((n, i) => {
    writeFileSync(join(dir, i === 0 ? 'base' : `nested/f${i}`), Buffer.alloc(n, 65));
  });
  return dir;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'pglite-leftovers-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isMigrationLeftoverName', () => {
  test("matches only the migration's own artifacts", () => {
    expect(isMigrationLeftoverName('brain.pglite')).toBe(true);
    expect(isMigrationLeftoverName('brain.pglite.pre-migrate-20260524')).toBe(true);
    // Unknown provenance — NOT claimed (Codex review: the evidence only
    // supports the migration's own artifacts).
    expect(isMigrationLeftoverName('brain.pglite.bak')).toBe(false);
    expect(isMigrationLeftoverName('brain.pglite2')).toBe(false);
    expect(isMigrationLeftoverName('brain-pages')).toBe(false);
    expect(isMigrationLeftoverName('pglite')).toBe(false);
  });
});

describe('assessPgliteLeftovers', () => {
  test('skips on a pglite engine — the store is live, not a leftover', () => {
    const home = makeHome('live-pglite');
    makeStore(home, 'brain.pglite', [1024]);
    expect(assessPgliteLeftovers('pglite', home).status).toBe('skip');
  });

  test('skips on unknown/missing engines — only durable postgres can warn (fail open)', () => {
    const home = makeHome('unknown-engine');
    makeStore(home, 'brain.pglite', [1024]);
    expect(assessPgliteLeftovers(undefined, home).status).toBe('skip');
    expect(assessPgliteLeftovers(null, home).status).toBe('skip');
    expect(assessPgliteLeftovers('', home).status).toBe('skip');
    expect(assessPgliteLeftovers('supabase', home).status).toBe('skip');
  });

  test('skips when the home itself is unreadable (fail open)', () => {
    expect(assessPgliteLeftovers('postgres', join(root, 'no-such-home')).status).toBe('skip');
  });

  test('ok on a postgres brain with no leftover dirs', () => {
    const home = makeHome('clean-postgres');
    mkdirSync(join(home, 'brain-pages'));
    makeStore(home, 'brain.pglite.bak', [512]); // out-of-scope sibling — not claimed
    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('ok');
    expect(a.leftovers).toHaveLength(0);
    expect(a.message).toContain('postgres');
  });

  test('a brain.pglite FILE (not dir) is ignored — only directories are stores', () => {
    const home = makeHome('file-not-dir');
    writeFileSync(join(home, 'brain.pglite'), 'not a directory');
    expect(assessPgliteLeftovers('postgres', home).status).toBe('ok');
  });

  test('a symlinked brain.pglite is not claimed (top-level symlinks skipped)', () => {
    const home = makeHome('symlinked-store');
    const target = makeStore(makeHome('symlink-target-home'), 'brain.pglite', [2048]);
    symlinkSync(target, join(home, 'brain.pglite'));
    expect(assessPgliteLeftovers('postgres', home).status).toBe('ok');
  });

  test('warns on a postgres brain with both the store and its pre-migrate copy', () => {
    const home = makeHome('migrated');
    const live = makeStore(home, 'brain.pglite', [4096, 2048]);
    const pre = makeStore(home, 'brain.pglite.pre-migrate-20260524', [4096]);
    // Freeze mtimes at a known date — the in-the-wild signature (#3856).
    const frozen = new Date('2026-05-24T02:38:42Z');
    utimesSync(live, frozen, frozen);
    utimesSync(pre, frozen, frozen);

    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('warn');
    expect(a.leftovers).toHaveLength(2);
    // Deterministic order (sorted): the store first, then the dotted copy.
    expect(a.leftovers[0]?.path).toBe(live);
    expect(a.leftovers[1]?.path).toBe(pre);
    expect(a.leftovers[0]?.approx_bytes).toBe(4096 + 2048);
    expect(a.leftovers[1]?.approx_bytes).toBe(4096);
    expect(a.leftovers[0]?.size_incomplete).toBe(false);
    // The message carries the receipts: paths, sizes, an honestly-labeled
    // dir mtime (contents can change without touching it), manual remediation.
    expect(a.message).toContain(live);
    expect(a.message).toContain(pre);
    expect(a.message).toContain('dir mtime 2026-05-24');
    expect(a.message).not.toContain('untouched since'); // over-claim, reviewed out
    expect(a.message).toContain('safe to delete by hand');
    expect(a.message).toContain('backup');
    // #3697 guard: the remediation must not invent a CLI surface.
    expect(a.message).not.toMatch(/gbrain (cleanup|migrate cleanup|prune)/);
  });

  test('warns for a pre-migrate copy alone (store already hand-deleted)', () => {
    const home = makeHome('half-cleaned');
    makeStore(home, 'brain.pglite.pre-migrate-20260101', [512]);
    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('warn');
    expect(a.leftovers).toHaveLength(1);
  });

  test('nested symlinks are not followed — the walk cannot escape the store', () => {
    const home = makeHome('nested-symlink');
    const dir = makeStore(home, 'brain.pglite', [1024]);
    const outside = makeHome('outside-data');
    writeFileSync(join(outside, 'big'), Buffer.alloc(8192, 66));
    symlinkSync(outside, join(dir, 'escape'));
    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('warn');
    expect(a.leftovers[0]?.approx_bytes).toBe(1024); // the symlink target's 8 KB is NOT counted
  });

  test('an unreadable subdirectory marks the size incomplete, never exactly 0 B', () => {
    const home = makeHome('unreadable');
    const dir = makeStore(home, 'brain.pglite', [1024]);
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'hidden'), Buffer.alloc(4096, 67));
    chmodSync(locked, 0o000);
    try {
      const a = assessPgliteLeftovers('postgres', home);
      expect(a.status).toBe('warn');
      expect(a.leftovers[0]?.size_incomplete).toBe(true);
      expect(a.message).toContain('>=');
    } finally {
      chmodSync(locked, 0o755); // so afterAll cleanup can delete it
    }
  });

  test('size walk is bounded by an injectable assessment-wide budget', () => {
    const home = makeHome('bounded');
    const a1 = makeStore(home, 'brain.pglite', [10, 10, 10]);
    makeStore(home, 'brain.pglite.pre-migrate-20260202', [10, 10, 10]);
    // Tiny budget: the walk must stop early and mark BOTH floors incomplete
    // (one shared budget — the second dir gets whatever remains).
    const a = assessPgliteLeftovers('postgres', home, 2);
    expect(a.status).toBe('warn');
    expect(a.leftovers).toHaveLength(2);
    expect(a.leftovers.some((l) => l.size_incomplete)).toBe(true);
    expect(a.message).toContain('at least ');
    // Default budget is the exported constant (production callers pass nothing).
    expect(SIZE_WALK_MAX_ENTRIES).toBe(20_000);
    void a1;
  });
});

/**
 * Unit tests for src/core/pglite-leftovers-check.ts (#3856).
 *
 * Tmp-dir fixtures only — fake store dirs with real files, no engine, no
 * network. Mirrors npm-squat-check.test.ts's shape (#505).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { permsEnforced } from './helpers/fs-perms.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessPgliteLeftovers,
  isMigrationLeftoverName,
  MIGRATE_MANIFEST_NAME,
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
  test('matches ONLY brain.pglite — the one dir the engines themselves create', () => {
    expect(isMigrationLeftoverName('brain.pglite')).toBe(true);
    // gbrain never creates `brain.pglite.*` siblings — no version writes a
    // pre-migrate copy (reviewer's full-history pickaxe found no creation
    // site), so every sibling has unknown provenance and is NOT claimed.
    expect(isMigrationLeftoverName('brain.pglite.pre-migrate-20260524')).toBe(false);
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

  test('skips while migrate-manifest.json exists — brain.pglite may be the live migration target', () => {
    // An interrupted postgres -> pglite migration leaves the durable engine
    // at `postgres` (config flips only on clean completion, #3194) while the
    // manifest survives at the home root. brain.pglite is then the LIVE
    // target: the check must not assess it, and must not advise deletion.
    const home = makeHome('mid-migration');
    makeStore(home, 'brain.pglite', [4096]);
    writeFileSync(join(home, MIGRATE_MANIFEST_NAME), '{"schema_version":2}');
    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('skip');
    expect(a.leftovers).toHaveLength(0);
    expect(a.message).toContain('migration is in progress or was interrupted');
    expect(a.message).toContain('not assessing leftovers');
    // No deletion advice of any kind while a migration may be in flight.
    expect(a.message).not.toContain('delete');
    expect(a.message).not.toContain('reclaimable');
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

  test('warns on a postgres brain with the abandoned store — siblings stay unclaimed', () => {
    const home = makeHome('migrated');
    const live = makeStore(home, 'brain.pglite', [4096, 2048]);
    // A pre-migrate-named sibling (no gbrain version creates one — unknown
    // provenance, e.g. an operator script) must never enter the warn.
    const pre = makeStore(home, 'brain.pglite.pre-migrate-20260524', [4096]);
    // Freeze mtime at a known date — the in-the-wild signature (#3856).
    const frozen = new Date('2026-05-24T02:38:42Z');
    utimesSync(live, frozen, frozen);

    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('warn');
    expect(a.leftovers).toHaveLength(1);
    expect(a.leftovers[0]?.path).toBe(live);
    expect(a.leftovers[0]?.approx_bytes).toBe(4096 + 2048);
    expect(a.leftovers[0]?.size_incomplete).toBe(false);
    // The message carries the receipts: path, size, an honestly-labeled
    // dir mtime (contents can change without touching it), manual remediation.
    expect(a.message).toContain(live);
    expect(a.message).not.toContain(pre);
    expect(a.message).not.toContain('pre-migrate');
    expect(a.message).toContain('dir mtime 2026-05-24');
    expect(a.message).not.toContain('untouched since'); // over-claim, reviewed out
    expect(a.message).toContain('safe to delete by hand');
    expect(a.message).toContain('backup');
    // #3697 guard: the remediation must not invent a CLI surface.
    expect(a.message).not.toMatch(/gbrain (cleanup|migrate cleanup|prune)/);
  });

  test('ok for a pre-migrate-named sibling alone — never claimed (unknown provenance)', () => {
    const home = makeHome('sibling-only');
    makeStore(home, 'brain.pglite.pre-migrate-20260101', [512]);
    const a = assessPgliteLeftovers('postgres', home);
    expect(a.status).toBe('ok');
    expect(a.leftovers).toHaveLength(0);
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

  // skipIf: needs a directory whose listing MUST fail (chmod 000) —
  // unrunnable on hosts that don't enforce permission bits.
  test.skipIf(!permsEnforced())('an unreadable subdirectory marks the size incomplete, never exactly 0 B', () => {
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
    makeStore(home, 'brain.pglite', [10, 10, 10]); // 4 entries: base, nested/, nested/f1, nested/f2
    // Tiny budget: the walk must stop early and mark the floor incomplete.
    const a = assessPgliteLeftovers('postgres', home, 2);
    expect(a.status).toBe('warn');
    expect(a.leftovers).toHaveLength(1);
    expect(a.leftovers[0]?.size_incomplete).toBe(true);
    expect(a.message).toContain('at least ');
    // Default budget is the exported constant (production callers pass nothing).
    expect(SIZE_WALK_MAX_ENTRIES).toBe(20_000);
  });
});

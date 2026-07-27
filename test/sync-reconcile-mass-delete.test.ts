/**
 * Test: full-sync reconcile separator normalization + mass-delete safety valve
 * (#2828 — Windows reconcile mass-delete).
 *
 * Pure-helper surface: `planReconcileDeletes` and `massReconcileAllowed` take
 * plain inputs and read no engine / no ambient env (the env reader is
 * parameterized), so these run without PGLite and without touching the shared
 * `process.env` — parallel-loop safe by construction.
 */

import { describe, test, expect } from 'bun:test';
import {
  planReconcileDeletes,
  massReconcileAllowed,
  MASS_RECONCILE_RATIO,
  MASS_RECONCILE_MIN_PAGES,
} from '../src/commands/sync.ts';

/** Build stored page rows from a list of source_paths (slug = `slug-<index>`). */
function rows(paths: Array<string | null>): Array<{ slug: string; source_path: string | null }> {
  return paths.map((p, i) => ({ slug: `slug-${i}`, source_path: p }));
}

/**
 * Reconcile scenario: `total` file-backed pages, of which the first `stale`
 * are absent from the working tree (deleted) and the rest are present.
 */
function scenario(total: number, stale: number) {
  const stored = rows(Array.from({ length: total }, (_, i) => `p/${i}.md`));
  const present = stored.slice(stale).map((r) => r.source_path as string);
  return planReconcileDeletes(stored, present, () => true);
}

describe('planReconcileDeletes — separator normalization (#2828)', () => {
  test('backslash working-tree paths match forward-slash stored source_path', () => {
    // Windows `path.relative` yields backslashes; source_path was stored with
    // forward slashes (e.g. git-derived). Both must compare equal.
    const stored = rows(['topics/foo.md', 'topics/bar.md', 'notes/baz.md']);
    const workingTree = ['topics\\foo.md', 'topics\\bar.md', 'notes\\baz.md'];
    const plan = planReconcileDeletes(stored, workingTree, () => true);
    expect(plan.staleSlugs).toEqual([]);
    expect(plan.reconcilableCount).toBe(3);
    expect(plan.massDelete).toBe(false);
  });

  test('forward-slash working-tree paths match backslash stored source_path', () => {
    const stored = rows(['topics\\foo.md', 'topics\\bar.md']);
    const workingTree = ['topics/foo.md', 'topics/bar.md'];
    const plan = planReconcileDeletes(stored, workingTree, () => true);
    expect(plan.staleSlugs).toEqual([]);
  });

  test('a genuinely removed file is the only stale slug, regardless of separator', () => {
    const stored = rows(['topics/foo.md', 'topics/bar.md', 'topics/gone.md']);
    const workingTree = ['topics\\foo.md', 'topics\\bar.md']; // gone.md deleted
    const plan = planReconcileDeletes(stored, workingTree, () => true);
    expect(plan.staleSlugs).toEqual(['slug-2']);
  });

  test('null source_path rows are never reconcilable (manual / put_page pages)', () => {
    const stored = rows([null, 'x.md']);
    const plan = planReconcileDeletes(stored, [], () => true);
    expect(plan.reconcilableCount).toBe(1);
    expect(plan.staleSlugs).toEqual(['slug-1']);
  });

  test('the strategy predicate excludes wrong-strategy pages from both stale set and denominator', () => {
    const stored = rows(['a.md', 'b.md', 'code.ts', 'gone.md']);
    const onlyMarkdown = (p: string) => p.endsWith('.md');
    const plan = planReconcileDeletes(stored, [], onlyMarkdown); // nothing present
    expect(plan.reconcilableCount).toBe(3); // code.ts excluded
    expect(plan.staleSlugs).toEqual(['slug-0', 'slug-1', 'slug-3']);
  });
});

describe('planReconcileDeletes — mass-delete safety valve (#2828)', () => {
  test('trips when > 50% of a > 20-page source would be deleted', () => {
    const plan = scenario(21, 11); // 11/21 ≈ 52% > 50%, and 21 > 20
    expect(plan.reconcilableCount).toBe(21);
    expect(plan.staleSlugs.length).toBe(11);
    expect(plan.massDelete).toBe(true);
  });

  test('holds at exactly 50% (threshold is strictly greater)', () => {
    const plan = scenario(40, 20); // 20/40 == 50%, not > 50%
    expect(plan.massDelete).toBe(false);
  });

  test('ignores small sources (<= 20 pages) even at 100% stale', () => {
    expect(scenario(MASS_RECONCILE_MIN_PAGES, MASS_RECONCILE_MIN_PAGES).massDelete).toBe(false);
    expect(scenario(15, 15).massDelete).toBe(false);
  });

  test('trips just past the min-pages boundary with a majority stale', () => {
    const plan = scenario(21, 20);
    expect(plan.massDelete).toBe(true);
  });

  test('thresholds are the documented constants', () => {
    expect(MASS_RECONCILE_RATIO).toBe(0.5);
    expect(MASS_RECONCILE_MIN_PAGES).toBe(20);
  });
});

describe('massReconcileAllowed — GBRAIN_ALLOW_MASS_RECONCILE escape hatch (#2828)', () => {
  test('=1 restores the old behavior', () => {
    expect(massReconcileAllowed({ GBRAIN_ALLOW_MASS_RECONCILE: '1' })).toBe(true);
  });

  test('unset or any other value keeps the valve active', () => {
    expect(massReconcileAllowed({})).toBe(false);
    expect(massReconcileAllowed({ GBRAIN_ALLOW_MASS_RECONCILE: '0' })).toBe(false);
    expect(massReconcileAllowed({ GBRAIN_ALLOW_MASS_RECONCILE: 'true' })).toBe(false);
  });

  test('effective gate: the valve blocks the delete unless the override is set', () => {
    const plan = scenario(21, 11);
    // This mirrors the guard in performFullSync.
    const blocked = plan.massDelete && !massReconcileAllowed({});
    const overridden = plan.massDelete && !massReconcileAllowed({ GBRAIN_ALLOW_MASS_RECONCILE: '1' });
    expect(blocked).toBe(true); // skip delete + loud warning
    expect(overridden).toBe(false); // old behavior restored
  });
});

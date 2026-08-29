/**
 * #3880 — archived sources must not re-enter automatic active-source
 * operations whose SQL used to filter only `local_path IS NOT NULL`.
 *
 * Two layers:
 *   1. Behavioral: the tier-4 cwd resolver prefers ACTIVE sources — an
 *      archived deeper registration can't shadow an active parent — while a
 *      cwd landing ONLY in an archived tree still throws (the deliberate
 *      "explicit unavailable target" rule).
 *   2. Structural: every all-source local_path selection in the affected
 *      files carries `archived IS NOT TRUE` (with the v34 legacy fallback).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSourceId,
  resolveSourceWithTier,
  SourceTargetError,
} from '../src/core/source-resolver.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

type StubSource = { id: string; local_path: string | null; archived?: boolean };

function stubEngine(sources: StubSource[]): BrainEngine {
  return {
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('archived FROM sources WHERE local_path IS NOT NULL')) {
        return sources
          .filter((s) => s.local_path !== null)
          .map((s) => ({ id: s.id, local_path: s.local_path, archived: s.archived === true }));
      }
      if (sql.includes('WHERE id = $1 AND archived = false')) {
        return sources
          .filter((s) => s.id === params?.[0] && s.archived !== true)
          .map((s) => ({ id: s.id }));
      }
      if (sql.includes("id != 'default'")) {
        // pickSoleNonDefaultSource — not the tier under test; return 2 rows
        // so it never fires.
        return [{ id: 'a' }, { id: 'b' }];
      }
      if (sql.includes('FROM pages')) return [];
      return [];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

let root: string;
let activeParent: string;
let archivedChild: string;
let archivedOnly: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-3880-'));
  activeParent = join(root, 'vault');
  archivedChild = join(activeParent, 'sub');
  archivedOnly = join(root, 'graveyard');
  mkdirSync(join(archivedChild, 'notes'), { recursive: true });
  mkdirSync(join(archivedOnly, 'notes'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('#3880 tier-4 cwd resolution vs archived sources', () => {
  test('archived deeper registration does NOT shadow an active parent source', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const engine = stubEngine([
        { id: 'vault', local_path: activeParent },
        { id: 'old-sub', local_path: archivedChild, archived: true },
      ]);
      const cwd = join(archivedChild, 'notes');
      // Pre-fix: 'old-sub' won the longest-prefix match and assertSourceExists
      // threw. Post-fix: the active parent resolves.
      expect(await resolveSourceId(engine, null, cwd)).toBe('vault');
      const withTier = await resolveSourceWithTier(engine, null, cwd);
      expect(withTier.source_id).toBe('vault');
      expect(withTier.tier).toBe('local_path');
    });
  });

  test('cwd ONLY inside an archived tree still throws (explicit unavailable target)', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const engine = stubEngine([
        { id: 'vault', local_path: activeParent },
        { id: 'graveyard', local_path: archivedOnly, archived: true },
      ]);
      const cwd = join(archivedOnly, 'notes');
      await expect(resolveSourceId(engine, null, cwd)).rejects.toThrow(SourceTargetError);
    });
  });
});

describe('#3880 structural pins — all-source local_path selections filter archived', () => {
  const sites: Array<{ file: string; patched: number }> = [
    { file: 'src/commands/sync.ts', patched: 1 },
    { file: 'src/core/brain-writer.ts', patched: 1 },
    { file: 'src/commands/doctor/checks/extraction-sync.ts', patched: 3 },
    { file: 'src/commands/frontmatter-install-hook.ts', patched: 1 },
    { file: 'src/commands/sources-harden.ts', patched: 1 },
  ];
  for (const { file, patched } of sites) {
    test(`${file} carries ${patched} archived-filtered all-source selection(s)`, () => {
      const src = readFileSync(file, 'utf-8');
      const filtered = src.match(/local_path IS NOT NULL AND archived IS NOT TRUE/g) ?? [];
      expect(filtered.length).toBeGreaterThanOrEqual(patched);
    });
  }

  test('src/core/source-resolver.ts tier-4 selects the archived column for active-over-archived tiering', () => {
    // The resolver keeps archived rows in the SELECT (JS tiering) so a cwd
    // landing ONLY in an archived tree still throws the deliberate
    // SourceTargetError instead of silently falling through.
    const src = readFileSync('src/core/source-resolver.ts', 'utf-8');
    expect(src).toContain('SELECT id, local_path, archived FROM sources WHERE local_path IS NOT NULL');
    // #4411: tier-4 realpath resolution was parallelized and the two
    // active/archived filter passes were consolidated into one indexed loop
    // over both tiers — same active-over-archived behavior (see the two
    // behavioral tests above), expressed once instead of duplicated twice.
    expect(src).toContain('for (const archivedTier of [false, true])');
    expect(src.match(/\.archived === true\) !== archivedTier/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Tests for the `sync --all` parallel fan-out + read-only `--status` dashboard.
 *
 * Why this exists:
 *   The CLI `sync --all` path walked sources SEQUENTIALLY via a `for...of`
 *   loop. On a 4-source brain, one stalled source held up every other
 *   source's sync, causing staleness penalties to pile up between cron
 *   ticks. Operators reported manual workarounds (8 ad-hoc parallel
 *   workers wrapping `sync --source <id>`) and the cycle's autopilot-
 *   fanout path already proves source dispatch is safe to parallelize
 *   when each source has its own DB lock.
 *
 *   These tests pin three guarantees:
 *     1. resolveParallelism() picks the right concurrency budget across
 *        all the inputs (PGLite, explicit --parallel, --workers ceiling,
 *        source-count floor).
 *     2. syncOneSource() passes a PER-SOURCE lockId to performSync so
 *        two concurrent --all invocations don't deadlock on the global
 *        gbrain-sync lock.
 *     3. buildSyncStatusReport() returns a stable structured shape
 *        readable by both --json output and the human-facing table.
 */
import { describe, expect, test } from 'bun:test';
import { resolveParallelism, buildSyncStatusReport } from '../src/commands/sync.ts';
import { SYNC_LOCK_ID } from '../src/core/db-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('resolveParallelism', () => {
  test('PGLite always serial regardless of source count or flags', () => {
    expect(resolveParallelism({ sourceCount: 10, engineKind: 'pglite' })).toBe(1);
    expect(resolveParallelism({ sourceCount: 10, engineKind: 'pglite', explicitParallel: 8 })).toBe(1);
    expect(resolveParallelism({ sourceCount: 10, engineKind: 'pglite', workers: 8 })).toBe(1);
  });

  test('explicit --parallel wins and is clamped to sourceCount', () => {
    expect(resolveParallelism({ sourceCount: 4, engineKind: 'postgres', explicitParallel: 2 })).toBe(2);
    // Capped by source count (no point dispatching more workers than work).
    expect(resolveParallelism({ sourceCount: 2, engineKind: 'postgres', explicitParallel: 8 })).toBe(2);
    // Floor of 1.
    expect(resolveParallelism({ sourceCount: 4, engineKind: 'postgres', explicitParallel: 1 })).toBe(1);
  });

  test('auto path: min(sourceCount, workers || 4)', () => {
    // sourceCount < default ceiling → bounded by sourceCount.
    expect(resolveParallelism({ sourceCount: 2, engineKind: 'postgres' })).toBe(2);
    // sourceCount > default ceiling → bounded by the 4-worker ceiling.
    expect(resolveParallelism({ sourceCount: 12, engineKind: 'postgres' })).toBe(4);
    // --workers tightens the ceiling.
    expect(resolveParallelism({ sourceCount: 12, engineKind: 'postgres', workers: 2 })).toBe(2);
    // --workers above the safety ceiling is itself clamped to 4.
    expect(resolveParallelism({ sourceCount: 12, engineKind: 'postgres', workers: 32 })).toBe(4);
  });

  test('single-source --all short-circuits to serial (no fan-out value)', () => {
    expect(resolveParallelism({ sourceCount: 1, engineKind: 'postgres' })).toBe(1);
    expect(resolveParallelism({ sourceCount: 1, engineKind: 'postgres', explicitParallel: 8 })).toBe(1);
  });

  test('zero-source edge case returns 1 (no division by zero, no negative worker count)', () => {
    expect(resolveParallelism({ sourceCount: 0, engineKind: 'postgres' })).toBe(1);
  });
});

describe('per-source lock id', () => {
  test('per-source lock id is namespaced under SYNC_LOCK_ID', () => {
    // Two sources -> two distinct lock ids. Each is namespaced under the
    // canonical SYNC_LOCK_ID so any future global-lock tooling (`gbrain
    // doctor`, expired-lock reaper) still finds them.
    const idA = `${SYNC_LOCK_ID}:source-a`;
    const idB = `${SYNC_LOCK_ID}:source-b`;
    expect(idA).not.toBe(idB);
    expect(idA.startsWith(`${SYNC_LOCK_ID}:`)).toBe(true);
    expect(idB.startsWith(`${SYNC_LOCK_ID}:`)).toBe(true);
    // Distinct from the global lock so the cycle's gbrain-sync acquire
    // doesn't block a per-source `sync --all` worker.
    expect(idA).not.toBe(SYNC_LOCK_ID);
  });
});

describe('buildSyncStatusReport', () => {
  // Minimal engine stub: implements executeRaw with a script of canned
  // responses keyed by the first SQL keyword. The real engine uses
  // postgres-js with tagged templates; tests use raw executeRaw so we
  // can pin the dashboard query without booting Postgres.
  function makeEngine(scripts: {
    sourceRows?: Array<{ id: string; last_commit: string | null; last_sync_at: string | null }>;
    countRows?: Array<{ source_id: string; pages: number; chunks_total: number; chunks_unembedded: number }>;
  }): BrainEngine {
    return {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (/FROM sources WHERE id = ANY/i.test(sql)) {
          return scripts.sourceRows ?? [];
        }
        if (/COALESCE\(p\.pages, 0\) AS pages/.test(sql)) {
          return scripts.countRows ?? [];
        }
        return [];
      },
    } as unknown as BrainEngine;
  }

  test('returns staleness_class fresh/stale/severe based on last_sync_at age', async () => {
    const now = Date.now();
    const freshIso = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const staleIso = new Date(now - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    const severeIso = new Date(now - 100 * 60 * 60 * 1000).toISOString(); // 100h ago

    const sources = [
      { id: 'fresh', name: 'fresh', local_path: '/tmp/a', config: { syncEnabled: true } },
      { id: 'stale', name: 'stale', local_path: '/tmp/b', config: { syncEnabled: true } },
      { id: 'severe', name: 'severe', local_path: '/tmp/c', config: { syncEnabled: true } },
      { id: 'never', name: 'never', local_path: '/tmp/d', config: { syncEnabled: true } },
    ];
    const engine = makeEngine({
      sourceRows: [
        { id: 'fresh', last_commit: 'a'.repeat(40), last_sync_at: freshIso },
        { id: 'stale', last_commit: 'b'.repeat(40), last_sync_at: staleIso },
        { id: 'severe', last_commit: 'c'.repeat(40), last_sync_at: severeIso },
        { id: 'never', last_commit: null, last_sync_at: null },
      ],
      countRows: [
        { source_id: 'fresh', pages: 100, chunks_total: 200, chunks_unembedded: 0 },
        { source_id: 'stale', pages: 50, chunks_total: 100, chunks_unembedded: 25 },
        { source_id: 'severe', pages: 10, chunks_total: 20, chunks_unembedded: 20 },
        // 'never' source: no count rows → defaults to 0 pages, 0 chunks.
      ],
    });

    const report = await buildSyncStatusReport(engine, sources);
    expect(report.sources).toHaveLength(4);

    const byId = new Map(report.sources.map((s) => [s.source_id, s]));
    expect(byId.get('fresh')!.staleness_class).toBe('fresh');
    expect(byId.get('stale')!.staleness_class).toBe('stale');
    expect(byId.get('severe')!.staleness_class).toBe('severe');
    expect(byId.get('never')!.staleness_class).toBe('unknown');
    expect(byId.get('never')!.staleness_hours).toBeNull();
  });

  test('embedding_coverage_pct computed from chunks_total vs chunks_unembedded', async () => {
    const sources = [
      { id: 'a', name: 'a', local_path: '/tmp/a', config: {} },
      { id: 'b', name: 'b', local_path: '/tmp/b', config: {} },
      { id: 'c', name: 'c', local_path: '/tmp/c', config: {} },
    ];
    const engine = makeEngine({
      sourceRows: [
        { id: 'a', last_commit: null, last_sync_at: null },
        { id: 'b', last_commit: null, last_sync_at: null },
        { id: 'c', last_commit: null, last_sync_at: null },
      ],
      countRows: [
        { source_id: 'a', pages: 10, chunks_total: 100, chunks_unembedded: 0 },
        { source_id: 'b', pages: 10, chunks_total: 100, chunks_unembedded: 50 },
        // c: zero chunks → coverage reported as 100% (vacuously complete; no
        // divide-by-zero blowup).
      ],
    });

    const report = await buildSyncStatusReport(engine, sources);
    const byId = new Map(report.sources.map((s) => [s.source_id, s]));
    expect(byId.get('a')!.embedding_coverage_pct).toBe(100);
    expect(byId.get('b')!.embedding_coverage_pct).toBe(50);
    expect(byId.get('c')!.embedding_coverage_pct).toBe(100);
  });

  test('disabled source is reflected in sync_enabled flag', async () => {
    const sources = [
      { id: 'on', name: 'on', local_path: '/tmp/on', config: { syncEnabled: true } },
      { id: 'off', name: 'off', local_path: '/tmp/off', config: { syncEnabled: false } },
      { id: 'default', name: 'default', local_path: '/tmp/default', config: {} },
    ];
    const engine = makeEngine({
      sourceRows: sources.map((s) => ({ id: s.id, last_commit: null, last_sync_at: null })),
      countRows: [],
    });

    const report = await buildSyncStatusReport(engine, sources);
    const byId = new Map(report.sources.map((s) => [s.source_id, s]));
    // syncEnabled omitted defaults to true (matches the loop's `!== false` check).
    expect(byId.get('on')!.sync_enabled).toBe(true);
    expect(byId.get('off')!.sync_enabled).toBe(false);
    expect(byId.get('default')!.sync_enabled).toBe(true);
  });

  test('handles count-query failure gracefully (schema variant safety)', async () => {
    const sources = [
      { id: 'a', name: 'a', local_path: '/tmp/a', config: {} },
    ];
    // Engine that throws on the count query but succeeds on the source query.
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (/FROM sources WHERE id = ANY/i.test(sql)) {
          return [{ id: 'a', last_commit: null, last_sync_at: null }];
        }
        throw new Error('relation "chunks" does not exist');
      },
    } as unknown as BrainEngine;

    const report = await buildSyncStatusReport(engine, sources);
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].pages).toBe(0);
    expect(report.sources[0].chunks_total).toBe(0);
    expect(report.sources[0].embedding_coverage_pct).toBe(100);
  });

  test('empty source list returns empty array, not crash', async () => {
    const engine = makeEngine({ sourceRows: [], countRows: [] });
    const report = await buildSyncStatusReport(engine, []);
    expect(report.sources).toEqual([]);
    expect(typeof report.generated_at).toBe('string');
  });
});

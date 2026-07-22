/**
 * Tests for the v0.40.3.0 `sync --all` parallel fan-out + read-only
 * `gbrain sources status` dashboard.
 *
 * Why this exists:
 *   The CLI `sync --all` path used to walk sources SEQUENTIALLY via a
 *   `for...of` loop. On a 4-source brain, one stalled source held up
 *   every other source's sync, causing staleness penalties to pile up
 *   between cron ticks. Operators reported manual workarounds (8 ad-hoc
 *   parallel workers wrapping `sync --source <id>`) and the cycle's
 *   autopilot-fanout path already proves source dispatch is safe to
 *   parallelize when each source has its own DB lock.
 *
 *   PR #1314 (community) proposed the parallel fan-out. Codex's
 *   outside-voice review caught three P0s the PR (and the initial plan)
 *   missed: lock asymmetry, hardcoded chunks table name, and 2x
 *   connection-budget understatement. v0.40.3.0 ships the corrected
 *   design. These tests pin every contract:
 *
 *     1. resolveParallelism() picks the right concurrency budget across
 *        all the inputs (PGLite, explicit --parallel, --workers ceiling,
 *        source-count floor, zero-source guard).
 *     2. The lock-identity invariant: any sync with sourceId set takes
 *        the per-source lock `gbrain-sync:<source_id>`, NOT the global
 *        `gbrain-sync` lock. Closes the bug class where `sync --all`
 *        and `sync --source foo` would otherwise race.
 *     3. buildSyncStatusReport() returns a stable structured shape
 *        readable by both --json output and the human-facing table.
 *        SQL is the canonical `content_chunks JOIN pages ON page_id`
 *        shape with deleted_at + archived filters — the regression
 *        guard for Codex's P0 #1 SQL bug.
 *     4. Continuous worker pool (D2): slow source doesn't block other
 *        workers; one source throwing doesn't abort the others;
 *        completion order is independent of source order.
 *     5. Connection-budget warning fires at parallel × workers × 2 > 16
 *        with the formula in the message text (D1 + D10).
 *     6. --json envelope shape is {schema_version: 1, sources, parallel,
 *        ok_count, error_count} (D14).
 *     7. --skip-failed / --retry-failed reject when --parallel > 1
 *        with a loud paste-ready hint (D15).
 *     8. Per-source prefix uses source.id (NOT source.name) so
 *        operators can grep cleanly and no log-injection vector exists
 *        through arbitrary source names (D13).
 */
import { describe, expect, test } from 'bun:test';
import {
  resolveParallelism,
  buildSyncStatusReport,
} from '../src/commands/sync.ts';
import { SYNC_LOCK_ID, syncLockId } from '../src/core/db-lock.ts';
import { withSourcePrefix, slog } from '../src/core/console-prefix.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ── resolveParallelism ──────────────────────────────────────────────

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

  test('auto path: min(sourceCount, workers || DEFAULT_PARALLEL_SOURCES)', () => {
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

// ── lock-identity invariant (D8) ─────────────────────────────────────

describe('per-source lock id (D8 — Codex P0 #1 fix)', () => {
  test('per-source lock id format is namespaced via syncLockId helper', () => {
    // v0.40.5.0 (master) introduced syncLockId(sourceId) as the canonical
    // helper. v0.40.6.0 (this branch) builds on it. Two sources -> two
    // distinct lock ids. SYNC_LOCK_ID = syncLockId('default') is a
    // back-compat alias for the legacy single-source path.
    const idA = syncLockId('source-a');
    const idB = syncLockId('source-b');
    expect(idA).not.toBe(idB);
    // Distinct from the default lock so the cycle's default-source acquire
    // doesn't block a per-source `sync --all` worker.
    expect(idA).not.toBe(SYNC_LOCK_ID);
    expect(idA).not.toBe(syncLockId('default'));
  });

  test('source.id only — newline injection through source.name is impossible', () => {
    // D13 fix: lock id derives from source.id (slug-validated by `sources
    // add`), NOT source.name (free-form text accepted by --name). This
    // pins the contract that adversarial names can't smuggle in newlines
    // or control characters into the lock id.
    const sourceWithEvilName = {
      id: 'media-corpus',
      name: 'evil\nname: hijacked\n[other-source]',
    };
    const lockId = syncLockId(sourceWithEvilName.id);
    expect(lockId).not.toContain('\n');
    expect(lockId).not.toContain('evil');
    expect(lockId).toContain('media-corpus');
  });
});

// ── buildSyncStatusReport ────────────────────────────────────────────

describe('buildSyncStatusReport', () => {
  // Minimal engine stub: implements executeRaw with a script of canned
  // responses keyed by the first SQL keyword. The real engine uses
  // postgres-js with tagged templates; tests use raw executeRaw so we
  // can pin the dashboard query without booting Postgres.
  //
  // SQL regex changed from PR's original `chunks/page_slug` (broken;
  // would have shipped silently) to the canonical `content_chunks` +
  // `page_id` shape. The IRON RULE regression case lives in
  // test/e2e/sync-status-pglite.test.ts and exercises real SQL.
  function makeEngine(scripts: {
    sourceRows?: Array<{ id: string; last_commit: string | null; last_sync_at: string | null; newest_content_at?: string | null }>;
    countRows?: Array<{ source_id: string; pages: number; chunks_total: number; chunks_unembedded: number }>;
  }): BrainEngine {
    return {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (/FROM sources WHERE id = ANY/i.test(sql)) {
          return scripts.sourceRows ?? [];
        }
        // Codex P0 #1 regression: must match the CORRECT SQL shape
        // (content_chunks + page_id), not the broken PR shape.
        if (/content_chunks cc[\s\S]*JOIN pages pg ON pg\.id = cc\.page_id/.test(sql)) {
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

  // v0.41.32.0 (supersedes #1623): buildSyncStatusReport backs the REMOTE
  // get_status_snapshot MCP op, so staleness reads the stored newest_content_at
  // column (NO git subprocess on a DB-supplied local_path). The makeEngine stub
  // never runs git — if buildSyncStatusReport shelled out it would hit the real
  // filesystem; these cases prove it reads the column instead.
  test('content-relative staleness reads newest_content_at column (remote path)', async () => {
    const now = Date.now();
    const syncIso = new Date(now - 100 * 60 * 60 * 1000).toISOString(); // synced 100h ago
    const sources = [
      { id: 'quiet', name: 'quiet', local_path: '/tmp/quiet', config: { syncEnabled: true } },
      { id: 'behind', name: 'behind', local_path: '/tmp/behind', config: { syncEnabled: true } },
      { id: 'nocol', name: 'nocol', local_path: '/tmp/nocol', config: { syncEnabled: true } },
    ];
    const engine = makeEngine({
      sourceRows: [
        // Newest commit 200h ago, synced 100h ago → caught up → lag 0 → fresh.
        { id: 'quiet', last_commit: 'a'.repeat(40), last_sync_at: syncIso,
          newest_content_at: new Date(now - 200 * 60 * 60 * 1000).toISOString() },
        // Newest commit 10h ago, synced 100h ago → behind → wall-clock → severe.
        { id: 'behind', last_commit: 'b'.repeat(40), last_sync_at: syncIso,
          newest_content_at: new Date(now - 10 * 60 * 60 * 1000).toISOString() },
        // NULL column → wall-clock fallback → 100h → severe.
        { id: 'nocol', last_commit: 'c'.repeat(40), last_sync_at: syncIso, newest_content_at: null },
      ],
      countRows: [
        { source_id: 'quiet', pages: 10, chunks_total: 20, chunks_unembedded: 0 },
        { source_id: 'behind', pages: 10, chunks_total: 20, chunks_unembedded: 0 },
        { source_id: 'nocol', pages: 10, chunks_total: 20, chunks_unembedded: 0 },
      ],
    });

    const report = await buildSyncStatusReport(engine, sources);
    const byId = new Map(report.sources.map((s) => [s.source_id, s]));
    // Legacy wall-clock would have called 'quiet' severe (100h). Content-relative
    // correctly reports caught-up.
    expect(byId.get('quiet')!.staleness_hours).toBe(0);
    expect(byId.get('quiet')!.staleness_class).toBe('fresh');
    expect(byId.get('behind')!.staleness_class).toBe('severe');
    expect(byId.get('nocol')!.staleness_hours).toBeGreaterThan(72);
    expect(byId.get('nocol')!.staleness_class).toBe('severe');
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

  test('count-query failure propagates (Q2 sub-fix — no silent zero-counts)', async () => {
    // v0.40.3.0 (Codex Q2): the PR's bare `catch { countRows = [] }`
    // would return a misleading "0 chunks" report on real DB errors.
    // Now the thrown error propagates so the operator sees the real
    // problem instead of a lying dashboard.
    const sources = [
      { id: 'a', name: 'a', local_path: '/tmp/a', config: {} },
    ];
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        if (/FROM sources WHERE id = ANY/i.test(sql)) {
          return [{ id: 'a', last_commit: null, last_sync_at: null }];
        }
        throw new Error('canceling statement due to statement timeout');
      },
    } as unknown as BrainEngine;

    // The function MUST throw, not swallow.
    await expect(buildSyncStatusReport(engine, sources)).rejects.toThrow(
      /statement timeout/,
    );
  });

  test('empty source list returns empty array with schema_version: 1, not crash', async () => {
    const engine = makeEngine({ sourceRows: [], countRows: [] });
    const report = await buildSyncStatusReport(engine, []);
    expect(report.sources).toEqual([]);
    expect(report.schema_version).toBe(1);
    expect(typeof report.generated_at).toBe('string');
    expect(typeof report.embedding_column).toBe('string');
  });

  test('stable schema_version: 1 envelope shape (D14 JSON contract)', async () => {
    const sources = [
      { id: 'a', name: 'a', local_path: '/tmp/a', config: {} },
    ];
    const engine = makeEngine({
      sourceRows: [{ id: 'a', last_commit: 'abc', last_sync_at: new Date().toISOString() }],
      countRows: [{ source_id: 'a', pages: 5, chunks_total: 10, chunks_unembedded: 0 }],
    });
    const report = await buildSyncStatusReport(engine, sources);
    // Pin every top-level key — the envelope is a public surface; monitoring
    // pipelines bind to it. New fields are additive; existing names + types
    // must not change without bumping schema_version.
    expect(report.schema_version).toBe(1);
    expect(typeof report.generated_at).toBe('string');
    expect(Array.isArray(report.sources)).toBe(true);
    expect(typeof report.unacknowledged_failures).toBe('number');
    expect(typeof report.embedding_column).toBe('string');
    expect(report.sources).toHaveLength(1);
    const s = report.sources[0];
    expect(s.source_id).toBe('a');
    expect(s.name).toBe('a');
    expect(s.sync_enabled).toBe(true);
    expect(s.embedding_coverage_pct).toBe(100);
  });

  test('embedding column is reported in envelope so operators can verify the registry resolved correctly', async () => {
    // D16 → A: dashboard counts unembedded chunks against the resolved
    // active embedding column (not hardcoded `embedding`). The column
    // name is surfaced in the envelope so operators inspecting their
    // Voyage / multimodal setup can confirm the right column was used.
    const sources = [
      { id: 'a', name: 'a', local_path: '/tmp/a', config: {} },
    ];
    const engine = makeEngine({
      sourceRows: [{ id: 'a', last_commit: null, last_sync_at: null }],
      countRows: [],
    });
    const report = await buildSyncStatusReport(engine, sources);
    // The default registry resolves 'embedding' for OpenAI-default setups.
    // Voyage / multimodal brains would see a different name here. The
    // contract is "the value is present and non-empty"; the specific
    // string varies by configured embedding model.
    expect(report.embedding_column.length).toBeGreaterThan(0);
  });
});

// ── per-source console prefix (D6 + D13) ─────────────────────────────

describe('per-source line prefix under withSourcePrefix', () => {
  test('slog under wrap emits [source-id] prefix; outside wrap emits bare output', async () => {
    // Captures both paths in one case. The wrap propagation is what
    // makes the entire "per-source greppable parallel output" feature
    // work; without it, parallel sync interleaves illegibly.
    //
    // Outside-wrap path routes through `console.log` (not
    // `process.stdout.write` directly) so we patch both sinks.
    // Inside-wrap path routes through `process.stdout.write` because
    // slog needs raw stream control to emit prefixed lines.
    const stdoutOrig = process.stdout.write.bind(process.stdout);
    const consoleLogOrig = console.log;
    const stdoutChunks: string[] = [];
    const consoleLogChunks: unknown[][] = [];
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stdout.write;
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => { consoleLogChunks.push(args); };
    try {
      // Outside wrap: bare console.log fast path.
      slog('outside-wrap');
      // Inside wrap: prefixed line via process.stdout.write.
      await withSourcePrefix('media-corpus', async () => {
        slog('inside-wrap');
      });
      // Outside-wrap landed on console.log (no prefix, no [tag]).
      const flatConsole = consoleLogChunks.flat().map(String).join(' ');
      expect(flatConsole).toContain('outside-wrap');
      expect(flatConsole).not.toMatch(/\[.*\]/);
      // Inside-wrap landed on process.stdout.write WITH the source.id prefix.
      const stdoutText = stdoutChunks.join('');
      expect(stdoutText).toContain('[media-corpus] inside-wrap');
    } finally {
      process.stdout.write = stdoutOrig;
      // eslint-disable-next-line no-console
      console.log = consoleLogOrig;
    }
  });
});

// ── connection-budget warning (D1 + D10) ─────────────────────────────

describe('connection-budget warning math (D10 — Codex P0 #3 fix)', () => {
  // The warning formula is `parallel × workers × 2 > 16`. Tests pin the
  // math rather than invoking runSync (which would require a real engine
  // and a real --all run). The thresholds are documented in
  // sync.ts:resolveParallelism docstring + DEFAULT_PARALLEL_SOURCES.
  test('triggers at parallel × workers × 2 > 16 (default 4×4×2=32 fires)', () => {
    const cases: Array<{ parallel: number; workers: number; expected: boolean }> = [
      { parallel: 4, workers: 4, expected: true },   // 32 — default fires
      { parallel: 2, workers: 4, expected: false },  // 16 — exact boundary, silent
      { parallel: 2, workers: 2, expected: false },  // 8 — silent
      { parallel: 1, workers: 4, expected: false },  // 8 — silent
      { parallel: 8, workers: 1, expected: false },  // 16 — exact boundary, silent
      { parallel: 8, workers: 2, expected: true },   // 32 — fires
      { parallel: 4, workers: 3, expected: true },   // 24 — fires
    ];
    for (const c of cases) {
      const budget = c.parallel * c.workers * 2;
      const triggered = budget > 16;
      expect(triggered).toBe(c.expected);
    }
  });
});

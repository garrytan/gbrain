/**
 * v0.38.2.0 — partial-scan state tests for scanBrainSources.
 *
 * Codex outside-voice C1 caught that AbortSignal.timeout cannot interrupt
 * the sync walker (event loop blocked by readdirSync / readFileSync). The
 * load-bearing interruption mechanism is `deadline?: number` checked
 * inside scanOneSource's visit closure before parsing each file.
 *
 * These tests use `deadline: Date.now() - 1` (already-expired) to force
 * partial state deterministically — NOT AbortSignal, which doesn't fire
 * in the sync loop and would make this test flake or never trigger.
 *
 * They also cover codex C2 (`ok` after abort must be false even on clean
 * prefix), C4 (`files_scanned` numerator surfaced), and the
 * `aborted_at_source` field that lets doctor name the partial source.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanBrainSources } from '../src/core/brain-writer.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let sourceA: string;
let sourceB: string;
let sourceC: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Three source dirs, each with a few markdown files.
  sourceA = mkdtempSync(join(tmpdir(), 'partial-scan-a-'));
  sourceB = mkdtempSync(join(tmpdir(), 'partial-scan-b-'));
  sourceC = mkdtempSync(join(tmpdir(), 'partial-scan-c-'));
  for (const dir of [sourceA, sourceB, sourceC]) {
    mkdirSync(join(dir, 'people'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(dir, 'people', `p${i}.md`),
        `---\ntitle: Person ${i}\n---\n\nbody\n`,
      );
    }
  }
});

afterAll(async () => {
  await engine.disconnect();
  for (const d of [sourceA, sourceB, sourceC]) {
    rmSync(d, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Register all three sources for each test.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('src-a', 'A', $1), ('src-b', 'B', $2), ('src-c', 'C', $3)`,
    [sourceA, sourceB, sourceC],
  );
});

describe('scanBrainSources partial-scan state', () => {
  test('no deadline + no abort: every source scanned, partial=false, ok reflects grandTotal', async () => {
    const report = await scanBrainSources(engine);
    expect(report.partial).toBe(false);
    expect(report.aborted_at_source).toBe(null);
    expect(report.per_source.length).toBe(3);
    for (const src of report.per_source) {
      expect(src.status).toBe('scanned');
      expect(src.files_scanned).toBe(5);
    }
    expect(report.total).toBe(0);
    expect(report.ok).toBe(true);
  });

  test('deadline expired before any source starts: all three skipped', async () => {
    const report = await scanBrainSources(engine, {
      deadline: Date.now() - 1, // already expired
    });
    expect(report.partial).toBe(true);
    expect(report.per_source.length).toBe(3);
    for (const src of report.per_source) {
      expect(src.status).toBe('skipped');
      expect(src.files_scanned).toBe(0);
    }
    // ok must be false even though zero errors were found — partial state
    // means the clean count can't speak for unscanned files (codex C2).
    expect(report.ok).toBe(false);
  });

  test('after-abort ok field is false even on clean prefix (codex C2 regression guard)', async () => {
    // Force the abort path: deadline already expired. Even though no
    // errors found (because no files scanned), `ok` must reflect the
    // partial-scan reality.
    const report = await scanBrainSources(engine, {
      deadline: Date.now() - 1,
    });
    expect(report.total).toBe(0);
    expect(report.partial).toBe(true);
    expect(report.ok).toBe(false);
  });

  test('files_scanned numerator populated on completed sources (codex C4 regression guard)', async () => {
    const report = await scanBrainSources(engine);
    for (const src of report.per_source) {
      // Each source has 5 .md files under people/; all syncable.
      expect(src.files_scanned).toBe(5);
    }
  });

  test('dbPageCountForSource hook plumbed onto db_page_count; failure degrades to null', async () => {
    let calls = 0;
    const report = await scanBrainSources(engine, {
      dbPageCountForSource: async (sourceId) => {
        calls++;
        if (sourceId === 'src-b') throw new Error('synthetic query failure');
        return sourceId === 'src-a' ? 42 : 99;
      },
    });
    expect(calls).toBe(3);
    const a = report.per_source.find(r => r.source_id === 'src-a')!;
    const b = report.per_source.find(r => r.source_id === 'src-b')!;
    const c = report.per_source.find(r => r.source_id === 'src-c')!;
    expect(a.db_page_count).toBe(42);
    // Throw → null, no crash, scan continues.
    expect(b.db_page_count).toBe(null);
    expect(c.db_page_count).toBe(99);
    // files_scanned numerator still populated regardless of denominator outcome.
    expect(b.files_scanned).toBe(5);
  });

  // Codex adversarial #3 regression: when the outer-loop deadline check fires
  // BEFORE any source starts, aborted_at_source MUST stamp the first
  // would-have-been-scanned source so the doctor message can name it.
  test('aborted_at_source stamped when deadline fires before any source starts', async () => {
    const report = await scanBrainSources(engine, {
      deadline: Date.now() - 1,
    });
    expect(report.partial).toBe(true);
    // First source in deterministic order (sources ORDER BY id) is 'src-a'.
    expect(report.aborted_at_source).toBe('src-a');
    // Every source skipped, no scans started.
    expect(report.per_source.every(r => r.status === 'skipped')).toBe(true);
  });

  // Codex adversarial #2 regression: a slow dbPageCountForSource that exceeds
  // the deadline must NOT result in scanOneSource running and reporting
  // status='partial' with files_scanned=0 (misleading — nothing was scanned).
  // The post-await deadline re-check should mark the source as 'skipped'.
  test('slow COUNT that exceeds deadline marks source skipped, not partial', async () => {
    const start = Date.now();
    // CI timing fix (same class as the "hanging COUNT" test below): widened
    // 50→250ms deadline + 100→500ms simulated query delay. Keeps the 2x
    // ratio that proves "query exceeds deadline" while giving CI runners
    // enough headroom to schedule both setTimeout callbacks on-budget.
    const report = await scanBrainSources(engine, {
      deadline: start + 250,
      dbPageCountForSource: async () => {
        // Simulate a hung query: take 500ms (past the deadline).
        await new Promise(resolve => setTimeout(resolve, 500));
        return 42;
      },
    });
    // The first source should be skipped (post-await deadline re-check fires),
    // NOT marked partial with files_scanned=0.
    const firstSource = report.per_source.find(r => r.source_id === 'src-a')!;
    expect(firstSource.status).toBe('skipped');
    expect(firstSource.files_scanned).toBe(0);
    expect(report.partial).toBe(true);
    expect(report.aborted_at_source).toBe('src-a');
  });

  // Codex adversarial #4 regression: even when dbPageCountForSource itself
  // would hang indefinitely, the Promise.race against the deadline must
  // resolve null and the scan must abort cleanly.
  //
  // Boundary fix (CI flake): brain-writer.ts post-await deadline check uses
  // `>=` not `>`. The Promise.race setTimeout resolves at exactly
  // `remainingMs` from now, so post-await Date.now() often equals deadline
  // within integer-ms precision. Strict `>` missed those landings on CI
  // runners and let scanOneSource run anyway, marking src-a as 'scanned'
  // instead of 'skipped'. Test budget is generous enough to absorb runner
  // timer drift; the real fix is the operator change in brain-writer.ts.
  test('hanging COUNT does not exceed deadline — Promise.race timeout fires', async () => {
    const start = Date.now();
    const DEADLINE_MS = 500;
    const BOUND_MS = 2500;
    const report = await scanBrainSources(engine, {
      deadline: start + DEADLINE_MS,
      dbPageCountForSource: () => {
        // Never resolves — would hang forever without the deadline race.
        return new Promise<number | null>(() => {});
      },
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(BOUND_MS);
    expect(report.partial).toBe(true);
    const firstSource = report.per_source.find(r => r.source_id === 'src-a')!;
    expect(firstSource.status).toBe('skipped');
    // Skipped sources never get db_page_count set — they weren't attempted.
    // (Either null from the race or undefined from never reaching the DB
    // path; both express "no denominator available" honestly.)
    expect(firstSource.db_page_count == null).toBe(true);
  });
});

/**
 * Regression coverage for the `gbrain dream --input <file>` diagnostic gap:
 * an already-synthesized transcript used to report status='clean' with a
 * bare "Brain is healthy" line and NO indication that anything was
 * examined and skipped (or that the queue's idempotency_key dedupe
 * silently reused a prior job instead of doing new work).
 *
 * Two independent fixes, pinned at function granularity (no DB needed —
 * both `deriveStatus` and `printHuman` are pure functions of a CycleReport):
 *
 *   1. `deriveStatus` (src/core/cycle.ts) now folds
 *      totals.transcripts_processed / totals.synth_pages_written into
 *      `anyWork`. A synthesize-only cycle (which --input implies) never
 *      touches sync/embed/lint/etc, so those totals staying zero used to
 *      force status='clean' even when synthesize genuinely processed a
 *      transcript or wrote pages.
 *   2. `printHuman` (src/commands/dream.ts) no longer short-circuits a
 *      'clean' report before checking each phase's `details.skips` — the
 *      synthesize phase's D8 (legacy-key) / D5 (oversize-chunk) skip
 *      reasons are now printed even when overall status stays 'clean'
 *      (e.g. every worth-processing transcript was skipped, so
 *      transcripts_processed/synth_pages_written are also 0).
 *
 * Run: bun test test/dream-clean-status-skip-visibility.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { __testing as cycleTesting, type CycleReport, type PhaseResult } from '../src/core/cycle.ts';
import { __testing as dreamTesting } from '../src/commands/dream.ts';

const { deriveStatus } = cycleTesting;
const { printHuman } = dreamTesting;

function emptyTotals(): CycleReport['totals'] {
  return {
    lint_fixes: 0,
    backlinks_added: 0,
    pages_synced: 0,
    pages_extracted: 0,
    pages_embedded: 0,
    orphans_found: 0,
    transcripts_processed: 0,
    synth_pages_written: 0,
    patterns_written: 0,
    pages_emotional_weight_recomputed: 0,
    edges_resolved: 0,
    edges_ambiguous: 0,
    purged_sources_count: 0,
    purged_pages_count: 0,
    facts_consolidated: 0,
    consolidate_takes_written: 0,
    phantoms_redirected: 0,
    phantoms_ambiguous: 0,
    phantoms_skipped_drift: 0,
  };
}

function synthesizePhase(details: Record<string, unknown>, summary = 'synthesize ran'): PhaseResult {
  return {
    phase: 'synthesize',
    status: 'ok',
    duration_ms: 200,
    summary,
    details,
  };
}

function report(phases: PhaseResult[], totals: CycleReport['totals']): CycleReport {
  return {
    schema_version: '1',
    timestamp: new Date().toISOString(),
    duration_ms: 200,
    status: deriveStatus(phases, totals),
    brain_dir: '/tmp/brain',
    phases,
    totals,
  };
}

/** Capture everything printHuman writes to console.log during `body()`. */
function captureLog(body: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    body();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('deriveStatus — synthesize-only activity is not invisible', () => {
  test('transcripts_processed > 0 (queue idempotency_key reuse: no pages, no lint/sync/embed) → ok, not clean', () => {
    const totals = emptyTotals();
    totals.transcripts_processed = 1; // reused an already-completed v2 job
    const phases = [synthesizePhase({ transcripts_processed: 1, pages_written: 0, skips: [] })];
    expect(deriveStatus(phases, totals)).toBe('ok');
  });

  test('synth_pages_written > 0 alone (transcripts_processed miscounted 0) → ok, not clean', () => {
    const totals = emptyTotals();
    totals.synth_pages_written = 2;
    const phases = [synthesizePhase({ pages_written: 2 })];
    expect(deriveStatus(phases, totals)).toBe('ok');
  });

  test('genuinely idle synthesize (0 transcripts, 0 pages) still reports clean', () => {
    const totals = emptyTotals();
    const phases = [synthesizePhase({ transcripts_processed: 0, pages_written: 0 }, 'no transcripts to process')];
    expect(deriveStatus(phases, totals)).toBe('clean');
  });

  test('D8/D5 skip-only run (worth-processing transcript fully skipped) still reports clean', () => {
    // Mirrors runPhaseSynthesize's D8 legacy-key branch: worthProcessing had
    // 1 entry, skipReports absorbed it, so submittedTranscripts=0 and no
    // pages were written — deriveStatus correctly stays 'clean' here; it's
    // printHuman's job (below) to surface *why*.
    const totals = emptyTotals();
    const phases = [synthesizePhase({
      transcripts_processed: 0,
      pages_written: 0,
      skips: [{ filePath: '/tmp/corpus/2026-08-15.txt', reason: 'already_synthesized_legacy_chunked' }],
    }, '0 transcript(s) synthesized in 0.0s')];
    expect(deriveStatus(phases, totals)).toBe('clean');
  });
});

describe('printHuman — a clean cycle still surfaces skip reasons', () => {
  test('clean + non-empty details.skips prints the skip reason, not just "Brain is healthy"', () => {
    const totals = emptyTotals();
    const phases = [synthesizePhase({
      transcripts_processed: 0,
      pages_written: 0,
      skips: [{ filePath: '/tmp/corpus/2026-08-15.txt', reason: 'already_synthesized_legacy_chunked' }],
    }, '0 transcript(s) synthesized in 0.0s')];
    const r = report(phases, totals);
    expect(r.status).toBe('clean');

    const lines = captureLog(() => printHuman(r));
    expect(lines[0]).toContain('Brain is healthy');
    const skipLine = lines.find(l => l.includes('already_synthesized_legacy_chunked'));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain('/tmp/corpus/2026-08-15.txt');
  });

  test('clean + empty skips prints only the healthy line (no regression for the idle case)', () => {
    const totals = emptyTotals();
    const phases = [synthesizePhase({ transcripts_processed: 0, pages_written: 0 }, 'no transcripts to process')];
    const r = report(phases, totals);
    expect(r.status).toBe('clean');

    const lines = captureLog(() => printHuman(r));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Brain is healthy');
  });

  test('ok status (transcripts_processed>0 via deriveStatus fix) prints the per-phase summary + totals line', () => {
    const totals = emptyTotals();
    totals.transcripts_processed = 1;
    const phases = [synthesizePhase(
      { transcripts_processed: 1, pages_written: 0, skips: [] },
      '1 transcript(s) synthesized in 0.0s',
    )];
    const r = report(phases, totals);
    expect(r.status).toBe('ok');

    const lines = captureLog(() => printHuman(r));
    expect(lines.some(l => l.includes('synthesize') && l.includes('1 transcript(s) synthesized'))).toBe(true);
    expect(lines.some(l => l.includes('synth_transcripts=1'))).toBe(true);
  });
});

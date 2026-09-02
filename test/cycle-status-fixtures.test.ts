/**
 * Status derivation fixtures (CM3 (k) of the brain-plane repair plan). The
 * HEALTHY_CYCLE watcher predicate keys on `report.status`, so the mapping
 * from phase results to the five derived statuses is pinned here:
 *   clean   every attempted phase ok/skipped, zero work
 *   ok      every attempted phase ok/skipped, some work
 *   partial at least one warn OR one fail, not all failed
 *   failed  every attempted phase failed
 * `skipped` is NOT derived: runCycle sets it directly when the lock is held
 * (reason cycle_already_running) or the run aborted. A cycle whose phases
 * were ALL skipped derives `clean`, which is why the watcher must also
 * require attempted work, not just a green status.
 */
import { describe, test, expect } from 'bun:test';
import { deriveStatus, type CycleReport, type PhaseResult } from '../src/core/cycle.ts';

const ZERO: CycleReport['totals'] = {
  lint_fixes: 0, backlinks_added: 0, pages_synced: 0, pages_extracted: 0, pages_embedded: 0,
  orphans_found: 0, transcripts_processed: 0, synth_pages_written: 0, patterns_written: 0,
  pages_emotional_weight_recomputed: 0, edges_resolved: 0, edges_ambiguous: 0,
  purged_sources_count: 0, purged_pages_count: 0, facts_consolidated: 0, consolidate_takes_written: 0,
  phantoms_redirected: 0, phantoms_ambiguous: 0, phantoms_skipped_drift: 0,
};
const rec = (phase: string, status: PhaseResult['status'], reason?: string): PhaseResult => ({
  phase: phase as PhaseResult['phase'], status, duration_ms: 0, summary: '', details: reason ? { reason } : {},
});

describe('deriveStatus fixtures', () => {
  test('clean: all ok, zero work', () => {
    expect(deriveStatus([rec('lint', 'ok'), rec('extract', 'ok')], ZERO)).toBe('clean');
  });
  test('ok: all ok, some work', () => {
    expect(deriveStatus([rec('lint', 'ok'), rec('extract', 'ok')], { ...ZERO, pages_extracted: 3 })).toBe('ok');
  });
  test('partial with warn: one warn among oks', () => {
    expect(deriveStatus([rec('lint', 'ok'), rec('extract_facts', 'warn')], { ...ZERO, pages_extracted: 3 })).toBe('partial');
  });
  test('partial with fail: one fail among oks', () => {
    expect(deriveStatus([rec('lint', 'ok'), rec('extract', 'fail')], ZERO)).toBe('partial');
  });
  test('failed: every attempted phase failed', () => {
    expect(deriveStatus([rec('lint', 'fail'), rec('extract', 'fail')], ZERO)).toBe('failed');
  });
  test('all skipped (no_brain_dir) derives clean, never skipped', () => {
    expect(deriveStatus([rec('lint', 'skipped', 'no_brain_dir'), rec('sync', 'skipped', 'no_brain_dir')], ZERO)).toBe('clean');
  });
  test('exclusion records do not dilute an all-failed run', () => {
    expect(deriveStatus([rec('sync', 'fail'), rec('embed', 'skipped', 'excluded_from_implicit_source_cycle')], ZERO)).toBe('failed');
  });
  test('a null-dir extract that drained work reads ok', () => {
    expect(deriveStatus([rec('lint', 'skipped', 'no_brain_dir'), rec('extract', 'ok')], { ...ZERO, pages_extracted: 1 })).toBe('ok');
  });
});

/**
 * v0.38.2.0 — doctor frontmatter_integrity rendering tests.
 *
 * Structural via source-grep. Behavioral coverage lives at two other
 * layers: (a) `test/brain-writer-partial-scan.test.ts` exercises the
 * scanBrainSources + deadline contract that doctor depends on, and
 * (b) `tests/heavy/frontmatter_scan_wallclock.sh` (manual / nightly)
 * subprocesses real `gbrain doctor` against a synthesized 60K-file brain.
 *
 * The unit layer here can't drive `runDoctor` directly because it calls
 * `process.exit(hasFail ? 1 : 0)` unconditionally, which terminates the
 * test runner. Refactoring runDoctor to return rather than exit is a
 * separate cleanup TODO (file: src/commands/doctor.ts:3885). Until then,
 * the source-grep tests below pin every load-bearing render string + the
 * codex D4 catch simplification.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const DOCTOR_SOURCE = readFileSync(
  join(__dirname, '..', 'src', 'commands', 'doctor.ts'),
  'utf8',
);

describe('doctor frontmatter_integrity — structural rendering (source-grep)', () => {
  test('source contains GBRAIN_DOCTOR_FM_TIMEOUT_MS handling', () => {
    expect(DOCTOR_SOURCE).toContain('GBRAIN_DOCTOR_FM_TIMEOUT_MS');
  });

  test('source uses both deadline and AbortSignal.timeout (deadline is load-bearing per codex C1)', () => {
    expect(DOCTOR_SOURCE).toContain('deadline: fmDeadline');
    expect(DOCTOR_SOURCE).toContain('AbortSignal.timeout(fmTimeoutMs)');
  });

  test('source issues the DB COUNT(*) denominator query with deleted_at IS NULL', () => {
    expect(DOCTOR_SOURCE).toContain('deleted_at IS NULL');
    expect(DOCTOR_SOURCE).toContain('FROM pages WHERE source_id');
  });

  test('source renders honest "source has ~M pages in DB" wording', () => {
    expect(DOCTOR_SOURCE).toContain('pages in DB');
  });

  test('source renders NOT SCANNED per skipped source with remediation hint', () => {
    expect(DOCTOR_SOURCE).toContain('NOT SCANNED');
    expect(DOCTOR_SOURCE).toContain('gbrain frontmatter validate');
  });

  test('source has been simplified to remove the unreachable AbortError catch branch (codex D4)', () => {
    // The pre-v0.38.2.0 PR #1287 had a code-level branch:
    //   const isTimeout = e instanceof DOMException && e.name === 'AbortError';
    //   if (isTimeout) { ... }
    // Post-D4 there is no code-level isTimeout assignment OR DOMException
    // instanceof check. (Comments mentioning AbortError for explanation are
    // fine — only the code branch is the regression target.)
    expect(DOCTOR_SOURCE).not.toContain('const isTimeout');
    expect(DOCTOR_SOURCE).not.toContain("instanceof DOMException");
  });
});

describe('doctor frontmatter_integrity — load-bearing render strings', () => {
  test('source includes "PARTIAL SCAN" wording for the warn message', () => {
    expect(DOCTOR_SOURCE).toContain('PARTIAL SCAN');
  });

  test('source includes "PARTIAL — scanned ~" per-source partial breakdown', () => {
    expect(DOCTOR_SOURCE).toContain('PARTIAL — scanned ~');
  });

  test('source threads files_scanned numerator into the render', () => {
    expect(DOCTOR_SOURCE).toContain('src.files_scanned');
  });

  test('source threads db_page_count denominator into the render', () => {
    expect(DOCTOR_SOURCE).toContain('src.db_page_count');
  });

  test('source uses fallback hint pointing at GBRAIN_DOCTOR_FM_TIMEOUT_MS on partial', () => {
    // The fix hint when partial: raise the timeout OR run validate directly.
    const partialHintMatch = DOCTOR_SOURCE.includes('Raise GBRAIN_DOCTOR_FM_TIMEOUT_MS');
    expect(partialHintMatch).toBe(true);
  });
});

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
import { formatFrontmatterSourceMessageForDoctor } from '../src/commands/doctor.ts';

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

describe('doctor frontmatter_integrity — per-source message formatter', () => {
  test('scanned sources include sample paths and cap extra samples', () => {
    const message = formatFrontmatterSourceMessageForDoctor({
      source_id: 'sawyer-hub',
      source_path: '/Users/sawbeck/Projects/sawyer-hub',
      total: 5,
      errors_by_code: { YAML_PARSE: 5 },
      sample: [
        { path: 'control-room/active/operator-loop.md', codes: ['YAML_PARSE'] },
        { path: 'control-room/shipped/receipt.md', codes: ['YAML_PARSE'] },
        { path: 'notes/private-extra.md', codes: ['YAML_PARSE'] },
      ],
      status: 'scanned',
      files_scanned: 400,
    });

    expect(message).toBe(
      'sawyer-hub: 5 (YAML_PARSE=5), sample: control-room/active/operator-loop.md (YAML_PARSE), control-room/shipped/receipt.md (YAML_PARSE), +1 more',
    );
  });

  test('clean scanned sources stay omitted from the doctor summary', () => {
    const message = formatFrontmatterSourceMessageForDoctor({
      source_id: 'clean-source',
      source_path: '/tmp/clean-source',
      total: 0,
      errors_by_code: {},
      sample: [],
      status: 'scanned',
      files_scanned: 10,
    });

    expect(message).toBeNull();
  });

  test('partial sources include samples without losing timeout context', () => {
    const message = formatFrontmatterSourceMessageForDoctor({
      source_id: 'partial-source',
      source_path: '/tmp/partial-source',
      total: 1,
      errors_by_code: { MISSING_CLOSE: 1 },
      sample: [{ path: 'broken.md', codes: ['MISSING_CLOSE'] }],
      status: 'partial',
      files_scanned: 25,
      db_page_count: 200,
    });

    expect(message).toBe(
      'partial-source: PARTIAL — scanned ~25 files (source has ~200 pages in DB), 1 issue(s) so far, MISSING_CLOSE=1, sample: broken.md (MISSING_CLOSE)',
    );
  });
});

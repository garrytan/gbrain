/**
 * Bug 9 regression — sync silently drops files with broken YAML.
 *
 * Before the fix, sync.ts caught per-file parse errors, printed a warning,
 * and still advanced sync.last_commit. The failed file was never retried
 * because it was behind the bookmark. Silent data loss.
 *
 * After the fix:
 *   - failures append to ~/.gbrain/sync-failures.jsonl (with dedup)
 *   - incremental + full-sync + import git-continuity paths gate the
 *     sync.last_commit advance on "no failures"
 *   - `gbrain sync --skip-failed` acknowledges the current set
 *   - `gbrain doctor` surfaces unacknowledged failures
 *
 * This suite exercises the helper + the dedup behavior. The full CLI
 * round-trip is covered by E2E tests.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Point HOME at a tmpdir so we don't stomp the real ~/.gbrain/sync-failures.jsonl
let tmpHome: string;
const originalHome = process.env.HOME;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-sync-failures-'));
  process.env.HOME = tmpHome;
  // Belt-and-suspenders: explicitly clear the jsonl at the resolved path.
  const { syncFailuresPath } = await import('../src/core/sync.ts');
  try { rmSync(syncFailuresPath(), { force: true }); } catch { /* none */ }
});

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome;
  else delete process.env.HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('Bug 9 — sync-failures JSONL helpers', () => {
  test('recordSyncFailures appends one line per failure with dedup', async () => {
    const { recordSyncFailures, loadSyncFailures, syncFailuresPath } = await import('../src/core/sync.ts');

    recordSyncFailures([
      { path: 'people/alice.md', error: 'YAML: unexpected colon in title' },
      { path: 'notes/broken.md', error: 'YAML: duplicated key' },
    ], 'abc123def456');

    expect(existsSync(syncFailuresPath())).toBe(true);
    const entries = loadSyncFailures();
    expect(entries.length).toBe(2);
    expect(entries[0].path).toBe('people/alice.md');
    expect(entries[0].commit).toBe('abc123def456');
    expect(entries[0].acknowledged).toBeUndefined();

    // Same failure on same commit should NOT re-append.
    recordSyncFailures([
      { path: 'people/alice.md', error: 'YAML: unexpected colon in title' },
    ], 'abc123def456');
    expect(loadSyncFailures().length).toBe(2);

    // Different commit → new entry.
    recordSyncFailures([
      { path: 'people/alice.md', error: 'YAML: unexpected colon in title' },
    ], 'zzz999');
    expect(loadSyncFailures().length).toBe(3);
  });

  test('acknowledgeSyncFailures marks unacked entries, leaves acked alone', async () => {
    const { recordSyncFailures, acknowledgeSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');

    recordSyncFailures([
      { path: 'a.md', error: 'err1' },
      { path: 'b.md', error: 'err2' },
    ], 'commit1');

    const result = acknowledgeSyncFailures();
    expect(result.count).toBe(2);
    expect(result.summary.length).toBeGreaterThan(0);
    const after = loadSyncFailures();
    expect(after.every(e => e.acknowledged === true)).toBe(true);
    expect(after.every(e => typeof e.acknowledged_at === 'string')).toBe(true);

    // Second ack: nothing new to mark.
    expect(acknowledgeSyncFailures().count).toBe(0);

    // Adding a fresh failure then ack: only the new one flips.
    recordSyncFailures([{ path: 'c.md', error: 'err3' }], 'commit2');
    expect(acknowledgeSyncFailures().count).toBe(1);
    expect(loadSyncFailures().length).toBe(3);
    expect(loadSyncFailures().every(e => e.acknowledged === true)).toBe(true);
  });

  test('unacknowledgedSyncFailures filters correctly', async () => {
    const { recordSyncFailures, acknowledgeSyncFailures, unacknowledgedSyncFailures } = await import('../src/core/sync.ts');

    recordSyncFailures([{ path: 'a.md', error: 'err1' }], 'c1');
    acknowledgeSyncFailures();
    recordSyncFailures([{ path: 'b.md', error: 'err2' }], 'c2');

    const unacked = unacknowledgedSyncFailures();
    expect(unacked.length).toBe(1);
    expect(unacked[0].path).toBe('b.md');
  });

  test('resolveSyncFailure removes entries by path and reports count', async () => {
    const { recordSyncFailures, resolveSyncFailure, loadSyncFailures } = await import('../src/core/sync.ts');

    recordSyncFailures([
      { path: 'a.md', error: 'err1' },
      { path: 'b.md', error: 'err2' },
    ], 'commit1');
    // Same path on a different commit — both entries should clear together.
    recordSyncFailures([{ path: 'a.md', error: 'err1-redux' }], 'commit2');
    expect(loadSyncFailures().length).toBe(3);

    expect(resolveSyncFailure('a.md')).toBe(2);
    const after = loadSyncFailures();
    expect(after.length).toBe(1);
    expect(after[0].path).toBe('b.md');

    // No-op when the path isn't recorded.
    expect(resolveSyncFailure('missing.md')).toBe(0);
  });

  test('resolveSyncFailure deletes the JSONL when the last entry clears', async () => {
    const { recordSyncFailures, resolveSyncFailure, syncFailuresPath } = await import('../src/core/sync.ts');
    recordSyncFailures([{ path: 'only.md', error: 'err' }], 'c1');
    expect(existsSync(syncFailuresPath())).toBe(true);
    expect(resolveSyncFailure('only.md')).toBe(1);
    expect(existsSync(syncFailuresPath())).toBe(false);
  });

  test('resolveSyncFailure on a missing JSONL is a no-op (returns 0)', async () => {
    const { resolveSyncFailure } = await import('../src/core/sync.ts');
    expect(resolveSyncFailure('whatever.md')).toBe(0);
  });

  test('loadSyncFailures returns [] when file is missing', async () => {
    const { loadSyncFailures } = await import('../src/core/sync.ts');
    expect(loadSyncFailures()).toEqual([]);
  });

  test('loadSyncFailures tolerates malformed lines', async () => {
    const { loadSyncFailures, syncFailuresPath, recordSyncFailures } = await import('../src/core/sync.ts');
    // Seed one valid entry.
    recordSyncFailures([{ path: 'a.md', error: 'err1' }], 'c1');
    // Append garbage.
    writeFileSync(syncFailuresPath(), readFileSync(syncFailuresPath(), 'utf-8') + 'NOT-JSON\n', { flag: 'w' });
    const out = loadSyncFailures();
    expect(out.length).toBe(1);
    expect(out[0].path).toBe('a.md');
  });
});

describe('Bug 9 follow-up — performSync retry + reconcile', () => {
  // These cases drive the actual sync flow against PGLite, not just helpers.
  // They guard the three bugs exposed by Hermes' Apr-27 sync:
  //   1. --retry-failed banner printed but did not actually re-run files
  //      when last_commit==HEAD (diff empty).
  //   2. Successful import did not reconcile sync-failures.jsonl, so files
  //      already in the DB stayed listed as failed forever.
  //   3. --skip-failed could not acknowledge stuck failures when the diff
  //      was empty (early return skipped the ack call).

  let repoPath: string;
  let engine: any;

  beforeEach(async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-retry-failed-'));
    const { execSync } = await import('child_process');
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    writeFileSync(join(repoPath, 'good.md'), [
      '---',
      'type: concept',
      'title: Good Page',
      '---',
      '',
      'Body.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(async () => {
    try { await engine.disconnect(); } catch { /* ignore */ }
    if (repoPath) try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('--retry-failed re-injects unacked failures even when diff is empty', async () => {
    const { recordSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');
    const { performSync } = await import('../src/commands/sync.ts');

    // First sync — pulls good.md into the DB and bookmarks last_commit at HEAD.
    const first = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(first.status).toBe('first_sync');
    expect(await engine.getPage('good')).not.toBeNull();
    const headCommit = await engine.getConfig('sync.last_commit');
    expect(headCommit).not.toBeNull();

    // Now record a stale failure for good.md against the same commit.
    // (Simulates the Hermes scenario: file already in DB, but jsonl carries
    // a historical failure entry that --retry-failed should clear.)
    recordSyncFailures([{ path: 'good.md', error: 'stale historical error' }], headCommit!);
    expect(loadSyncFailures().length).toBe(1);

    // Second sync with --retry-failed. Diff is empty (no new commits), but
    // the retry path must still revisit good.md and clear the failure.
    const second = await performSync(engine, {
      repoPath, noPull: true, noEmbed: true, retryFailed: true,
    });
    // Re-injection turns the empty diff into one modified file.
    expect(second.modified).toBeGreaterThanOrEqual(1);
    // jsonl is now empty — successful import reconciled it.
    expect(loadSyncFailures().length).toBe(0);
  });

  test('successful import reconciles JSONL even without --retry-failed', async () => {
    const { recordSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');
    const { performSync } = await import('../src/commands/sync.ts');

    // Seed a failure entry for good.md before any sync runs.
    recordSyncFailures([{ path: 'good.md', error: 'old error' }], 'deadbeef');
    expect(loadSyncFailures().length).toBe(1);

    // Plain first sync — good.md imports normally; the jsonl entry should
    // disappear because the file was reconciled by the import loop.
    const result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('first_sync');
    expect(await engine.getPage('good')).not.toBeNull();
    expect(loadSyncFailures().length).toBe(0);
  });

  test('successful rename clears stale failures under both old and new path', async () => {
    const { recordSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');
    const { performSync } = await import('../src/commands/sync.ts');
    const { execSync } = await import('child_process');

    // First sync — bookmark HEAD with good.md.
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    // Seed failures for both names. The from-side mirrors the case where a
    // file that previously failed gets renamed to fix it.
    recordSyncFailures([
      { path: 'good.md', error: 'old name failure' },
      { path: 'renamed.md', error: 'new name failure (somehow)' },
    ], 'deadbeef');
    expect(loadSyncFailures().length).toBe(2);

    // git mv good.md → renamed.md and commit.
    execSync('git mv good.md renamed.md', { cwd: repoPath, stdio: 'pipe' });
    execSync('git commit -m "rename"', { cwd: repoPath, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    // Whether git -M identifies this as rename (R) or delete+add depends on
    // similarity heuristics; either way both jsonl entries should clear:
    // - rename branch reconciles `from` and `to`
    // - delete+add branches each reconcile their own path
    const touched = result.renamed + result.deleted + result.added;
    expect(touched).toBeGreaterThanOrEqual(1);
    expect(loadSyncFailures().length).toBe(0);
  });

  test('--skip-failed acknowledges stuck failures when diff is empty', async () => {
    const { recordSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');
    const { performSync } = await import('../src/commands/sync.ts');

    // First sync to bookmark last_commit at HEAD.
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    const headCommit = await engine.getConfig('sync.last_commit');

    // Record a failure that the user can't fix — they want to acknowledge it.
    recordSyncFailures([{ path: 'unfixable.md', error: 'no longer relevant' }], headCommit!);
    const before = loadSyncFailures();
    expect(before.length).toBe(1);
    expect(before[0].acknowledged).toBeUndefined();

    // Second sync with --skip-failed. Diff is empty. Without the fix the ack
    // call sat behind the early return and never ran.
    await performSync(engine, {
      repoPath, noPull: true, noEmbed: true, skipFailed: true,
    });
    const after = loadSyncFailures();
    expect(after.length).toBe(1);
    expect(after[0].acknowledged).toBe(true);
  });
});

describe('Bug 9 — doctor surfaces sync failures', () => {
  test('doctor source contains sync_failures check', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain('sync_failures');
    expect(source).toContain('unacknowledgedSyncFailures');
    expect(source).toContain("'gbrain sync --skip-failed'");
  });
});

describe('Bug 9 — sync.ts CLI flag wiring', () => {
  test('runSync parses --skip-failed and --retry-failed flags', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    expect(source).toContain("args.includes('--skip-failed')");
    expect(source).toContain("args.includes('--retry-failed')");
    expect(source).toContain('skipFailed');
    expect(source).toContain('retryFailed');
  });

  test('performSync gates sync.last_commit on failedFiles.length', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    // The gate exists and references the failure set.
    expect(source).toContain('failedFiles.length > 0');
    expect(source).toContain('blocked_by_failures');
  });

  test('performFullSync gates on result.failures from runImport', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    expect(source).toContain('result.failures.length > 0');
  });

  test('runImport returns RunImportResult with failures list', async () => {
    const source = await Bun.file(new URL('../src/commands/import.ts', import.meta.url)).text();
    expect(source).toContain('RunImportResult');
    expect(source).toContain('failures: Array<{ path: string; error: string }>');
    expect(source).toContain('recordSyncFailures');
  });
});

describe('classifyErrorCode — error message to code mapping', () => {
  test('classifies SLUG_MISMATCH from error message', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode(
      'Frontmatter slug "my-friend-mike" does not match path-derived slug "2008-03-20-my-friend-mike"'
    )).toBe('SLUG_MISMATCH');
  });

  test('classifies YAML_PARSE from error message', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('YAML parse failed: unexpected colon in title')).toBe('YAML_PARSE');
  });

  test('classifies YAML_DUPLICATE_KEY', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('YAMLException: duplicated mapping key')).toBe('YAML_DUPLICATE_KEY');
  });

  test('classifies STATEMENT_TIMEOUT', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('canceling statement due to statement timeout')).toBe('STATEMENT_TIMEOUT');
  });

  test('classifies NULL_BYTES', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('invalid UTF-8: null byte at position 3770')).toBe('NULL_BYTES');
  });

  test('classifies INVALID_UTF8', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('invalid UTF-8 sequence at position 500')).toBe('INVALID_UTF8');
  });

  test('classifies FILE_TOO_LARGE across all three production sites', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    // src/core/import-file.ts:352 — OS-level file size on disk
    expect(classifyErrorCode('File too large (8432105 bytes)')).toBe('FILE_TOO_LARGE');
    // src/core/import-file.ts:199 — content size limit (5MB cap)
    expect(classifyErrorCode('Content too large (6000000 bytes, max 5000000). Split the content into smaller files or remove large embedded assets.')).toBe('FILE_TOO_LARGE');
    // src/core/import-file.ts:401 — code file size cap
    expect(classifyErrorCode('Code file too large (8000000 bytes)')).toBe('FILE_TOO_LARGE');
  });

  test('classifies SYMLINK_NOT_ALLOWED from import-file.ts symlink rejection', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Skipping symlink: /path/to/link.md')).toBe('SYMLINK_NOT_ALLOWED');
  });

  test('returns UNKNOWN for unrecognized errors', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('something completely different')).toBe('UNKNOWN');
  });
});

describe('summarizeFailuresByCode — grouped summary', () => {
  test('groups failures by classified code', async () => {
    const { summarizeFailuresByCode } = await import('../src/core/sync.ts');
    const summary = summarizeFailuresByCode([
      { error: 'Frontmatter slug "a" does not match path-derived slug "b"' },
      { error: 'Frontmatter slug "c" does not match path-derived slug "d"' },
      { error: 'YAML parse failed: bad colon' },
      { error: 'something unknown' },
    ]);
    expect(summary).toEqual([
      { code: 'SLUG_MISMATCH', count: 2 },
      { code: 'YAML_PARSE', count: 1 },
      { code: 'UNKNOWN', count: 1 },
    ]);
  });

  test('respects pre-classified code field', async () => {
    const { summarizeFailuresByCode } = await import('../src/core/sync.ts');
    const summary = summarizeFailuresByCode([
      { error: 'anything', code: 'SLUG_MISMATCH' },
      { error: 'anything', code: 'SLUG_MISMATCH' },
      { error: 'anything', code: 'YAML_PARSE' },
    ]);
    expect(summary).toEqual([
      { code: 'SLUG_MISMATCH', count: 2 },
      { code: 'YAML_PARSE', count: 1 },
    ]);
  });

  test('returns empty array for no failures', async () => {
    const { summarizeFailuresByCode } = await import('../src/core/sync.ts');
    expect(summarizeFailuresByCode([])).toEqual([]);
  });
});

describe('acknowledgeSyncFailures — structured return', () => {
  test('returns count and code summary', async () => {
    const { recordSyncFailures, acknowledgeSyncFailures } = await import('../src/core/sync.ts');
    recordSyncFailures([
      { path: 'a.md', error: 'Frontmatter slug "x" does not match path-derived slug "y"' },
      { path: 'b.md', error: 'Frontmatter slug "p" does not match path-derived slug "q"' },
      { path: 'c.md', error: 'YAML parse failed: bad' },
    ], 'commit1');

    const result = acknowledgeSyncFailures();
    expect(result.count).toBe(3);
    expect(result.summary).toEqual([
      { code: 'SLUG_MISMATCH', count: 2 },
      { code: 'YAML_PARSE', count: 1 },
    ]);
  });
});

describe('recordSyncFailures — code field', () => {
  test('records classified code alongside error message', async () => {
    const { recordSyncFailures, loadSyncFailures } = await import('../src/core/sync.ts');
    recordSyncFailures([
      { path: 'a.md', error: 'Frontmatter slug "x" does not match path-derived slug "y"' },
    ], 'commit1');

    const entries = loadSyncFailures();
    expect(entries[0].code).toBe('SLUG_MISMATCH');
  });
});

// classifyErrorCode disambiguates Postgres unique-constraint errors from
// YAML duplicate-key errors. Pre-fix, every "duplicate.*key" string mapped
// to YAML_DUPLICATE_KEY, which mislabels DB-layer failures during sync.
describe('classifyErrorCode — DB vs YAML duplicate-key disambiguation', () => {
  test('Postgres unique-constraint violation classifies as DB_DUPLICATE_KEY', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode(
      'duplicate key value violates unique constraint "pages_slug_key"'
    )).toBe('DB_DUPLICATE_KEY');
  });

  test('YAML duplicated mapping key still classifies as YAML_DUPLICATE_KEY', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('YAMLException: duplicated mapping key "title"'))
      .toBe('YAML_DUPLICATE_KEY');
  });

  test('DB pattern is checked BEFORE YAML so DB errors are not mislabeled', async () => {
    // Both patterns historically matched /duplicate.*key/i — order matters now.
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode(
      'duplicate key value violates unique constraint on table "pages"'
    )).toBe('DB_DUPLICATE_KEY');
    expect(classifyErrorCode(
      'duplicate key value violates unique constraint on table "pages"'
    )).not.toBe('YAML_DUPLICATE_KEY');
  });
});

// classifyErrorCode matches the canonical messages emitted by
// collectValidationErrors() in src/core/markdown.ts. Pre-fix, the regexes
// keyed off "missing open" / "missing close" / "empty frontmatter" — none
// of which are produced upstream. Today these all classify correctly.
describe('classifyErrorCode — canonical message coverage', () => {
  test('MISSING_OPEN matches "File is empty or whitespace-only"', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode(
      'File is empty or whitespace-only; expected frontmatter starting with ---'
    )).toBe('MISSING_OPEN');
  });

  test('MISSING_OPEN matches "Frontmatter must start with ---"', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode(
      'Frontmatter must start with --- on the first non-empty line'
    )).toBe('MISSING_OPEN');
  });

  test('MISSING_CLOSE matches "No closing --- delimiter"', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('No closing --- delimiter found')).toBe('MISSING_CLOSE');
  });

  test('MISSING_CLOSE matches "Heading at line N found inside frontmatter"', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode(
      'Heading at line 5 found inside frontmatter zone (closing --- comes after)'
    )).toBe('MISSING_CLOSE');
  });

  test('EMPTY_FRONTMATTER matches "Frontmatter block is empty"', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Frontmatter block is empty')).toBe('EMPTY_FRONTMATTER');
  });

  test('NULL_BYTES matches "Content contains null bytes"', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Content contains null bytes (likely binary corruption)'))
      .toBe('NULL_BYTES');
  });

  test('NESTED_QUOTES matches "Nested double quotes"', async () => {
    const { classifyErrorCode } = await import('../src/core/sync.ts');
    expect(classifyErrorCode('Nested double quotes in YAML value at line 3'))
      .toBe('NESTED_QUOTES');
  });
});

// acknowledgeSyncFailures backfills `code` on legacy entries that were
// recorded before the code field existed (~/.gbrain/sync-failures.jsonl
// from pre-PR brains). Without this branch, upgraded users see "UNKNOWN"
// for every previously-recorded failure even when the message is parseable.
describe('acknowledgeSyncFailures — backfill on legacy entries', () => {
  test('backfills code on entries that predate the code field', async () => {
    const { acknowledgeSyncFailures, loadSyncFailures, syncFailuresPath } =
      await import('../src/core/sync.ts');

    // Hand-write a legacy entry with no `code` field. Mimics a pre-PR
    // ~/.gbrain/sync-failures.jsonl row that exists on real upgrades.
    const { mkdirSync } = await import('fs');
    const { dirname } = await import('path');
    mkdirSync(dirname(syncFailuresPath()), { recursive: true });
    writeFileSync(
      syncFailuresPath(),
      JSON.stringify({
        path: 'a.md',
        error: 'Frontmatter slug "x" does not match path-derived slug "y"',
        commit: 'old',
        ts: '2025-01-01T00:00:00Z',
      }) + '\n',
    );

    const result = acknowledgeSyncFailures();
    expect(result.count).toBe(1);
    expect(result.summary).toEqual([{ code: 'SLUG_MISMATCH', count: 1 }]);

    const after = loadSyncFailures();
    expect(after).toHaveLength(1);
    expect(after[0].code).toBe('SLUG_MISMATCH');
    expect(after[0].acknowledged).toBe(true);
  });

  test('preserves existing code field; never reclassifies', async () => {
    const { acknowledgeSyncFailures, loadSyncFailures, syncFailuresPath } =
      await import('../src/core/sync.ts');

    const { mkdirSync } = await import('fs');
    const { dirname } = await import('path');
    mkdirSync(dirname(syncFailuresPath()), { recursive: true });
    // Pre-classified entry — should NOT be re-run through classifier.
    writeFileSync(
      syncFailuresPath(),
      JSON.stringify({
        path: 'a.md',
        error: 'some message that would otherwise classify as UNKNOWN',
        code: 'CUSTOM_CODE',
        commit: 'x',
        ts: '2025-01-01T00:00:00Z',
      }) + '\n',
    );

    const result = acknowledgeSyncFailures();
    expect(result.summary).toEqual([{ code: 'CUSTOM_CODE', count: 1 }]);
    expect(loadSyncFailures()[0].code).toBe('CUSTOM_CODE');
  });
});

// formatCodeBreakdown is the DRY helper used by both the failures-array
// path (sync.ts blocked-by-failures + full-sync stderr) and the pre-summarized
// AcknowledgeResult.summary path (--skip-failed ack message). One renderer,
// two input shapes.
describe('formatCodeBreakdown — dual input shape', () => {
  test('renders raw failures by classifying internally', async () => {
    const { formatCodeBreakdown } = await import('../src/core/sync.ts');
    const out = formatCodeBreakdown([
      { error: 'Frontmatter slug "a" does not match path-derived slug "b"' },
      { error: 'Frontmatter slug "c" does not match path-derived slug "d"' },
      { error: 'YAML parse failed: bad' },
    ]);
    expect(out).toBe('  SLUG_MISMATCH: 2\n  YAML_PARSE: 1');
  });

  test('renders pre-summarized {code, count} input directly', async () => {
    const { formatCodeBreakdown } = await import('../src/core/sync.ts');
    const out = formatCodeBreakdown([
      { code: 'SLUG_MISMATCH', count: 5 },
      { code: 'YAML_PARSE', count: 2 },
    ]);
    expect(out).toBe('  SLUG_MISMATCH: 5\n  YAML_PARSE: 2');
  });

  test('returns empty string for empty input', async () => {
    const { formatCodeBreakdown } = await import('../src/core/sync.ts');
    expect(formatCodeBreakdown([])).toBe('');
  });
});

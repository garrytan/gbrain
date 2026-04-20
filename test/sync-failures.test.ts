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

    const n = acknowledgeSyncFailures();
    expect(n).toBe(2);
    const after = loadSyncFailures();
    expect(after.every(e => e.acknowledged === true)).toBe(true);
    expect(after.every(e => typeof e.acknowledged_at === 'string')).toBe(true);

    // Second ack: nothing new to mark.
    expect(acknowledgeSyncFailures()).toBe(0);

    // Adding a fresh failure then ack: only the new one flips.
    recordSyncFailures([{ path: 'c.md', error: 'err3' }], 'commit2');
    expect(acknowledgeSyncFailures()).toBe(1);
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

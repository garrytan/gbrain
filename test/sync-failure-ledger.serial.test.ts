/**
 * issue #1939 — sync failure ledger + bounded auto-skip valve.
 *
 * Covers the correctness gates the /codex outside-voice review identified:
 *   #1 auto-skipped entries stay UNRESOLVED (doctor WARN), not hidden
 *   #2 (source_id, path) keying — failures never merge across sources
 *   #3 `<head>` sentinel never auto-skips; always hard-blocks
 *   #4 success clears a path so `attempts` is truly consecutive
 *   #5 advance-before-ack atomicity (a throwing advance marks nothing)
 *   #7 legacy rows normalize + duplicates collapse deterministically
 *   #8 cross-process lock + atomic write (stale-lock break, no partial file)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, utimesSync, openSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

let tmpHome: string;
const originalHome = process.env.HOME;
const originalThreshold = process.env.GBRAIN_SYNC_AUTOSKIP_AFTER;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-ledger-'));
  process.env.HOME = tmpHome;
  delete process.env.GBRAIN_SYNC_AUTOSKIP_AFTER;
  const { syncFailuresPath } = await import('../src/core/sync-failure-ledger.ts');
  try { rmSync(syncFailuresPath(), { force: true }); } catch { /* none */ }
});

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome; else delete process.env.HOME;
  if (originalThreshold === undefined) delete process.env.GBRAIN_SYNC_AUTOSKIP_AFTER;
  else process.env.GBRAIN_SYNC_AUTOSKIP_AFTER = originalThreshold;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function L() {
  return import('../src/core/sync-failure-ledger.ts');
}

describe('#2 multi-source keying', () => {
  test('same relative path in two sources keeps independent counters', async () => {
    const { recordFailures, loadSyncFailures } = await L();
    recordFailures('alpha', [{ path: 'people/x.md', error: 'YAML parse failed' }], 'c1');
    recordFailures('alpha', [{ path: 'people/x.md', error: 'YAML parse failed' }], 'c2');
    recordFailures('beta', [{ path: 'people/x.md', error: 'YAML parse failed' }], 'c1');

    const rows = loadSyncFailures();
    expect(rows.length).toBe(2);
    const alpha = rows.find(r => r.source_id === 'alpha')!;
    const beta = rows.find(r => r.source_id === 'beta')!;
    expect(alpha.attempts).toBe(2);
    expect(beta.attempts).toBe(1);
  });

  test('acknowledgeFailures(sourceId) only acks that source', async () => {
    const { recordFailures, acknowledgeFailures, loadSyncFailures } = await L();
    recordFailures('alpha', [{ path: 'a.md', error: 'e' }], 'c1');
    recordFailures('beta', [{ path: 'b.md', error: 'e' }], 'c1');

    const res = acknowledgeFailures('alpha');
    expect(res.count).toBe(1);
    const rows = loadSyncFailures();
    expect(rows.find(r => r.source_id === 'alpha')!.state).toBe('acknowledged');
    expect(rows.find(r => r.source_id === 'beta')!.state).toBe('open');
  });
});

describe('#4 success clears → consecutive attempts', () => {
  test('clearFailures removes a path; a later failure restarts at 1', async () => {
    const { recordFailures, clearFailures, loadSyncFailures } = await L();
    recordFailures('s', [{ path: 'a.md', error: 'e' }], 'c1');
    recordFailures('s', [{ path: 'a.md', error: 'e' }], 'c2');
    expect(loadSyncFailures()[0].attempts).toBe(2);

    clearFailures('s', ['a.md']);
    expect(loadSyncFailures().length).toBe(0);

    recordFailures('s', [{ path: 'a.md', error: 'e' }], 'c3');
    expect(loadSyncFailures()[0].attempts).toBe(1);
  });

  test('clearFailures is source-scoped', async () => {
    const { recordFailures, clearFailures, loadSyncFailures } = await L();
    recordFailures('s1', [{ path: 'a.md', error: 'e' }], 'c1');
    recordFailures('s2', [{ path: 'a.md', error: 'e' }], 'c1');
    clearFailures('s1', ['a.md']);
    const rows = loadSyncFailures();
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('s2');
  });
});

describe('#3 sentinel never auto-skips', () => {
  test('decideGateAction hard-blocks on a sentinel even when chronic + skipFailed', async () => {
    const { decideGateAction } = await L();
    const d = decideGateAction({
      fileFailures: [],
      sentinels: [{ path: '<head>' }],
      attemptsByPath: new Map(),
      threshold: 3,
      skipFailed: true,
    });
    expect(d.action).toBe('hard_block');
    expect(d.autoSkipPaths).toEqual([]);
  });

  test('autoSkipFailures refuses to skip a sentinel path', async () => {
    const { recordFailures, autoSkipFailures, loadSyncFailures } = await L();
    recordFailures('s', [{ path: '<head>', error: 'history rewrite' }], 'c1');
    const res = autoSkipFailures('s', ['<head>']);
    expect(res.count).toBe(0);
    expect(loadSyncFailures()[0].state).toBe('open');
  });

  test('isSkippablePath', async () => {
    const { isSkippablePath } = await L();
    expect(isSkippablePath('people/x.md')).toBe(true);
    expect(isSkippablePath('<head>')).toBe(false);
  });
});

describe('#7 legacy normalization + dup collapse', () => {
  test('backfills source_id/state/attempts/first_seen on legacy rows', async () => {
    const { loadSyncFailures, syncFailuresPath } = await L();
    mkdirSync(dirname(syncFailuresPath()), { recursive: true });
    writeFileSync(
      syncFailuresPath(),
      JSON.stringify({ path: 'a.md', error: 'YAML parse failed', commit: 'old', ts: '2025-01-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ path: 'b.md', error: 'e', commit: 'old', ts: '2025-01-02T00:00:00Z', acknowledged_at: '2025-02-01T00:00:00Z' }) + '\n',
    );
    const rows = loadSyncFailures();
    const a = rows.find(r => r.path === 'a.md')!;
    const b = rows.find(r => r.path === 'b.md')!;
    expect(a.source_id).toBe('default');
    expect(a.state).toBe('open');
    expect(a.attempts).toBe(1);
    expect(a.first_seen).toBe('2025-01-01T00:00:00Z');
    expect(b.state).toBe('acknowledged');
  });

  test('collapses duplicate open rows for one (source,path) into one with attempts = distinct commits', async () => {
    const { loadSyncFailures, syncFailuresPath } = await L();
    mkdirSync(dirname(syncFailuresPath()), { recursive: true });
    // Three legacy rows, same path, two distinct commits.
    writeFileSync(
      syncFailuresPath(),
      [
        { path: 'a.md', error: 'e', commit: 'c1', ts: '2025-01-01T00:00:00Z' },
        { path: 'a.md', error: 'e', commit: 'c2', ts: '2025-01-02T00:00:00Z' },
        { path: 'a.md', error: 'e2', commit: 'c2', ts: '2025-01-03T00:00:00Z' },
      ].map(r => JSON.stringify(r)).join('\n') + '\n',
    );
    const rows = loadSyncFailures();
    expect(rows.length).toBe(1);
    expect(rows[0].attempts).toBe(2); // distinct commits c1, c2
    expect(rows[0].commit).toBe('c2'); // latest by ts
    expect(rows[0].first_seen).toBe('2025-01-01T00:00:00Z');
  });

  test('skips malformed lines', async () => {
    const { loadSyncFailures, recordFailures, syncFailuresPath } = await L();
    recordFailures('s', [{ path: 'a.md', error: 'e' }], 'c1');
    writeFileSync(syncFailuresPath(), readFileSync(syncFailuresPath(), 'utf-8') + 'NOT-JSON\n');
    expect(loadSyncFailures().length).toBe(1);
  });
});

describe('#1 severity — auto_skipped stays visible (WARN)', () => {
  test('decideSyncFailureSeverity branches', async () => {
    const { decideSyncFailureSeverity } = await L();
    const base = { source_id: 's', path: 'a.md', error: 'e', code: 'X', commit: 'c', first_seen: '', ts: '', attempts: 1 };
    const now = Date.parse('2026-06-07T00:00:00Z');
    const failHours = 72;

    // empty → ok
    expect(decideSyncFailureSeverity({ entries: [], nowMs: now, failHours }).status).toBe('ok');

    // one recent open → warn
    expect(decideSyncFailureSeverity({
      entries: [{ ...base, state: 'open', ts: '2026-06-06T18:00:00Z' }],
      nowMs: now, failHours,
    }).status).toBe('warn');

    // one OLD open (>72h) → fail
    expect(decideSyncFailureSeverity({
      entries: [{ ...base, state: 'open', ts: '2026-06-01T00:00:00Z' }],
      nowMs: now, failHours,
    }).status).toBe('fail');

    // 10 recent OPEN → fail (count of blocking failures)
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...base, path: `a${i}.md`, state: 'open' as const, ts: '2026-06-06T23:00:00Z' }));
    expect(decideSyncFailureSeverity({ entries: ten, nowMs: now, failHours }).status).toBe('fail');

    // 10 recent AUTO_SKIPPED → still warn (#3): the valve already advanced the
    // bookmark, so indexing is not wedged. Visible, not gating.
    const tenSkipped = Array.from({ length: 10 }, (_, i) => ({ ...base, path: `s${i}.md`, state: 'auto_skipped' as const, ts: '2026-06-06T23:00:00Z' }));
    const skSev = decideSyncFailureSeverity({ entries: tenSkipped, nowMs: now, failHours });
    expect(skSev.status).toBe('warn');
    expect(skSev.auto_skipped).toBe(10);

    // auto_skipped only → warn (still visible), counted
    const sev = decideSyncFailureSeverity({
      entries: [{ ...base, state: 'auto_skipped', ts: '2026-06-01T00:00:00Z' }],
      nowMs: now, failHours,
    });
    expect(sev.status).toBe('warn');
    expect(sev.auto_skipped).toBe(1);
    expect(sev.unresolved).toBe(1);

    // acknowledged only → ok
    expect(decideSyncFailureSeverity({
      entries: [{ ...base, state: 'acknowledged', ts: '2026-06-01T00:00:00Z' }],
      nowMs: now, failHours,
    }).status).toBe('ok');
  });

  test('malformed ts never crashes (treated as not-old)', async () => {
    const { decideSyncFailureSeverity } = await L();
    const sev = decideSyncFailureSeverity({
      entries: [{ source_id: 's', path: 'a.md', error: 'e', code: 'X', commit: 'c', first_seen: '', ts: 'not-a-date', attempts: 1, state: 'open' }],
      nowMs: Date.now(), failHours: 72,
    });
    expect(sev.status).toBe('warn');
  });

  test('auto_skipped row keeps acknowledged_at null so legacy !acknowledged_at readers still count it', async () => {
    const { recordFailures, autoSkipFailures, loadSyncFailures } = await L();
    recordFailures('s', [{ path: 'a.md', error: 'e' }], 'c1');
    autoSkipFailures('s', ['a.md']);
    const row = loadSyncFailures()[0];
    expect(row.state).toBe('auto_skipped');
    expect(row.acknowledged).toBe(false);
    expect(row.acknowledged_at).toBeNull();
  });
});

describe('decideGateAction — full branch table', () => {
  test('all branches', async () => {
    const { decideGateAction } = await L();
    const mk = (over: Partial<Parameters<typeof decideGateAction>[0]>) => decideGateAction({
      fileFailures: [], sentinels: [], attemptsByPath: new Map(), threshold: 3, skipFailed: false, ...over,
    });

    expect(mk({}).action).toBe('advance'); // no failures
    expect(mk({ fileFailures: [{ path: 'a' }], skipFailed: true }).action).toBe('advance');
    expect(mk({ fileFailures: [{ path: 'a' }], threshold: 0 }).action).toBe('block'); // valve off
    expect(mk({ fileFailures: [{ path: 'a' }], attemptsByPath: new Map([['a', 1]]) }).action).toBe('block'); // fresh

    const chronic = mk({ fileFailures: [{ path: 'a' }], attemptsByPath: new Map([['a', 3]]) });
    expect(chronic.action).toBe('advance_then_autoskip');
    expect(chronic.autoSkipPaths).toEqual(['a']);

    // mixed fresh + chronic → block (don't silently drop the fresh one)
    expect(mk({
      fileFailures: [{ path: 'a' }, { path: 'b' }],
      attemptsByPath: new Map([['a', 3], ['b', 1]]),
    }).action).toBe('block');
  });
});

describe('#5 + #6 applySyncFailureGate orchestration', () => {
  test('advance_then_autoskip after threshold; advance runs before auto-skip mark', async () => {
    process.env.GBRAIN_SYNC_AUTOSKIP_AFTER = '3';
    const { applySyncFailureGate, loadSyncFailures } = await L();
    let advanceCalls = 0;
    const run = () => applySyncFailureGate({
      sourceId: 's', failedFiles: [{ path: 'poison.md', error: 'YAML parse failed' }],
      succeededPaths: [], commit: 'c', skipFailed: false,
      advance: async () => { advanceCalls++; },
    });

    let r = await run();
    expect(r.advanced).toBe(false); // attempts 1 → block
    r = await run();
    expect(r.advanced).toBe(false); // attempts 2 → block
    r = await run();
    expect(r.advanced).toBe(true);  // attempts 3 → advance + auto-skip
    expect(r.autoSkipped).toEqual(['poison.md']);
    expect(advanceCalls).toBe(1);
    expect(loadSyncFailures()[0].state).toBe('auto_skipped');
  });

  test('a throwing advance() marks nothing auto_skipped (atomicity)', async () => {
    process.env.GBRAIN_SYNC_AUTOSKIP_AFTER = '1';
    const { applySyncFailureGate, loadSyncFailures } = await L();
    await expect(applySyncFailureGate({
      sourceId: 's', failedFiles: [{ path: 'poison.md', error: 'e' }],
      succeededPaths: [], commit: 'c', skipFailed: false,
      advance: async () => { throw new Error('db write failed'); },
    })).rejects.toThrow('db write failed');
    // Recorded as open, NOT auto_skipped — next run can retry.
    const row = loadSyncFailures()[0];
    expect(row.state).toBe('open');
  });

  test('sentinel hard-blocks even with skipFailed; no advance', async () => {
    const { applySyncFailureGate } = await L();
    let advanced = false;
    const r = await applySyncFailureGate({
      sourceId: 's', failedFiles: [{ path: '<head>', error: 'history rewrite' }],
      succeededPaths: [], commit: 'c', skipFailed: true,
      advance: async () => { advanced = true; },
    });
    expect(r.advanced).toBe(false);
    expect(r.sentinelBlocked).toBe(true);
    expect(advanced).toBe(false);
  });

  test('succeeded paths clear prior failures even with no new failures', async () => {
    const { recordFailures, applySyncFailureGate, loadSyncFailures } = await L();
    recordFailures('s', [{ path: 'a.md', error: 'e' }], 'c1');
    expect(loadSyncFailures().length).toBe(1);
    const r = await applySyncFailureGate({
      sourceId: 's', failedFiles: [], succeededPaths: ['a.md'], commit: 'c2',
      skipFailed: false, advance: async () => {},
    });
    expect(r.advanced).toBe(true);
    expect(loadSyncFailures().length).toBe(0);
  });

  test('skipFailed acknowledges and advances', async () => {
    const { applySyncFailureGate, loadSyncFailures } = await L();
    const r = await applySyncFailureGate({
      sourceId: 's', failedFiles: [{ path: 'a.md', error: 'e' }],
      succeededPaths: [], commit: 'c', skipFailed: true, advance: async () => {},
    });
    expect(r.advanced).toBe(true);
    expect(r.acknowledged).toBe(1);
    expect(loadSyncFailures()[0].state).toBe('acknowledged');
  });
});

describe('#8 concurrency: lock + atomic write', () => {
  test('atomic rewrite leaves valid JSON lines (no partial)', async () => {
    const { recordFailures, syncFailuresPath } = await L();
    recordFailures('s', [{ path: 'a.md', error: 'e' }, { path: 'b.md', error: 'e' }], 'c1');
    const raw = readFileSync(syncFailuresPath(), 'utf-8');
    for (const line of raw.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(existsSync(syncFailuresPath() + '.lock')).toBe(false); // lock released
  });

  test('a stale lock (old mtime) is broken so a mutation still proceeds', async () => {
    const { recordFailures, syncFailuresPath, withLedgerLock } = await L();
    // Pre-create the data dir + a stale lock file.
    mkdirSync(dirname(syncFailuresPath()), { recursive: true });
    const lockPath = syncFailuresPath() + '.lock';
    closeSync(openSync(lockPath, 'w'));
    const old = new Date(Date.now() - 120_000); // 2 min ago > 30s stale window
    utimesSync(lockPath, old, old);

    // Mutation should break the stale lock and succeed.
    recordFailures('s', [{ path: 'a.md', error: 'e' }], 'c1');
    const { loadSyncFailures } = await L();
    expect(loadSyncFailures().length).toBe(1);

    // withLedgerLock returns the callback's value.
    expect(withLedgerLock(() => 42)).toBe(42);
  });
});

describe('resolveAutoSkipThreshold', () => {
  test('default 3, env override, 0 disables, invalid → default', async () => {
    const { resolveAutoSkipThreshold } = await L();
    delete process.env.GBRAIN_SYNC_AUTOSKIP_AFTER;
    expect(resolveAutoSkipThreshold()).toBe(3);
    process.env.GBRAIN_SYNC_AUTOSKIP_AFTER = '5';
    expect(resolveAutoSkipThreshold()).toBe(5);
    process.env.GBRAIN_SYNC_AUTOSKIP_AFTER = '0';
    expect(resolveAutoSkipThreshold()).toBe(0);
    process.env.GBRAIN_SYNC_AUTOSKIP_AFTER = 'nonsense';
    expect(resolveAutoSkipThreshold()).toBe(3);
  });
});

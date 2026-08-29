/**
 * test/backup-status-file.test.ts — engine-free coverage for
 * src/core/backup/status-file.ts: cached-verdict I/O, staleness, interval /
 * kill-switch config resolution, notice rendering (privacy pins), the
 * pseudo-version fingerprint, the bounded nag gate lifecycle (per-channel
 * ceiling, 24h dampener, global monthly cap), the read-only consult, the
 * spawn debounce, and the CLI startup-rail helper.
 *
 * Uses the module's __set...ForTests seams pointed at files under a mkdtemp
 * dir; never touches the real ~/.gbrain. No engine.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BACKUP_BANNER_MAX_CHARS,
  BACKUP_DAMPENER_MS,
  BACKUP_GLOBAL_CEILING,
  BACKUP_INTERVAL_DAYS_DEFAULT,
  BACKUP_NAG_SCHEMA_VERSION,
  BACKUP_STATUS_SCHEMA_VERSION,
  BACKUP_CLI_NAG_SKIP,
  backupCheckDisabled,
  backupIntervalMs,
  backupNagGate,
  backupNagReadOnlyConsult,
  backupNagStatePath,
  backupNoticeText,
  backupSpawnDue,
  backupStatusPath,
  backupVerdictVersion,
  invalidateBackupStatus,
  isBackupStatusStale,
  loadBackupNagState,
  loadBackupStatus,
  maybeEmitBackupNag,
  recordBackupSpawn,
  saveBackupNagState,
  saveBackupStatus,
  __setBackupIntervalForTests,
  __setBackupNagStatePathForTests,
  __setBackupStatusPathForTests,
  type BackupAssetVerdict,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ENV_KEYS = [
  'GBRAIN_HOME',
  'GBRAIN_BACKUP_CHECK',
  'GBRAIN_BACKUP_CHECK_DAYS',
  'GBRAIN_SKIP_STARTUP_HOOKS',
  'GBRAIN_FORCE_BACKUP_NAG',
  'NODE_ENV',
] as const;

let tmp: string;
let statusPath: string;
let nagPath: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-backup-status-'));
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Clear the backup knobs; leave NODE_ENV as-is (bun test sets it).
  delete process.env.GBRAIN_BACKUP_CHECK;
  delete process.env.GBRAIN_BACKUP_CHECK_DAYS;
  delete process.env.GBRAIN_SKIP_STARTUP_HOOKS;
  delete process.env.GBRAIN_FORCE_BACKUP_NAG;
  process.env.GBRAIN_HOME = tmp; // config reads resolve to <tmp>/.gbrain/config.json
  statusPath = join(tmp, 'backup-status.json');
  nagPath = join(tmp, 'backup-nag-state.json');
  __setBackupStatusPathForTests(statusPath);
  __setBackupNagStatePathForTests(nagPath);
  __setBackupIntervalForTests(null);
});

afterEach(() => {
  __setBackupStatusPathForTests(null);
  __setBackupNagStatePathForTests(null);
  __setBackupIntervalForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(cfg: Record<string, unknown>): void {
  const dir = join(tmp, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ engine: 'pglite', ...cfg }));
}

/** Warn-by-default fixture: 2 of 3 assets have no remote. Ids deliberately
 * include a local path and a client name for the privacy pins. */
function makeStatus(overrides: Partial<BackupStatus> = {}): BackupStatus {
  const assets: BackupAssetVerdict[] =
    overrides.assets ??
    ([
      { kind: 'source_repo', id: '/tmp/secret-repo', state: 'no_remote', fix_argv: null },
      { kind: 'source_repo', id: 'client-acme', state: 'no_remote', fix_argv: null },
      { kind: 'source_repo', id: 'public-notes', state: 'ok' },
    ] as BackupAssetVerdict[]);
  const no_remote = assets.filter((a) => a.state === 'no_remote').length;
  const base: BackupStatus = {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: '2026-01-05T12:00:00.000Z',
    gbrain_version: '0.0.0-test',
    interval_days: 30,
    computed_by: 'cli',
    overall: no_remote > 0 ? 'warn' : 'ok',
    totals: {
      assets: assets.length,
      no_remote,
      unpushed: 0,
      failing: 0,
      recoverable_repos: assets.length - no_remote,
      pages_at_risk: 0,
    },
    assets,
  };
  return { ...base, ...overrides };
}

function okStatus(): BackupStatus {
  return makeStatus({
    assets: [{ kind: 'source_repo', id: 'public-notes', state: 'ok' }] as BackupAssetVerdict[],
  });
}

function collect(): { write: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (line: string) => lines.push(line), lines };
}

// ── 1. Cached verdict I/O ────────────────────────────────────────────────────

describe('loadBackupStatus / saveBackupStatus', () => {
  test('seams route the machine files under the tmp dir', () => {
    expect(backupStatusPath()).toBe(statusPath);
    expect(backupNagStatePath()).toBe(nagPath);
  });

  test('save/load round-trip', () => {
    const s = makeStatus();
    saveBackupStatus(s);
    expect(existsSync(statusPath)).toBe(true);
    expect(loadBackupStatus()).toEqual(s);
  });

  test('missing file -> null', () => {
    expect(existsSync(statusPath)).toBe(false);
    expect(loadBackupStatus()).toBeNull();
  });

  test('corrupt JSON -> null (fail-open)', () => {
    writeFileSync(statusPath, '{ definitely not json');
    expect(loadBackupStatus()).toBeNull();
  });

  test('unknown schema_version -> null', () => {
    const s = makeStatus();
    writeFileSync(statusPath, JSON.stringify({ ...s, schema_version: 'gbrain-backup-status-v999' }));
    expect(loadBackupStatus()).toBeNull();
  });

  test('structurally invalid payloads -> null (checked_at / assets / overall)', () => {
    const s = makeStatus();
    writeFileSync(statusPath, JSON.stringify({ ...s, checked_at: 42 }));
    expect(loadBackupStatus()).toBeNull();
    writeFileSync(statusPath, JSON.stringify({ ...s, assets: 'nope' }));
    expect(loadBackupStatus()).toBeNull();
    writeFileSync(statusPath, JSON.stringify({ ...s, overall: 'panic' }));
    expect(loadBackupStatus()).toBeNull();
  });

  test('missing or malformed totals block -> null (renderers dereference totals un-guarded)', () => {
    const s = makeStatus();
    // Schema-valid JSON with the totals block REMOVED must read as absent,
    // not crash `gbrain backup status`.
    const { totals: _dropped, ...withoutTotals } = s;
    writeFileSync(statusPath, JSON.stringify(withoutTotals));
    expect(loadBackupStatus()).toBeNull();
    // Truncated-but-schema-valid totals (non-numeric / null) are rejected too.
    writeFileSync(statusPath, JSON.stringify({ ...s, totals: null }));
    expect(loadBackupStatus()).toBeNull();
    writeFileSync(statusPath, JSON.stringify({ ...s, totals: { assets: 'three' } }));
    expect(loadBackupStatus()).toBeNull();
    writeFileSync(statusPath, JSON.stringify({ ...s, totals: { ...s.totals, no_remote: 'two' } }));
    expect(loadBackupStatus()).toBeNull();
    // The intact fixture still loads (the guard rejects only malformed shapes).
    writeFileSync(statusPath, JSON.stringify(s));
    expect(loadBackupStatus()).toEqual(s);
  });
});

// ── 2. invalidateBackupStatus ────────────────────────────────────────────────

describe('invalidateBackupStatus', () => {
  test('removes the cache file', () => {
    saveBackupStatus(makeStatus());
    expect(existsSync(statusPath)).toBe(true);
    invalidateBackupStatus();
    expect(existsSync(statusPath)).toBe(false);
    expect(loadBackupStatus()).toBeNull();
  });

  test('no-op when the file is absent', () => {
    expect(existsSync(statusPath)).toBe(false);
    expect(() => invalidateBackupStatus()).not.toThrow();
    expect(existsSync(statusPath)).toBe(false);
  });
});

// ── 3. isBackupStatusStale ───────────────────────────────────────────────────

describe('isBackupStatusStale', () => {
  const now = Date.parse('2026-06-15T00:00:00.000Z');

  test('null -> true (cold start computes)', () => {
    expect(isBackupStatusStale(null, now)).toBe(true);
  });

  test('fresh -> false (injected now)', () => {
    const s = makeStatus({ checked_at: new Date(now - HOUR).toISOString() });
    expect(isBackupStatusStale(s, now)).toBe(false);
  });

  test('older than the default 30d interval -> true', () => {
    const s = makeStatus({ checked_at: new Date(now - 31 * DAY).toISOString() });
    expect(isBackupStatusStale(s, now)).toBe(true);
    const edge = makeStatus({ checked_at: new Date(now - 29 * DAY).toISOString() });
    expect(isBackupStatusStale(edge, now)).toBe(false);
  });

  test('interval seam is honored', () => {
    __setBackupIntervalForTests(1000);
    expect(isBackupStatusStale(makeStatus({ checked_at: new Date(now - 2000).toISOString() }), now)).toBe(true);
    expect(isBackupStatusStale(makeStatus({ checked_at: new Date(now - 500).toISOString() }), now)).toBe(false);
  });

  test('checked_at >24h in the FUTURE -> true (clock skew); <=24h future is tolerated', () => {
    expect(isBackupStatusStale(makeStatus({ checked_at: new Date(now + 25 * HOUR).toISOString() }), now)).toBe(true);
    expect(isBackupStatusStale(makeStatus({ checked_at: new Date(now + HOUR).toISOString() }), now)).toBe(false);
  });

  test('unparseable checked_at -> true', () => {
    expect(isBackupStatusStale(makeStatus({ checked_at: 'not-a-date' }), now)).toBe(true);
  });
});

// ── 4. backupIntervalMs ──────────────────────────────────────────────────────

describe('backupIntervalMs', () => {
  test('default is 30 days', () => {
    expect(BACKUP_INTERVAL_DAYS_DEFAULT).toBe(30);
    expect(backupIntervalMs()).toBe(30 * DAY);
  });

  test('env GBRAIN_BACKUP_CHECK_DAYS=7 -> 7 days', () => {
    process.env.GBRAIN_BACKUP_CHECK_DAYS = '7';
    expect(backupIntervalMs()).toBe(7 * DAY);
  });

  test('DAYS=0 is clamped to the default (invalid, NOT always-stale)', () => {
    process.env.GBRAIN_BACKUP_CHECK_DAYS = '0';
    expect(backupIntervalMs()).toBe(30 * DAY);
    // A fresh cache stays fresh under DAYS=0 — the clamp prevents always-stale.
    const now = Date.parse('2026-06-15T00:00:00.000Z');
    const fresh = makeStatus({ checked_at: new Date(now - HOUR).toISOString() });
    expect(isBackupStatusStale(fresh, now)).toBe(false);
  });

  test('config backup.check_interval_days honored; env wins over config', () => {
    writeConfig({ backup: { check_interval_days: 2 } });
    expect(backupIntervalMs()).toBe(2 * DAY);
    process.env.GBRAIN_BACKUP_CHECK_DAYS = '7';
    expect(backupIntervalMs()).toBe(7 * DAY);
  });
});

// ── 5. backupCheckDisabled ───────────────────────────────────────────────────

describe('backupCheckDisabled', () => {
  test('default false (on — the whole point is unopted users)', () => {
    expect(backupCheckDisabled()).toBe(false);
  });

  test('env GBRAIN_BACKUP_CHECK=0 -> true', () => {
    process.env.GBRAIN_BACKUP_CHECK = '0';
    expect(backupCheckDisabled()).toBe(true);
  });

  test("env GBRAIN_BACKUP_CHECK 'false' / 'off' (case-insensitive, trimmed) -> true", () => {
    for (const v of ['false', 'off', 'FALSE', 'Off', ' false ']) {
      process.env.GBRAIN_BACKUP_CHECK = v;
      expect(backupCheckDisabled()).toBe(true);
    }
  });

  test("env GBRAIN_BACKUP_CHECK '1' / 'true' / '' do NOT disable", () => {
    for (const v of ['1', 'true', 'on', '']) {
      process.env.GBRAIN_BACKUP_CHECK = v;
      expect(backupCheckDisabled()).toBe(false);
    }
  });

  test("config backup.check_enabled false/'false'/'off'/'0' -> true", () => {
    for (const v of [false, 'false', 'off', '0'] as const) {
      writeConfig({ backup: { check_enabled: v } });
      expect(backupCheckDisabled()).toBe(true);
    }
  });

  test("config backup.check_enabled true/'true' -> false", () => {
    for (const v of [true, 'true'] as const) {
      writeConfig({ backup: { check_enabled: v } });
      expect(backupCheckDisabled()).toBe(false);
    }
  });
});

// ── 6. backupNoticeText ──────────────────────────────────────────────────────

describe('backupNoticeText', () => {
  test('ok verdict -> null on both surfaces', () => {
    expect(backupNoticeText(okStatus(), 'human')).toBeNull();
    expect(backupNoticeText(okStatus(), 'aggregate')).toBeNull();
  });

  test('human form names up to two assets and stays <= 300 chars', () => {
    const text = backupNoticeText(makeStatus(), 'human');
    expect(text).not.toBeNull();
    expect(text!).toContain('/tmp/secret-repo');
    expect(text!).toContain('client-acme');
    expect(text!).toContain('2 of your 3');
    expect(text!.length).toBeLessThanOrEqual(BACKUP_BANNER_MAX_CHARS);
  });

  test('human form is truncated to the banner budget even with long asset ids', () => {
    const long = makeStatus({
      assets: [
        { kind: 'source_repo', id: `/very/deep/${'x'.repeat(200)}`, state: 'no_remote', fix_argv: null },
        { kind: 'source_repo', id: `/another/${'y'.repeat(200)}`, state: 'no_remote', fix_argv: null },
      ] as BackupAssetVerdict[],
    });
    const text = backupNoticeText(long, 'human');
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(BACKUP_BANNER_MAX_CHARS);
    expect(text!.endsWith('…')).toBe(true);
  });

  test('aggregate form carries counts only — never an asset id or path fragment (privacy pin)', () => {
    const text = backupNoticeText(makeStatus(), 'aggregate');
    expect(text).not.toBeNull();
    expect(text!).toContain('2 of 3');
    expect(text!).not.toContain('secret-repo');
    expect(text!).not.toContain('client-acme');
    expect(text!).not.toContain('/tmp');
    // No path fragments from the fixture ids at all.
    expect(text!).not.toContain('/tmp/secret-repo');
  });
});

// ── 7. backupVerdictVersion ──────────────────────────────────────────────────

describe('backupVerdictVersion', () => {
  test('same month + same no-remote set -> equal (day within month is irrelevant)', () => {
    const a = makeStatus({ checked_at: '2026-01-05T12:00:00.000Z' });
    const b = makeStatus({ checked_at: '2026-01-28T09:30:00.000Z' });
    expect(backupVerdictVersion(a)).toBe(backupVerdictVersion(b));
  });

  test('different month -> different', () => {
    const a = makeStatus({ checked_at: '2026-01-05T12:00:00.000Z' });
    const b = makeStatus({ checked_at: '2026-02-05T12:00:00.000Z' });
    expect(backupVerdictVersion(a)).not.toBe(backupVerdictVersion(b));
  });

  test('different no-remote set -> different', () => {
    const a = makeStatus();
    const b = makeStatus({
      assets: [
        { kind: 'source_repo', id: '/tmp/secret-repo', state: 'no_remote', fix_argv: null },
        { kind: 'source_repo', id: 'client-other', state: 'no_remote', fix_argv: null },
        { kind: 'source_repo', id: 'public-notes', state: 'ok' },
      ] as BackupAssetVerdict[],
    });
    expect(backupVerdictVersion(a)).not.toBe(backupVerdictVersion(b));
  });
});

// ── 8. backupNagGate lifecycle ───────────────────────────────────────────────

describe('backupNagGate', () => {
  test('ok verdict -> hidden; disabled -> hidden even on warn', () => {
    expect(backupNagGate('cli', okStatus(), Date.parse('2026-03-01T00:00:00Z')).show).toBe(false);
    process.env.GBRAIN_BACKUP_CHECK = '0';
    expect(backupNagGate('cli', makeStatus(), Date.parse('2026-03-01T00:00:00Z')).show).toBe(false);
  });

  test('first show -> record -> immediate re-gate hidden by the 24h dampener', () => {
    const s = makeStatus();
    const t0 = Date.parse('2026-03-01T00:00:00.000Z');
    const g1 = backupNagGate('hook-banner', s, t0);
    expect(g1.show).toBe(true);
    g1.record();
    expect(backupNagGate('hook-banner', s, t0 + 1000).show).toBe(false);
    expect(backupNagGate('hook-banner', s, t0 + BACKUP_DAMPENER_MS - 1000).show).toBe(false);
  });

  test('per-channel ceiling of 3 per pseudo-version; a different channel is independent of it but bound by the dampener', () => {
    const s = makeStatus({ checked_at: '2026-01-05T12:00:00.000Z' });
    // Spread the three recorded impressions across months so the GLOBAL cap
    // never saturates — this isolates the per-channel ceiling.
    const t1 = Date.parse('2026-01-05T12:00:00.000Z');
    const t2 = Date.parse('2026-02-06T12:00:00.000Z');
    const t3 = Date.parse('2026-03-07T12:00:00.000Z');
    for (const t of [t1, t2, t3]) {
      const g = backupNagGate('cli', s, t);
      expect(g.show).toBe(true);
      g.record();
    }
    const state = loadBackupNagState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.declined_count).toBe(3);
    expect(state.entries[0]!.suppressed).toBe(true);
    expect(state.global_shown_count).toBe(1); // March bucket only holds one

    // Ceiling hit: hidden even after the dampener ages out (+48h).
    const t4 = Date.parse('2026-03-09T12:00:00.000Z');
    expect(backupNagGate('cli', s, t4).show).toBe(false);

    // A DIFFERENT channel: not bound by cli's per-channel ceiling...
    expect(backupNagGate('status', s, t4).show).toBe(true);
    // ...but IS blocked by the shared 24h dampener right after a record.
    expect(backupNagGate('status', s, t3 + HOUR).show).toBe(false);
  });

  test('same-month forced recompute (new checked_at, same verdict) stays suppressed; month rollover re-surfaces with reset count', () => {
    const s = makeStatus({ checked_at: '2026-01-05T12:00:00.000Z' });
    const t1 = Date.parse('2026-01-05T12:00:00.000Z');
    const t2 = Date.parse('2026-02-06T12:00:00.000Z');
    const t3 = Date.parse('2026-03-07T12:00:00.000Z');
    for (const t of [t1, t2, t3]) {
      const g = backupNagGate('cli', s, t);
      expect(g.show).toBe(true);
      g.record();
    }
    const t4 = Date.parse('2026-03-09T12:00:00.000Z'); // dampener aged, global under cap
    expect(backupNagGate('cli', s, t4).show).toBe(false); // at ceiling

    // Same checked_at month, different day, same no-remote set -> same
    // pseudo-version -> STAYS suppressed.
    const sSameMonth = makeStatus({ checked_at: '2026-01-28T03:00:00.000Z' });
    expect(backupVerdictVersion(sSameMonth)).toBe(backupVerdictVersion(s));
    expect(backupNagGate('cli', sSameMonth, t4).show).toBe(false);

    // New checked_at month -> new pack_version -> re-surfaces, count resets.
    const sApril = makeStatus({ checked_at: '2026-04-01T00:00:00.000Z' });
    const t5 = Date.parse('2026-04-10T12:00:00.000Z');
    const g = backupNagGate('cli', sApril, t5);
    expect(g.show).toBe(true);
    g.record();
    const entry = loadBackupNagState().entries.find((e) => e.pack_name === 'cli');
    expect(entry!.declined_count).toBe(1); // reset, not 4
    expect(entry!.suppressed).toBe(false);
    // Still under ceiling: shows again once the dampener ages out.
    expect(backupNagGate('cli', sApril, t5 + 26 * HOUR).show).toBe(true);
  });

  test('global cap: 3 recorded impressions in one month across channels hides EVERY channel; next month re-arms', () => {
    const s = makeStatus({ checked_at: '2026-03-01T00:00:00.000Z' });
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    const channels = ['a', 'b', 'c'];
    channels.forEach((ch, i) => {
      const g = backupNagGate(ch, s, base + i * 25 * HOUR);
      expect(g.show).toBe(true);
      g.record();
    });
    expect(loadBackupNagState().global_shown_count).toBe(BACKUP_GLOBAL_CEILING);

    const later = base + 3 * 25 * HOUR; // dampener aged; still March
    expect(backupNagGate('d', s, later).show).toBe(false); // fresh channel: global cap
    expect(backupNagGate('a', s, later).show).toBe(false); // under-ceiling channel: global cap
    expect(backupNagGate('d', s, later + 25 * HOUR).show).toBe(false); // stays hidden in-month

    // Next month: global count re-arms (dampener long aged).
    const april = Date.parse('2026-04-02T00:00:00.000Z');
    expect(backupNagGate('d', s, april).show).toBe(true);
  });

  test('record() is deferred — show without record leaves no state, so the next gate still shows', () => {
    const s = makeStatus();
    const t0 = Date.parse('2026-03-01T00:00:00.000Z');
    const g1 = backupNagGate('cli', s, t0);
    expect(g1.show).toBe(true);
    // record NOT called: nothing persisted, nothing counted.
    expect(existsSync(nagPath)).toBe(false);
    expect(backupNagGate('cli', s, t0 + 60_000).show).toBe(true); // even inside the would-be dampener window
    expect(backupNagGate('cli', s, t0 + BACKUP_DAMPENER_MS + HOUR).show).toBe(true);
  });
});

// ── 9. backupNagReadOnlyConsult ──────────────────────────────────────────────

describe('backupNagReadOnlyConsult', () => {
  const now = Date.parse('2026-03-10T00:00:00.000Z');

  test('warn + no state -> true, and never creates the state file', () => {
    expect(existsSync(nagPath)).toBe(false);
    expect(backupNagReadOnlyConsult(makeStatus(), now)).toBe(true);
    expect(existsSync(nagPath)).toBe(false);
  });

  test('ok verdict / disabled -> false', () => {
    expect(backupNagReadOnlyConsult(okStatus(), now)).toBe(false);
    process.env.GBRAIN_BACKUP_CHECK = '0';
    expect(backupNagReadOnlyConsult(makeStatus(), now)).toBe(false);
  });

  test('within 24h of last_shown_at -> false; never writes the state file', () => {
    saveBackupNagState({
      schema_version: BACKUP_NAG_SCHEMA_VERSION,
      entries: [],
      last_shown_at: new Date(now - HOUR).toISOString(),
    });
    const before = readFileSync(nagPath, 'utf-8');
    expect(backupNagReadOnlyConsult(makeStatus(), now)).toBe(false);
    expect(readFileSync(nagPath, 'utf-8')).toBe(before);
  });

  test('global count at ceiling for the current month -> false; under cap next month -> true; never writes', () => {
    saveBackupNagState({
      schema_version: BACKUP_NAG_SCHEMA_VERSION,
      entries: [],
      last_shown_at: new Date(now - 48 * HOUR).toISOString(),
      global_month: '2026-03',
      global_shown_count: BACKUP_GLOBAL_CEILING,
    });
    const before = readFileSync(nagPath, 'utf-8');
    expect(backupNagReadOnlyConsult(makeStatus(), now)).toBe(false);
    // Month rollover: the March count no longer binds.
    expect(backupNagReadOnlyConsult(makeStatus(), Date.parse('2026-04-05T00:00:00.000Z'))).toBe(true);
    expect(readFileSync(nagPath, 'utf-8')).toBe(before);
  });
});

// ── 10. backupSpawnDue / recordBackupSpawn ───────────────────────────────────

describe('backupSpawnDue / recordBackupSpawn', () => {
  test('due when never recorded; not due within 24h; due after (injected now)', () => {
    const t0 = Date.parse('2026-05-01T00:00:00.000Z');
    expect(backupSpawnDue(t0)).toBe(true);
    recordBackupSpawn(t0);
    expect(backupSpawnDue(t0 + HOUR)).toBe(false);
    expect(backupSpawnDue(t0 + 23 * HOUR)).toBe(false);
    expect(backupSpawnDue(t0 + 25 * HOUR)).toBe(true);
  });

  test('recordBackupSpawn preserves the rest of the nag state', () => {
    const t0 = Date.parse('2026-05-01T00:00:00.000Z');
    const g = backupNagGate('cli', makeStatus(), t0);
    g.record();
    recordBackupSpawn(t0 + 1000);
    const state = loadBackupNagState();
    expect(state.entries).toHaveLength(1);
    expect(state.last_spawn_at).toBe(new Date(t0 + 1000).toISOString());
    expect(state.last_shown_at).toBe(new Date(t0).toISOString());
  });
});

// ── 11. maybeEmitBackupNag (CLI startup rail) ────────────────────────────────

describe('maybeEmitBackupNag', () => {
  test('warn cache + non-skip command emits the machine marker + human line and records', () => {
    process.env.GBRAIN_FORCE_BACKUP_NAG = '1';
    saveBackupStatus(makeStatus());
    const c = collect();
    maybeEmitBackupNag('search', {}, c.write);
    // stderr is not a TTY under redirected test runs -> machine marker first.
    expect(c.lines.some((l) => l === 'BACKUP_LOCAL_ONLY 2\n')).toBe(true);
    const human = c.lines.find((l) => l.startsWith('gbrain backup check: '));
    expect(human).toBeDefined();
    expect(human!).toContain("aren't on any git remote");
    // Recorded: nag state exists and counted one impression.
    const state = loadBackupNagState();
    expect(state.global_shown_count).toBe(1);
    expect(state.entries.find((e) => e.pack_name === 'cli')).toBeDefined();
    // Immediate second invocation is dampened -> silent.
    const c2 = collect();
    maybeEmitBackupNag('search', {}, c2.write);
    expect(c2.lines).toEqual([]);
  });

  test('skip-set commands emit nothing and record nothing', () => {
    process.env.GBRAIN_FORCE_BACKUP_NAG = '1';
    saveBackupStatus(makeStatus());
    for (const cmd of ['serve', 'backup', 'doctor', 'advisor', 'call', 'jobs', 'hook', 'upgrade']) {
      expect(BACKUP_CLI_NAG_SKIP.has(cmd)).toBe(true);
      const c = collect();
      maybeEmitBackupNag(cmd, {}, c.write);
      expect(c.lines).toEqual([]);
    }
    // Undefined command is skipped too.
    const c = collect();
    maybeEmitBackupNag(undefined, {}, c.write);
    expect(c.lines).toEqual([]);
    expect(existsSync(nagPath)).toBe(false);
  });

  test('quiet opt emits nothing', () => {
    process.env.GBRAIN_FORCE_BACKUP_NAG = '1';
    saveBackupStatus(makeStatus());
    const c = collect();
    maybeEmitBackupNag('search', { quiet: true }, c.write);
    expect(c.lines).toEqual([]);
    expect(existsSync(nagPath)).toBe(false);
  });

  test('GBRAIN_SKIP_STARTUP_HOOKS set -> nothing', () => {
    process.env.GBRAIN_FORCE_BACKUP_NAG = '1';
    process.env.GBRAIN_SKIP_STARTUP_HOOKS = '1';
    saveBackupStatus(makeStatus());
    const c = collect();
    maybeEmitBackupNag('search', {}, c.write);
    expect(c.lines).toEqual([]);
  });

  test('disabled -> nothing (stale warn cache goes silent)', () => {
    process.env.GBRAIN_FORCE_BACKUP_NAG = '1';
    process.env.GBRAIN_BACKUP_CHECK = '0';
    saveBackupStatus(makeStatus());
    const c = collect();
    maybeEmitBackupNag('search', {}, c.write);
    expect(c.lines).toEqual([]);
  });

  test('ok cache -> nothing; missing cache -> nothing', () => {
    process.env.GBRAIN_FORCE_BACKUP_NAG = '1';
    saveBackupStatus(okStatus());
    const c = collect();
    maybeEmitBackupNag('search', {}, c.write);
    expect(c.lines).toEqual([]);
    invalidateBackupStatus();
    const c2 = collect();
    maybeEmitBackupNag('search', {}, c2.write);
    expect(c2.lines).toEqual([]);
  });

  test("NODE_ENV=test without GBRAIN_FORCE_BACKUP_NAG -> early return (test-suite guard)", () => {
    process.env.NODE_ENV = 'test';
    delete process.env.GBRAIN_FORCE_BACKUP_NAG;
    saveBackupStatus(makeStatus());
    const c = collect();
    maybeEmitBackupNag('search', {}, c.write);
    expect(c.lines).toEqual([]);
  });
});

// ── 12. Fail-open corruption + atomic-write hygiene ──────────────────────────

describe('fail-open + atomicity', () => {
  test('corrupt nag-state file -> gate fail-open (still decides; record repairs the file)', () => {
    writeFileSync(nagPath, '{ this is not json');
    const s = makeStatus();
    const t0 = Date.parse('2026-03-01T00:00:00.000Z');
    const g = backupNagGate('cli', s, t0);
    expect(g.show).toBe(true); // worst case: one extra display, never a crash
    g.record();
    const state = loadBackupNagState();
    expect(state.schema_version).toBe(BACKUP_NAG_SCHEMA_VERSION);
    expect(state.entries).toHaveLength(1);
    expect(state.global_shown_count).toBe(1);
  });

  test('unknown nag-state schema -> empty state (fail-open load)', () => {
    writeFileSync(nagPath, JSON.stringify({ schema_version: 'gbrain-backup-nag-v999', entries: [{}] }));
    const state = loadBackupNagState();
    expect(state.entries).toEqual([]);
  });

  test('kill-mid-write: a partial .tmp sibling next to the status path is ignored', () => {
    const s = makeStatus();
    saveBackupStatus(s);
    // Simulate a writer killed between writeFileSync(tmp) and renameSync.
    writeFileSync(`${statusPath}.tmp-99999`, '{"schema_version":"gbrain-ba'); // truncated JSON
    expect(loadBackupStatus()).toEqual(s); // real file wins; tmp never consulted
    // And with ONLY the orphaned partial present, load sees a missing file.
    rmSync(statusPath);
    expect(loadBackupStatus()).toBeNull();
  });

  test('saveBackupStatus leaves no .tmp droppings on the happy path', () => {
    saveBackupStatus(makeStatus());
    expect(existsSync(`${statusPath}.tmp-${process.pid}`)).toBe(false);
    expect(existsSync(statusPath)).toBe(true);
  });
});

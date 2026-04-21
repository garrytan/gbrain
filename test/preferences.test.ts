import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  loadPreferences,
  savePreferences,
  validateMinionMode,
  appendCompletedMigration,
  loadCompletedMigrations,
  preferencesPaths,
  type Preferences,
} from '../src/core/preferences.ts';

let origHome: string | undefined;
let tmp: string;

beforeEach(() => {
  origHome = process.env.HOME;
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-prefs-test-'));
  process.env.HOME = tmp;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('validateMinionMode', () => {
  test('accepts always / pain_triggered / off', () => {
    expect(() => validateMinionMode('always')).not.toThrow();
    expect(() => validateMinionMode('pain_triggered')).not.toThrow();
    expect(() => validateMinionMode('off')).not.toThrow();
  });

  test('rejects bogus string with clear allowed list', () => {
    expect(() => validateMinionMode('bogus')).toThrow(/always.*pain_triggered.*off/);
  });

  test('rejects non-string values', () => {
    expect(() => validateMinionMode(42)).toThrow();
    expect(() => validateMinionMode(null)).toThrow();
    expect(() => validateMinionMode(undefined)).toThrow();
  });
});

describe('loadPreferences', () => {
  test('returns empty object when file is missing', () => {
    expect(loadPreferences()).toEqual({});
  });

  test('parses existing JSON file', () => {
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(
      join(tmp, '.gbrain', 'preferences.json'),
      JSON.stringify({ minion_mode: 'always', set_in_version: '0.11.0' }),
    );
    expect(loadPreferences()).toEqual({ minion_mode: 'always', set_in_version: '0.11.0' });
  });

  test('throws on malformed JSON so callers can surface it', () => {
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(join(tmp, '.gbrain', 'preferences.json'), '{not json');
    expect(() => loadPreferences()).toThrow();
  });
});

describe('savePreferences', () => {
  test('writes file with 0o600 perms', () => {
    savePreferences({ minion_mode: 'pain_triggered' });
    const path = preferencesPaths.file();
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('round-trip preserves unknown keys for forward-compat', () => {
    const prefs: Preferences = {
      minion_mode: 'always',
      set_at: '2026-04-18T00:00:00Z',
      set_in_version: '0.11.0',
      // deliberately unknown key — future version may add this
      future_feature_flag: { enabled: true, setting: 42 },
    };
    savePreferences(prefs);
    expect(loadPreferences()).toEqual(prefs);
  });

  test('rejects invalid minion_mode on save', () => {
    expect(() => savePreferences({ minion_mode: 'bogus' as any })).toThrow();
  });

  test('creates ~/.gbrain directory if missing', () => {
    // Confirm .gbrain doesn't exist yet
    expect(existsSync(join(tmp, '.gbrain'))).toBe(false);
    savePreferences({ minion_mode: 'off' });
    expect(existsSync(join(tmp, '.gbrain'))).toBe(true);
  });

  test('concurrent save + load: reader never sees a half-written file', () => {
    // Save a valid file, then save a new one. In the middle, the file should
    // always be parseable (atomic rename guarantees this).
    savePreferences({ minion_mode: 'always' });
    const firstLoad = loadPreferences();
    expect(firstLoad.minion_mode).toBe('always');

    savePreferences({ minion_mode: 'pain_triggered' });
    const secondLoad = loadPreferences();
    expect(secondLoad.minion_mode).toBe('pain_triggered');
  });

  test('cleans up temp directory used for atomic write', () => {
    savePreferences({ minion_mode: 'off' });
    const gbrainDir = join(tmp, '.gbrain');
    // Walk children; nothing should remain except preferences.json (plus maybe subdirs
    // created by other code, but for this test the only thing we wrote is prefs).
    const { readdirSync } = require('fs');
    const entries = readdirSync(gbrainDir);
    // Only preferences.json should remain; no .prefs-tmp-* directories left over.
    expect(entries.filter((e: string) => e.startsWith('.prefs-tmp-'))).toEqual([]);
    expect(entries).toContain('preferences.json');
  });
});

describe('appendCompletedMigration', () => {
  test('creates migrations dir and appends valid JSONL', () => {
    appendCompletedMigration({ version: '0.11.0', status: 'complete', mode: 'always' });
    const path = preferencesPaths.completedJsonl();
    expect(existsSync(path)).toBe(true);

    const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.version).toBe('0.11.0');
    expect(parsed.status).toBe('complete');
    expect(parsed.mode).toBe('always');
    expect(parsed.ts).toBeTruthy();
  });

  test('appends instead of overwriting', () => {
    appendCompletedMigration({ version: '0.11.0', status: 'partial', apply_migrations_pending: true });
    appendCompletedMigration({ version: '0.11.0', status: 'complete', mode: 'always' });
    const lines = readFileSync(preferencesPaths.completedJsonl(), 'utf-8').split('\n').filter(l => l.trim());
    expect(lines.length).toBe(2);
  });

  test('rejects entries with no version', () => {
    expect(() => appendCompletedMigration({ status: 'complete' } as any)).toThrow(/version/);
  });

  test('rejects entries with invalid status', () => {
    expect(() => appendCompletedMigration({ version: '0.11.0', status: 'done' as any })).toThrow(/status/);
  });

  test('auto-populates ts when not provided', () => {
    const before = Date.now();
    appendCompletedMigration({ version: '0.11.0', status: 'complete' });
    const parsed = JSON.parse(readFileSync(preferencesPaths.completedJsonl(), 'utf-8').trim());
    const ts = Date.parse(parsed.ts);
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  test('preserves caller-provided ts', () => {
    appendCompletedMigration({ version: '0.11.0', status: 'complete', ts: '2020-01-01T00:00:00Z' });
    const parsed = JSON.parse(readFileSync(preferencesPaths.completedJsonl(), 'utf-8').trim());
    expect(parsed.ts).toBe('2020-01-01T00:00:00Z');
  });
});

describe('loadCompletedMigrations', () => {
  test('returns empty when file is missing', () => {
    expect(loadCompletedMigrations()).toEqual([]);
  });

  test('parses valid JSONL lines', () => {
    appendCompletedMigration({ version: '0.10.0', status: 'complete' });
    appendCompletedMigration({ version: '0.11.0', status: 'partial' });
    const entries = loadCompletedMigrations();
    expect(entries.length).toBe(2);
    expect(entries[0].version).toBe('0.10.0');
    expect(entries[1].status).toBe('partial');
  });

  test('tolerates malformed lines with a warning, continuing past them', () => {
    const dir = join(tmp, '.gbrain', 'migrations');
    mkdirSync(dir, { recursive: true });
    // Write a file with a good line, a malformed line, and another good line.
    writeFileSync(
      join(dir, 'completed.jsonl'),
      [
        JSON.stringify({ version: '0.10.0', status: 'complete' }),
        '{this is not valid json',
        JSON.stringify({ version: '0.11.0', status: 'complete' }),
        '',
      ].join('\n'),
    );
    const entries = loadCompletedMigrations();
    expect(entries.length).toBe(2);
    expect(entries[0].version).toBe('0.10.0');
    expect(entries[1].version).toBe('0.11.0');
  });
});

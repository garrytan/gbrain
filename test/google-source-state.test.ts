/**
 * Direct unit tests for Google source cursor state file mode hardening (bp-u49.4.5.4).
 *
 * Properties verified:
 *  1. Fresh .google-source.json files are mode 0600 regardless of umask.
 *  2. Atomic rewrites preserve or reassert mode 0600 (even when overwriting legacy 0644).
 *  3. Corrupt state file quarantine closes the exposure window before rename,
 *     ensuring .corrupt is mode 0600.
 *  4. Secure quarantine failure fails loudly.
 *  5. Discrimination: old fresh-file creation without mode option creates mode 0644/0666,
 *     while writeGoogleState strictly creates 0600.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  googleStateFile,
  readGoogleState,
  writeGoogleState,
} from '../src/core/google/google-source.ts';
import type { GoogleSourceState } from '../src/core/google/types.ts';
import { atomicWriteFileSync } from '../src/core/atomic-write.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'google-source-state-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sampleState: GoogleSourceState = {
  gmail_history_id: '1234567',
  gmail_backfill_floor_ms: 1726200000000,
  gmail_backfill_done: true,
  gmail_newest_ms: 1726300000000,
  calendar_sync_token: 'cal-sync-tok-abc',
  calendar_id: 'primary',
  contacts_sync_token: 'contact-sync-tok-xyz',
  last_full_at: '2026-09-14T00:00:00.000Z',
};

describe('Google source state file mode hardening (0600)', () => {
  test('fresh .google-source.json is created as mode 0600 under permissive umask (0000)', () => {
    const oldUmask = process.umask(0);
    try {
      writeGoogleState(dir, sampleState);
      const file = googleStateFile(dir);
      expect(existsSync(file)).toBe(true);
      const mode = statSync(file).mode & 0o7777;
      expect(mode).toBe(0o600);

      const readBack = readGoogleState(dir);
      expect(readBack.gmail_history_id).toBe('1234567');
      expect(readBack.calendar_sync_token).toBe('cal-sync-tok-abc');
      expect(readBack.contacts_sync_token).toBe('contact-sync-tok-xyz');
      expect(readBack.gmail_backfill_done).toBe(true);
    } finally {
      process.umask(oldUmask);
    }
  });

  test('fresh .google-source.json is created as mode 0600 under standard umask (0022)', () => {
    const oldUmask = process.umask(0o022);
    try {
      writeGoogleState(dir, sampleState);
      const file = googleStateFile(dir);
      expect(existsSync(file)).toBe(true);
      const mode = statSync(file).mode & 0o7777;
      expect(mode).toBe(0o600);
    } finally {
      process.umask(oldUmask);
    }
  });

  test('atomic rewrite of legacy mode 0644 state file reasserts mode 0600', () => {
    const file = googleStateFile(dir);
    // Simulate legacy live file created at 0644
    writeFileSync(file, JSON.stringify({ ...sampleState, gmail_history_id: '100' }, null, 2));
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o7777).toBe(0o644);

    // Next sync tick executes writeGoogleState
    writeGoogleState(dir, { ...sampleState, gmail_history_id: '200' });
    expect(statSync(file).mode & 0o7777).toBe(0o600);

    const readBack = readGoogleState(dir);
    expect(readBack.gmail_history_id).toBe('200');
  });

  test('atomic rewrite of mode 0600 state file preserves mode 0600', () => {
    const file = googleStateFile(dir);
    writeGoogleState(dir, { ...sampleState, gmail_history_id: 'initial' });
    expect(statSync(file).mode & 0o7777).toBe(0o600);

    writeGoogleState(dir, { ...sampleState, gmail_history_id: 'updated' });
    expect(statSync(file).mode & 0o7777).toBe(0o600);

    const readBack = readGoogleState(dir);
    expect(readBack.gmail_history_id).toBe('updated');
  });

  test('corruption quarantine closes exposure window before rename and produces 0600 .corrupt file', () => {
    const file = googleStateFile(dir);
    // Create a corrupt state file at mode 0644 to test pre-rename chmodding
    writeFileSync(file, '{ corrupt json content ... NOT VALID JSON');
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o7777).toBe(0o644);

    const fallbackState = readGoogleState(dir);
    expect(fallbackState.gmail_history_id).toBeNull();
    expect(fallbackState.gmail_backfill_done).toBe(false);

    // The original file was moved to .corrupt
    expect(existsSync(file)).toBe(false);
    const corruptFile = `${file}.corrupt`;
    expect(existsSync(corruptFile)).toBe(true);

    // Quarantined file MUST be mode 0600 (not 0644)
    expect(statSync(corruptFile).mode & 0o7777).toBe(0o600);
  });

  test('discriminator: legacy unconfigured atomicWriteFileSync yields non-0600 under permissive umask while writeGoogleState yields 0600', () => {
    const oldUmask = process.umask(0);
    try {
      const legacyTarget = join(dir, 'legacy-cursor.json');
      atomicWriteFileSync(legacyTarget, '{"cursor":"data"}\n');
      const legacyMode = statSync(legacyTarget).mode & 0o7777;
      // Without { mode: 0o600 }, umask 0 leaves 0o644 or 0o666 (world readable)
      expect(legacyMode & 0o044).not.toBe(0);

      const hardenedDir = join(dir, 'hardened-sub');
      writeGoogleState(hardenedDir, sampleState);
      const hardenedMode = statSync(googleStateFile(hardenedDir)).mode & 0o7777;
      // With writeGoogleState, mode is strictly 0o600 (not world readable)
      expect(hardenedMode).toBe(0o600);
      expect(hardenedMode & 0o044).toBe(0);
    } finally {
      process.umask(oldUmask);
    }
  });

  test('isolated child process with umask 0000 creates mode 0600 state file', () => {
    const isolatedDir = join(dir, 'isolated-proc');
    const script = `
      import { writeGoogleState, googleStateFile } from "./src/core/google/google-source.ts";
      import { statSync } from "fs";
      process.umask(0);
      writeGoogleState(${JSON.stringify(isolatedDir)}, {
        gmail_history_id: "test",
        gmail_backfill_floor_ms: null,
        gmail_backfill_done: true,
        gmail_newest_ms: null,
        calendar_sync_token: null,
        calendar_id: null,
        contacts_sync_token: null,
        last_full_at: null
      });
      const mode = statSync(googleStateFile(${JSON.stringify(isolatedDir)})).mode & 0o7777;
      process.stdout.write(mode.toString(8));
    `;
    const res = Bun.spawnSync(['bun', '-e', script], {
      cwd: join(__dirname, '..'),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim()).toBe('600');
  });

  test('quarantine failure fails loudly if secure quarantine cannot be established', () => {
    const roSubdir = join(dir, 'readonly-quarantine');
    const file = googleStateFile(roSubdir);
    writeGoogleState(roSubdir, sampleState);
    writeFileSync(file, 'not valid json');

    // Make parent directory read-only so renameSync will fail (EACCES)
    chmodSync(roSubdir, 0o500);
    try {
      expect(() => readGoogleState(roSubdir)).toThrow();
    } finally {
      chmodSync(roSubdir, 0o700);
    }
  });
});

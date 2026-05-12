import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeBrainId,
  loadCheckpoint,
  writeCheckpoint,
  clearCheckpoint,
  validateCheckpoint,
  markStepComplete,
  markStepFailed,
  ALL_UPGRADE_STEPS,
  type UpgradeCheckpoint,
} from '../src/core/upgrade-checkpoint.ts';

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-checkpoint-test-'));
  originalHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = originalHome;
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe('computeBrainId — X2 multi-tenant safety', () => {
  test('strips userinfo before hashing — same hash for cred-rotated URL', () => {
    const a = computeBrainId('postgresql://user:passA@host:5432/db');
    const b = computeBrainId('postgresql://user:passB@host:5432/db');
    expect(a).toBe(b);
  });

  test('different DBs hash differently', () => {
    const a = computeBrainId('postgresql://u:p@host:5432/db_a');
    const b = computeBrainId('postgresql://u:p@host:5432/db_b');
    expect(a).not.toBe(b);
  });

  test('returns a stable 16-char hex string', () => {
    const id = computeBrainId('postgresql://u:p@host:5432/db');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test('no URL → still returns a hash (PGLite path)', () => {
    const id = computeBrainId(undefined);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test('null URL → same hash as undefined', () => {
    const a = computeBrainId(null);
    const b = computeBrainId(undefined);
    expect(a).toBe(b);
  });
});

describe('writeCheckpoint + loadCheckpoint round-trip', () => {
  test('writes and reads a complete checkpoint', () => {
    const cp: UpgradeCheckpoint = {
      brain_id: 'abc123',
      started_at: '2026-05-08T00:00:00.000Z',
      from_version: '0.30.0',
      to_version: '0.30.1',
      completed_steps: ['pull', 'install'],
    };
    writeCheckpoint(cp);
    const loaded = loadCheckpoint();
    expect(loaded).toEqual(cp);
  });

  test('loadCheckpoint returns null when no file', () => {
    expect(loadCheckpoint()).toBeNull();
  });

  test('loadCheckpoint returns null for malformed JSON', () => {
    const cp: UpgradeCheckpoint = {
      brain_id: 'abc',
      started_at: '2026-05-08T00:00:00.000Z',
      from_version: '0.30.0',
      to_version: '0.30.1',
      completed_steps: [],
    };
    writeCheckpoint(cp);
    // Corrupt the file. gbrainPath resolves to GBRAIN_HOME/.gbrain/<file>.
    const path = join(tmpHome, '.gbrain', 'upgrade-checkpoint.json');
    writeFileSync(path, 'not json {{');
    expect(loadCheckpoint()).toBeNull();
  });

  test('clearCheckpoint removes the file', () => {
    const cp: UpgradeCheckpoint = {
      brain_id: 'abc',
      started_at: '2026-05-08T00:00:00.000Z',
      from_version: '0.30.0',
      to_version: '0.30.1',
      completed_steps: [],
    };
    writeCheckpoint(cp);
    expect(loadCheckpoint()).not.toBeNull();
    clearCheckpoint();
    expect(loadCheckpoint()).toBeNull();
  });
});

describe('validateCheckpoint — F4 fall-through + X2 mismatch', () => {
  test('F4: no checkpoint → falls through to full upgrade', () => {
    const r = validateCheckpoint('any-brain-id');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no_checkpoint');
  });

  test('X2: brain mismatch → reason=brain_mismatch', () => {
    const cp: UpgradeCheckpoint = {
      brain_id: 'brain-A',
      started_at: '2026-05-08T00:00:00.000Z',
      from_version: '0.30.0',
      to_version: '0.30.1',
      completed_steps: ['pull'],
    };
    writeCheckpoint(cp);
    const r = validateCheckpoint('brain-B');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('brain_mismatch');
    expect(r.checkpoint?.brain_id).toBe('brain-A');
  });

  test('partial completion → resumeAt = next un-completed step', () => {
    const cp: UpgradeCheckpoint = {
      brain_id: 'brain-A',
      started_at: '2026-05-08T00:00:00.000Z',
      from_version: '0.30.0',
      to_version: '0.30.1',
      completed_steps: ['pull', 'install'],
    };
    writeCheckpoint(cp);
    const r = validateCheckpoint('brain-A');
    expect(r.valid).toBe(true);
    expect(r.resumeAt).toBe('schema');
    expect(r.checkpoint?.brain_id).toBe('brain-A');
  });

  test('all steps complete → reason=all_complete', () => {
    const cp: UpgradeCheckpoint = {
      brain_id: 'brain-A',
      started_at: '2026-05-08T00:00:00.000Z',
      from_version: '0.30.0',
      to_version: '0.30.1',
      completed_steps: [...ALL_UPGRADE_STEPS],
    };
    writeCheckpoint(cp);
    const r = validateCheckpoint('brain-A');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('all_complete');
  });

  test('first step pending → resumeAt = first step', () => {
    const cp: UpgradeCheckpoint = {
      brain_id: 'brain-A',
      started_at: '2026-05-08T00:00:00.000Z',
      from_version: '0.30.0',
      to_version: '0.30.1',
      completed_steps: [],
    };
    writeCheckpoint(cp);
    const r = validateCheckpoint('brain-A');
    expect(r.valid).toBe(true);
    expect(r.resumeAt).toBe(ALL_UPGRADE_STEPS[0]);
  });
});

describe('markStepComplete + markStepFailed', () => {
  const base: UpgradeCheckpoint = {
    brain_id: 'a',
    started_at: '2026-05-08T00:00:00.000Z',
    from_version: '0.30.0',
    to_version: '0.30.1',
    completed_steps: [],
  };

  test('markStepComplete appends new step', () => {
    const cp = markStepComplete({ ...base }, 'pull');
    expect(cp.completed_steps).toEqual(['pull']);
  });

  test('markStepComplete is idempotent', () => {
    let cp = markStepComplete({ ...base }, 'pull');
    cp = markStepComplete(cp, 'pull');
    expect(cp.completed_steps).toEqual(['pull']);
  });

  test('markStepComplete clears prior failed_step', () => {
    const cp: UpgradeCheckpoint = {
      ...base,
      failed_step: 'pull',
      failed_step_error: { message: 'broken' },
    };
    const out = markStepComplete(cp, 'pull');
    expect(out.failed_step).toBeUndefined();
    expect(out.failed_step_error).toBeUndefined();
  });

  test('markStepFailed sets failed_step + error info', () => {
    const err = Object.assign(new Error('timeout'), { code: '57014' });
    const cp = markStepFailed({ ...base }, 'schema', err);
    expect(cp.failed_step).toBe('schema');
    expect(cp.failed_step_error?.message).toBe('timeout');
    expect(cp.failed_step_error?.code).toBe('57014');
  });
});

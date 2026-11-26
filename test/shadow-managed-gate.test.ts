/**
 * `readManagedStorage` and its report helpers (src/shadow/managed-gate.ts): what `gbrain engine shadow start` records
 * about managed storage.
 *
 * Protects: shadow mode gathers evidence on managed brains too, so nothing here refuses. A managed brain reads
 * `managed: true` (and its report line says the brain cannot swap), an unmanaged one `false`, and a mode that cannot
 * be read (query error, missing, duplicated or non-boolean singleton, a brain that cannot be opened) `managed: null`
 * with a short reason code, never a guess and never free-form error text.
 * Regression it catches: a read failure that throws out of `start`, or one that is recorded as unmanaged.
 * Not covered elsewhere: test/rust-engine-shadow-managed-gate.serial.test.ts drives the CLI end to end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  MODE_UNREAD_NOTE, SWAP_BLOCKED_NOTE, readManagedStorage, storageLine, storageReport, unopenableManagedStorage,
} from '../src/shadow/managed-gate.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const engineReading = (rows: unknown): BrainEngine => ({ executeRaw: async () => rows }) as unknown as BrainEngine;
const engineThrowing = (e: Error): BrainEngine => ({ executeRaw: async () => { throw e; } }) as unknown as BrainEngine;
const AT = new Date('2026-01-02T03:04:05.000Z');

describe('readManagedStorage', () => {
  test('a managed brain reads managed: true', async () => {
    expect(await readManagedStorage(engineReading([{ enabled: true }]), AT)).toEqual({ managed: true, checked_at: AT.toISOString() });
  });

  test('an unmanaged brain reads managed: false', async () => {
    expect(await readManagedStorage(engineReading([{ enabled: false }]), AT)).toEqual({ managed: false, checked_at: AT.toISOString() });
  });

  test('a query error is managed: null with the error code, and does not throw', async () => {
    const busy = Object.assign(new Error('A running gbrain holds the PGLite lock at /home/someone/brain'), { code: 'pglite_busy' });
    expect(await readManagedStorage(engineThrowing(busy), AT)).toEqual({ managed: null, checked_at: AT.toISOString(), reason: 'pglite_busy' });
    expect(await readManagedStorage(engineThrowing(new Error('relation "persistence_brain" does not exist')), AT))
      .toEqual({ managed: null, checked_at: AT.toISOString(), reason: 'read_failed' });
  });

  test('a missing, duplicated or non-boolean singleton is managed: null (storage_error), never unmanaged', async () => {
    for (const rows of [[], [{ enabled: true }, { enabled: false }], [{ enabled: 'yes' }], [{ enabled: null }]]) {
      const r = await readManagedStorage(engineReading(rows), AT);
      expect(r, JSON.stringify(rows)).toEqual({ managed: null, checked_at: AT.toISOString(), reason: 'storage_error' });
    }
  });

  test('the reason is a code, never free-form error text', async () => {
    const secret = 'postgresql://host/db?app=VALUECANARY refused';
    for (const e of [new Error(secret), Object.assign(new Error(secret), { code: secret })]) {
      const r = await readManagedStorage(engineThrowing(e), AT);
      expect(JSON.stringify(r)).not.toContain('VALUECANARY');
      expect(r.reason).toBe('read_failed');
    }
  });

  test('a brain that cannot be opened is managed: null with open_failed or the error code', () => {
    expect(unopenableManagedStorage(new Error('connection refused'), AT)).toEqual({ managed: null, checked_at: AT.toISOString(), reason: 'open_failed' });
    expect(unopenableManagedStorage(Object.assign(new Error('x'), { code: 'no_brain' }), AT)).toEqual({ managed: null, checked_at: AT.toISOString(), reason: 'no_brain' });
  });

  describe('a real PGLite brain', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    });
    afterAll(async () => { await engine.disconnect(); });
    beforeEach(async () => { await resetPgliteState(engine); });

    test('enabled=true reads managed and enabled=false reads unmanaged', async () => {
      expect((await readManagedStorage(engine, AT)).managed).toBe(false);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await readManagedStorage(engine, AT)).managed).toBe(true);
    });
  });
});

describe('storageReport and storageLine', () => {
  test('managed carries the swap note, unread carries the mode-unread note, unmanaged has no note', () => {
    expect(storageReport({ managed: true, checked_at: 'T' })).toEqual({ managed: true, checked_at: 'T', note: SWAP_BLOCKED_NOTE });
    expect(storageReport({ managed: null, checked_at: 'T', reason: 'pglite_busy' })).toEqual({ managed: null, checked_at: 'T', reason: 'pglite_busy', note: MODE_UNREAD_NOTE });
    expect(storageReport({ managed: false, checked_at: 'T' })).toEqual({ managed: false, checked_at: 'T', note: null });
    expect(SWAP_BLOCKED_NOTE).toBe('this brain cannot swap while it uses managed storage');
    expect(MODE_UNREAD_NOTE).toBe('could not read whether this brain uses managed storage; the swap will check it');
  });

  test('an absent or malformed record is null, so a state written before the field existed still reads', () => {
    for (const bad of [undefined, null, 'x', {}, { managed: 'true', checked_at: 'T' }, { managed: true }, { managed: true, checked_at: 5 }]) {
      expect(storageReport(bad), JSON.stringify(bad)).toBeNull();
      expect(storageLine(bad)).toBeNull();
    }
  });

  test('the line is printed for a managed or unread brain and not for an unmanaged one', () => {
    expect(storageLine({ managed: true, checked_at: 'T' })).toBe(SWAP_BLOCKED_NOTE);
    expect(storageLine({ managed: null, checked_at: 'T', reason: 'no_brain' })).toBe(`${MODE_UNREAD_NOTE} (no_brain)`);
    expect(storageLine({ managed: null, checked_at: 'T' })).toBe(MODE_UNREAD_NOTE);
    expect(storageLine({ managed: false, checked_at: 'T' })).toBeNull();
  });
});

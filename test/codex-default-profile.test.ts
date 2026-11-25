/**
 * Codex's default registration reads mcp.allow_session_widen the way gbrain serve does: the brain database first,
 * then the config file, with serve's own off check. A brain setup cannot read never gets a new full registration.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import { FULL_PROFILE, registrationProfile, STARTER_PROFILE } from '../src/core/mcp-registration.ts';
import { harnessDefaultProfile, readSessionWidenDb, type DbWidenRead } from '../src/commands/setup-codex-default.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const cfg = (mcp: Record<string, unknown> = {}): GBrainConfig => ({ engine: 'pglite', database_path: '/nonexistent/brain.pglite', mcp } as GBrainConfig);
const reader = (r: DbWidenRead) => { const calls: number[] = []; return { calls, read: async () => { calls.push(1); return r; } }; };

describe('the config file uses serve\'s off check', () => {
  test('every value serve reads as off keeps Codex on starter', () => {
    for (const v of [false, 'false', 'off', 'no', '0', ' FALSE ']) expect(registrationProfile('codex', { mcp: { allow_session_widen: v } })).toEqual(STARTER_PROFILE);
    for (const v of [true, 'true', 'on', undefined]) expect(registrationProfile('codex', { mcp: { allow_session_widen: v } })).toEqual(FULL_PROFILE);
  });
});

describe('harnessDefaultProfile', () => {
  test('the database setting wins over the file, as in serve', async () => {
    const notes: string[] = [];
    const off = await harnessDefaultProfile('codex', cfg(), { note: (n) => notes.push(n), probe: true }, reader({ value: 'off' }).read);
    expect(off.profile).toEqual(STARTER_PROFILE);
    expect(off.why).toContain('mcp.allow_session_widen');
    const on = await harnessDefaultProfile('codex', cfg({ allow_session_widen: false }), { note: (n) => notes.push(n), probe: true }, reader({ value: 'true' }).read);
    expect(on.profile).toEqual(FULL_PROFILE);
    const none = await harnessDefaultProfile('codex', cfg(), { note: (n) => notes.push(n), probe: true }, reader({ value: null }).read);
    expect(none.profile).toEqual(FULL_PROFILE);
    expect(notes).toEqual([]);
  });

  test('an unreadable database gives a new registration starter and names the setting', async () => {
    const notes: string[] = [];
    const r = await harnessDefaultProfile('codex', cfg(), { note: (n) => notes.push(n), probe: true }, reader({ unreadable: 'held' }).read);
    expect(r.profile).toEqual(STARTER_PROFILE);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('mcp.allow_session_widen');
    expect(notes[0]).toContain('--surface starter --advertise verbs');
  });

  test('an unreadable database leaves an existing registration as it is', async () => {
    const notes: string[] = [];
    const r = await harnessDefaultProfile('codex', cfg(), { note: (n) => notes.push(n), probe: true, keep: { ...FULL_PROFILE } }, reader({ unreadable: 'held' }).read);
    expect(r.profile).toEqual(FULL_PROFILE);
    expect(notes[0]).toContain('stays serve --surface full');
  });

  test('the knob, a chosen surface and other harnesses never open the brain', async () => {
    const { calls, read } = reader({ value: 'false' });
    expect((await harnessDefaultProfile('codex', cfg({ default_surface_codex: 'full' }), { note: () => {}, probe: true }, read)).profile).toEqual(FULL_PROFILE);
    expect((await harnessDefaultProfile('codex', cfg(), { note: () => {}, probe: false }, read)).profile).toEqual(FULL_PROFILE);
    expect((await harnessDefaultProfile('hermes', cfg(), { note: () => {}, probe: true }, read)).profile).toEqual(STARTER_PROFILE);
    expect((await harnessDefaultProfile('codex', null, { note: () => {}, probe: true }, read)).profile).toEqual(FULL_PROFILE);
    expect(calls).toHaveLength(0);
  });
});

describe('readSessionWidenDb on a real PGLite brain', () => {
  let db = '';
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-widen-')); roots.push(root);
    db = join(root, 'brain.pglite');
    expect(await readSessionWidenDb({ engine: 'pglite', database_path: db } as GBrainConfig)).toEqual({ value: null });
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: db });
    try { await engine.initSchema(); await engine.setConfig('mcp.allow_session_widen', 'false'); } finally { await engine.disconnect(); }
  }, 60_000);

  test('reads the row and gives up on a held lock', async () => {
    const c = { engine: 'pglite', database_path: db } as GBrainConfig;
    expect(await readSessionWidenDb(c)).toEqual({ value: 'false' });
    const lock = await acquireLock(db);
    try {
      const r = await readSessionWidenDb(c, 200);
      expect(r).toHaveProperty('unreadable');
    } finally { await releaseLock(lock); }
    expect(await readSessionWidenDb(c)).toEqual({ value: 'false' });
  }, 60_000);
});

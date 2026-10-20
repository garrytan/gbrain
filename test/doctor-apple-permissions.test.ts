/**
 * apple_permissions doctor check (#6855): zero-network, reads the last probe a
 * sync recorded in cursor state. PGLite in-memory; synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { appleServicePermissionsCheck } from '../src/commands/doctor/checks/apple-permissions.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { WAVE_CHECKS } from '../src/commands/doctor/wave-checks.ts';
import { connectorHeldItemsCheck } from '../src/commands/doctor/checks/connector-holds.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function seed(id: string, extra: Record<string, unknown>, state?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'apple-doctor-'));
  mkdirSync(dir, { recursive: true });
  if (state) writeFileSync(join(dir, '.apple-source.json'), JSON.stringify({ version: 1, calendar: { hashes: {} }, contacts: { hashes: {} }, mail: { hashes: {} }, ...state }));
  void engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)', [id, dir, JSON.stringify({ kind: 'apple', a_dir: dir, ...extra })]);
  return dir;
}
const settle = () => engine.executeRaw('SELECT 1');

describe('apple_permissions', () => {
  test('ok when no apple source exists', async () => {
    const check = await appleServicePermissionsCheck(engine);
    expect(check.status).toBe('ok');
    expect(check.name).toBe('apple_permissions');
  });

  test('ok when the last recorded probes passed or nothing was recorded yet', async () => {
    seed('apple-ok', {}, { last_probe: { calendar: { ok: true, at: '2026-10-16T00:00:00Z' } } });
    seed('apple-new', {});
    await settle();
    expect((await appleServicePermissionsCheck(engine)).status).toBe('ok');
  });

  test('warns, with the exact pane and an agent fix, for an enabled service denied at the last sync', async () => {
    seed('apple-denied', {}, { last_probe: {
      calendar: { ok: false, at: '2026-10-16T00:00:00Z', code: 'permission_denied' },
      mail: { ok: false, at: '2026-10-16T00:00:00Z', code: 'automation_denied' },
      contacts: { ok: true, at: '2026-10-16T00:00:00Z' },
    } });
    await settle();
    const check = await appleServicePermissionsCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ code: 'permission_denied', count: 2 });
    expect(check.message).toContain('Privacy & Security > Calendars');
    expect(check.message).toContain('Automation');
    expect((check.fix as { argv: string[]; verify: { argv: string[] } })).toMatchObject({
      argv: ['gbrain', 'apple', 'status', '--json'], verify: { argv: ['gbrain', 'doctor', '--only', 'apple_permissions', '--json'] } });
  });

  test('a disabled service that was denied is not reported (opt-out is honored)', async () => {
    seed('apple-optout', { a_services: 'contacts' }, { last_probe: { mail: { ok: false, at: '2026-10-16T00:00:00Z', code: 'automation_denied' } } });
    await settle();
    expect((await appleServicePermissionsCheck(engine)).status).toBe('ok');
  });

  test('a non-permission failure (helper_failed) is not a permission warning', async () => {
    seed('apple-helper', {}, { last_probe: { calendar: { ok: false, at: '2026-10-16T00:00:00Z', code: 'helper_failed' } } });
    await settle();
    expect((await appleServicePermissionsCheck(engine)).status).toBe('ok');
  });

  test('respects the source scope', async () => {
    seed('apple-a', {}, { last_probe: { calendar: { ok: false, at: 'x', code: 'permission_denied' } } });
    await settle();
    expect((await appleServicePermissionsCheck(engine, ['other'])).status).toBe('ok');
    expect((await appleServicePermissionsCheck(engine, ['apple-a'])).status).toBe('warn');
  });

  test('is registered as a wave check and categorized', () => {
    expect(WAVE_CHECKS.some((spec) => spec.id === 'apple_permissions')).toBe(true);
    expect(categorizeCheck('apple_permissions')).toBeTruthy();
  });
});

describe('connector_held_items covers apple sources', () => {
  test('a held apple item is reported with its retry and status commands', async () => {
    seed('apple-held', {}, { item_holds: { version: 1, items: { 'people/x': {
      key: 'people/x', state: 'held', code: 'invalid_params', class: 'content', message: 'render failed', upstream_version: null,
      first_failed_at: '2026-10-14T00:00:00Z', last_failed_at: '2026-10-16T00:00:00Z', attempts: 3, held_at: '2026-10-16T00:00:00Z',
      next_attempt_at: null, reconsiderations: 0, meta: { sender: null, subject: null, title: null, upstream_at: null }, slug: null } } } });
    await settle();
    const check = await connectorHeldItemsCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ held: 1, sources: [{ source_id: 'apple-held', kind: 'apple', held: 1,
      retry: 'gbrain sources retry-held apple-held', status: 'gbrain sources status apple-held' }] });
  });
});

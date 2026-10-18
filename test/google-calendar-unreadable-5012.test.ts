/**
 * #5012 item 9: an unreadable calendar is reported, not synced as empty.
 *
 *  - the calendar sweep records `calendar_unreadable` (403 or 404 from
 *    events.list on the configured calendar) in source state and names the
 *    fix, instead of failing like a cursor expiry; a readable list clears it;
 *  - `CalendarClient.probeCalendar` classifies the live read;
 *  - doctor `google_calendar_readable` reads the stored result (zero-network)
 *    and `google status --no-probe` reports the same;
 *  - `gbrain sources set-calendar` changes the source's calendar id;
 *  - (#5012 item 6) changing the contextual retrieval mode prints that
 *    existing pages keep theirs, with the repair command.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { CalendarClient, type FetchImpl } from '../src/core/google/google-clients.ts';
import { sweepCalendar } from '../src/core/google/people-calendar-sweep.ts';
import type { GoogleSourceState } from '../src/core/google/types.ts';
import { runSources } from '../src/commands/sources.ts';
import { runConfig } from '../src/commands/config.ts';

const tokens = { getAccessToken: async () => 'token', forceRefresh: async () => 'token' };

function calendarFetch(status: number, body: unknown = {}): { fetchImpl: FetchImpl; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, urls };
}

const forbidden = { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden', message: 'Forbidden' }] } };

function sweepDeps(logs: string[]) {
  return {
    sourceId: 'gmail-me',
    cfg: { account: 'me@example.com', services: ['calendar'], historyDays: 30, calendarId: 'team0123@group.calendar.google.com', dir: '/nonexistent', access: 'vault', contactsDir: 'contacts' },
    opts: {},
    log: (m: string) => logs.push(m),
  } as never;
}

describe('calendar sweep records an unreadable calendar (forced probe)', () => {
  for (const [status, body] of [[404, { error: { code: 404, message: 'Not Found' } }], [403, forbidden]] as const) {
    test(`HTTP ${status} on events.list is recorded as calendar_unreadable and named in the log`, async () => {
      const { fetchImpl } = calendarFetch(status, body);
      const logs: string[] = [];
      const state = { calendar_sync_token: null } as unknown as GoogleSourceState;
      await sweepCalendar(sweepDeps(logs), new CalendarClient(tokens, fetchImpl), state, undefined, {} as never, new Set());
      expect(state.calendar_unreadable).toMatchObject({ code: 'calendar_unreadable', calendar_id: 'team0123@group.calendar.google.com', http_status: status });
      const line = logs.join('\n');
      expect(line).toContain('calendar_unreadable');
      expect(line).toContain('gbrain google calendars --account me@example.com');
      expect(line).toContain('gbrain sources set-calendar gmail-me <calendar-id>');
      expect(line).not.toContain('syncToken expired');
    });
  }

  test('a readable list clears the stored result', async () => {
    const { fetchImpl } = calendarFetch(200, { items: [], nextSyncToken: 'tok-1' });
    const state = { calendar_sync_token: null, calendar_unreadable: { code: 'calendar_unreadable', calendar_id: 'x', http_status: 404, at: '2026-10-01T00:00:00Z' } } as unknown as GoogleSourceState;
    await sweepCalendar(sweepDeps([]), new CalendarClient(tokens, fetchImpl), state, undefined, {} as never, new Set());
    expect(state.calendar_unreadable).toBeNull();
    expect(state.calendar_sync_token).toBe('tok-1');
  });

  test('any other upstream failure still fails the calendar sweep', async () => {
    const { fetchImpl } = calendarFetch(500, { error: { message: 'backend' } });
    const state = { calendar_sync_token: null } as unknown as GoogleSourceState;
    await expect(sweepCalendar(sweepDeps([]), new CalendarClient(tokens, fetchImpl), state, undefined, {} as never, new Set())).rejects.toThrow();
    expect(state.calendar_unreadable).toBeUndefined();
  });

  test('probeCalendar: readable, 403 and 404', async () => {
    const probe = (client: CalendarClient) => (client as unknown as { probeCalendar: (id: string) => Promise<unknown> }).probeCalendar('team0123@group.calendar.google.com');
    const ok = calendarFetch(200, { kind: 'calendar#events' });
    expect(await probe(new CalendarClient(tokens, ok.fetchImpl))).toEqual({ readable: true });
    expect(ok.urls[0]).toContain('/calendars/team0123%40group.calendar.google.com/events?maxResults=1');
    expect(await probe(new CalendarClient(tokens, calendarFetch(403, forbidden).fetchImpl))).toEqual({ readable: false, httpStatus: 403 });
    expect(await probe(new CalendarClient(tokens, calendarFetch(404).fetchImpl))).toEqual({ readable: false, httpStatus: 404 });
  });
});

describe('doctor, google status and sources set-calendar', () => {
  let engine: PGLiteEngine;
  let dir: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'gbrain-cal-5012-'));
  });
  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('gmail-me', 'gmail-me', $1::text::jsonb)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
      [JSON.stringify({ kind: 'google', g_account: 'me@example.com', g_dir: dir, g_calendar_id: 'team0123@group.calendar.google.com' })]);
    writeFileSync(join(dir, '.google-source.json'), '{}');
  });

  const stored = (calendarId: string) => writeFileSync(join(dir, '.google-source.json'), JSON.stringify({
    calendar_unreadable: { code: 'calendar_unreadable', calendar_id: calendarId, http_status: 404, at: '2026-10-14T00:00:00Z' } }));

  test('doctor google_calendar_readable warns from stored state with a read-only fix, and is ok otherwise', async () => {
    const { googleCalendarReadableCheck } = await import('../src/commands/doctor/checks/google-calendar.ts');
    expect((await googleCalendarReadableCheck(engine)).status).toBe('ok');
    stored('team0123@group.calendar.google.com');
    const check = await googleCalendarReadableCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ code: 'calendar_unreadable', count: 1, sources: [{ source_id: 'gmail-me', http_status: 404 }] });
    expect(check.message).toContain('gbrain google calendars --account me@example.com');
    expect(check.message).toContain('gbrain sources set-calendar gmail-me <calendar-id>');
    expect((check.fix as { argv: string[]; verify: { argv: string[] } })).toMatchObject({
      argv: ['gbrain', 'google', 'calendars', '--account', 'me@example.com', '--json'],
      verify: { argv: ['gbrain', 'doctor', '--only', 'google_calendar_readable', '--json'] } });
    // A result recorded for a calendar the source no longer uses is not reported.
    stored('old@group.calendar.google.com');
    expect((await googleCalendarReadableCheck(engine)).status).toBe('ok');
  });

  test('google status: --no-probe reports the stored result; a live probe overrides it', async () => {
    const { sourceCalendarReadability } = await import('../src/commands/google-calendar-status.ts');
    const [row] = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null; config: Record<string, unknown> }>(
      `SELECT id, incarnation::text AS incarnation, local_path, config FROM sources WHERE id = 'gmail-me'`);
    stored('team0123@group.calendar.google.com');
    expect(await sourceCalendarReadability(engine, row!, null)).toMatchObject({ readable: false, checked: 'last_sync', code: 'calendar_unreadable',
      fix: { list_command: 'gbrain google calendars --account me@example.com', set_command: 'gbrain sources set-calendar gmail-me <calendar-id>' } });
    const probed: string[] = [];
    expect(await sourceCalendarReadability(engine, row!, async (account, id) => { probed.push(`${account} ${id}`); return { readable: true }; }))
      .toEqual({ calendar_id: 'team0123@group.calendar.google.com', readable: true, checked: 'live' });
    expect(probed).toEqual(['me@example.com team0123@group.calendar.google.com']);
    expect(await sourceCalendarReadability(engine, row!, async () => ({ readable: false, httpStatus: 403 }))).toMatchObject({ readable: false, http_status: 403, checked: 'live' });
  });

  async function cli(fn: () => Promise<void>): Promise<{ out: string; err: string; exit: number | null }> {
    const out: string[] = [];
    const err: string[] = [];
    let exit: number | null = null;
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const error = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    const write = spyOn(process.stderr, 'write').mockImplementation(((c: string) => { err.push(String(c)); return true; }) as never);
    const ex = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
    try { await fn(); } catch (e) { if (!(e as Error).message.startsWith('EXIT:')) throw e; } finally {
      log.mockRestore(); error.mockRestore(); write.mockRestore(); ex.mockRestore();
    }
    return { out: out.join('\n'), err: err.join('\n'), exit };
  }

  test('sources set-calendar writes g_calendar_id and names the sync; refuses a non-Google source', async () => {
    const r = await cli(() => runSources(engine, ['set-calendar', 'gmail-me', 'family0123@group.calendar.google.com']));
    expect(r.exit).toBeNull();
    expect(r.out).toContain('now syncs calendar family0123@group.calendar.google.com');
    expect(r.out).toContain('gbrain sync --source gmail-me');
    const [src] = await engine.executeRaw<{ config: Record<string, unknown> }>(`SELECT config FROM sources WHERE id = 'gmail-me'`);
    expect(src!.config.g_calendar_id).toBe('family0123@group.calendar.google.com');
    expect(src!.config.g_account).toBe('me@example.com');
    const notGoogle = await cli(() => runSources(engine, ['set-calendar', 'default', 'primary']));
    expect(notGoogle.exit).toBe(2);
    const missing = await cli(() => runSources(engine, ['set-calendar', 'nope', 'primary']));
    expect(missing.exit).toBe(4);
  });

  test('sources set-calendar on a managed brain asks first when the source also syncs Gmail (exit 3), then writes with --yes', async () => {
    const managed = new Proxy(engine, { get(target, prop, recv) {
      if (prop !== 'executeRaw') return Reflect.get(target, prop, recv);
      return (sql: string, ...rest: unknown[]) => sql.includes('FROM persistence_brain') ? Promise.resolve([{ enabled: true }])
        : (target.executeRaw as (...a: unknown[]) => Promise<unknown>).call(target, sql, ...rest);
    } }) as PGLiteEngine;
    const asked = await cli(() => runSources(managed, ['set-calendar', 'gmail-me', 'family0123@group.calendar.google.com']));
    expect(asked.exit).toBe(3);
    expect(asked.err).toContain('re-read gmail and contacts history');
    const [before] = await engine.executeRaw<{ config: Record<string, unknown> }>(`SELECT config FROM sources WHERE id = 'gmail-me'`);
    expect(before!.config.g_calendar_id).toBe('team0123@group.calendar.google.com');
    const yes = await cli(() => runSources(managed, ['set-calendar', 'gmail-me', 'family0123@group.calendar.google.com', '--yes']));
    expect(yes.exit).toBeNull();
    const [after] = await engine.executeRaw<{ config: Record<string, unknown> }>(`SELECT config FROM sources WHERE id = 'gmail-me'`);
    expect(after!.config.g_calendar_id).toBe('family0123@group.calendar.google.com');
  });

  test('#5012 item 6: config set search.contextual_retrieval and sources set-cr-mode print the existing-pages hint', async () => {
    const global = await cli(() => runConfig(engine, ['set', 'search.contextual_retrieval', 'title']));
    expect(global.out).toContain('Existing pages keep the contextual retrieval mode recorded when they were imported');
    expect(global.out).toContain('gbrain repair contextual-mode --apply');
    const perSource = await cli(() => runSources(engine, ['set-cr-mode', 'gmail-me', 'none']));
    expect(perSource.out).toContain('Existing pages keep the contextual retrieval mode');
    expect(perSource.out).toContain('gbrain repair contextual-mode --source gmail-me --apply');
  });

  test('config set loops.updates_require_reciprocity validates a boolean and writes nothing on a bad value', async () => {
    const bad = await cli(() => runConfig(engine, ['set', 'loops.updates_require_reciprocity', 'maybe']));
    expect(bad.exit).not.toBeNull();
    expect(await engine.getConfig('loops.updates_require_reciprocity')).toBeNull();
    const good = await cli(() => runConfig(engine, ['set', 'loops.updates_require_reciprocity', 'true']));
    expect(good.exit).toBeNull();
    expect(await engine.getConfig('loops.updates_require_reciprocity')).toBe('true');
  });
});

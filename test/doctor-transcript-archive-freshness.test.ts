/**
 * GST-2768 PR 3: the transcript_archive_freshness doctor check. Off is ok with no noise; with the archive on it warns
 * when the newest archived day is more than transcripts.archive.stale_days behind the newest session day the last run
 * read (fix: archive run, or backfill --from when the gap is wider than one run); the check itself reads no reader, when no maintenance pass has run
 * the archive in that long (fix: gbrain autopilot --install), and lists held days with their codes; a harness with
 * no readable sessions is informational. PGLite, synthetic sessions only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_ENABLED_KEY, ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { ARCHIVE_MAINTENANCE_KEY } from '../src/core/transcripts/archive-maintenance.ts';
import { checkTranscriptArchiveFreshness } from '../src/commands/doctor/checks/transcript-archive.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { conversation, staticReader } from './helpers/transcript-archive.ts';

const NOW = new Date('2026-11-10T09:00:00Z');
const DAY = 86_400_000;
const said = (key: string, ts: string) => conversation('codex', key, [['user', ts, 'synthetic message for alice-example']]);

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await engine.setConfig('brain.audience', 'personal');
});

async function recordPass(atMs: number): Promise<void> {
  await engine.setConfig(ARCHIVE_MAINTENANCE_KEY, JSON.stringify({ at: new Date(atMs).toISOString(), runner: 'serve', status: 'ok', written: 0, held: 0, errors: [] }));
}

/** A run at NOW that read a conversation on `day` but could not read it again to write it, so the day stays unarchived. */
async function runSawUnarchived(day: string): Promise<void> {
  const ts = day + 'T08:00:00.000Z';
  const reader: ArchiveReader = {
    harness: 'codex', name: 'codex',
    async *scan({ dayOf }) { yield { harness: 'codex', conversationKey: 'codex-new', sessionId: 'codex-new', days: [dayOf(ts)], newest: ts, load: async () => null }; },
  };
  await runTranscriptArchive(engine, { mode: 'run', now: NOW, readers: [reader] });
}

async function archiveDay(day: string): Promise<void> {
  await runTranscriptArchive(engine, { mode: 'run', now: new Date(day + 'T12:00:00Z'), readers: [staticReader('codex', [said('codex-old-' + day, day + 'T08:00:00.000Z')])] });
}

describe('transcript_archive_freshness', () => {
  test('is a brain-category check', () => {
    expect(categorizeCheck('transcript_archive_freshness')).toBe('brain');
  });

  test('off is ok with no noise and reads no sessions', async () => {
    await engine.setConfig(ARCHIVE_ENABLED_KEY, 'false');
    let read = 0;
    const reader: ArchiveReader = { harness: 'codex', name: 'codex', list: async () => { read++; return []; } };
    const check = await checkTranscriptArchiveFreshness(engine, { readers: [reader], nowMs: NOW.getTime() });
    expect(check.status).toBe('ok');
    expect(check.fix).toBeUndefined();
    expect(check.message).toContain('off');
    expect(read).toBe(0);
  });

  test('a 3-day gap warns with the run fix', async () => {
    await archiveDay('2026-11-07');
    await runSawUnarchived('2026-11-10');
    await recordPass(NOW.getTime() - 60_000);
    const readers = [staticReader('codex', [said('codex-old-2026-11-07', '2026-11-07T08:00:00.000Z'), said('codex-new', '2026-11-10T08:00:00.000Z')])];
    const check = await checkTranscriptArchiveFreshness(engine, { readers, nowMs: NOW.getTime() });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('codex');
    expect(check.message).toContain('3 day(s) behind');
    expect(check.fix?.argv).toEqual(['gbrain', 'transcripts', 'archive', 'run']);
    expect(check.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'transcript_archive_freshness', '--json']);
  }, 60_000);

  test('a gap wider than one run names the backfill with --from', async () => {
    await archiveDay('2026-11-01');
    await runSawUnarchived('2026-11-09');
    await recordPass(NOW.getTime() - 60_000);
    const readers = [staticReader('codex', [said('codex-old-2026-11-01', '2026-11-01T08:00:00.000Z'), said('codex-new', '2026-11-09T08:00:00.000Z')])];
    const check = await checkTranscriptArchiveFreshness(engine, { readers, nowMs: NOW.getTime() });
    expect(check.status).toBe('warn');
    expect(check.fix?.argv).toEqual(['gbrain', 'transcripts', 'archive', 'backfill', '--from', '2026-11-02']);
  }, 60_000);

  test('an archive in step with its sessions and a recent pass is ok', async () => {
    await archiveDay('2026-11-09');
    await recordPass(NOW.getTime() - 60_000);
    const readers = [staticReader('codex', [said('codex-old-2026-11-09', '2026-11-09T08:00:00.000Z')])];
    const check = await checkTranscriptArchiveFreshness(engine, { readers, nowMs: NOW.getTime() });
    expect(check.status).toBe('ok');
  }, 60_000);

  test('a harness with no readable sessions is informational', async () => {
    await recordPass(NOW.getTime() - 60_000);
    const check = await checkTranscriptArchiveFreshness(engine, { readers: [staticReader('grok', []), { harness: 'hermes', name: 'hermes', unavailable: 'no Hermes sessions on this machine' }], nowMs: NOW.getTime() });
    expect(check.status).toBe('ok');
    expect(check.severity).toBe('info');
    expect(check.message).toContain('grok');
    expect(check.message).toContain('hermes');
  });

  test('held days are listed with their codes', async () => {
    await recordPass(NOW.getTime() - 60_000);
    await engine.setConfig('transcripts.archive.ledger.conversations.codex.0123456789abcdef.2026-11-08', JSON.stringify({ held: { code: 'archive_redaction_failed', message: 'synthetic' } }));
    const check = await checkTranscriptArchiveFreshness(engine, { readers: [staticReader('codex', [])], nowMs: NOW.getTime() });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('codex 2026-11-08 (archive_redaction_failed)');
    expect((check.details as { held: unknown[] }).held).toEqual([{ harness: 'codex', day: '2026-11-08', code: 'archive_redaction_failed' }]);
  });

  test('no maintenance pass in 2 days warns with the autopilot fix', async () => {
    await archiveDay('2026-11-09');
    await recordPass(NOW.getTime() - 3 * DAY);
    const readers = [staticReader('codex', [said('codex-old-2026-11-09', '2026-11-09T08:00:00.000Z')])];
    const check = await checkTranscriptArchiveFreshness(engine, { readers, nowMs: NOW.getTime() });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('no maintenance pass has run the archive');
    expect(check.fix?.argv).toEqual(['gbrain', 'autopilot', '--install']);
  }, 60_000);

  test('a recorded maintenance error is shown', async () => {
    await engine.setConfig(ARCHIVE_MAINTENANCE_KEY, JSON.stringify({ at: new Date(NOW.getTime() - 60_000).toISOString(), runner: 'serve', status: 'failed', code: 'archive_reader_failed', written: 0, held: 0, errors: [{ code: 'archive_reader_failed', message: 'synthetic reader failure' }] }));
    const check = await checkTranscriptArchiveFreshness(engine, { readers: [staticReader('codex', [])], nowMs: NOW.getTime() });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('archive_reader_failed');
  });
});

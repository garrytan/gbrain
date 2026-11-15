/**
 * GST-2768 PR 2: a brain with no repository archives into the database (repo-less brains are first class), and the
 * archive source is created database-only when missing. PGLite, no git anywhere.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

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
});

describe('repo-less archive (pglite)', () => {
  test('runs, creates the database-only source, and the database is the record', async () => {
    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
    await setArchiveEnabled(engine, true);
    const result = await runTranscriptArchive(engine, {
      mode: 'run', readers: [staticReader('grok', [conversation('grok', 'grok-session-1', [['user', '2026-11-10T08:00:00.000Z', 'hello from grok']])])],
      now: new Date('2026-11-10T09:00:00Z'),
    });
    expect(result.write_mode).toBe('database');
    expect(result.written).toBe(1);
    const [source] = await engine.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id = 'conversations'");
    expect(source).toEqual({ local_path: null });
    expect((await archivedPages(engine)).map(p => p.slug.split('/').slice(0, 3).join('/'))).toEqual(['conversations/days/2026-11-10', 'conversations/grok/2026-11-10']);
  }, 60_000);

  test('off by default: an unset switch refuses to write and says how to turn it on; a dry run previews', async () => {
    const readers = [staticReader('grok', [conversation('grok', 'grok-session-2', [['user', '2026-11-10T08:00:00.000Z', 'hello']])])];
    const off = await runTranscriptArchive(engine, { mode: 'run', readers, now: new Date('2026-11-10T09:00:00Z') });
    expect(off.enabled).toBe(false);
    expect(off.written).toBe(0);
    expect(off.fix?.argv).toEqual(['gbrain', 'transcripts', 'archive', 'on']);
    expect((await engine.executeRaw('SELECT 1 FROM pages')).length).toBe(0);
    const preview = await runTranscriptArchive(engine, { mode: 'run', readers, dryRun: true, now: new Date('2026-11-10T09:00:00Z') });
    expect(preview.planned).toBe(1);
    expect((await engine.executeRaw('SELECT 1 FROM pages')).length).toBe(0);
    expect((await engine.executeRaw("SELECT 1 FROM config WHERE key LIKE 'transcripts.archive.%'")).length).toBe(0);
  }, 60_000);
});

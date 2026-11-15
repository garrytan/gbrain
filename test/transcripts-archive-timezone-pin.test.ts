/**
 * GST-2768 PR 2: the archive timezone is pinned per source at the first run (ledger and frontmatter). Changing
 * transcripts.archive.timezone afterwards never re-slices existing or new days. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, archiveStatus, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
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

describe('timezone pin (pglite)', () => {
  test('a timezone change after the first run never re-slices', async () => {
    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
    await setArchiveEnabled(engine, true);
    const reader = staticReader('codex', [conversation('codex', 'rollout-tz', [
      ['user', '2026-10-05T20:00:00.000Z', 'evening UTC, next morning in Tokyo'],
      ['user', '2026-10-06T20:00:00.000Z', 'the next evening'],
    ])]);
    const opts = { mode: 'backfill' as const, from: '2026-10-01', to: '2026-10-09', readers: [reader], now: new Date('2026-10-20T00:00:00Z') };
    await runTranscriptArchive(engine, opts);
    const before = await archivedPages(engine);
    expect(before.filter(p => p.slug.startsWith('conversations/codex/')).map(p => p.slug.split('/')[2])).toEqual(['2026-10-05', '2026-10-06']);

    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'Asia/Tokyo');
    const result = await runTranscriptArchive(engine, opts);
    expect(result.timezone).toBe('UTC');
    expect(result.written).toBe(0);
    const after = await archivedPages(engine);
    expect(after).toEqual(before);
    for (const p of after.filter(p => p.slug.startsWith('conversations/codex/'))) {
      expect((p.frontmatter.transcript_archive as Record<string, unknown>).timezone).toBe('UTC');
    }
    const status = await archiveStatus(engine, { readers: [reader] });
    expect(status.timezone).toBe('UTC');
    expect(status.configured_timezone).toBe('Asia/Tokyo');
  }, 60_000);
});

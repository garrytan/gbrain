/**
 * GST-2768 PR 2: idempotency. Two runs and an overlapping backfill give the same pages and revisions; the open day
 * is re-rendered as it grows, and closed days stay byte-identical. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { archivedPages, conversation, staticReader, type Turn } from './helpers/transcript-archive.ts';

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
  await setArchiveEnabled(engine, true);
});

describe('archive idempotency (pglite)', () => {
  test('run, run again, then an overlapping backfill: same pages, same revisions; the open day grows in place', async () => {
    const turns: Turn[] = [
      ['user', '2026-11-08T09:00:00.000Z', 'two days ago'],
      ['user', '2026-11-09T09:00:00.000Z', 'yesterday'],
      ['user', '2026-11-10T09:00:00.000Z', 'today, first message'],
    ];
    const reader = staticReader('hermes', () => [conversation('hermes', 'hermes-session-1', turns)]);
    const now = new Date('2026-11-10T12:00:00Z');
    const first = await runTranscriptArchive(engine, { mode: 'run', readers: [reader], now });
    expect(first.written).toBe(3);
    const pages1 = await archivedPages(engine);
    const today = pages1.find(p => p.slug.startsWith('conversations/hermes/2026-11-10/'))!;
    expect((today.frontmatter.transcript_archive as Record<string, unknown>).complete).toBe(false);
    expect((pages1.find(p => p.slug.startsWith('conversations/hermes/2026-11-09/'))!.frontmatter.transcript_archive as Record<string, unknown>).complete).toBe(true);

    const second = await runTranscriptArchive(engine, { mode: 'run', readers: [reader], now });
    expect(second.written).toBe(0);
    expect(await archivedPages(engine)).toEqual(pages1);

    const backfill = await runTranscriptArchive(engine, { mode: 'backfill', from: '2026-11-01', to: '2026-11-10', readers: [reader], now });
    expect(backfill.written).toBe(0);
    expect(await archivedPages(engine)).toEqual(pages1);

    turns.push(['assistant', '2026-11-10T13:00:00.000Z', 'today, second message']);
    const third = await runTranscriptArchive(engine, { mode: 'run', readers: [reader], now: new Date('2026-11-10T14:00:00Z') });
    expect(third.written).toBe(1);
    const pages3 = await archivedPages(engine);
    const today3 = pages3.find(p => p.slug === today.slug)!;
    expect(today3.revision).toBeGreaterThan(today.revision);
    expect(today3.body).toContain('today, second message');
    for (const p of pages1.filter(p => !p.slug.includes('2026-11-10'))) expect(pages3.find(q => q.slug === p.slug)).toEqual(p);
  }, 60_000);
});

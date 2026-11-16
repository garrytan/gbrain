/**
 * GST-2768 PR 2: the day layout. One page per (harness, conversation, local day) in the pinned timezone, with its own
 * slug and id namespace, the archive stamp beside transcript_import, UTC anchors, and the DST fall-back day kept as one
 * day. Repo-less PGLite, keyless.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { localDay, sliceSessionByDay } from '../src/core/transcripts/archive-day.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { transcriptFullId } from '../src/core/transcripts/types.ts';
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

const LA = 'America/Los_Angeles';

describe('local day slicing', () => {
  test('localDay uses the zone, not UTC', () => {
    expect(localDay('2026-11-03T06:00:00.000Z', LA)).toBe('2026-11-02');
    expect(localDay('2026-11-03T06:00:00.000Z', 'UTC')).toBe('2026-11-03');
  });

  test('the DST fall-back day (2026-11-01 in Los Angeles, 25 hours long) is one day', () => {
    const c = conversation('claude-code', 'session-dst', [
      ['user', '2026-11-01T06:30:00.000Z', 'late on Oct 31 PDT'],
      ['assistant', '2026-11-01T08:30:00.000Z', '01:30 PDT on Nov 1'],
      ['user', '2026-11-01T09:30:00.000Z', '01:30 PST on Nov 1, the repeated hour'],
      ['assistant', '2026-11-02T07:30:00.000Z', '23:30 PST on Nov 1'],
      ['user', '2026-11-02T08:30:00.000Z', '00:30 PST on Nov 2'],
    ]);
    const days = sliceSessionByDay(c.session.messages, LA);
    expect(days.map(d => [d.day, d.messages.length])).toEqual([['2026-10-31', 1], ['2026-11-01', 3], ['2026-11-02', 1]]);
  });
});

describe('archive day pages (pglite, repo-less)', () => {
  test('a session spanning three local days writes three day pages and three day index pages', async () => {
    await engine.setConfig(ARCHIVE_TIMEZONE_KEY, LA);
    await setArchiveEnabled(engine, true);
    const c = conversation('claude-code', 'session-three-days', [
      ['user', '2026-11-03T17:00:00.000Z', 'morning on the 3rd'],
      ['assistant', '2026-11-04T07:30:00.000Z', 'late evening on the 3rd (Los Angeles)'],
      ['user', '2026-11-04T18:00:00.000Z', 'the 4th'],
      ['assistant', '2026-11-05T19:00:00.000Z', 'the 5th'],
    ]);
    const result = await runTranscriptArchive(engine, {
      mode: 'backfill', from: '2026-11-01', to: '2026-11-06', readers: [staticReader('claude-code', [c])], now: new Date('2026-11-10T12:00:00Z'),
    });
    expect(result.held).toBe(0);
    const pages = await archivedPages(engine);
    const dayPages = pages.filter(p => !p.slug.startsWith('conversations/days/'));
    expect(dayPages.map(p => p.slug.split('/').slice(0, 3).join('/'))).toEqual([
      'conversations/claude-code/2026-11-03', 'conversations/claude-code/2026-11-04', 'conversations/claude-code/2026-11-05']);
    const hash = transcriptFullId('session-three-days');
    expect(dayPages.map(p => p.frontmatter.id)).toEqual([
      `claude-code-${hash}-d20261103-p1`, `claude-code-${hash}-d20261104-p1`, `claude-code-${hash}-d20261105-p1`]);
    const first = dayPages[0]!;
    expect(first.frontmatter.type).toBe('conversation');
    expect(first.frontmatter.date).toBe('2026-11-03');
    expect(first.frontmatter.transcript_import).toMatchObject({ harness: 'claude-code', session_id: 'session-three-days', layout: 'day', day: '2026-11-03' });
    expect(first.frontmatter.transcript_archive).toMatchObject({
      layout: 'day', harness: 'claude-code', conversation_key_hash: hash, day: '2026-11-03', timezone: LA, messages: 2, complete: true,
      first_ts: '2026-11-03T17:00:00.000Z', last_ts: '2026-11-04T07:30:00.000Z',
    });
    expect(first.frontmatter.readable_by).toBeUndefined();
    expect(first.body).toContain('(2026-11-04 7:30 AM)');
    expect(pages.filter(p => p.slug.startsWith('conversations/days/')).map(p => p.slug)).toEqual([
      'conversations/days/2026-11-03', 'conversations/days/2026-11-04', 'conversations/days/2026-11-05']);
    const index = pages.find(p => p.slug === 'conversations/days/2026-11-04')!;
    expect(index.body).toContain(dayPages[1]!.slug);
  }, 60_000);
});

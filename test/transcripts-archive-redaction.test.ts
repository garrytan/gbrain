/**
 * GST-2768 PR 2, review change 7: redaction runs over the whole session on every run, so a credential labelled on one
 * day is also scrubbed where it is echoed bare on another day, on the page and in its raw data. A redaction failure
 * holds the session's days (never drops them) and the next run writes them. Repo-less PGLite. The credential is
 * synthetic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, readArchiveLedger, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
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
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

const SECRET = 'Zq7mPq-synthetic-0001';
const conv = () => conversation('claude-code', 'session-secret', [
  ['user', '2026-10-01T10:00:00.000Z', `the staging password: ${SECRET}`],
  ['assistant', '2026-10-01T10:01:00.000Z', 'noted'],
  ['user', '2026-10-02T10:00:00.000Z', `log in again with ${SECRET} please`],
], undefined, { session_id: 'session-secret', cwd: `/home/alice-example/${SECRET}` });
const opts = { mode: 'backfill' as const, from: '2026-10-01', to: '2026-10-03', now: new Date('2026-10-10T00:00:00Z') };

describe('archive redaction (pglite)', () => {
  test('a secret labelled on day 1 and echoed on day 2 is redacted on both pages and in raw data', async () => {
    await runTranscriptArchive(engine, { ...opts, readers: [staticReader('claude-code', [conv()])] });
    const pages = (await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/claude-code/'));
    expect(pages.length).toBe(2);
    for (const p of pages) {
      expect(p.body).not.toContain(SECRET);
      expect(JSON.stringify(p.frontmatter)).not.toContain(SECRET);
    }
    const day2 = pages.find(p => p.slug.includes('/2026-10-02/'))!;
    expect(day2.body).toContain('<REDACTED:');
    const raw = await engine.getRawData(day2.slug, 'transcript:claude-code', { sourceId: 'conversations' });
    expect(raw.length).toBe(1);
    expect(JSON.stringify(raw[0]!.data)).not.toContain(SECRET);
  }, 60_000);

  test('a redaction throw holds every day of the session, writes nothing for it, and the next run writes them', async () => {
    const failed = await runTranscriptArchive(engine, { ...opts, readers: [staticReader('claude-code', [conv()])], redact: () => { throw new Error('scanner failed'); } });
    expect(failed.written).toBe(0);
    expect(failed.days.map(d => [d.day, d.status, d.code])).toEqual([
      ['2026-10-02', 'held', 'archive_redaction_failed'], ['2026-10-01', 'held', 'archive_redaction_failed']]);
    expect(await archivedPages(engine)).toEqual([]);
    expect((await readArchiveLedger(engine, 'conversations')).map(e => e.held?.code)).toEqual(['archive_redaction_failed', 'archive_redaction_failed']);
    const retried = await runTranscriptArchive(engine, { ...opts, readers: [staticReader('claude-code', [conv()])] });
    expect(retried.written).toBe(2);
    expect((await readArchiveLedger(engine, 'conversations')).some(e => e.held)).toBe(false);
  }, 60_000);
});

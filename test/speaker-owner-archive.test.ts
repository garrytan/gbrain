/**
 * GST-3216 PR 2: the conversation archive stamps speaker_owner on the days it writes, and a day archived before the
 * marker existed gets it only on a write it needs anyway, so a re-read session never rewrites its old days. PGLite.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { readSpeakerOwners } from '../src/core/identity/speaker-owner.ts';
import { archivedPages, conversation, staticReader, type Turn } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

const turns: Turn[] = [
  ['user', '2026-11-08T09:00:00.000Z', 'two days ago'],
  ['assistant', '2026-11-08T09:01:00.000Z', 'noted'],
  ['user', '2026-11-10T09:00:00.000Z', 'today'],
];
const now = new Date('2026-11-10T12:00:00Z');
const owned = (list: Turn[]) => {
  const c = conversation('claude-code', 'cc-session-1', list);
  return { ...c, session: { ...c.session, meta: { ...c.session.meta, ownerBasis: 'session_user' as const } } };
};
const marker = (p: { frontmatter: Record<string, unknown> }) => p.frontmatter.speaker_owner;

test('an owner session\'s days carry a trusted marker', async () => {
  await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('claude-code', () => [owned(turns)])], now });
  const pages = (await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/claude-code/'));
  expect(pages.map(marker)).toEqual([{ label: 'User', basis: 'session_user', turns: 1 }, { label: 'User', basis: 'session_user', turns: 1 }]);
  const reads = await readSpeakerOwners(engine, pages.map(p => ({ source_id: 'conversations', slug: p.slug })));
  expect(reads.map(r => r.status)).toEqual(['trusted', 'trusted']);
});

test('a day archived without a marker is left as it is; only a day that changes gains one', async () => {
  const plain = staticReader('claude-code', () => [conversation('claude-code', 'cc-session-1', turns)]);
  await runTranscriptArchive(engine, { mode: 'run', readers: [plain], now });
  const before = (await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/claude-code/'));
  expect(before.map(marker)).toEqual([undefined, undefined]);

  const grown: Turn[] = [...turns, ['user', '2026-11-10T13:00:00.000Z', 'today, again']];
  const again = await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('claude-code', () => [owned(grown)])], now: new Date('2026-11-10T14:00:00Z') });
  expect(again.written).toBe(1);
  const after = (await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/claude-code/'));
  const old = after.find(p => p.slug.includes('2026-11-08'))!;
  expect(old).toEqual(before.find(p => p.slug === old.slug)!);
  expect(marker(after.find(p => p.slug.includes('2026-11-10'))!)).toEqual({ label: 'User', basis: 'session_user', turns: 2 });
});

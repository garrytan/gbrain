/**
 * GST-2768 PR 2, Critical review fix 2: on a shared brain with no owner member the archive holds every day with
 * archive_owner_unset and a fix command, and writes nothing; with an owner every page carries readable_by. Repo-less
 * PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
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
  await engine.setConfig('brain.audience', 'shared');
  await addMember(engine, 'alice-example');
  await addMember(engine, 'bob-example');
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

const reader = () => staticReader('codex', [
  conversation('codex', 'rollout-a', [['user', '2026-10-01T10:00:00.000Z', 'day one'], ['user', '2026-10-02T10:00:00.000Z', 'day two']]),
  conversation('codex', 'rollout-b', [['user', '2026-10-02T11:00:00.000Z', 'other session']]),
]);
const run = () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-10-01', to: '2026-10-03', readers: [reader()], now: new Date('2026-10-10T00:00:00Z') });

describe('shared brain without an owner member (pglite)', () => {
  test('every day is held with archive_owner_unset, nothing is written and the fix names the owner command', async () => {
    const result = await run();
    expect(result.written).toBe(0);
    expect(result.held).toBe(3);
    expect(result.days.every(d => d.status === 'held' && d.code === 'archive_owner_unset')).toBe(true);
    expect(result.fix?.argv?.slice(0, 4)).toEqual(['gbrain', 'access', 'owner', 'set']);
    expect(await archivedPages(engine)).toEqual([]);
    expect((await engine.executeRaw('SELECT 1 FROM pages')).length).toBe(0);
    const ledger = await readArchiveLedger(engine, 'conversations');
    expect(ledger.length).toBe(3);
    expect(ledger.every(e => e.held?.code === 'archive_owner_unset' && !e.hash)).toBe(true);
  }, 60_000);

  test('once the owner is set, the next run writes every held day, each with readable_by naming the owner', async () => {
    await run();
    await setOwner(engine, 'alice-example');
    const result = await run();
    expect(result.held).toBe(0);
    const pages = await archivedPages(engine);
    expect(pages.length).toBe(5);
    for (const p of pages) expect(p.frontmatter.readable_by).toEqual(['alice-example']);
    expect((await readArchiveLedger(engine, 'conversations')).some(e => e.held)).toBe(false);
  }, 60_000);
});

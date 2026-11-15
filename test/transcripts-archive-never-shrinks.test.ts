/**
 * GST-2768 PR 2: the archive never shrinks or replaces a day page because the source now shows less. Covered here:
 * an OpenClaw reset in place (the same conversation now reads only the messages after the reset), a deleted session
 * (gone from the source), a Gateway that is unreachable for a run, and a Gateway that returns partial history (only
 * the newest messages). In every case each day page already written keeps its body and revision. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { openclawGatewayReader, parseGatewayCliOutput } from '../src/core/transcripts/openclaw-gateway.ts';
import { archivedPages, conversation, staticReader, type Turn } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

const KEY = 'agent:main:scratch-reset';
const FULL: Turn[] = [
  ['user', '2026-11-09T08:00:00.000Z', 'monday one'], ['assistant', '2026-11-09T08:01:00.000Z', 'monday two'],
  ['user', '2026-11-10T08:00:00.000Z', 'tuesday one'], ['assistant', '2026-11-10T08:01:00.000Z', 'tuesday two'],
  ['user', '2026-11-10T09:00:00.000Z', 'tuesday three'],
];
const NOW = new Date('2026-11-10T23:00:00Z');
const run = (readers: ArchiveReader[]) => runTranscriptArchive(engine, { mode: 'run', readers, now: NOW });
const snapshot = async () => (await archivedPages(engine)).map(p => ({ slug: p.slug, revision: p.revision, body: p.body }));

async function seed() {
  const first = await run([staticReader('openclaw', [conversation('openclaw', KEY, FULL)])]);
  expect(first.errors).toEqual([]);
  const pages = await snapshot();
  expect(pages.filter(p => p.slug.startsWith('conversations/openclaw/')).length).toBe(2);
  return pages;
}

describe('the archive never shrinks a day page (pglite)', () => {
  test('reset in place: the conversation now shows only the last message, and both day pages are kept unchanged', async () => {
    const before = await seed();
    const result = await run([staticReader('openclaw', [conversation('openclaw', KEY, [FULL[4]!])])]);
    expect(result.errors).toEqual([]);
    expect(result.days.map(d => [d.day, d.status])).toEqual([['2026-11-10', 'kept']]);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  test('deleted session: the conversation is gone from the source, and its pages stay', async () => {
    const before = await seed();
    const result = await run([staticReader('openclaw', [])]);
    expect(result.errors).toEqual([]);
    expect(result.written).toBe(0);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  test('Gateway unreachable for a run: the reader fails, nothing is written or removed, and the next run is unchanged', async () => {
    const before = await seed();
    const down = openclawGatewayReader({ transport: { async call() {
      return parseGatewayCliOutput(JSON.stringify({ ok: false, error: { type: 'gateway_transport_error', message: 'connect ECONNREFUSED 127.0.0.1:18789', details: { kind: 'closed' } } }), 1);
    } } }) as unknown as ArchiveReader;
    const result = await run([down]);
    expect(result.errors.map(e => e.code)).toEqual(['archive_gateway_unreachable']);
    expect(result.written).toBe(0);
    expect(await snapshot()).toEqual(before);
    const again = await run([staticReader('openclaw', [conversation('openclaw', KEY, FULL)])]);
    expect(again.written).toBe(0);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  test('partial history: the Gateway returns only the newest messages, and each shorter day is kept', async () => {
    const before = await seed();
    const result = await run([staticReader('openclaw', [conversation('openclaw', KEY, FULL.slice(3))])]);
    expect(result.errors).toEqual([]);
    expect(result.days.map(d => [d.day, d.status])).toEqual([['2026-11-10', 'kept']]);
    expect(await snapshot()).toEqual(before);
  }, 60_000);
});

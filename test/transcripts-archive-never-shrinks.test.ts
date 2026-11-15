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

  test('reset in place, then as many new messages the same day: the day page keeps the earlier messages', async () => {
    const before = await seed();
    const after: Turn[] = [
      ['user', '2026-11-10T20:00:00.000Z', 'new a'], ['assistant', '2026-11-10T20:01:00.000Z', 'new b'],
      ['user', '2026-11-10T20:02:00.000Z', 'new c'], ['assistant', '2026-11-10T20:03:00.000Z', 'new d'],
    ];
    const result = await run([staticReader('openclaw', [conversation('openclaw', KEY, after)])]);
    expect(result.days.map(d => [d.day, d.status])).toEqual([['2026-11-10', 'kept']]);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  test('the same reset with the reset file still on disk: the run merges both and the day grows', async () => {
    await seed();
    const after: Turn[] = [['user', '2026-11-10T20:00:00.000Z', 'new a'], ['assistant', '2026-11-10T20:01:00.000Z', 'new b']];
    const gateway = { ...staticReader('openclaw', [{ ...conversation('openclaw', KEY, after), via: 'gateway' as const }]), name: 'openclaw-gateway' };
    const file = staticReader('openclaw', [{ ...conversation('openclaw', KEY, FULL), via: 'file' as const }]);
    const result = await run([gateway, file]);
    expect(result.errors).toEqual([]);
    expect(result.days.filter(d => d.status === 'written').map(d => d.day)).toEqual(['2026-11-10']);
    const tuesday = (await snapshot()).find(p => p.slug.startsWith('conversations/openclaw/2026-11-10'))!;
    for (const text of ['tuesday one', 'tuesday three', 'new a', 'new b']) expect(tuesday.body).toContain(text);
    expect(tuesday.body.split('tuesday one').length - 1).toBe(1);
  }, 60_000);

  test('partial history: the Gateway returns only the newest messages, and each shorter day is kept', async () => {
    const before = await seed();
    const result = await run([staticReader('openclaw', [conversation('openclaw', KEY, FULL.slice(3))])]);
    expect(result.errors).toEqual([]);
    expect(result.days.map(d => [d.day, d.status])).toEqual([['2026-11-10', 'kept']]);
    expect(await snapshot()).toEqual(before);
  }, 60_000);
});

describe('never shrinks across holds and overlapping runs (pglite)', () => {
  test('a day written, then held, then read shorter after a reset keeps its page', async () => {
    const before = await seed();
    const held = await runTranscriptArchive(engine, { mode: 'run', readers: [staticReader('openclaw', [conversation('openclaw', KEY, FULL)])], now: NOW, redact: () => { throw new Error('bad pattern'); } });
    expect(held.days.map(d => d.status)).toEqual(['held', 'held']);
    const result = await run([staticReader('openclaw', [conversation('openclaw', KEY, [FULL[4]!])])]);
    expect(result.days.map(d => [d.day, d.status])).toEqual([['2026-11-10', 'kept']]);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  test('two overlapping runs never publish older history over newer', async () => {
    const OLD = FULL.slice(2, 4);
    const NEW = FULL.slice(2);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let started!: () => void;
    const loading = new Promise<void>(r => { started = r; });
    const slow: ArchiveReader = {
      harness: 'openclaw', name: 'openclaw',
      async *scan() {
        const conv = conversation('openclaw', KEY, OLD);
        yield { harness: 'openclaw', conversationKey: KEY, sessionId: KEY, days: ['2026-11-10'], load: async () => { started(); await gate; return conv; } };
      },
    };
    const first = run([slow]).then(r => r, (e: unknown) => e as Error);
    await loading;
    const second = await run([staticReader('openclaw', [conversation('openclaw', KEY, NEW)])]).then(r => r, (e: unknown) => e as Error);
    release();
    const older = await first;
    const tuesday = (await snapshot()).find(p => p.slug.startsWith('conversations/openclaw/2026-11-10'));
    const wrote = (r: unknown) => !(r instanceof Error) && (r as { written: number }).written > 0;
    if (wrote(second)) expect(tuesday?.body ?? '').toContain('tuesday three');
    else expect((second as { code?: string }).code).toBe('archive_run_busy');
    expect(wrote(older) || wrote(second)).toBe(true);
  }, 60_000);
});

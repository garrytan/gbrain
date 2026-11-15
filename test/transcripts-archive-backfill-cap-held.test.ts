/**
 * GST-2768 PR 2: days that keep failing never use up transcripts.archive.backfill_days_per_run. With the five newest
 * days held (redaction fails for their sessions) and a cap of 5, one backfill run still archives five good days, and
 * the held days are retried on the next run without counting against its cap. Synthetic values. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { redactSession } from '../src/core/transcripts/render.ts';
import { ARCHIVE_BACKFILL_CAP_KEY, ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';
import { conversation, staticReader } from './helpers/transcript-archive.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await engine.setConfig(ARCHIVE_BACKFILL_CAP_KEY, '5');
  await setArchiveEnabled(engine, true);
});

const day = (n: number) => '2026-11-' + String(n).padStart(2, '0');
const convs = Array.from({ length: 12 }, (_, i) => conversation('codex', 'rollout-' + day(i + 1), [['user', day(i + 1) + 'T09:00:00.000Z', 'work on ' + day(i + 1)]]));
const FAILING = new Set([8, 9, 10, 11, 12].map(n => 'rollout-' + day(n)));
const redact = (s: ParsedSession) => {
  if (FAILING.has(s.meta.sessionId)) throw new Error('synthetic redaction failure');
  return redactSession(s);
};
const backfill = () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-11-01', readers: [staticReader('codex', convs)], now: new Date('2026-11-14T12:00:00Z'), redact });

describe('backfill cap with days that keep failing (pglite)', () => {
  test('five held days and a cap of 5: the run still archives five good days, and the next run retries the held days', async () => {
    const first = await backfill();
    expect(first.days.filter(d => d.status === 'held').map(d => d.day).sort()).toEqual([8, 9, 10, 11, 12].map(day));
    expect(first.days.filter(d => d.status === 'written').map(d => d.day).sort()).toEqual([3, 4, 5, 6, 7].map(day));
    expect(first.deferred_days).toEqual([1, 2].map(day));
    const second = await backfill();
    expect(second.days.filter(d => d.status === 'held').map(d => d.day).sort()).toEqual([8, 9, 10, 11, 12].map(day));
    expect(second.days.filter(d => d.status === 'written').map(d => d.day).sort()).toEqual([1, 2].map(day));
    expect(second.deferred_days).toEqual([]);
  }, 60_000);
});

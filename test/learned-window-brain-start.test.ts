/**
 * GBRA-789: on a brain younger than the learned window, `gbrain learned` and
 * `learned --stats` name the brain's own start, never a date before the brain
 * existed. The brain's start is the default source's row, which initSchema
 * seeds when the brain is created.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { formatLearned } from '../src/core/learning/read.ts';
import { formatLearnedStats } from '../src/core/learning/stats.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

const learned = async (params: Record<string, unknown> = {}) => {
  const out = await dispatchToolCall(engine, 'learned', params, { remote: false, sourceId: 'default' });
  return JSON.parse(out.content.map(c => c.text).join('\n'));
};
const brainStart = async () => new Date((await engine.executeRaw<{ at: string }>(
  `SELECT to_char(min(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM sources`))[0]!.at);

describe('learned on a fresh brain', () => {
  test('the default window starts when the brain was created, not seven days before', async () => {
    const start = await brainStart();
    expect(Date.now() - start.getTime()).toBeLessThan(3_600_000);
    const view = await learned();
    expect(view.count).toBe(0);
    expect(Date.parse(view.window.since)).toBeGreaterThanOrEqual(start.getTime());
    expect(view.window.default).toBe(true);
    expect(formatLearned(view)).toBe(`Nothing new learned since ${start.toISOString().slice(0, 10)}.\n`);
  });

  test('--stats starts at the brain too', async () => {
    const start = await brainStart();
    const { stats } = await learned({ stats: true });
    expect(Date.parse(stats.since)).toBeGreaterThanOrEqual(start.getTime());
    expect(formatLearnedStats(stats)).toBe(`No learning recorded since ${start.toISOString().slice(0, 10)}.\n`);
  });

  test('a brain older than the window keeps the window; an explicit since is the caller\'s', async () => {
    await engine.executeRaw(`UPDATE sources SET created_at = now() - interval '90 days'`);
    const view = await learned();
    expect(Math.abs(Date.parse(view.window.since) - (Date.now() - 7 * 86_400_000))).toBeLessThan(60_000);
    const { stats } = await learned({ stats: true });
    expect(Math.abs(Date.parse(stats.since) - (Date.now() - 30 * 86_400_000))).toBeLessThan(60_000);
    await engine.executeRaw(`UPDATE sources SET created_at = now()`);
    expect((await learned({ since: '2026-01-01' })).window.since).toBe('2026-01-01T00:00:00.000Z');
  });
});

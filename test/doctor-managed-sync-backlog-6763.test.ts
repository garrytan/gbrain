/**
 * #6763: doctor's managed_sync_backlog check warned "not advanced for over an hour" on a cursor discovered moments ago,
 * because a cursor that has not advanced yet has no progress stamp. The age origin is now the last advance, else the
 * cursor's discovery; a cursor with neither, or with an unreadable time, still warns, and the hour stays an hour.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkManagedSyncBacklog } from '../src/commands/doctor/checks/managed-sync-backlog.ts';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const progress = (minutes: number) => { const at = Date.now() - minutes * 60_000; return { startedAt: at - 60_000, startIndex: 0, lastAt: at, lastIndex: 1 }; };
const fake = (headers: Record<string, unknown>[]) => ({ executeRaw: async () => headers.map(header => ({ header })) }) as unknown as BrainEngine;
const status = async (header: Record<string, unknown>) => (await checkManagedSyncBacklog(fake([{ sourceId: 'example-source', index: 0, total: 3, done: false, ...header }])))?.status;

test('#6763 a cursor that has not advanced yet is aged from its discovery', async () => {
  expect(await status({ total: 0, discoveredAt: minutesAgo(0) })).toBe('ok');
  expect(await status({ discoveredAt: minutesAgo(0) })).toBe('ok');
  expect(await status({ discoveredAt: minutesAgo(59) })).toBe('ok');
  expect(await status({ discoveredAt: minutesAgo(61) })).toBe('warn');
  expect(await status({ total: 0, discoveredAt: minutesAgo(61) })).toBe('warn');
});

test('#6763 the last advance, when there is one, is the age origin; a missing or unreadable time still warns', async () => {
  expect(await status({ index: 1, discoveredAt: minutesAgo(600), progress: progress(5) })).toBe('ok');
  expect(await status({ index: 1, discoveredAt: minutesAgo(5), progress: progress(61) })).toBe('warn');
  expect(await status({})).toBe('warn');
  expect(await status({ discoveredAt: 'not a time' })).toBe('warn');
  const check = await checkManagedSyncBacklog(fake([{ sourceId: 'a-example', index: 0, total: 2, discoveredAt: minutesAgo(1) }, { sourceId: 'b-example', index: 0, total: 2, discoveredAt: minutesAgo(90) }]));
  expect(check).toMatchObject({ status: 'warn' });
  expect(check!.message).toStartWith('1 managed sync cursor(s) have not advanced for over an hour.');
});

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('#6763 a stored cursor: a fresh row write never hides an old discovery, and a done cursor is not a backlog', async () => {
  const put = (fingerprint: string, header: Record<string, unknown>) => engine.executeRaw(
    "INSERT INTO op_checkpoints(op, fingerprint, completed_keys, updated_at) VALUES('managed-sync', $1, jsonb_build_array($2::jsonb), now())", [fingerprint, JSON.stringify(header)]);
  await put('fresh', { sourceId: 'fresh-example', index: 0, total: 0, done: false, discoveredAt: minutesAgo(0) });
  expect(await checkManagedSyncBacklog(engine, ['fresh-example'])).toMatchObject({ status: 'ok' });
  await put('old', { sourceId: 'old-example', index: 0, total: 4, done: false, discoveredAt: minutesAgo(120) });
  expect(await checkManagedSyncBacklog(engine, ['old-example'])).toMatchObject({ status: 'warn' });
  await put('done', { sourceId: 'done-example', index: 4, total: 4, done: true, discoveredAt: minutesAgo(120) });
  expect(await checkManagedSyncBacklog(engine, ['done-example'])).toBeNull();
}, 60_000);

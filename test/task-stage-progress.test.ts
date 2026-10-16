import { expect, test } from 'bun:test';
import { TaskProgressAdapter, finishTaskProgress } from '../src/product/tasks/progress-adapter.ts';
import { TaskProductProgressSchema } from '../shared/contracts/common.ts';

test('entity progress exposes exact counts, remaining work and elapsed stage time', () => {
  const adapter = new TaskProgressAdapter('dream_full');
  adapter.plan(['sync', 'capture_entities', 'extract']);
  adapter.event({ phase: 'cycle.sync', event: 'start', ts: '2026-10-15T00:00:00.000Z' });
  adapter.event({ phase: 'cycle.sync', event: 'finish', ts: '2026-10-15T00:00:05.000Z', elapsed_ms: 5000 });
  adapter.event({ phase: 'cycle.capture_entities', event: 'start', ts: '2026-10-15T00:00:05.000Z' });
  adapter.event({ phase: 'cycle.capture_entities', event: 'tick', done: 2, total: 7, remaining: 5, active: 1,
    unit: '分块', elapsed_ms: 12000, ts: '2026-10-15T00:00:17.000Z', file: '资料.md' });
  expect(adapter.view.phaseProgress).toEqual({ id: 'capture_entities', startedAt: '2026-10-15T00:00:17.000Z',
    elapsedMs: 12000, completed: 2, total: 7, remaining: 5, active: 1, unit: '分块' });
  expect(adapter.view.processed).toBe(2);
  expect(adapter.view.total).toBe(7);
  expect(TaskProductProgressSchema.parse(adapter.view).phaseProgress).toEqual(adapter.view.phaseProgress);
  adapter.event({ phase: 'cycle.extract', event: 'start', ts: '2026-10-15T00:00:20.000Z' });
  expect(adapter.view.phaseProgress?.completed).toBeNull();
  expect(adapter.view.phaseProgress?.total).toBeNull();
});

test('persisted phase progress survives reload and freezes on cancellation', () => {
  const adapter = new TaskProgressAdapter('dream_full');
  adapter.plan(['capture_entities']);
  adapter.event({ phase: 'cycle.capture_entities', event: 'tick', done: 1, total: 3, remaining: 2, active: 1,
    elapsed_ms: 8000, ts: '2026-10-15T00:00:08.000Z' });
  const stopped = finishTaskProgress(adapter.view, 'cancelled', {}, null, Date.parse('2026-10-15T00:00:12.000Z'));
  expect(stopped.phaseProgress?.elapsedMs).toBe(12000);
  expect(stopped.phaseProgress?.startedAt).toBeNull();
  expect(stopped.phaseProgress?.remaining).toBe(2);
  const reloaded = new TaskProgressAdapter('dream_full', stopped);
  reloaded.plan(['capture_entities']);
  expect(reloaded.view.phaseProgress).toEqual(stopped.phaseProgress);
  reloaded.event({ phase: 'cycle.capture_entities', event: 'start', ts: '2026-10-15T01:00:00.000Z' });
  expect(reloaded.view.phaseProgress?.elapsedMs).toBe(12000);
  reloaded.event({ phase: 'cycle.capture_entities', event: 'tick', elapsed_ms: 3000, ts: '2026-10-15T01:00:03.000Z' });
  expect(reloaded.view.phaseProgress?.elapsedMs).toBe(15000);
  reloaded.scope({name:'下一资料库',index:1,total:2});
  expect(reloaded.view.phaseProgress).toBeUndefined();
});

test('finished model children do not mark relationship reconciliation as finished', () => {
  const adapter = new TaskProgressAdapter('dream_full');
  adapter.plan(['capture_entities']);
  adapter.event({ phase: 'cycle.capture_entities', event: 'tick', done: 3, total: 3, remaining: 0, active: 0,
    stage: '核对知识关联', unit: '分块' });
  expect(adapter.view.stage).toContain('核对知识关联');
  expect(adapter.view.steps[0].status).toBe('running');
  expect(adapter.view.phaseProgress?.remaining).toBe(0);
});

test('流式规划总量未知时不编造百分比，心跳和实际推进时间分别记录', () => {
  const adapter = new TaskProgressAdapter('dream_full');
  adapter.plan(['capture_entities']);
  adapter.event({ phase: 'cycle.capture_entities', event: 'tick', done: 2, total: 32, totalKnown: false, active: 1, failed: 1, ts: '2026-10-15T00:00:01.000Z' });
  expect(adapter.view.phaseProgress?.total).toBeNull();
  expect(adapter.view.phasePercent).toBeNull();
  expect(adapter.view.failedUnits).toBe(1);
  expect(adapter.view.lastProgressAt).toBe('2026-10-15T00:00:01.000Z');
  adapter.event({ phase: 'cycle.capture_entities', event: 'tick', done: 2, total: 32, totalKnown: false, active: 1, ts: '2026-10-15T00:00:16.000Z' });
  expect(adapter.view.heartbeatAt).toBe('2026-10-15T00:00:16.000Z');
  expect(adapter.view.lastProgressAt).toBe('2026-10-15T00:00:01.000Z');
  adapter.event({ phase: 'cycle.capture_entities', event: 'tick', done: 3, total: 40, totalKnown: true, active: 1, ts: '2026-10-15T00:00:17.000Z' });
  expect(adapter.view.phasePercent).toBe(7);
  expect(adapter.view.lastProgressAt).toBe('2026-10-15T00:00:17.000Z');
  expect(TaskProductProgressSchema.parse(adapter.view).failedUnits).toBe(1);
});

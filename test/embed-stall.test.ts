/**
 * #4599 — unit tests for the embed stall watchdog module
 * (src/core/embed-stall.ts). Integration coverage (locks released, summary
 * flushed, reason surfaces through runEmbedCore) lives in
 * test/embed.serial.test.ts.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  DEFAULT_EMBED_STALL_ABORT_SEC,
  resolveEmbedStallAbortSeconds,
  createEmbedStallWatchdog,
  noteEmbedApiResponse,
  _resetEmbedApiLivenessForTests,
  assertEmbedNotStalled,
} from '../src/core/embed-stall.ts';

afterEach(() => {
  _resetEmbedApiLivenessForTests();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('resolveEmbedStallAbortSeconds', () => {
  test('defaults to 900 (mirrors sync #1950)', () => {
    expect(DEFAULT_EMBED_STALL_ABORT_SEC).toBe(900);
    expect(resolveEmbedStallAbortSeconds({})).toBe(900);
    expect(resolveEmbedStallAbortSeconds({ GBRAIN_EMBED_STALL_ABORT_SECONDS: '' })).toBe(900);
  });

  test('env override wins; garbage falls back to default', () => {
    expect(resolveEmbedStallAbortSeconds({ GBRAIN_EMBED_STALL_ABORT_SECONDS: '120' })).toBe(120);
    expect(resolveEmbedStallAbortSeconds({ GBRAIN_EMBED_STALL_ABORT_SECONDS: 'soon' })).toBe(900);
  });

  test('0 (and negatives) disable the watchdog', () => {
    expect(resolveEmbedStallAbortSeconds({ GBRAIN_EMBED_STALL_ABORT_SECONDS: '0' })).toBe(0);
    expect(resolveEmbedStallAbortSeconds({ GBRAIN_EMBED_STALL_ABORT_SECONDS: '-5' })).toBe(-5);
  });
});

describe('createEmbedStallWatchdog', () => {
  test('fires once when no successful progress crosses the threshold', async () => {
    const wd = createEmbedStallWatchdog({
      thresholdSeconds: 0.05,
      readProgress: () => 0,
      checkIntervalMs: 10,
    });
    const info = await wd.stalled;
    expect(wd.fired).toBe(true);
    expect(info.thresholdSeconds).toBe(0.05);
    expect(info.msSinceLastProgress).toBeGreaterThanOrEqual(50);
    wd.stop(); // idempotent after fire
  });

  test('successful progress resets the stall clock', async () => {
    let progress = 0;
    const bump = setInterval(() => { progress += 1; }, 5);
    const wd = createEmbedStallWatchdog({
      thresholdSeconds: 0.05,
      readProgress: () => progress,
      checkIntervalMs: 10,
    });
    const winner = await Promise.race([
      wd.stalled.then(() => 'stalled' as const),
      sleep(150).then(() => 'still-running' as const),
    ]);
    clearInterval(bump);
    wd.stop();
    expect(winner).toBe('still-running');
    expect(wd.fired).toBe(false);
  });

  test('stop() disarms without resolving the stalled promise', async () => {
    const wd = createEmbedStallWatchdog({
      thresholdSeconds: 0.02,
      readProgress: () => 0,
      checkIntervalMs: 5,
    });
    wd.stop();
    const winner = await Promise.race([
      wd.stalled.then(() => 'stalled' as const),
      sleep(80).then(() => 'never-fired' as const),
    ]);
    expect(winner).toBe('never-fired');
    expect(wd.fired).toBe(false);
  });

  test('liveness clock: null without API responses, ms-age for responses observed while armed', async () => {
    _resetEmbedApiLivenessForTests();
    const wd1 = createEmbedStallWatchdog({
      thresholdSeconds: 0.02,
      readProgress: () => 0,
      checkIntervalMs: 5,
    });
    const info1 = await wd1.stalled;
    expect(info1.msSinceLastApiResponse).toBeNull();

    const wd2 = createEmbedStallWatchdog({
      thresholdSeconds: 0.05,
      readProgress: () => 0,
      checkIntervalMs: 5,
    });
    noteEmbedApiResponse(); // settles while wd2 is armed → counts as liveness
    const info2 = await wd2.stalled;
    expect(info2.msSinceLastApiResponse).not.toBeNull();
    expect(info2.msSinceLastApiResponse!).toBeGreaterThanOrEqual(0);
  });

  test('liveness clock is run-scoped: pre-arm responses read as null (worker reuse)', async () => {
    _resetEmbedApiLivenessForTests();
    noteEmbedApiResponse(); // a PREVIOUS run's response in a long-lived worker
    await sleep(5);
    const wd = createEmbedStallWatchdog({
      thresholdSeconds: 0.02,
      readProgress: () => 0,
      checkIntervalMs: 5,
    });
    const info = await wd.stalled;
    expect(info.msSinceLastApiResponse).toBeNull();
  });
});

describe('assertEmbedNotStalled (minion failed-job contract, X6)', () => {
  test('no-op on a clean result', () => {
    expect(() => assertEmbedNotStalled({ embedded: 12 })).not.toThrow();
  });

  test('throws a stall_timeout error on a stalled result', () => {
    expect(() => assertEmbedNotStalled({ reason: 'stall_timeout', embedded: 3 })).toThrow(
      /stall_timeout.*embedded=3/,
    );
  });
});

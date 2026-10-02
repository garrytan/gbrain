import { describe, expect, test } from 'bun:test';
import {
  HTTP_WATCHDOG_DEFAULTS,
  HttpInflightGate,
  HttpPipelineWatchdog,
  resolveHttpWatchdogConfig,
} from '../src/core/http-pipeline-watchdog.ts';

function watchdog(overrides: Record<string, string | undefined> = {}) {
  let t = 1_000;
  const warnings: string[] = [];
  const config = resolveHttpWatchdogConfig({
    GBRAIN_HTTP_WATCHDOG_HEARTBEAT_MS: '0',
    ...overrides,
  }, (msg) => { warnings.push(msg); });
  return { t: () => t, set: (n: number) => { t = n; }, warnings, config, w: new HttpPipelineWatchdog(config, () => t) };
}

describe('resolveHttpWatchdogConfig', () => {
  test('defaults', () => {
    const cfg = resolveHttpWatchdogConfig({}, () => {});
    expect(cfg.pipelineMs).toBe(HTTP_WATCHDOG_DEFAULTS.pipelineMs);
    expect(cfg.heartbeatMs).toBe(HTTP_WATCHDOG_DEFAULTS.heartbeatMs);
    expect(cfg.minInflight).toBe(2);
    expect(cfg.maxInflight).toBe(6);
    expect(cfg.inflightWaitMs).toBe(15_000);
    expect(cfg.deepHealth).toBe(false);
    expect(cfg.fatalExit).toBe(true);
  });

  test('invalid numbers fall back and 0 disables the named check', () => {
    const warnings: string[] = [];
    const cfg = resolveHttpWatchdogConfig({
      GBRAIN_HTTP_WATCHDOG_MS: 'nope',
      GBRAIN_HTTP_WATCHDOG_HEARTBEAT_MS: '0',
      GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT: '0',
      GBRAIN_HTTP_MAX_INFLIGHT: '0',
      GBRAIN_HTTP_HEALTH_DEEP: '1',
      GBRAIN_HTTP_FATAL_EXIT: '0',
    }, (msg) => { warnings.push(msg); });
    expect(cfg.pipelineMs).toBe(HTTP_WATCHDOG_DEFAULTS.pipelineMs);
    expect(cfg.heartbeatMs).toBe(0);
    expect(cfg.minInflight).toBe(2);
    expect(cfg.maxInflight).toBe(0);
    expect(cfg.deepHealth).toBe(true);
    expect(cfg.fatalExit).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('HttpPipelineWatchdog', () => {
  test('one slow request is not a wedge', () => {
    const { w, set } = watchdog({ GBRAIN_HTTP_WATCHDOG_MS: '1000' });
    w.begin();
    set(1_000 + 5_000);
    expect(w.assess()).toEqual({ ready: true, reason: null });
  });

  test('two stale requests with no completion are wedged', () => {
    const { w, set } = watchdog({ GBRAIN_HTTP_WATCHDOG_MS: '1000', GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT: '2' });
    w.begin();
    w.begin();
    set(1_000 + 1_000);
    expect(w.assess()).toEqual({ ready: false, reason: 'pipeline_wedged' });
  });

  test('a recent completion keeps two old requests ready', () => {
    const { w, set } = watchdog({ GBRAIN_HTTP_WATCHDOG_MS: '1000' });
    const endA = w.begin();
    w.begin();
    set(1_000 + 1_000);
    endA();
    w.begin();
    expect(w.assess().ready).toBe(true);
  });

  test('pipeline check is off when the window is 0', () => {
    const { w, set } = watchdog({ GBRAIN_HTTP_WATCHDOG_MS: '0' });
    w.begin();
    w.begin();
    set(1_000 + 10_000_000);
    expect(w.assess().ready).toBe(true);
  });

  test('a missed heartbeat fails closed without any inflight work', () => {
    let t = 0;
    const config = resolveHttpWatchdogConfig({
      GBRAIN_HTTP_WATCHDOG_MS: '0',
      GBRAIN_HTTP_WATCHDOG_HEARTBEAT_MS: '1000',
    }, () => {});
    const w = new HttpPipelineWatchdog(config, () => t);
    w.start();
    try {
      t = 2_001;
      expect(w.assess()).toEqual({ ready: false, reason: 'event_loop_stalled' });
    } finally {
      w.stop();
    }
  });
});

describe('HttpInflightGate', () => {
  test('max 0 does not cap', async () => {
    const gate = new HttpInflightGate(0, 5);
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(a.ok && b.ok).toBe(true);
  });

  test('a waiter gets the slot when the holder releases', async () => {
    const gate = new HttpInflightGate(1, 1_000);
    const first = await gate.acquire();
    expect(first.ok).toBe(true);
    let secondOk = false;
    const pending = gate.acquire().then(slot => { secondOk = slot.ok; return slot; });
    await new Promise(r => setTimeout(r, 15));
    expect(secondOk).toBe(false);
    if (first.ok) first.release();
    const second = await pending;
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
  });

  test('wait timeout returns not ok and does not leak the slot', async () => {
    const gate = new HttpInflightGate(1, 20);
    const first = await gate.acquire();
    const second = await gate.acquire();
    expect(second.ok).toBe(false);
    if (first.ok) first.release();
    const third = await gate.acquire();
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });
});

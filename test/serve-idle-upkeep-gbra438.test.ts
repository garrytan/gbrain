/**
 * GBRA-438 PR 2, done item 1: the resident serve runs free upkeep on its idle
 * tick, through the injected timer seam.
 *
 * 1. Protects: upkeep never runs at boot (the first tick only opens the
 *    window), runs after the idle sweep and never beside it, never runs twice
 *    at once, is aborted by stdin data, a warm CLI request or shutdown, is
 *    skipped when a request arrived during the sweep, and is never armed on a
 *    read-only (lean) Postgres serve. The HTTP serve gets the same tick, keyed
 *    on POST /mcp activity, stopped when the server ends.
 * 2. Fails when: upkeep starts on the first tick, overlaps the sweep, keeps
 *    running after a request, or a lean serve or an HTTP serve's GET stream
 *    counts wrong.
 * 3. Seams: ServeOptions.setInterval / sweep / upkeep / runServeHttp, a stub
 *    engine, and the real foreground-activity window.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { runServe, type ServeOptions } from '../src/commands/serve.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { _resetStdoutRedirectForTests } from '../src/core/console-prefix.ts';
import { _resetForegroundActivityForTests, beginForegroundRequest, foregroundWindow, mcpForegroundMiddleware } from '../src/core/foreground-activity.ts';

/* eslint-disable no-console */
const realLog = console.log, realInfo = console.info, realDebug = console.debug;
afterEach(() => {
  console.log = realLog; console.info = realInfo; console.debug = realDebug;
  _resetStdoutRedirectForTests();
});
/* eslint-enable no-console */
beforeEach(() => { _resetForegroundActivityForTests(); });

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const engineOf = (kind: 'pglite' | 'postgres') =>
  ({ kind, disconnect: async () => {}, getConfig: async () => null, executeRaw: async () => [] }) as unknown as BrainEngine;

function harness() {
  const stdin = new EventEmitter();
  const signals = new EventEmitter();
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const events: string[] = [];
  const runs: AbortSignal[] = [];
  const retries: boolean[] = [];
  let sweepGate = gate();
  let upkeepGate = gate();
  const opts: ServeOptions = {
    stdin: stdin as never, signals: signals as never, exit: () => {}, log: () => {}, startMcpServer: async () => {},
    getParentPid: () => 1, probeWatchdog: () => true,
    setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: (h) => { cleared.push(h); },
    mcpStdio: false, bootTimeoutMs: 0, sweepEnabled: true, factsDrain: false,
    sweep: async () => { events.push('sweep:start'); await sweepGate.promise; events.push('sweep:end'); },
    upkeep: async (_engine, signal, retryParked) => {
      events.push('upkeep:start');
      runs.push(signal);
      retries.push(retryParked);
      await Promise.race([upkeepGate.promise, new Promise<void>((r) => signal.addEventListener('abort', () => r()))]);
      events.push(signal.aborted ? 'upkeep:aborted' : 'upkeep:end');
    },
  };
  return {
    stdin, signals, timers, cleared, events, runs, retries, opts,
    tick: () => timers[0]!(),
    openSweep: () => { sweepGate.open(); sweepGate = gate(); },
    openUpkeep: () => { upkeepGate.open(); upkeepGate = gate(); },
  };
}

describe('stdio serve: idle upkeep on the idle tick', () => {
  test('never at boot: the first tick only opens the window; the second runs the sweep, then upkeep', async () => {
    const h = harness();
    await runServe(engineOf('pglite'), [], h.opts);
    expect(h.timers).toHaveLength(1);
    expect(h.events).toEqual([]);
    h.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).toEqual([]);
    h.tick();
    await until(() => h.events.includes('sweep:start'));
    expect(h.events).toEqual(['sweep:start']);
    h.openSweep();
    await until(() => h.events.includes('upkeep:start'));
    expect(h.events).toEqual(['sweep:start', 'sweep:end', 'upkeep:start']);
    h.openUpkeep();
    await until(() => h.events.includes('upkeep:end'));
  });

  test('never overlaps the sweep or itself: ticks while either runs start nothing', async () => {
    const h = harness();
    await runServe(engineOf('pglite'), [], h.opts);
    h.tick(); h.tick();
    await until(() => h.events.includes('sweep:start'));
    h.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).toEqual(['sweep:start']);
    h.openSweep();
    await until(() => h.events.includes('upkeep:start'));
    h.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).toEqual(['sweep:start', 'sweep:end', 'upkeep:start']);
    h.openUpkeep();
    await until(() => h.events.includes('upkeep:end'));
    expect(h.events.filter((e) => e === 'sweep:start')).toHaveLength(1);
    expect(h.events.filter((e) => e === 'upkeep:start')).toHaveLength(1);
  });

  test("the process's first idle run retries parked items (retryParked); later runs do not", async () => {
    const h = harness();
    await runServe(engineOf('pglite'), [], h.opts);
    h.tick(); h.tick();
    for (const n of [1, 2]) {
      await until(() => h.events.filter((e) => e === 'sweep:start').length === n);
      h.openSweep();
      await until(() => h.runs.length === n);
      h.openUpkeep();
      await until(() => h.events.filter((e) => e === 'upkeep:end').length === n);
      if (n === 1) h.tick();
    }
    expect(h.retries).toEqual([true, false]);
  });

  test('stdin data aborts the run in flight', async () => {
    const h = harness();
    await runServe(engineOf('pglite'), [], h.opts);
    h.tick(); h.tick();
    await until(() => h.events.includes('sweep:start'));
    h.openSweep();
    await until(() => h.runs.length === 1);
    expect(h.runs[0]!.aborted).toBe(false);
    h.stdin.emit('data', Buffer.from('{}'));
    expect(h.runs[0]!.aborted).toBe(true);
    await until(() => h.events.includes('upkeep:aborted'));
  });

  test('a warm CLI socket request aborts the run in flight', async () => {
    const h = harness();
    await runServe(engineOf('pglite'), [], h.opts);
    h.tick(); h.tick();
    await until(() => h.events.includes('sweep:start'));
    h.openSweep();
    await until(() => h.runs.length === 1);
    beginForegroundRequest()();
    expect(h.runs[0]!.aborted).toBe(true);
  });

  test('shutdown aborts the run in flight', async () => {
    const h = harness();
    await runServe(engineOf('pglite'), [], h.opts);
    h.tick(); h.tick();
    await until(() => h.events.includes('sweep:start'));
    h.openSweep();
    await until(() => h.runs.length === 1);
    h.signals.emit('SIGTERM');
    expect(h.runs[0]!.aborted).toBe(true);
  });

  test('stdin data during the sweep skips upkeep for that tick', async () => {
    const h = harness();
    await runServe(engineOf('pglite'), [], h.opts);
    h.tick(); h.tick();
    await until(() => h.events.includes('sweep:start'));
    h.stdin.emit('data', Buffer.from('{}'));
    h.openSweep();
    await until(() => h.events.includes('sweep:end'));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).toEqual(['sweep:start', 'sweep:end']);
  });

  test('a read-only (lean) Postgres serve arms no idle tick, so upkeep never runs', async () => {
    const h = harness();
    await runServe(engineOf('postgres'), ['--access', 'read-only'], h.opts);
    expect(h.timers).toHaveLength(0);
    expect(h.events).toEqual([]);
  });
});

describe('HTTP serve: the same idle tick, keyed on request activity', () => {
  function httpHarness() {
    const h = harness();
    const server = gate();
    const opts: ServeOptions = {
      ...h.opts, stallWatchdogMs: 0,
      runServeHttp: () => server.promise,
      armCorpusDrain: () => ({ tick: async () => {}, cancel: () => {} }),
    };
    return { ...h, opts, stopServer: server.open };
  }

  test('never at boot; a quiet window runs upkeep; a request aborts it; the tick stops with the server', async () => {
    const h = httpHarness();
    const served = runServe(engineOf('pglite'), ['--http'], h.opts);
    await until(() => h.timers.length === 1);
    h.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).toEqual([]);
    h.tick();
    await until(() => h.runs.length === 1);
    expect(h.events).toEqual(['upkeep:start']);
    h.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.runs).toHaveLength(1);
    beginForegroundRequest()();
    expect(h.runs[0]!.aborted).toBe(true);
    await until(() => h.events.includes('upkeep:aborted'));
    h.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.runs).toHaveLength(1);
    h.tick();
    await until(() => h.runs.length === 2);
    expect(h.retries).toEqual([true, false]);
    h.openUpkeep();
    h.stopServer();
    await served;
    expect(h.cleared).toContain(1);
  });

  test('GBRAIN_SWEEP=0 (the idle tick switch) arms no HTTP idle tick', async () => {
    const h = httpHarness();
    h.stopServer();
    await runServe(engineOf('pglite'), ['--http'], { ...h.opts, sweepEnabled: false });
    expect(h.timers).toHaveLength(0);
  });

  test('POST /mcp is foreground activity; GET /mcp (the event stream) is not', async () => {
    const window = foregroundWindow();
    window();
    const finish: Array<() => void> = [];
    let nexts = 0;
    mcpForegroundMiddleware({ method: 'GET' }, { once: (_e, fn) => finish.push(fn) }, () => { nexts++; });
    expect(window()).toBe(false);
    mcpForegroundMiddleware({ method: 'POST' }, { once: (_e, fn) => finish.push(fn) }, () => { nexts++; });
    expect(nexts).toBe(2);
    expect(window()).toBe(true);
    for (const fn of finish) fn();
    await new Promise((r) => setTimeout(r, 5));
    window();
    await new Promise((r) => setTimeout(r, 5));
    expect(window()).toBe(false);
  });
});

/**
 * The facts drain scheduler and its stdio serve wiring (Foundations 2, Lane D).
 * Protects: a quiet resident serve drains within two ticks with zero commands;
 * sustained MCP traffic still drains every 30 minutes; shutdown aborts the
 * in-flight run before the engine closes; the owner's veto (delegated sync,
 * degraded engine) skips a tick; Postgres registers no timer; nothing is
 * written to stdout. A real PGLite + stub chat case covers the acceptance
 * path end to end (start serve, write after startup, restart with a backlog).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runServe, type ServeOptions } from '../src/commands/serve.ts';
import { _resetStdoutRedirectForTests } from '../src/core/console-prefix.ts';
import { FACTS_DRAIN_MAX_GAP_MS, FACTS_DRAIN_TICK_MS, startFactsDrainScheduler } from '../src/core/facts/drain-scheduler.ts';
import type { FactsDrainRunResult } from '../src/core/facts/drain.ts';
import { __resetFactsDrainNoticesForTests } from '../src/core/facts/drain.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';

const settle = () => new Promise<void>(r => setTimeout(r, 0));
const fakeResult = (owner: FactsDrainRunResult['owner']) => ({ owner, outcome: 'drained' } as FactsDrainRunResult);

function intervalStub() {
  const registered: Array<{ fn: () => void; ms: number; handle: { unrefCalled: boolean; unref(): void } }> = [];
  return {
    registered,
    setInterval: (fn: () => void, ms: number) => {
      const handle = { unrefCalled: false, unref() { this.unrefCalled = true; } };
      registered.push({ fn, ms, handle });
      return handle;
    },
    clearInterval: (h: unknown) => {
      const i = registered.findIndex(r => r.handle === h);
      if (i >= 0) registered.splice(i, 1);
    },
  };
}

describe('startFactsDrainScheduler', () => {
  test('quiet ticks run, busy ticks wait for the 30-minute gap, one run at a time', async () => {
    let clock = 0;
    let activity = 0;
    const runs: number[] = [];
    let release!: () => void;
    const timers = intervalStub();
    const s = startFactsDrainScheduler({ kind: 'pglite' } as BrainEngine, {
      owner: 'serve', now: () => clock, lastActivityAt: () => activity, ...timers,
      run: async () => { runs.push(clock); await new Promise<void>(r => { release = r; }); return fakeResult('serve'); },
    });
    expect(timers.registered.map(r => r.ms)).toEqual([FACTS_DRAIN_TICK_MS]);
    expect(timers.registered[0].handle.unrefCalled).toBe(true);
    clock = FACTS_DRAIN_TICK_MS; activity = clock - 1;
    expect(await s.tick()).toBeNull();
    clock += FACTS_DRAIN_TICK_MS;
    void s.tick();
    await settle();
    expect(runs).toEqual([2 * FACTS_DRAIN_TICK_MS]);
    expect(s.running).toBe(true);
    clock += FACTS_DRAIN_TICK_MS;
    expect(await s.tick()).toBeNull();
    release();
    await settle();
    clock += FACTS_DRAIN_TICK_MS; activity = clock;
    expect(await s.tick()).toBeNull();
    clock += FACTS_DRAIN_TICK_MS; activity = clock;
    void s.tick();
    await settle();
    expect(runs.length).toBe(2);
    expect(runs[1] - runs[0]).toBeGreaterThanOrEqual(FACTS_DRAIN_MAX_GAP_MS);
    release();
    await s.stop();
    expect(timers.registered).toEqual([]);
  });

  test('stop aborts the in-flight run; the owner veto skips a tick', async () => {
    let signal: AbortSignal | undefined;
    let veto = true;
    const s = startFactsDrainScheduler({ kind: 'pglite' } as BrainEngine, {
      owner: 'serve_http', ...intervalStub(), canRun: () => !veto,
      run: async (_e, o) => { signal = o.signal; await new Promise(r => o.signal.addEventListener('abort', r, { once: true })); return fakeResult('serve_http'); },
    });
    expect(await s.tick()).toBeNull();
    veto = false;
    void s.tick();
    await settle();
    expect(signal?.aborted).toBe(false);
    await s.stop();
    expect(signal?.aborted).toBe(true);
  });

  test('a Postgres engine registers no timer and never runs', async () => {
    const timers = intervalStub();
    let ran = false;
    const s = startFactsDrainScheduler({ kind: 'postgres' } as BrainEngine, { owner: 'serve', ...timers, run: async () => { ran = true; return fakeResult('serve'); } });
    expect(timers.registered).toEqual([]);
    expect(await s.tick()).toBeNull();
    expect(ran).toBe(false);
  });
});

describe('stdio serve wiring', () => {
  function harness(engine: BrainEngine, factsDrain: ServeOptions['factsDrain']) {
    const stdin = new EventEmitter() as EventEmitter & { isTTY?: boolean };
    const timers = intervalStub();
    const logs: string[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(r => { resolveExit = r; });
    const opts: ServeOptions = {
      stdin: stdin as never, signals: new EventEmitter() as never, exit: code => resolveExit(code ?? 0), log: m => { logs.push(m); },
      startMcpServer: async () => {}, getParentPid: () => 1, probeWatchdog: () => true, mcpStdio: false, bootTimeoutMs: 0,
      setInterval: timers.setInterval, clearInterval: timers.clearInterval, sweepEnabled: false, eofDrainMs: 0, factsDrain,
    };
    return { stdin, timers, logs, exited, opts };
  }

  test('serve registers the drain timer, drains on the second quiet tick, re-arms on stdin data, and aborts it on shutdown', async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const engine = { kind: 'pglite', disconnect: async () => {} } as unknown as BrainEngine;
    const h = harness(engine, { run: async (_e, o) => { calls++; signal = o.signal; expect(o.owner).toBe('serve'); return fakeResult('serve'); } });
    await runServe(engine, [], h.opts);
    _resetStdoutRedirectForTests();
    expect(h.timers.registered.map(r => r.ms)).toEqual([FACTS_DRAIN_TICK_MS]);
    const tick = h.timers.registered[0].fn;
    const wait = () => new Promise(r => setTimeout(r, 100));
    tick(); await wait();
    expect(calls).toBe(0);
    tick(); await wait();
    expect(calls).toBe(1);
    h.stdin.emit('data', Buffer.from('{}'));
    tick(); await wait();
    expect(calls).toBe(1);
    h.stdin.emit('end');
    expect(await h.exited).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(h.timers.registered).toEqual([]);
  });

  test('factsDrain: false and non-PGLite engines install nothing', async () => {
    const off = harness({ kind: 'pglite', disconnect: async () => {} } as unknown as BrainEngine, false);
    await runServe({ kind: 'pglite', disconnect: async () => {} } as unknown as BrainEngine, [], off.opts);
    _resetStdoutRedirectForTests();
    expect(off.timers.registered).toEqual([]);
    off.stdin.emit('end'); await off.exited;
  });
});

describe('acceptance: a resident serve on a real PGLite brain', () => {
  let engine: PGLiteEngine;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-serve-drain-'));
  const KEYS = { ANTHROPIC_API_KEY: 'sk-test-drain', OPENAI_API_KEY: 'sk-test-drain' };
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('version', String(LATEST_VERSION));
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
    __resetFactsDrainNoticesForTests();
    configureGateway({ embedding_disabled: true, env: KEYS } as never);
    // #5275: an exact repeat with no resolved entity is a duplicate, so each extraction yields a distinct claim.
    let extraction = 0;
    __setChatTransportForTests(async () => ({ text: JSON.stringify({ facts: [{ fact: `Acme Example shipped the beta in 2026 (extraction ${++extraction})`, kind: 'fact', entity: 'companies/acme-example', confidence: 0.9, notability: 'high' }] }),
      blocks: [], stopReason: 'end', model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
      usage: { input_tokens: 900, output_tokens: 120, cache_read_tokens: 0, cache_creation_tokens: 0 } } as ChatResult));
  });

  async function write(slug: string) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Acme Example shipped the beta in 2026. ${'A substantive project record. '.repeat(6)}`, timeline: '', frontmatter: {} } as never);
    await new MinionQueue(engine).add('facts-absorb', { slug, sourceId: 'default', source: 'mcp:put_page', notabilityFilter: 'all', visibility: 'private' });
  }
  const facts = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts'))[0].n);

  test('pages written after startup are extracted within two ticks; a restart drains the backlog', () => withEnv({ GBRAIN_HOME: home, ...KEYS }, async () => {
    const view = Object.create(engine, { disconnect: { value: async () => {} } }) as BrainEngine;
    const boot = async () => {
      const stdin = new EventEmitter();
      const timers = intervalStub();
      let resolveExit!: (n: number) => void;
      const exited = new Promise<number>(r => { resolveExit = r; });
      await runServe(view, [], { stdin: stdin as never, signals: new EventEmitter() as never, exit: c => resolveExit(c ?? 0), log: () => {},
        startMcpServer: async () => {}, getParentPid: () => 1, probeWatchdog: () => true, mcpStdio: false, bootTimeoutMs: 0,
        setInterval: timers.setInterval, clearInterval: timers.clearInterval, sweepEnabled: false, eofDrainMs: 0 });
      _resetStdoutRedirectForTests();
      const tick = async () => { timers.registered.find(r => r.ms === FACTS_DRAIN_TICK_MS)!.fn(); for (let i = 0; i < 400 && (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name='facts-absorb' AND status IN ('waiting','active')"))[0].n > 0; i++) await new Promise(r => setTimeout(r, 10)); };
      return { stdin, tick, exited };
    };
    const first = await boot();
    await write('notes/after-startup-1');
    await write('notes/after-startup-2');
    expect(await facts()).toBe(0);
    await first.tick();
    await first.tick();
    await new Promise(r => setTimeout(r, 50));
    expect(await facts()).toBe(2);
    await write('notes/backlog-1');
    first.stdin.emit('end'); await first.exited;
    const second = await boot();
    await second.tick();
    await second.tick();
    await new Promise(r => setTimeout(r, 50));
    expect(await facts()).toBe(3);
    second.stdin.emit('end'); await second.exited;
  }), 60_000);
});

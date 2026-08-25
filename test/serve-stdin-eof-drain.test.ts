/**
 * #4409 — stdio serve must not exit on stdin EOF while requests are in flight.
 *
 * A one-shot MCP client writes its frames and closes stdin immediately; the
 * SDK parses every frame during 'data' (handler start is a microtask), so at
 * 'end' time a tools/call can be in flight with no response written. Pre-fix,
 * 'end' → beginShutdown immediately and the response was silently dropped
 * (the codex-plugin door went red on exactly this shape from v0.46.24.0).
 *
 * Also pins the complementary boot-cost fix: serve.ts must not import
 * serve-sync-runner statically (the #4362 static import defeated the
 * GBRAIN_SERVE_SYNC_IPC=0 kill switch and put the runner's module graph on
 * every boot).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runServe, type ServeOptions } from '../src/commands/serve';
import { stdioRpcsInFlightCount, trackStdioRpc } from '../src/mcp/server';
import type { BrainEngine } from '../src/core/engine';
import { _resetStdoutRedirectForTests } from '../src/core/console-prefix';

/* eslint-disable no-console */
const __realConsoleLog = console.log;
const __realConsoleInfo = console.info;
const __realConsoleDebug = console.debug;
afterEach(() => {
  console.log = __realConsoleLog;
  console.info = __realConsoleInfo;
  console.debug = __realConsoleDebug;
  _resetStdoutRedirectForTests();
});
/* eslint-enable no-console */

class StubEngine implements Partial<BrainEngine> {
  disconnectCalls = 0;
  disconnect = async (): Promise<void> => {
    this.disconnectCalls += 1;
  };
}

interface Harness {
  engine: StubEngine;
  stdin: EventEmitter & { isTTY?: boolean };
  logs: string[];
  exited: Promise<number>;
  opts: ServeOptions;
  signals: { emit: (s: string) => void };
}

function makeHarness(extra: Partial<ServeOptions> = {}): Harness {
  const engine = new StubEngine();
  const stdin = new EventEmitter() as EventEmitter & { isTTY?: boolean };
  const logs: string[] = [];
  const handlers = new Map<string, Array<() => void>>();
  const signals = {
    on(signal: string, handler: () => void) {
      const list = handlers.get(signal) ?? [];
      list.push(handler);
      handlers.set(signal, list);
      return signals;
    },
    emit(signal: string) {
      for (const h of handlers.get(signal) ?? []) h();
    },
  };

  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  let exitCalled = false;

  const opts: ServeOptions = {
    stdin: stdin as any,
    signals: signals as any,
    exit: (code?: number) => {
      if (exitCalled) return;
      exitCalled = true;
      resolveExit(code ?? 0);
    },
    log: (msg: string) => { logs.push(msg); },
    startMcpServer: async () => {},
    getParentPid: () => 1, // skip the parent watchdog
    setInterval: () => 0,
    clearInterval: () => {},
    probeWatchdog: () => false,
    sweepEnabled: false,
    ...extra,
  };

  return { engine, stdin, logs, exited, opts, signals };
}

describe('stdin-EOF drain (#4409)', () => {
  test('EOF with in-flight RPCs waits for them before exiting', async () => {
    let pending = 2;
    const h = makeHarness({ pendingRpcs: () => pending, eofDrainMs: 5_000 });
    await runServe(h.engine as unknown as BrainEngine, [], h.opts);

    h.stdin.emit('end');
    // Let the drain start and observe the pending requests.
    await new Promise((r) => setTimeout(r, 60));
    expect(h.engine.disconnectCalls).toBe(0); // still draining
    expect(h.logs.some((l) => l.includes('draining before exit'))).toBe(true);

    pending = 0; // responses settled
    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some((l) => l.includes('graceful exit (stdin-end)'))).toBe(true);
  }, 30000);

  test('EOF with no in-flight RPCs exits promptly (idle-server behavior unchanged)', async () => {
    const h = makeHarness({ pendingRpcs: () => 0, eofDrainMs: 5_000 });
    await runServe(h.engine as unknown as BrainEngine, [], h.opts);
    h.stdin.emit('end');
    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some((l) => l.includes('draining before exit'))).toBe(false);
  }, 30000);

  test('the drain is bounded: a wedged handler cannot pin the process', async () => {
    const h = makeHarness({ pendingRpcs: () => 1, eofDrainMs: 150 });
    await runServe(h.engine as unknown as BrainEngine, [], h.opts);
    h.stdin.emit('end');
    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
  }, 30000);

  test('eofDrainMs=0 restores immediate shutdown', async () => {
    const h = makeHarness({ pendingRpcs: () => 99, eofDrainMs: 0 });
    await runServe(h.engine as unknown as BrainEngine, [], h.opts);
    h.stdin.emit('end');
    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.logs.some((l) => l.includes('draining before exit'))).toBe(false);
  }, 30000);

  test('a signal during the drain still shuts down immediately', async () => {
    const h = makeHarness({ pendingRpcs: () => 1, eofDrainMs: 60_000 });
    await runServe(h.engine as unknown as BrainEngine, [], h.opts);
    h.stdin.emit('end');
    await new Promise((r) => setTimeout(r, 30));
    h.signals.emit('SIGTERM');
    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.logs.some((l) => l.includes('graceful exit (SIGTERM)'))).toBe(true);
  }, 30000);

  test('stdin close takes the same drain path', async () => {
    const h = makeHarness({ pendingRpcs: () => 0, eofDrainMs: 5_000 });
    await runServe(h.engine as unknown as BrainEngine, [], h.opts);
    h.stdin.emit('close');
    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.logs.some((l) => l.includes('graceful exit (stdin-close)'))).toBe(true);
  }, 30000);
});

describe('in-flight RPC counter (#4409)', () => {
  test('trackStdioRpc counts entry/exit including throws', async () => {
    expect(stdioRpcsInFlightCount()).toBe(0);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inFlight = trackStdioRpc(async () => { await gate; return 'ok'; });
    await new Promise((r) => setTimeout(r, 0));
    expect(stdioRpcsInFlightCount()).toBe(1);
    release();
    expect(await inFlight).toBe('ok');
    expect(stdioRpcsInFlightCount()).toBe(0);

    await expect(trackStdioRpc(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(stdioRpcsInFlightCount()).toBe(0);
  });
});

describe('serve-sync-runner stays off the boot path (#4409)', () => {
  test('serve.ts has no static import of serve-sync-runner', () => {
    // test-reads-source-ok: structural module-graph guard — a static import
    // is invisible at runtime once loaded; only the source text can prove
    // the runner stays off the serve boot path (#4409).
    const src = readFileSync(join(import.meta.dir, '../src/commands/serve.ts'), 'utf8');
    // A static `import { x } from '.../serve-sync-runner.ts'` puts the runner
    // module graph on every serve boot and defeats GBRAIN_SERVE_SYNC_IPC=0.
    // Type-only imports are erased at compile time and stay allowed.
    const staticImport = /^import\s+(?!type\b)[^;]*serve-sync-runner/m;
    expect(staticImport.test(src)).toBe(false);
  });
});

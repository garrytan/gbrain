import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'events';
import { runServe, type ServeOptions } from '../src/commands/serve';
import type { BrainEngine } from '../src/core/engine';

// These tests cover the stdio lifecycle hooks added to runServe so that the
// PGLite write lock is released when the parent disconnects. We don't spawn
// a real Bun child or boot the real MCP SDK; we inject a stub `engine`, a
// fake stdin Readable (EventEmitter is enough — only on/once/emit are
// touched), an injected exit() that resolves a promise instead of
// terminating the process, and (per Codex Layer 2 review feedback) a
// no-op startMcpServer stub so the real MCP SDK never attaches a 'data'
// listener to the test runner's actual process.stdin.

class StubEngine implements Partial<BrainEngine> {
  // Track whether disconnect was called; the lock-release behavior we care
  // about here is "did the lifecycle path actually invoke disconnect?".
  disconnectCalls = 0;
  disconnect = async (): Promise<void> => {
    this.disconnectCalls += 1;
  };
}

class StubSignals {
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  on(signal: string, handler: (...a: unknown[]) => void): this {
    const list = this.handlers.get(signal) ?? [];
    list.push(handler);
    this.handlers.set(signal, list);
    return this;
  }
  emit(signal: string): void {
    for (const h of this.handlers.get(signal) ?? []) h();
  }
}

// Stub timer pair: `setInterval` returns a numeric handle; `tickAll()`
// fires every registered fn once, mirroring 1 real-time tick. Lets the
// test drive the parent-watchdog deterministically without 5s of wall
// clock and without leaving real timers active across the suite.
interface TimerStub {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  tickAll: () => void;
  active: () => number;
}

function makeTimerStub(): TimerStub {
  const fns = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval(fn) {
      const id = next++;
      fns.set(id, fn);
      return id;
    },
    clearInterval(h) {
      if (typeof h === 'number') fns.delete(h);
    },
    tickAll() {
      for (const fn of fns.values()) fn();
    },
    active() {
      return fns.size;
    },
  };
}

interface Harness {
  engine: StubEngine;
  stdin: EventEmitter & { isTTY?: boolean; on: any; once: any };
  signals: StubSignals;
  logs: string[];
  exited: Promise<number>;
  opts: ServeOptions;
  timers: TimerStub;
  setParentPid: (pid: number) => void;
}

function makeHarness(opts: {
  isTTY?: boolean;
  initialParentPid?: number;
  probeWatchdog?: boolean;
  mcpStdio?: boolean;
} = {}): Harness {
  const engine = new StubEngine();
  const stdin = new EventEmitter() as EventEmitter & { isTTY?: boolean };
  if (opts.isTTY) stdin.isTTY = true;
  const signals = new StubSignals();
  const logs: string[] = [];

  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>(r => { resolveExit = r; });
  let exitCalled = false;

  // Mutable parent-pid the test can flip; defaults to a non-1 sentinel
  // so the watchdog *will* install (`initialParentPid !== 1` guard).
  // Tests that want "we were spawned under PID 1" pass `initialParentPid: 1`.
  let parentPid = opts.initialParentPid ?? 12345;
  const timers = makeTimerStub();

  // probeWatchdog defaults to true so tests run with watchdog installed.
  // Set probeWatchdog: false to simulate stripped-container ps unavailability.
  const probeWatchdogResult = opts.probeWatchdog ?? true;

  const serveOpts: ServeOptions = {
    stdin: stdin as any,
    signals: signals as any,
    exit: (code?: number) => {
      if (exitCalled) return;
      exitCalled = true;
      resolveExit(code ?? 0);
    },
    log: (msg: string) => { logs.push(msg); },
    // Replace the real MCP SDK boot with a no-op so we never touch the
    // test runner's real process.stdin. The lifecycle hooks under test
    // are installed *before* this is awaited, so all behaviors are still
    // exercised end-to-end.
    startMcpServer: async () => {},
    getParentPid: () => parentPid,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    probeWatchdog: () => probeWatchdogResult,
    mcpStdio: opts.mcpStdio,
  };

  return {
    engine,
    stdin: stdin as any,
    signals,
    logs,
    exited,
    opts: serveOpts,
    timers,
    setParentPid: (pid: number) => { parentPid = pid; },
  };
}

// runServe in tests resolves quickly because the injected startMcpServer
// is a no-op. The lifecycle hooks were installed synchronously before
// that no-op was awaited, so they're already wired by the time runServe
// returns. We start runServe and `await` it (so any setup error surfaces
// immediately), then drive the test-controlled events.
async function startInBackground(
  engine: StubEngine,
  args: string[],
  opts: ServeOptions,
): Promise<void> {
  await runServe(engine as unknown as BrainEngine, args, opts);
}

describe('runServe stdio lifecycle', () => {
  test('stdin end triggers engine.disconnect() and process exit(0)', async () => {
    const h = makeHarness();
    await startInBackground(h.engine, [], h.opts);

    h.stdin.emit('end');
    const code = await h.exited;

    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('graceful exit (stdin-end)'))).toBe(true);
  });

  test('SIGTERM triggers graceful exit', async () => {
    const h = makeHarness();
    await startInBackground(h.engine, [], h.opts);

    h.signals.emit('SIGTERM');
    const code = await h.exited;

    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('graceful exit (SIGTERM)'))).toBe(true);
  });

  test('SIGINT triggers graceful exit', async () => {
    const h = makeHarness();
    await startInBackground(h.engine, [], h.opts);

    h.signals.emit('SIGINT');
    const code = await h.exited;

    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('graceful exit (SIGINT)'))).toBe(true);
  });

  test('SIGHUP triggers graceful exit (terminal disconnect / daemon reload)', async () => {
    // Per Aragorn (#591): real-world hosts (Claude Desktop on macOS,
    // hermes-agent restart) sometimes send SIGHUP instead of closing
    // stdin or sending SIGTERM. The handler converges on the same
    // graceful path as the other signals.
    const h = makeHarness();
    await startInBackground(h.engine, [], h.opts);

    h.signals.emit('SIGHUP');
    const code = await h.exited;

    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('graceful exit (SIGHUP)'))).toBe(true);
  });

  test('stdin close (parent SIGKILL leaves pipe destroyed) triggers graceful exit', async () => {
    // 'end' fires on a clean EOF; 'close' fires when the underlying
    // handle is destroyed (e.g. parent SIGKILL'd while pipe still open).
    // We must observe both — observing only 'end' would miss the
    // hard-kill path that #591's reporter hit on macOS.
    const h = makeHarness();
    await startInBackground(h.engine, [], h.opts);

    h.stdin.emit('close');
    const code = await h.exited;

    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('graceful exit (stdin-close)'))).toBe(true);
  });

  test('parent watchdog fires shutdown when ppid flips to 1 (orphaned to init)', async () => {
    // Some hosts (launchd, cron, certain MCP gateways) terminate
    // without closing stdin and without sending a signal — the kernel
    // re-parents us. The watchdog polls the live ppid on an interval;
    // when it differs from the initial captured ppid, we detect "parent
    // died" and shut down.
    const h = makeHarness({ initialParentPid: 4242 });
    await startInBackground(h.engine, [], h.opts);

    // Watchdog should have installed (we passed initialParentPid !== 1
    // and probeWatchdog defaulted to true).
    expect(h.timers.active()).toBe(1);

    // Simulate parent death: our process gets re-parented to init.
    h.setParentPid(1);
    h.timers.tickAll();

    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('graceful exit (parent-died)'))).toBe(true);

    // beginShutdown clears the watchdog interval as part of cleanup so
    // a duplicate tick can't queue a redundant shutdown.
    expect(h.timers.active()).toBe(0);
  });

  test('parent watchdog fires shutdown when ppid flips to a SUBREAPER PID > 1 (codex finding #3)', async () => {
    // Reparent-to-PID-1 is the easy case. Real hosts under launchd /
    // systemd / tmux / a parent-shell-with-PR_SET_CHILD_SUBREAPER will
    // re-parent us to that subreaper's PID, NOT to 1. The PR-#676
    // author's original `=== 1` check missed this. The fix is to fire
    // on `current !== initialParentPid` so any reparent triggers the
    // shutdown, regardless of where the kernel re-anchors us.
    const h = makeHarness({ initialParentPid: 8500 });
    await startInBackground(h.engine, [], h.opts);

    expect(h.timers.active()).toBe(1);

    // Parent died; kernel re-parented to a launchd subreaper (PID 47).
    h.setParentPid(47);
    h.timers.tickAll();

    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('graceful exit (parent-died)'))).toBe(true);
    expect(h.timers.active()).toBe(0);
  });

  test('parent watchdog NOT installed when initial ppid is already 1 (legitimate init child)', async () => {
    // Spawned directly under PID 1 (e.g. systemd unit, Docker entrypoint):
    // ppid=1 is the documented steady state, not "parent died". We must
    // NOT install the watchdog or we'd shut down immediately.
    const h = makeHarness({ initialParentPid: 1 });
    await startInBackground(h.engine, [], h.opts);

    expect(h.timers.active()).toBe(0);

    // Sanity: the other lifecycle paths still work.
    h.signals.emit('SIGTERM');
    await h.exited;
    expect(h.engine.disconnectCalls).toBe(1);
  });

  test('parent watchdog NOT installed when ps probe fails (codex finding #4 / D2-revisited)', async () => {
    // Stripped containers / busybox-without-procps environments lack ps.
    // The original PR's per-tick fallback would silently return cached
    // process.ppid, never detect a change, and never fire the shutdown
    // — while still claiming to be active.
    //
    // The fix: a one-shot startup probe. When it returns false, we skip
    // installing the watchdog interval AND emit a loud stderr line so
    // the operator sees the degraded mode at startup.
    const h = makeHarness({ initialParentPid: 4242, probeWatchdog: false });
    await startInBackground(h.engine, [], h.opts);

    // Watchdog NOT installed — message matches behavior.
    expect(h.timers.active()).toBe(0);
    expect(h.logs.some(l => l.includes('[gbrain serve] watchdog disabled: ps unavailable'))).toBe(true);

    // Sanity: the other lifecycle paths still work — the shutdown still
    // funnels through stdin EOF / signals, just not via the watchdog.
    h.signals.emit('SIGTERM');
    await h.exited;
    expect(h.engine.disconnectCalls).toBe(1);
  });

  test('parent watchdog tick with ppid still alive does NOT fire shutdown', async () => {
    // The watchdog must only fire on the *transition* away from the
    // initial ppid; a healthy tick (ppid still equal to the original)
    // is a no-op.
    const h = makeHarness({ initialParentPid: 4242 });
    await startInBackground(h.engine, [], h.opts);

    expect(h.timers.active()).toBe(1);
    // Tick with ppid unchanged.
    h.timers.tickAll();
    h.timers.tickAll();
    h.timers.tickAll();
    expect(h.engine.disconnectCalls).toBe(0);

    // ... and signal-driven shutdown still works after several quiet ticks.
    h.signals.emit('SIGTERM');
    await h.exited;
    expect(h.engine.disconnectCalls).toBe(1);
  });

  test('shutdown is idempotent — multiple signals only disconnect once', async () => {
    const h = makeHarness();
    await startInBackground(h.engine, [], h.opts);

    h.signals.emit('SIGTERM');
    h.signals.emit('SIGTERM');
    h.signals.emit('SIGINT');
    h.stdin.emit('end');

    await h.exited;
    expect(h.engine.disconnectCalls).toBe(1);
  });

  test('TTY stdin does NOT install end watcher (interactive use unaffected)', async () => {
    const h = makeHarness({ isTTY: true });
    await startInBackground(h.engine, [], h.opts);

    // Emit 'end' on TTY stdin — no listener should be wired so this is a
    // no-op. The test passes by simply not exiting; we give the runtime a
    // beat to confirm nothing fires. Signals must still work.
    h.stdin.emit('end');
    await new Promise(r => setTimeout(r, 10));
    expect(h.engine.disconnectCalls).toBe(0);

    // Sanity: signals still wired regardless of TTY-ness.
    h.signals.emit('SIGTERM');
    await h.exited;
    expect(h.engine.disconnectCalls).toBe(1);
  });

  test('--stdio-idle-timeout 0 disarms the idle hook (sanity)', async () => {
    const h = makeHarness();
    await startInBackground(h.engine, ['--stdio-idle-timeout', '0'], h.opts);

    // 0 is the documented opt-out. No idle hook should be armed; drive a
    // different exit path to confirm flow still works.
    h.signals.emit('SIGTERM');
    await h.exited;
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.every(l => !l.includes('idle timeout'))).toBe(true);
  });

  test('--stdio-idle-timeout > 0 logs the configured value', async () => {
    const h = makeHarness();
    await startInBackground(h.engine, ['--stdio-idle-timeout', '60'], h.opts);

    expect(h.logs.some(l => l.includes('stdio idle timeout = 60s'))).toBe(true);

    h.signals.emit('SIGTERM');
    await h.exited;
    expect(h.engine.disconnectCalls).toBe(1);
  });

  test('idle timer is reset on every stdin data chunk', async () => {
    const h = makeHarness();
    // Use a very short timeout so we can observe the firing/resetting
    // without slowing the suite. 50ms is enough to be measurable but
    // short enough that the suite finishes promptly.
    await startInBackground(
      h.engine,
      ['--stdio-idle-timeout', '1'], // 1 second; we reset it before it fires
      h.opts,
    );

    // Pulse 'data' a few times to keep the timer reset.
    for (let i = 0; i < 3; i++) {
      h.stdin.emit('data', Buffer.from('{"jsonrpc":"2.0"}'));
      await new Promise(r => setTimeout(r, 100));
    }
    expect(h.engine.disconnectCalls).toBe(0);

    // Now stop pulsing and wait for the timer to actually fire end-to-end
    // (it ought to elapse within ~1s of the last reset). Awaiting
    // h.exited rather than a wall-clock race makes this deterministic.
    await h.exited;
    expect(h.engine.disconnectCalls).toBe(1);
    expect(h.logs.some(l => l.includes('stdio-idle-timeout (1s)'))).toBe(true);
  }, 5000);

  test.each([
    ['abc', /--stdio-idle-timeout/],
    ['30junk', /--stdio-idle-timeout/],
    ['-1', /--stdio-idle-timeout/],
    ['1.5', /--stdio-idle-timeout/],
    ['', /--stdio-idle-timeout/],
  ])('--stdio-idle-timeout rejects invalid value %p (typo is a CLI error)', async (bad, msgRe) => {
    // Per Codex Layer 2 review P1: silent fallback on typo turns the
    // opt-in safety net into a no-op. Strict parsing throws so the
    // operator sees the mistake immediately.
    const h = makeHarness();
    expect(
      runServe(h.engine as unknown as BrainEngine, ['--stdio-idle-timeout', bad], h.opts),
    ).rejects.toThrow(msgRe);
  });

  test('--stdio-idle-timeout with no following value also throws', async () => {
    const h = makeHarness();
    // Flag at end of args — no value to consume.
    expect(
      runServe(h.engine as unknown as BrainEngine, ['--stdio-idle-timeout'], h.opts),
    ).rejects.toThrow(/missing value/);
  });

  test('engine.disconnect throwing still results in exit(0) and logged error', async () => {
    const h = makeHarness();
    h.engine.disconnect = async () => {
      throw new Error('synthetic disconnect failure');
    };
    await startInBackground(h.engine, [], h.opts);

    h.signals.emit('SIGTERM');
    const code = await h.exited;
    expect(code).toBe(0);
    expect(h.logs.some(l => l.includes('cleanup error: synthetic disconnect failure'))).toBe(true);
  });

  // v0.34.1 (#870): OpenClaw gateway / bundle-mcp wrappers pipe the
  // JSON-RPC handshake on stdin then close their stdin half. Without
  // MCP_STDIO=1 the server treats that as a permanent disconnect and
  // exits before handling tools/call. The guard skips the stdin 'end' /
  // 'close' hooks when MCP_STDIO=1; signals and parent watchdog still
  // cover legitimate shutdown.
  describe('MCP_STDIO=1 piped-stdin guard (#870)', () => {
    test('stdin end with mcpStdio=true does NOT trigger shutdown', async () => {
      const h = makeHarness({ mcpStdio: true });
      await startInBackground(h.engine, [], h.opts);

      // Without the guard this would shutdown; with the guard it must not.
      h.stdin.emit('end');

      // Give the event loop a microtask turn to catch any erroneous shutdown
      // path. We assert NO exit was registered.
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(h.engine.disconnectCalls).toBe(0);

      // Then trigger SIGTERM to drive the test to completion; signal handlers
      // remain active even with mcpStdio=true (codex would catch if they didn't).
      h.signals.emit('SIGTERM');
      const code = await h.exited;
      expect(code).toBe(0);
      expect(h.engine.disconnectCalls).toBe(1);
      expect(h.logs.some(l => l.includes('graceful exit (SIGTERM)'))).toBe(true);
    });

    test('stdin close with mcpStdio=true does NOT trigger shutdown', async () => {
      const h = makeHarness({ mcpStdio: true });
      await startInBackground(h.engine, [], h.opts);

      h.stdin.emit('close');

      await new Promise<void>((r) => setTimeout(r, 10));
      expect(h.engine.disconnectCalls).toBe(0);

      h.signals.emit('SIGINT');
      const code = await h.exited;
      expect(code).toBe(0);
      expect(h.engine.disconnectCalls).toBe(1);
    });

    test('mcpStdio=false (default) preserves stdin EOF shutdown', async () => {
      // Regression guard: the guard must not over-trigger. With the env
      // unset, stdin EOF must still drive shutdown so existing CLI usage
      // (gbrain serve under launchd, claude-desktop's stdio MCP) is
      // unchanged.
      const h = makeHarness({ mcpStdio: false });
      await startInBackground(h.engine, [], h.opts);

      h.stdin.emit('end');
      const code = await h.exited;
      expect(code).toBe(0);
      expect(h.engine.disconnectCalls).toBe(1);
      expect(h.logs.some(l => l.includes('graceful exit (stdin-end)'))).toBe(true);
    });
  });
});

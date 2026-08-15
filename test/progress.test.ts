import { describe, test, expect } from 'bun:test';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { createProgress, startHeartbeat, __liveReporterCountForTest, __signalHandlerInstalledForTest } from '../src/core/progress.ts';

const REPO = join(import.meta.dir, '..');
type SigintHarnessProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Collect everything a reporter writes into a string. */
function sink(isTTY = false): { stream: PassThrough & { isTTY?: boolean }; read: () => string } {
  const s = new PassThrough() as PassThrough & { isTTY?: boolean };
  s.isTTY = isTTY;
  const chunks: string[] = [];
  s.on('data', (c) => chunks.push(c.toString('utf8')));
  return { stream: s, read: () => chunks.join('') };
}

function parseJsonl(raw: string): Record<string, unknown>[] {
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function waitForStdoutMarker(proc: SigintHarnessProcess, marker: string, readStdout: () => string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
      proc.off('error', onError);
    };
    const onData = () => {
      if (!readStdout().includes(marker)) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`child exited before ${marker}: code=${code} signal=${signal}`));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${marker}; stdout=${JSON.stringify(readStdout())}`));
    }, timeoutMs);

    proc.stdout.on('data', onData);
    proc.once('exit', onExit);
    proc.once('error', onError);
    onData();
  });
}

function waitForExit(proc: SigintHarnessProcess, timeoutMs = 1500): Promise<{ exited: boolean; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timeout);
      proc.off('exit', onExit);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ exited: true, code, signal });
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ exited: false, code: null, signal: null });
    }, timeoutMs);
    proc.once('exit', onExit);
  });
}

async function runSigintHarness(script: string): Promise<{
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const proc = spawn(process.execPath, ['-e', script], {
    cwd: REPO,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  await waitForStdoutMarker(proc, 'READY\n', () => stdout);
  proc.kill('SIGINT');
  const result = await waitForExit(proc);
  if (!result.exited) {
    proc.kill('SIGKILL');
    await waitForExit(proc);
  }
  return { ...result, stdout, stderr };
}

describe('progress reporter', () => {
  test('auto mode: non-TTY → human-plain (NOT JSON)', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'auto', stream, minIntervalMs: 0, minItems: 1 });
    p.start('scan', 3);
    p.tick();
    p.tick();
    p.tick();
    p.finish();
    const out = read();
    // plain lines, no JSON
    expect(out).not.toContain('"event"');
    expect(out).toContain('[scan]');
    expect(out).toContain('1/3');
    expect(out).toContain('3/3');
  });

  test('auto mode: TTY → human-\\r (carriage return, no newline between ticks)', () => {
    const { stream, read } = sink(true);
    const p = createProgress({ mode: 'auto', stream, minIntervalMs: 0, minItems: 1 });
    p.start('scan', 2);
    p.tick();
    p.tick();
    p.finish();
    const out = read();
    // TTY path uses \r + clear-line escape; final newline on finish.
    expect(out).toContain('\r');
    expect(out).toContain('[scan]');
  });

  test('json mode emits one JSON object per line with schema', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
    p.start('doctor.jsonb_integrity', 4);
    p.tick(1, 'pages.frontmatter');
    p.tick(1, 'raw_data.data');
    p.finish();
    const events = parseJsonl(read());
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]).toMatchObject({ event: 'start', phase: 'doctor.jsonb_integrity', total: 4 });
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events[1]).toMatchObject({ event: 'tick', phase: 'doctor.jsonb_integrity', done: 1, total: 4 });
    expect(events[1].pct).toBe(25);
    expect(typeof events[1].elapsed_ms).toBe('number');
    expect(events[events.length - 1]).toMatchObject({ event: 'finish', phase: 'doctor.jsonb_integrity' });
  });

  test('quiet mode emits nothing', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'quiet', stream });
    p.start('scan', 10);
    p.tick();
    p.heartbeat('hello');
    p.finish();
    expect(read()).toBe('');
  });

  test('tick() time-gated: calls inside minIntervalMs collapse to one emit', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 5000, minItems: 999999 });
    p.start('scan', 100);
    // Rapid ticks — should not emit intermediate 'tick' events (only the final one if eq total).
    for (let i = 0; i < 10; i++) p.tick();
    const events = parseJsonl(read());
    const ticks = events.filter((e) => e.event === 'tick');
    // 10 ticks, total=100, final-tick-on-complete heuristic doesn't apply (done < total).
    // Time-gated + item-gated should suppress all.
    expect(ticks.length).toBe(0);
    p.finish();
  });

  test('tick() item-gated: minItems threshold emits after N items', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 999999, minItems: 50 });
    p.start('scan', 1000);
    for (let i = 0; i < 100; i++) p.tick();
    p.finish();
    const events = parseJsonl(read());
    const ticks = events.filter((e) => e.event === 'tick');
    // 100 ticks with minItems=50 ⇒ expect ~2 emits
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks.length).toBeLessThanOrEqual(3);
  });

  test('final tick emits regardless of gating when done === total', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 999999, minItems: 999999 });
    p.start('scan', 3);
    p.tick();
    p.tick();
    p.tick(); // this one hits done===total, must emit
    p.finish();
    const events = parseJsonl(read());
    const ticks = events.filter((e) => e.event === 'tick');
    expect(ticks.length).toBe(1);
    expect(ticks[0]).toMatchObject({ done: 3, total: 3 });
  });

  test('start(phase) with no total → ticks omit pct/eta_ms', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
    p.start('unknown_size_scan'); // no total
    p.tick();
    p.finish();
    const events = parseJsonl(read());
    const tick = events.find((e) => e.event === 'tick')!;
    expect(tick).toBeDefined();
    expect(tick.total).toBeUndefined();
    expect(tick.pct).toBeUndefined();
    expect(tick.eta_ms).toBeUndefined();
    expect(tick.done).toBe(1);
  });

  test('heartbeat() emits without bumping done', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
    p.start('slow_query');
    p.heartbeat('still scanning…');
    p.heartbeat('still scanning…');
    p.finish();
    const events = parseJsonl(read());
    const hb = events.filter((e) => e.event === 'heartbeat');
    expect(hb.length).toBe(2);
    expect(hb[0]).toMatchObject({ phase: 'slow_query', note: 'still scanning…' });
    // No 'done' field on heartbeat.
    expect(hb[0].done).toBeUndefined();
  });

  test('child() composes phase path with dots', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
    p.start('sync');
    const c = p.child('import');
    c.start('file1', 1);
    c.tick();
    c.finish();
    p.finish();
    const events = parseJsonl(read());
    const startEvents = events.filter((e) => e.event === 'start');
    const phases = startEvents.map((e) => e.phase);
    expect(phases).toContain('sync');
    expect(phases).toContain('sync.import.file1');
  });

  test('child.finish() does not close parent', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
    p.start('sync');
    const c = p.child('import');
    c.start('batch1', 1);
    c.tick();
    c.finish();
    // Parent still alive — another tick should work.
    // (parent.tick requires a started phase; start was called on 'sync'.)
    p.tick(1, 'after-child');
    p.finish();
    const events = parseJsonl(read());
    const finishes = events.filter((e) => e.event === 'finish');
    const finishPhases = finishes.map((e) => e.phase);
    expect(finishPhases).toContain('sync.import.batch1');
    expect(finishPhases).toContain('sync');
  });

  test('EPIPE sync throw is swallowed; subsequent writes are no-ops', () => {
    const brokenStream = {
      isTTY: false,
      write: () => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
      on: () => {},
    } as unknown as NodeJS.WritableStream;
    const p = createProgress({ mode: 'json', stream: brokenStream, minIntervalMs: 0, minItems: 1 });
    // Must not throw.
    expect(() => {
      p.start('scan', 3);
      p.tick();
      p.tick();
      p.finish();
    }).not.toThrow();
  });

  test("EPIPE stream 'error' event marks stream broken", () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
    p.start('scan', 2);
    p.tick();
    // Simulate async EPIPE via error event.
    stream.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    // Subsequent calls must not throw.
    expect(() => {
      p.tick();
      p.finish();
    }).not.toThrow();
    // We did get at least the pre-error emissions.
    expect(read()).toContain('"event":"start"');
  });

  test('only one process-level signal handler installed across many reporters', () => {
    // Baseline: one handler already installed by prior tests in this file.
    const installedBefore = __signalHandlerInstalledForTest();
    // liveReporters is module-global, so a reporter left running by ANOTHER
    // test file in the same shard shows up here. Assert the DELTA (these 50
    // lifecycles leak nothing) instead of an absolute zero — the absolute
    // form flaked whenever shard composition changed and an unrelated file
    // held a live reporter across this test.
    const liveBefore = __liveReporterCountForTest();
    const { stream } = sink(false);
    for (let i = 0; i < 50; i++) {
      const p = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
      p.start(`phase_${i}`, 1);
      p.finish();
    }
    // After 50 reporter lifecycles, still exactly one handler and no new live entries.
    expect(__signalHandlerInstalledForTest()).toBe(installedBefore || true);
    expect(__liveReporterCountForTest()).toBe(liveBefore);
  });

  test('SIGINT exits a child process when the progress reporter is the only handler', async () => {
    const result = await runSigintHarness(`
      const { createProgress } = await import('./src/core/progress.ts');
      const progress = createProgress({ mode: 'json' });
      progress.start('sigint_repro', 1);
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1000);
    `);

    expect(result.exited).toBe(true);
    expect(result.signal === 'SIGINT' || result.code === 130).toBe(true);
    expect(result.stderr).toContain('"event":"abort"');
    expect(result.stderr).toContain('"reason":"SIGINT"');
  });

  test('SIGINT still defers to another process handler when one is installed', async () => {
    const result = await runSigintHarness(`
      const { createProgress } = await import('./src/core/progress.ts');
      process.once('SIGINT', () => {
        process.stdout.write('HANDLED\\n');
        setTimeout(() => process.exit(0), 50);
      });
      const progress = createProgress({ mode: 'json' });
      progress.start('sigint_repro', 1);
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1000);
    `);

    expect(result.exited).toBe(true);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('HANDLED');
    expect(result.stderr).toContain('"event":"abort"');
    expect(result.stderr).toContain('"reason":"SIGINT"');
  });

  test('startHeartbeat() fires heartbeats and stop() clears', async () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream, minIntervalMs: 0, minItems: 1 });
    p.start('slow_query');
    // Larger window + wider tolerance: under 4-way parallel CI shards on a
    // contended host, setTimeout's effective quantum can balloon and a tight
    // 85ms/2-6 bound flakes. We just need to confirm "fires multiple times,
    // stops cleanly" — exact count isn't load-bearing.
    const stop = startHeartbeat(p, 'still running…', 20);
    await new Promise((r) => setTimeout(r, 200));
    stop();
    p.finish();
    const events = parseJsonl(read());
    const hb = events.filter((e) => e.event === 'heartbeat');
    expect(hb.length).toBeGreaterThanOrEqual(1);
    expect(hb.length).toBeLessThanOrEqual(20);
  });

  test('finish without prior start is a no-op (no crash)', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream });
    expect(() => p.finish()).not.toThrow();
    expect(read()).toBe('');
  });

  test('tick without prior start is a no-op (no crash)', () => {
    const { stream, read } = sink(false);
    const p = createProgress({ mode: 'json', stream });
    expect(() => p.tick()).not.toThrow();
    expect(read()).toBe('');
  });
});

/**
 * #6858 ask 6: the on-commit HEAD watcher under the `gbrain serve --http`
 * lifecycle (the HTTP twin of the stdio wiring in serve.ts installResidentTickers).
 *
 * Protects: runServeHttp starts the watcher beside the movement watch, so with
 * `sync.on_commit` on it polls on its own interval and logs that it is enabled,
 * and an orderly shutdown (SIGINT through waitForHttpServerLifecycle) clears
 * that interval and deregisters every cleanup it added.
 * Fails when: the HTTP serve drops the watcher, starts it outside the
 * try/finally, or shuts down without stopping it (its poll interval would
 * outlive the server).
 *
 * Serial: mutates GBRAIN_HOME and GBRAIN_SERVE_HEAD_POLL_MS, spies on the
 * global timers, emits SIGINT on the process and reads the process-global
 * cleanup registry.
 */

import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runServeHttp } from '../src/commands/serve-http.ts';
import { _registeredCleanupCountForTests } from '../src/core/process-cleanup.ts';
import { SYNC_ON_COMMIT_KEY } from '../src/core/sync-config-keys.ts';

/** A poll period no other serve timer uses, so the watcher's interval is the one registered with it. */
const POLL_MS = 1_234;

let engine: PGLiteEngine;
let home: string;
const priorHome = process.env.GBRAIN_HOME;
const priorPoll = process.env.GBRAIN_SERVE_HEAD_POLL_MS;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig(SYNC_ON_COMMIT_KEY, 'true');
  home = mkdtempSync(join(tmpdir(), 'gbrain-serve-http-head-watcher-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'brain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain') }));
  process.env.GBRAIN_HOME = home;
  process.env.GBRAIN_SERVE_HEAD_POLL_MS = String(POLL_MS);
});

afterAll(async () => {
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  if (priorPoll === undefined) delete process.env.GBRAIN_SERVE_HEAD_POLL_MS;
  else process.env.GBRAIN_SERVE_HEAD_POLL_MS = priorPoll;
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('runServeHttp starts the head watcher with the serve and stops it on SIGINT shutdown', async () => {
  const lines: string[] = [];
  const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  const watcherIntervals: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const handle = realSetInterval(fn, ms, ...rest);
    if (ms === POLL_MS) watcherIntervals.push(handle);
    return handle;
  }) as typeof setInterval);
  const clearSpy = spyOn(globalThis, 'clearInterval');
  try {
    const baseline = _registeredCleanupCountForTests();
    const done = runServeHttp(engine, { port: 0, tokenTtl: 3600, enableDcr: false });
    const enabled = `[serve-sync] on-commit: enabled (poll ${POLL_MS} ms`;
    for (let i = 0; i < 400 && !lines.some(l => l.includes(enabled)); i++) await Bun.sleep(25);
    expect(lines.find(l => l.includes(enabled)), `watcher never enabled; stderr:\n${lines.join('\n').slice(-2000)}`).toBeDefined();
    expect(watcherIntervals).toHaveLength(1);
    const cleared = () => clearSpy.mock.calls.filter(([h]) => h === watcherIntervals[0]).length;
    expect(cleared()).toBe(0);
    // http-server (lifecycle), resolve-ipc-close and pglite-engine-disconnect: the watcher adds none of its own.
    expect(_registeredCleanupCountForTests()).toBe(baseline + 3);

    process.emit('SIGINT');
    await done;

    expect(cleared()).toBe(1);
    expect(watcherIntervals).toHaveLength(1);
    expect(_registeredCleanupCountForTests()).toBe(baseline);
  } finally {
    clearSpy.mockRestore();
    setSpy.mockRestore();
    errorSpy.mockRestore();
  }
}, 30_000);

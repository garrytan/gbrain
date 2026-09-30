/**
 * runServeHttp shutdown after the buildServeHttpApp extraction (refactor
 * wave 1, TE1).
 *
 * Protects: runServeHttp still owns listen, the resolve-IPC binding and the
 * process-cleanup registrations, and an orderly shutdown (SIGINT through
 * waitForHttpServerLifecycle) closes the IPC listener, removes its socket
 * file and deregisters every cleanup it added without running the engine
 * disconnect (the CLI teardown stays its single owner).
 * Fails when: the extraction moves IPC binding or cleanup registration out of
 * runServeHttp's try/finally, leaks a registered cleanup, or leaves the
 * socket behind.
 * Why new: the lifecycle tests drive waitForHttpServerLifecycle with fakes;
 * nothing ran the real runServeHttp teardown.
 *
 * Serial: mutates GBRAIN_HOME, emits SIGINT on the process and reads the
 * process-global cleanup registry.
 */

import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runServeHttp } from '../src/commands/serve-http.ts';
import { _registeredCleanupCountForTests } from '../src/core/process-cleanup.ts';

let engine: PGLiteEngine;
let home: string;
const priorHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-serve-http-teardown-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'brain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain') }));
  process.env.GBRAIN_HOME = home;
});

afterAll(async () => {
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('SIGINT shutdown closes the resolve-IPC socket and deregisters every cleanup runServeHttp added', async () => {
  const lines: string[] = [];
  const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  try {
    const baseline = _registeredCleanupCountForTests();
    const done = runServeHttp(engine, { port: 0, tokenTtl: 3600, enableDcr: false });
    let socketPath: string | undefined;
    for (let i = 0; i < 200 && (socketPath === undefined || _registeredCleanupCountForTests() < baseline + 3); i++) {
      socketPath ??= lines.map(l => /Resolve IPC: (\S+)/.exec(l)?.[1]).find(Boolean);
      await Bun.sleep(25);
    }
    expect(socketPath, `resolve-IPC path not logged; stderr:\n${lines.join('\n').slice(-2000)}`).toBeDefined();
    expect(existsSync(socketPath!)).toBe(true);
    // http-server (lifecycle), resolve-ipc-close and pglite-engine-disconnect.
    expect(_registeredCleanupCountForTests()).toBe(baseline + 3);

    process.emit('SIGINT');
    await done;

    expect(_registeredCleanupCountForTests()).toBe(baseline);
    expect(existsSync(socketPath!)).toBe(false);
    expect(await engine.executeRaw<{ one: number }>('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  } finally {
    errorSpy.mockRestore();
  }
}, 30_000);

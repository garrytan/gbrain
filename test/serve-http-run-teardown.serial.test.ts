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
 *
 * Value: protects=runServeHttp runs the server inside a local engine scope (the process gateway), not unscoped; fails_when=withLocalScope is removed from runServeHttp;
 *   why_new=the teardown test never inspected the scope the server runs in; seam=none; no_claim=gateway selection (scope presence only)
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
import * as processCleanup from '../src/core/process-cleanup.ts';
import { _registeredCleanupCountForTests } from '../src/core/process-cleanup.ts';
import { currentEngineScope } from '../src/core/engine-scope.ts';

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
    for (let i = 0; i < 200 && (socketPath === undefined || _registeredCleanupCountForTests() < baseline + 4); i++) {
      socketPath ??= lines.map(l => /Resolve IPC: (\S+)/.exec(l)?.[1]).find(Boolean);
      await Bun.sleep(25);
    }
    expect(socketPath, `resolve-IPC path not logged; stderr:\n${lines.join('\n').slice(-2000)}`).toBeDefined();
    expect(existsSync(socketPath!)).toBe(true);
    // http-server (lifecycle), resolve-ipc-close, pglite-engine-disconnect and the resident notifier's lease release.
    expect(_registeredCleanupCountForTests()).toBe(baseline + 4);

    process.emit('SIGINT');
    await done;

    expect(_registeredCleanupCountForTests()).toBe(baseline);
    expect(existsSync(socketPath!)).toBe(false);
    expect(await engine.executeRaw<{ one: number }>('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  } finally {
    errorSpy.mockRestore();
  }
}, 30_000);

test('runServeHttp runs the server in a local engine scope', async () => {
  const scopes: Array<object | undefined> = [];
  const original = processCleanup.registerCleanup;
  const cleanupSpy = spyOn(processCleanup, 'registerCleanup').mockImplementation(((...args: Parameters<typeof original>) => {
    scopes.push(currentEngineScope());
    return original(...args);
  }) as typeof original);
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const baseline = _registeredCleanupCountForTests();
    const done = runServeHttp(engine, { port: 0, tokenTtl: 3600, enableDcr: false });
    for (let i = 0; i < 200 && scopes.length === 0; i++) await Bun.sleep(25);
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope).toBeDefined();
      expect(scope).not.toBe(engine);
    }
    process.emit('SIGINT');
    await done;
    expect(_registeredCleanupCountForTests()).toBe(baseline);
  } finally {
    cleanupSpy.mockRestore();
    errorSpy.mockRestore();
  }
}, 30_000);

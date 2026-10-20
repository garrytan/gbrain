/**
 * #6647 (option B): a serve that could not bind its resolve sockets because another serve owned them takes them over
 * once that owner is gone, on its own retry timer, without ever displacing a live owner (#4896).
 *
 * Protects: two serves for one source; the owner (a real child process) is SIGKILLed, leaving its socket file
 * behind; within one injected retry interval the survivor binds the source socket AND the legacy socket and answers
 * an authenticated `turn_context`; while the owner is alive the survivor keeps deferring; `close()` stops the retry
 * timers, and a bind that lands after `close()` is closed rather than left listening. Fails on master: the survivor
 * binds once at boot, gets nothing, and never retries, so the hook gets `IPC_UNAVAILABLE` until a serve restarts.
 *
 * Serial: spawns a child serve and binds real Unix sockets under a temp GBRAIN_HOME.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { bindResolveIpcForServe, type ResolveIpcBinding } from '../src/mcp/resolve-ipc-binding.ts';
import {
  IPC_UNAVAILABLE,
  readIpcSecretForConfig,
  requestTurnContext,
  resolveSocketPathForConfig,
  socketHasLiveListener,
  startResolveIpcServer,
} from '../src/core/context/resolve-ipc.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { fileURLToPath } from 'node:url';

const INTERVAL_MS = 300;
const cfg = { engine: 'postgres' as const, database_url: 'postgresql://user@db.example.invalid:5432/rebind-brain' };
const BINDING_MODULE = fileURLToPath(new URL('../src/mcp/resolve-ipc-binding.ts', import.meta.url));

let engine: PGLiteEngine;
let tmp: string;
let child: ChildProcess | null = null;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-ipc-rebind-'));
  mkdirSync(join(tmp, '.gbrain'), { recursive: true });
  writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify(cfg));
});
afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = null;
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ GBRAIN_HOME: tmp, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined, GBRAIN_SERVE_SYNC_IPC: '0' });
const inBrain = <T>(fn: () => Promise<T>) => withEnv(env(), fn);

/** A real serve process that binds the source + legacy sockets and then just stays alive. */
async function startOwnerProcess(source: string): Promise<ChildProcess> {
  const script = `
    const { bindResolveIpcForServe } = await import(${JSON.stringify(BINDING_MODULE)});
    const binding = await bindResolveIpcForServe({}, ${JSON.stringify(source)}, undefined, { rebindDelayMs: () => 3_600_000 });
    process.stdout.write((binding.socketPath ? 'bound ' + binding.socketPath : 'unbound') + '\\n');
    setInterval(() => {}, 1_000);
  `;
  const proc = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, GBRAIN_HOME: tmp, GBRAIN_SERVE_SYNC_IPC: '0', GBRAIN_DATABASE_URL: '', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stderr!.on('data', d => { err += String(d); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`owner did not start: ${out} ${err}`)), 30_000);
    proc.stdout!.on('data', d => {
      out += String(d);
      if (out.includes('\n')) { clearTimeout(timer); resolve(); }
    });
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`owner exited ${code}: ${err}`)); });
  });
  expect(out.startsWith('bound ')).toBe(true);
  return proc;
}

async function waitUntil(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
}

async function closeBinding(binding: ResolveIpcBinding): Promise<void> {
  const server = binding.server;
  const closed = server ? once(server, 'close') : Promise.resolve();
  binding.close();
  await closed;
}

describe('resolve IPC re-bind after the owning serve exits (#6647)', () => {
  it('a surviving serve takes over both sockets within one interval and answers turn_context', async () => {
    child = await startOwnerProcess('alpha');
    await inBrain(async () => {
      const own = resolveSocketPathForConfig(cfg, 'resolve', 'alpha')!;
      const legacy = resolveSocketPathForConfig(cfg)!;
      const survivor = await bindResolveIpcForServe(engine as unknown as BrainEngine, 'alpha', undefined, { rebindDelayMs: () => INTERVAL_MS });
      try {
        expect(survivor.server).toBeNull();
        // The owner is alive: the survivor keeps deferring across several intervals (#4896).
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS * 3));
        expect(survivor.server).toBeNull();

        child!.kill('SIGKILL');
        await once(child!, 'exit');
        expect(existsSync(own)).toBe(true);
        const killedAt = Date.now();

        const tookOver = await waitUntil(async () => survivor.server !== null, INTERVAL_MS * 2 + 500);
        expect(tookOver).toBe(true);
        expect(Date.now() - killedAt).toBeLessThan(INTERVAL_MS * 2 + 500);
        expect(survivor.socketPath).toBe(own);
        expect(await waitUntil(() => socketHasLiveListener(legacy), INTERVAL_MS * 2 + 500)).toBe(true);

        const secret = readIpcSecretForConfig(cfg)!;
        const reply = await requestTurnContext(own, { secret, sourceId: 'alpha', window: [{ role: 'user', text: 'hello' }] }, { timeoutMs: 5_000 });
        expect(reply).not.toBe(IPC_UNAVAILABLE);
        expect(reply).toMatchObject({ ok: true, protocol: 2 });
      } finally {
        await closeBinding(survivor);
      }
    });
  }, 60_000);

  it('close() stops the retry timer: a serve closed while deferring never binds later', async () => {
    child = await startOwnerProcess('beta');
    await inBrain(async () => {
      const own = resolveSocketPathForConfig(cfg, 'resolve', 'beta')!;
      const deferred = await bindResolveIpcForServe(engine as unknown as BrainEngine, 'beta', undefined, { rebindDelayMs: () => INTERVAL_MS });
      expect(deferred.server).toBeNull();
      deferred.close();
      child!.kill('SIGKILL');
      await once(child!, 'exit');
      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS * 3));
      expect(deferred.server).toBeNull();
      expect(await socketHasLiveListener(own)).toBe(false);
    });
  }, 60_000);

  it('a bind that completes after close() is closed instead of left listening', async () => {
    await inBrain(async () => {
      const own = resolveSocketPathForConfig(cfg, 'resolve', 'gamma')!;
      const legacy = resolveSocketPathForConfig(cfg)!;
      // Close lands at every point of a 1 ms retry loop: before, during and after the claim/probe/listen.
      for (let closeAfterMs = 0; closeAfterMs <= 8; closeAfterMs++) {
        const owner = await startResolveIpcServer(own, { resolve: async () => null }, { boundSourceId: 'gamma' });
        const legacyOwner = await startResolveIpcServer(legacy, { resolve: async () => null }, { boundSourceId: 'gamma' });
        expect(owner).not.toBeNull();
        expect(legacyOwner).not.toBeNull();
        let scheduled = 0;
        const deferred = await bindResolveIpcForServe(engine as unknown as BrainEngine, 'gamma', undefined, {
          rebindDelayMs: () => { scheduled++; return 1; },
        });
        expect(deferred.server).toBeNull();
        await Promise.all([once(owner!, 'close'), once(legacyOwner!, 'close'), owner!.close(), legacyOwner!.close()]);
        await new Promise(resolve => setTimeout(resolve, closeAfterMs));
        deferred.close();
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(await socketHasLiveListener(own)).toBe(false);
        expect(await socketHasLiveListener(legacy)).toBe(false);
        const after = scheduled;
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(scheduled).toBe(after);
      }
    });
  }, 60_000);
});

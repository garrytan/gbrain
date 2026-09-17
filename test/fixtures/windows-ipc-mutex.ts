import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { tryAcquireNativeIpcMutex } from '../../src/core/persistence/native-lock.ts';
import { startPersistenceIpcServer } from '../../src/core/persistence/ipc.ts';

const [mode, path, output, barrier] = process.argv.slice(2);
if (process.platform !== 'win32' || !mode || !path || !output) throw new Error('Windows IPC fixture arguments required');
const addon = process.arch === 'x64' ? require('../../native/locks/prebuilds/win32-x64.node') : require('../../native/locks/prebuilds/win32-arm64.node');
async function keepAlive() { await new Promise<void>(done => { process.stdin.once('data', () => done()); process.stdin.once('end', done); process.stdin.resume(); }); }
if (mode === 'finalize') {
  (() => { const handle = addon.openIpcMutex(path); if (!addon.tryLock(handle)) throw new Error('Initial fixture claim refused'); })();
  let acquired = false;
  for (let i = 0; i < 100 && !acquired; i++) {
    Bun.gc(true); await delay(10);
    const next = addon.openIpcMutex(path); acquired = addon.tryLock(next); addon.close(next);
  }
  if (!acquired) throw new Error('Finalizer did not release the mutex on its owner thread');
  writeFileSync(output, 'released');
} else if (mode === 'copied-addon') {
  const copy = join(dirname(output), 'second-addon.node');
  copyFileSync(new URL(`../../native/locks/prebuilds/win32-${process.arch}.node`, import.meta.url), copy);
  const second = require(copy);
  const firstHandle = addon.openIpcMutex(path), secondHandle = second.openIpcMutex(path);
  if (!addon.tryLock(firstHandle)) throw new Error('Original addon claim refused');
  if (second.tryLock(secondHandle)) throw new Error('Copied addon recursively acquired a held mutex');
  addon.close(firstHandle);
  if (!second.tryLock(secondHandle)) throw new Error('Copied addon could not acquire after release');
  second.close(secondHandle);
  writeFileSync(output, 'released');
} else if (mode === 'worker') {
  const worker = new Worker(new URL('./windows-ipc-mutex-worker.ts', import.meta.url), { workerData: path });
  const [result] = await once(worker, 'message'); if (result !== 'acquired') throw new Error('Worker claim failed');
  if (await tryAcquireNativeIpcMutex(path)) throw new Error('Worker did not retain its claim');
  await worker.terminate();
  const next = await tryAcquireNativeIpcMutex(path); if (!next) throw new Error('Worker cleanup retained its claim');
  await next.release(); writeFileSync(output, 'released');
} else {
  const opened = mode === 'abandoned' ? addon.openIpcMutex(path) : undefined;
  writeFileSync(`${output}.ready`, 'ready');
  while (!existsSync(barrier)) await delay(10);
  const lock = mode === 'server'
    ? await startPersistenceIpcServer(path, { brainId: '10000000-0000-4000-8000-000000000001', dispatch: async () => ({}) })
    : mode === 'abandoned' ? (addon.tryLock(opened) ? { release: async () => addon.close(opened) } : null)
      : await tryAcquireNativeIpcMutex(path);
  writeFileSync(output, lock ? 'acquired' : 'busy');
  if (lock) { await keepAlive(); if ('server' in lock) lock.close(); else await lock.release(); }
  else if (opened) addon.close(opened);
}

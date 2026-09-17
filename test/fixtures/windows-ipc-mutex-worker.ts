import { parentPort, workerData } from 'node:worker_threads';
import { tryAcquireNativeIpcMutex } from '../../src/core/persistence/native-lock.ts';
const lock = await tryAcquireNativeIpcMutex(workerData);
parentPort!.postMessage(lock ? 'acquired' : 'busy');
const alive = setInterval(() => { if (lock?.released) clearInterval(alive); }, 1000);

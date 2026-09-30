import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tryAcquireNativeLock } from '../../src/core/persistence/native-lock.ts';

const [path, result, start] = process.argv.slice(2);
if (!path || !result) throw new Error('Expected lock and barrier paths');
if (start) {
  writeFileSync(`${result}.ready`, 'ready');
  while (!existsSync(start)) await delay(10);
}
const lock = await tryAcquireNativeLock(path);
writeFileSync(result, lock ? 'acquired' : 'busy');
if (lock) {
  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
    process.stdin.once('end', () => resolve());
    process.stdin.resume();
  });
  await lock.release();
}

/** Focused entrypoint to exercise the exact production import in --compile. */
import { nativeLockCapability, tryAcquireNativeLock } from '../../src/core/persistence/native-lock.ts';
const [path, ready, mode] = process.argv.slice(2);
const lock = await tryAcquireNativeLock(path);
if (lock && mode === 'hold') {
  await Bun.write(ready, 'held');
  process.stdin.resume();
  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
    process.stdin.once('end', () => resolve());
  });
}
console.log(JSON.stringify({ capability: await nativeLockCapability(), acquired: lock !== null }));
await lock?.release();

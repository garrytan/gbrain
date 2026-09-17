import { writeFileSync } from 'node:fs';
import { acquireLock, releaseLock } from '../../src/core/pglite-lock.ts';
const [dataDir, ready, command] = process.argv.slice(2);
if (command === 'serve') process.argv = [process.execPath, 'src/cli.ts', '--quiet', 'serve'];
const lock = await acquireLock(dataDir, { timeoutMs: 1000 });
writeFileSync(ready, 'held');
await new Promise<void>(resolve => {
  process.stdin.once('data', () => resolve());
  process.stdin.once('end', () => resolve());
  process.stdin.resume();
});
await releaseLock(lock);

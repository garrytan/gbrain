import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startResolveIpcServer } from '../../src/core/context/resolve-ipc.ts';
import { startPersistenceIpcServer } from '../../src/core/persistence/ipc.ts';

const [path, result, start, role] = process.argv.slice(2);
if (!path || !result || !start) throw new Error('Expected socket, result, and barrier paths');
writeFileSync(`${result}.ready`, 'ready');
while (!existsSync(start)) await delay(10);
const binding = role === 'persistence'
  ? await startPersistenceIpcServer(path, {
    brainId: '10000000-0000-4000-8000-000000000001', dispatch: async () => ({ owner: result }),
  }) : await startResolveIpcServer(path, async () => ({ pointers: [], text: result }));
writeFileSync(result, binding ? 'bound' : 'busy');
if (binding) {
  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
    process.stdin.once('end', () => resolve());
    process.stdin.resume();
  });
  binding.close();
}

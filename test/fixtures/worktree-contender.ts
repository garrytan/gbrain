/**
 * GBRA-133 test fixture: a writer in another process that takes a canonical worktree's lock and gives it back in a tight
 * loop, the way a sync drain's publications do (no-wait takes that yield lanes, each held briefly, the next one at once).
 * argv: the binding as JSON, a stop file, a stats file. Writes "ready" when it first held the lock.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { acquireWorktree, type WorktreeBinding } from '../../src/core/persistence/ownership.ts';

const [bindingJson, stopFile, statsFile] = process.argv.slice(2) as [string, string, string];
const binding = JSON.parse(bindingJson) as WorktreeBinding;
let held = 0, refused = 0;
while (!existsSync(stopFile)) {
  const lock = await acquireWorktree(binding, 0, undefined, undefined, { yieldLanes: true });
  if (!lock) { refused++; await Bun.sleep(1); continue; }
  if (++held === 1) process.stdout.write('ready\n');
  await Bun.sleep(40);
  await lock.release();
}
writeFileSync(statsFile, JSON.stringify({ held, refused }));

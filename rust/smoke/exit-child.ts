/**
 * Child process for the exit proofs, started by run.ts.
 *
 *   exit    start long native tasks, then call process.exit(0) while they run
 *   natural start long native tasks and let the event loop finish by itself
 *
 * Prints "ready" once the tasks are running. In `exit` mode the process must end at once with code
 * 0. In `natural` mode, run.ts records whether and when it ends; that is a measurement, not a
 * pass/fail gate.
 */
import { loadAddon } from './addon.ts';

const mode = process.argv[2];
const addon = loadAddon();
const pool = new addon.Pool(2);
const received: number[] = [];
const sink = new addon.Sink(value => received.push(value));

// Never awaited: these are still running when the process leaves.
pool.blockFor(5000).catch(() => {});
pool.blockFor(5000).catch(() => {});
pool.blockFor(5000).catch(() => {}); // queued behind the two running tasks
void sink.emitFromThread(100);

await new Promise(resolve => setTimeout(resolve, 100));
console.log(`ready running=${pool.running} queued=${pool.queued}`);
if (mode === 'exit') process.exit(0);

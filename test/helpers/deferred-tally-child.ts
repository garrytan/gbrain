/**
 * A shadow child's write tally for test/shadow-write-compare.test.ts ("killed between note() and its deferred save"). It opens the tally of the
 * shadow directory argv[2] for epoch argv[3] and session argv[4] with deferred saves, the way src/shadow/child.ts does (`setImmediate`).
 * Turn 1 notes a pass and a write the shadow does not compare, and lets the save it asked for run; then it writes `<argv[5]>.1` and waits for
 * the test to write `<argv[5]>.go`. Turn 2 marks a replay in flight, notes the replay's own pass and two more outcomes, writes `<argv[5]>.2`
 * and then blocks its event loop, so the save turn 2 asked for cannot run before the test kills it with SIGKILL.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { WriteTally } from '../../src/shadow/write-compare.ts';

const [dir, epoch, session, ready] = process.argv.slice(2) as [string, string, string, string];
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const tally = new WriteTally(dir, () => epoch, () => true, process.pid, session, Date.now, (save) => { setImmediate(save); });

// Turn 1: two outcomes, saved together once this turn ends.
tally.note('comparable', undefined, 1, false, 1, 1);
tally.note('capability_missing', 'tags', 1, false, 1, 0);
await new Promise<void>((resolve) => { setImmediate(resolve); }); // queued after the save, so the save has run
writeFileSync(`${ready}.1`, String(process.pid));
for (let i = 0; i < 1_000 && !existsSync(`${ready}.go`); i++) pause(20); // the test reads the tally turn 1 saved

// Turn 2: the replay's mark is saved at once; its verdict and two more outcomes wait for the next save.
if (!tally.begin()) process.exit(3);
tally.note('comparable', undefined, 1, true, 1, 1);
tally.note('comparable', undefined, 1, false, 1, 1);
tally.note('capability_missing', 'tags', 1, false, 1, 0);
writeFileSync(`${ready}.2`, String(process.pid));
pause(30_000); // this turn never ends: the save it asked for never runs
process.exit(4); // reached only when nobody killed it

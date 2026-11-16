/**
 * The hook lane's worker thread (hook-lane.ts): every synchronous step of a
 * turn (reading the index and session state, ranking, rendering) runs here,
 * so the lane's main thread keeps an event loop whose deadline timer can
 * always fire. lane-worker.ts starts it before the lane's own I/O, so its
 * start-up and module loading overlap the main thread's config, stdin and
 * carrier reads; the turn arrives as one message. It posts the prepared
 * turn and its pending commit; it never commits: the main thread does,
 * after delivery and before the deadline.
 *
 * GBRAIN_TEST_SKILL_LANE_STALL (tests only) forces a slow stage: block
 * (synchronous 10 s busy loop), hang (never answers), late (answers after
 * 300 ms), load-error (throws while loading), exit (waits on nothing, so
 * the thread ends without answering); commit-held and commit-written
 * (hook-lane.ts) stop the main thread's commit once it holds the lease, or
 * once its temp file is written; gc (hook-lane.ts) makes the session GC pass
 * after the logged turn never settle. GBRAIN_TEST_SKILL_LANE_DEADLINE_MS (tests only, hook-lane.ts)
 * widens the lane's deadline so a loaded test machine can assert delivery.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { resolveSkills } from './resolve.ts';

export interface LaneWorkerData { stall?: string }
export interface LaneWorkerTurn { input: unknown; home: string; catalogs: string[]; deadlineMs: number }

const { stall } = (workerData ?? {}) as LaneWorkerData;
if (stall === 'load-error') throw new Error('forced worker load failure');
const { input, home, catalogs, deadlineMs } = await new Promise<LaneWorkerTurn>(resolve => parentPort!.once('message', resolve));

if (stall === 'block') { const end = Date.now() + 10_000; while (Date.now() < end) { /* forced synchronous stall */ } }
if (stall === 'hang') await new Promise(() => setInterval(() => {}, 60_000));
if (stall === 'exit') await new Promise(() => {});
if (stall === 'late') await new Promise(r => setTimeout(r, 300));

try {
  const r = await resolveSkills(input, { home, catalogs, deadlineMs, failOpen: true });
  parentPort!.postMessage({ output: r.output, pending: r.pending ?? null });
} catch (e) {
  const code = (e as { code?: unknown }).code;
  parentPort!.postMessage({ error: { code: typeof code === 'string' ? code : 'skill_resolver_internal' } });
}

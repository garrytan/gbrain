/**
 * The hook lane's worker thread (hook-lane.ts): every synchronous step of a
 * turn (reading the index and session state, ranking, rendering) runs here,
 * so the lane's main thread keeps an event loop whose deadline timer can
 * always fire. lane-worker.ts starts it before the lane's own I/O, so its
 * start-up and module loading overlap the main thread's config, stdin and
 * carrier reads. It posts {ready: true} once its modules have loaded, which
 * starts the lane's turn deadline; the turn arrives as one message. It posts
 * the prepared turn and its pending commit; it never commits: the main thread does,
 * after delivery and before the deadline. At SessionStart the message
 * carries the harness's stored pins instead, and it posts their rendered
 * block (pinned-block.ts sessionStartPinnedBlock) as pinned.
 *
 * GBRAIN_TEST_SKILL_LANE_STALL (tests only) forces a slow stage: block
 * (synchronous 10 s busy loop), hang (never answers), late (answers after
 * 300 ms), slow-start (posts ready after 1.5 s), start-hang (never posts
 * ready), load-error (throws while loading), exit (waits on nothing, so
 * the thread ends without answering); commit-held and commit-written
 * (hook-lane.ts) stop the main thread's commit once it holds the lease, or
 * once its temp file is written; gc (hook-lane.ts) makes the session GC pass
 * after the logged turn never settle; start-race (hook-lane.ts) holds the
 * main thread past the start bound so the ready message and the start timer
 * are both pending. GBRAIN_TEST_SKILL_LANE_DEADLINE_MS (tests only, hook-lane.ts)
 * widens the lane's deadline so a loaded test machine can assert delivery;
 * GBRAIN_TEST_SKILL_LANE_START_MS (tests only, hook-lane.ts) widens the
 * bound on the worker's load.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { parsePins, sessionStartPinnedBlock } from './pinned-block.ts';
import { resolveSkills } from './resolve.ts';

export interface LaneWorkerData { stall?: string }
export interface LaneWorkerTurn { input: unknown; home: string; catalogs: string[]; deadlineMs: number; router: boolean }
export interface LaneWorkerPins { pins: unknown; harness: 'claude-code' | 'codex'; home: string }

const { stall } = (workerData ?? {}) as LaneWorkerData;
if (stall === 'load-error') throw new Error('forced worker load failure');
if (stall === 'slow-start') await new Promise(r => setTimeout(r, 1500));
if (stall === 'start-hang') await new Promise(() => setInterval(() => {}, 60_000));
parentPort!.postMessage({ ready: true });
const message = await new Promise<LaneWorkerTurn | LaneWorkerPins>(resolve => parentPort!.once('message', resolve));

if (stall === 'block') { const end = Date.now() + 10_000; while (Date.now() < end) { /* forced synchronous stall */ } }
if (stall === 'hang') await new Promise(() => setInterval(() => {}, 60_000));
if (stall === 'exit') await new Promise(() => {});
if (stall === 'late') await new Promise(r => setTimeout(r, 300));

try {
  if ('pins' in message) {
    parentPort!.postMessage({ pinned: sessionStartPinnedBlock(message.home, message.harness, parsePins(message.pins)).block });
  } else {
    const r = await resolveSkills(message.input, { home: message.home, catalogs: message.catalogs, deadlineMs: message.deadlineMs, failOpen: true, router: message.router });
    parentPort!.postMessage({ output: r.output, pending: r.pending ?? null });
  }
} catch (e) {
  const code = (e as { code?: unknown }).code;
  parentPort!.postMessage({ error: { code: typeof code === 'string' ? code : 'skill_resolver_internal' } });
}

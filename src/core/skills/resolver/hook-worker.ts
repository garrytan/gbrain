/**
 * The hook lane's worker thread (hook-lane.ts): every synchronous step of a
 * turn (reading the index and session state, ranking, rendering) runs here,
 * so the lane's main thread keeps an event loop whose deadline timer can
 * always fire. It posts the prepared turn and its pending commit; it never
 * commits: the main thread does, after delivery and before the deadline.
 *
 * GBRAIN_TEST_SKILL_LANE_STALL (tests only) forces a slow stage: block
 * (synchronous 10 s busy loop), hang (never answers), late (answers after
 * 300 ms). GBRAIN_TEST_SKILL_LANE_DEADLINE_MS (tests only, hook-lane.ts)
 * widens the lane's deadline so a loaded test machine can assert delivery.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { resolveSkills } from './resolve.ts';

export interface LaneWorkerData { input: unknown; home: string; catalogs: string[]; deadlineMs: number; stall?: string }

const { input, home, catalogs, deadlineMs, stall } = workerData as LaneWorkerData;

if (stall === 'block') { const end = Date.now() + 10_000; while (Date.now() < end) { /* forced synchronous stall */ } }
if (stall === 'hang') await new Promise(() => {});
if (stall === 'late') await new Promise(r => setTimeout(r, 300));

try {
  const r = await resolveSkills(input, { home, catalogs, deadlineMs, failOpen: true });
  parentPort!.postMessage({ output: r.output, pending: r.pending ?? null });
} catch (e) {
  const code = (e as { code?: unknown }).code;
  parentPort!.postMessage({ error: { code: typeof code === 'string' ? code : 'skill_resolver_internal' } });
}

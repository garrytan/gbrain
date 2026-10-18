/**
 * The one preload for test/sync-convergence.serial.test.ts: acts once, at the
 * nth hit of one named persistence fault point (`fault-points.ts`), after
 * writing a marker that records where. Configured by GBRAIN_TEST_CONVERGENCE_FAULT =
 * {"point","nth","marker"[,"operation"][,"path"][,"action"][,...action fields]}.
 * `operation` and `path` filter the hits counted (a hit without that detail
 * never matches). The actions (ACTIONS):
 *
 *   kill   (default) SIGKILL this process;
 *   edit   write `edit.content` to `edit.file` (an uncommitted worktree edit), then continue;
 *   stall  wait until the harness creates the `release` file, or for `ms` (at most 600 s), then continue;
 *   throw  throw an error carrying SQLSTATE `sqlstate` (default P0001), as the driver reports a database error.
 *
 * `prime` (#6712) sets up the condition the fault point needs: an uncommitted edit (`prime.edit`) written at the
 * `prime.nth` hit of `prime.point` (filtered by `prime.path`) in the same process, before any hit of the fault's point
 * is counted, so a file changed after its freeze reaches the deferral and hold points.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { installFaultHook, type FaultPoint } from '../../src/core/persistence/fault-points.ts';

interface Fault { point: FaultPoint; nth: number; marker: string; operation?: string; path?: string; action?: keyof typeof ACTIONS;
  edit?: { file: string; content: string }; release?: string; ms?: number; sqlstate?: string;
  prime?: { point: FaultPoint; nth: number; path?: string; edit: { file: string; content: string } } }

const ACTIONS = {
  kill: () => { process.kill(process.pid, 'SIGKILL'); },
  edit: (fault: Fault) => { writeFileSync(fault.edit!.file, fault.edit!.content); },
  stall: async (fault: Fault) => {
    const deadline = Date.now() + Math.min(fault.ms ?? 600_000, 600_000);
    while (Date.now() < deadline && !(fault.release && existsSync(fault.release))) await Bun.sleep(50);
  },
  throw: (fault: Fault, point: FaultPoint, nth: number) => {
    const sqlstate = fault.sqlstate ?? 'P0001';
    throw Object.assign(new Error(`convergence harness: injected ${sqlstate} at ${point} #${nth}`), { name: 'PostgresError', code: sqlstate, severity: 'ERROR' });
  },
} satisfies Record<string, (fault: Fault, point: FaultPoint, nth: number) => unknown>;

const raw = process.env.GBRAIN_TEST_CONVERGENCE_FAULT;
if (!raw) throw new Error('convergence-fault-kill needs GBRAIN_TEST_CONVERGENCE_FAULT.');
const fault = JSON.parse(raw) as Fault;
const action = fault.action ?? 'kill';
if (!(action in ACTIONS)) throw new Error(`convergence-fault-kill: unknown action '${action}' (known: ${Object.keys(ACTIONS).join(', ')}).`);
let seen = 0, primed = 0;
installFaultHook(async (point, detail) => {
  if (fault.prime && point === fault.prime.point && (!fault.prime.path || detail.path === fault.prime.path) && ++primed === fault.prime.nth) writeFileSync(fault.prime.edit.file, fault.prime.edit.content);
  if (point !== fault.point || (fault.operation && detail.operation !== fault.operation) || (fault.path && detail.path !== fault.path)) return;
  if (++seen !== fault.nth) return;
  writeFileSync(fault.marker, JSON.stringify({ point, nth: seen, pid: process.pid, requestId: detail.requestId, operation: detail.operation ?? null,
    path: detail.path ?? null, action }), { mode: 0o600 });
  await ACTIONS[action](fault, point, seen);
});

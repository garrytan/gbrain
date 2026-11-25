/**
 * topology_recovery_stopped doctor check: a topology change recovering on this host that the Rust engine stops by name.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: ok on a real brain with nothing recovering and on an engine with no managed worktrees (a held Rust brain:
 *    nothing is read); `writer status` (`readTopologyRecoveryStops`) names the stop `source_topology_recovery` for a
 *    recovering change on an engine that serves neither raw SQL nor managed worktrees, and none once the hold is
 *    lifted; with raw SQL or lifted managed mode the row is ok (the owner converges it); a pre-journal schema is ok and
 *    any other read failure is a warn with its error, never swallowed.
 *  - Why new: the stop itself is pinned on three arms in test/engine-parity/topology-named-stop.test.ts; this pins the
 *    doctor wording and status that tell an operator about it.
 *  - Seam: stub engines answer listTopologyRecoveries and carry a capability set; the host id is given with
 *    setEngineHostId. no_claim: the SQL of the list (pinned in the parity case).
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { topologyRecoveryStoppedEntry } from '../src/commands/doctor/checks/topology-recovery-stopped.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { setEngineHostId } from '../src/core/persistence/identity.ts';
import { readTopologyRecoveryStops } from '../src/core/persistence/topology-stop.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

const CHANGE = randomUUID();
const run = async (stub: object) => (await topologyRecoveryStoppedEntry.run({ engine: stub } as unknown as DoctorContext) as Check[])[0]!;
function stub(capabilities: string[], list: () => Promise<unknown[]>) {
  const fake = { kind: 'rust', capabilities: new Set(capabilities), listTopologyRecoveries: list };
  setEngineHostId(fake, randomUUID());
  return fake;
}
const recovering = async () => [{ id: CHANGE, source_id: 'work', operation: 'reclone', state: 'recovering' }];

describe('topology_recovery_stopped doctor check', () => {
  test('a real brain with nothing recovering is ok, and the check is categorized', async () => {
    setEngineHostId(engine, randomUUID());
    expect(await run(engine)).toMatchObject({ name: 'topology_recovery_stopped', status: 'ok', details: { count: 0, stop: null } });
    expect(categorizeCheck('topology_recovery_stopped')).toBe('ops');
  }, 60_000);

  test('a held Rust brain (no managed worktrees, no raw SQL) is ok and reads nothing; status names the stop', async () => {
    let read = false;
    const held = stub(['transactions'], async () => { read = true; return await recovering(); });
    expect(await run(held)).toMatchObject({ name: 'topology_recovery_stopped', status: 'ok' });
    expect(read).toBe(false);
    // `writer status` reads the same typed list and names the stop for each change.
    const status = await readTopologyRecoveryStops(held as never, 'host');
    expect(status).toMatchObject({ recovering: [{ source_id: 'work', operation: 'reclone', stop: 'source_topology_recovery' }], stop: 'source_topology_recovery' });
  });

  test('with the managed hold lifted (managed_persistence, no raw SQL) a recovering change is ok: the owner converges it, no stop named', async () => {
    const check = await run(stub(['managed_persistence'], recovering));
    expect(check).toMatchObject({ name: 'topology_recovery_stopped', status: 'ok', details: { count: 1, more: false, stop: null } });
    expect(check.message).toContain('the owner converges them');
    expect((await readTopologyRecoveryStops(stub(['managed_persistence'], recovering) as never, 'host')).stop).toBeNull();
  });

  test('with raw SQL the same change is ok; with no managed worktrees nothing is read', async () => {
    expect(await run(stub(['managed_persistence', 'raw_sql'], recovering))).toMatchObject({ status: 'ok', details: { count: 1, stop: null } });
    let read = false;
    expect(await run(stub([], async () => { read = true; return []; }))).toMatchObject({ status: 'ok' });
    expect(read).toBe(false);
  });

  test('a pre-journal schema is ok; any other read error is reported, never swallowed', async () => {
    const missing = Object.assign(new Error('relation "persistence_topology_changes" does not exist'), { code: '42P01' });
    expect(await run(stub(['managed_persistence'], async () => { throw missing; }))).toMatchObject({ status: 'ok' });
    const failed = await run(stub(['managed_persistence'], async () => { throw new Error('connection reset by peer'); }));
    expect(failed).toMatchObject({ name: 'topology_recovery_stopped', status: 'warn' });
    expect(failed.message).toContain('connection reset by peer');
  });
});

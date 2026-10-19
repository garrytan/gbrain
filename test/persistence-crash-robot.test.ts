/**
 * The crash robot's in-process contracts (scripts/persistence/ops.ts,
 * generator.ts, model.ts, robot-driver.ts, shrink.ts) and the PGLite release
 * of claims a dead owner left behind (effect-journal.ts releaseAbandonedClaims).
 *
 * Protects: the op-descriptor protocol refuses malformed descriptors; the five
 * cross-boundary sequences exist and pass the reference model through the real
 * operation handlers; schedules are a function of their seed; shrinking keeps
 * dependencies and accepts only a 3/3 reproduction; a PGLite owner releases a
 * claim last written before it started, and never one written after.
 * Fails when: a descriptor field stops being validated, a sequence family
 * disappears or regresses on master, `restrict` keeps an op whose producer was
 * dropped, or a restarted PGLite owner waits out a dead owner's lease.
 * Seams: none (the fault hook stays uninstalled); PGLite.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptor, executeOp, parseDescriptor, SessionDrops } from '../scripts/persistence/ops.ts';
import { ReferenceModel } from '../scripts/persistence/model.ts';
import { crossBoundarySequences, pageBody, randomSchedule } from '../scripts/persistence/generator.ts';
import { FULL_ROBOT_SECONDS, ROBOT_TOPOLOGY, restrict, runRobotPhase, type RobotRun } from '../scripts/persistence/robot-driver.ts';
import { robotFailure, robotFullGate, runValidation, spawnWorker } from '../scripts/persistence/validate.ts';
import { faultPoint, installFaultHook, type FaultDetail, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { shrinkRun } from '../scripts/persistence/shrink.ts';
import { finish, runSchedule, runSteps, seamCounter } from '../scripts/persistence/crash-robot.ts';
import { installLockOrderTrace, lockOrderReport } from '../scripts/persistence/lock-order.ts';
import { prepareTopology } from '../scripts/persistence/history-fixture.ts';
import { claimPersistenceEffect, releaseAbandonedClaims } from '../src/core/persistence/effect-journal.ts';
import { LOCK_COUNTERS_SQL } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { toAgentError } from '../src/core/agent-output.ts';
import { dispatchRenderContext, type DispatchOpts } from '../src/mcp/dispatch.ts';
import { LockUnavailableError } from '../src/core/db-lock.ts';

async function robotBrain<T>(run: (brain: Awaited<ReturnType<typeof prepareTopology>>) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-crash-robot-test-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine();
      try { return await run(await prepareTopology(engine, { sources: 2, worktrees: 2, root: join(home, 'checkouts'), prefix: 'robot', connector: true })); }
      finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('op-descriptor protocol', () => {
  test('accepts a well-formed descriptor and refuses every malformed field', () => {
    const good = descriptor('op-1', 'put_page', 'local', 'robot-0', { slug: 'notes/a', content: 'x' }, { deps: ['op-0'] });
    expect(parseDescriptor(JSON.parse(JSON.stringify(good)))).toEqual(good);
    for (const bad of [{ ...good, v: 2 }, { ...good, id: '' }, { ...good, kind: 'drop_table' }, { ...good, actor: '' },
      { ...good, requestId: 7 }, { ...good, args: [] }, { ...good, deps: [3] }]) {
      expect(() => parseDescriptor(bad)).toThrow(/op descriptor/);
    }
  });
});

describe('generator', () => {
  test('the cross-boundary sequences are always generated', () => {
    expect(crossBoundarySequences(ROBOT_TOPOLOGY).map(s => s.label)).toEqual(['withdrawal_then_stale_publication',
      'overlapping_slugs_two_sources', 'competing_writers_one_page', 'caller_bound_replay', 'authority_change_pending_effects',
      'sync_and_connector_race_direct_write']);
  });
  test('a random schedule is a function of its seed and covers every write op', () => {
    expect(JSON.stringify(randomSchedule(ROBOT_TOPOLOGY, 9))).toBe(JSON.stringify(randomSchedule(ROBOT_TOPOLOGY, 9)));
    expect(JSON.stringify(randomSchedule(ROBOT_TOPOLOGY, 10))).not.toBe(JSON.stringify(randomSchedule(ROBOT_TOPOLOGY, 9)));
    const kinds = new Set(Array.from({ length: 40 }, (_, i) => randomSchedule(ROBOT_TOPOLOGY, i).ops.map(d => d.kind)).flat());
    expect([...kinds].sort()).toEqual(['add_timeline_entry', 'delete_page', 'edit_page', 'forget', 'put_page', 'remember',
      'restore_page', 'takes_add', 'takes_supersede']);
  });
});

describe('shrinking', () => {
  test('restrict drops an op whose producer was dropped and shrinks groups', () => {
    const schedule = crossBoundarySequences(ROBOT_TOPOLOGY)[2];
    const kept = restrict(schedule, new Set(schedule.ops.filter(d => d.id !== 'cw0').map(d => d.id)));
    expect(kept.ops.map(d => d.id)).toEqual([]);
    const partial = restrict(schedule, new Set(['cw0', 'cw1', 'cw4']));
    expect(partial.ops.map(d => d.id)).toEqual(['cw0', 'cw1', 'cw4']);
    expect(partial.groups).toEqual([]);
  });
  test('ddmin finds the minimal reproducing set and requires 3/3', async () => {
    const failing = { schedule: 'random-1', seed: 1, length: 8, crashed: false, duration_ms: 0,
      ops: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], violations: [{ class: 'lost_write' as const, detail: 'x' }] };
    const result = await shrinkRun(failing, async run => ({ violations: run.ops!.includes('c') && run.ops!.includes('f') ? [{ class: 'lost_write' }] : [] }));
    expect(result.shrunk.ops).toEqual(['c', 'f']);
    expect(result).toMatchObject({ reproduced: 3, accepted: true });
    let calls = 0;
    const flaky = await shrinkRun(failing, async () => ({ violations: ++calls % 2 ? [{ class: 'lost_write' }] : [] }));
    expect(flaky.accepted).toBe(false);
  });
});

describe('reference model on master behavior', () => {
  test('the cross-boundary sequences hold every invariant through the real handlers', async () => {
    for (const schedule of crossBoundarySequences(ROBOT_TOPOLOGY)) {
      const result = await robotBrain(({ world }) => runSchedule(world, schedule));
      expect({ label: schedule.label, violations: result.violations }).toEqual({ label: schedule.label, violations: [] });
    }
  }, 180_000);
});

describe('concurrent connector publish and direct write', () => {
  // CI run 37322995874: the direct put committed first, then the connector republish imported the newer
  // item over it. The group check knew only the put's revision; the connector reports none.
  test('the connector republishing after a receipted put is a legal final state; an unexplained revision is still lost', async () => {
    await robotBrain(async ({ world }) => {
      const schedule = crossBoundarySequences(ROBOT_TOPOLOGY).find(s => s.label === 'sync_and_connector_race_direct_write')!;
      const [again, racing] = schedule.groups.find(g => g.length === 2 && schedule.ops.some(d => d.id === g[0] && d.kind === 'connector_publish'))!
        .map(id => schedule.ops.find(d => d.id === id)!);
      const model = new ReferenceModel(world);
      world.descriptors = new Map(schedule.ops.map(d => [d.id, d]));
      await runSteps(world, model, { ...schedule, ops: schedule.ops.filter(d => d !== again && d !== racing), groups: schedule.groups.filter(g => !g.includes(again.id)) });
      expect(model.violations).toEqual([]);
      const put = await executeOp(world, racing);
      const connector = await executeOp(world, again);
      expect([put.status, connector.status]).toEqual(['committed', 'committed']);
      model.beginStep(true);
      await model.observe(again, connector); await model.observe(racing, put);
      await model.settleGroup([again, racing], [connector, put]);
      expect(model.violations).toEqual([]);

      // A write no group member returned moves the page to the put's content at a revision nobody receipted.
      const unseen = await executeOp(world, { ...racing, id: `${racing.id}-unseen`, requestId: crypto.randomUUID() });
      expect(unseen.status).toBe('committed');
      model.beginStep(true);
      await model.settleGroup([again, racing], [connector, put]);
      expect(model.violations.map(v => v.class)).toEqual(['lost_write']);
    });
  }, 120_000);
});

describe('injected session drops', () => {
  // CI jobs 111669020132 and 111702893848: a pooler_disconnect drop landed on the robot's own `$current`
  // revision read, which had no retry, and the worker died with `write CONNECTION_CLOSED 127.0.0.1:55433`.
  const closed = () => Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:55433'), { code: 'CONNECTION_CLOSED' });
  const dropOnce = (world: { engine: { readPageSnapshot: (...a: never[]) => Promise<unknown> } }) => {
    const engine = world.engine;
    const read = engine.readPageSnapshot;
    let calls = 0;
    engine.readPageSnapshot = (async (...args: never[]) => {
      calls++;
      engine.readPageSnapshot = read;
      throw closed();
    }) as never;
    return () => calls;
  };

  test('an injected drop on the robot\'s own revision read is retried; a close it did not inject fails the run', async () => {
    await robotBrain(async ({ world }) => {
      const source = world.remotes[0].sourceId;
      const put = await executeOp(world, descriptor('seed', 'put_page', 'local', source, { slug: 'notes/alpha', content: pageBody('notes/alpha', 'mk-seed0') }));
      expect(put.status).toBe('committed');
      const edit = (id: string) => descriptor(id, 'put_page', 'local', source,
        { slug: 'notes/alpha', content: pageBody('notes/alpha', `mk-${id}0`), expected_revision: '$current' });

      const unexpectedCalls = dropOnce(world);
      await expect(executeOp(world, edit('unexpected'))).rejects.toThrow(/robot had dropped no session before it[\s\S]*validate\.ts --engine=postgres/);
      expect(unexpectedCalls()).toBe(1);
      expect(world.submitted?.has('unexpected')).toBe(false);

      world.sessionDrops = new SessionDrops();
      expect(await world.sessionDrops.inject(async () => 1)).toBe(1);
      const injectedCalls = dropOnce(world);
      const seen = await executeOp(world, edit('injected'));
      expect(injectedCalls()).toBe(1);
      expect(seen.status).toBe('committed');
      expect(world.submitted?.get('injected')?.expected_revision).toBe(put.receipt?.revision);
    });
  }, 120_000);

  // Local replay of the pooler_disconnect fault (Bun 1.4.2, seed 5105): drops kept a put pending past its caller's
  // wait, so the model never folded it; the next remember on that page created a model entry saying "not live"
  // and the drained page then read as an untrue receipt.
  test('a fact write on a page whose put is still pending claims nothing about that page', async () => {
    await robotBrain(async ({ world }) => {
      const source = world.remotes[0].sourceId;
      const model = new ReferenceModel(world);
      const put = descriptor('pending-put', 'put_page', 'local', source, { slug: 'notes/alpha', content: pageBody('notes/alpha', 'mk-pending0') });
      const fact = descriptor('fact', 'remember', 'local', source, { fact: 'Alpha fact mk-fact0', entity: 'notes/alpha' });
      const forget = descriptor('forget', 'forget', 'local', source, { fact_id: { $ref: fact.id, field: 'fact_id' } });
      world.descriptors = new Map([put, fact, forget].map(d => [d.id, d]));
      const committed = await executeOp(world, put);
      expect(committed.status).toBe('committed');
      model.beginStep(false);
      await model.observe(put, { ...committed, status: 'pending', values: {} });
      await model.checkGlobal('after the pending put');
      for (const d of [fact, forget]) {
        const seen = await executeOp(world, d);
        expect(seen.status).toBe('committed');
        model.beginStep(false);
        await model.observe(d, seen);
        await model.checkGlobal(`after ${d.id}`);
      }
      expect(model.violations).toEqual([]);
    });
  }, 120_000);

  test('a drop round counts once it terminated a session, including a round still in flight', async () => {
    const drops = new SessionDrops();
    expect(await drops.injectedBefore()).toBe(false);
    expect(await drops.inject(async () => 0)).toBe(0);
    expect(await drops.inject(() => Promise.reject(new Error('admin connection lost')))).toBe(0);
    expect(await drops.injectedBefore()).toBe(false);
    let finish!: (killed: number) => void;
    void drops.inject(() => new Promise<number>(done => { finish = done; }));
    const asked = drops.injectedBefore();
    finish(2);
    expect(await asked).toBe(true);
  });
});

describe('lock order', () => {
  test('real publications keep worktree > sources-by-id order; an inversion is reported', async () => {
    await robotBrain(async ({ world }) => {
      installLockOrderTrace();
      const before = lockOrderReport().violations.length;
      await runSchedule(world, crossBoundarySequences(ROBOT_TOPOLOGY)[1]);
      const clean = lockOrderReport();
      expect(clean.transactions).toBeGreaterThan(10);
      expect(clean.violations.slice(before)).toEqual([]);
      await world.engine.transaction(async tx => {
        await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', ['robot-1']);
        await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', ['robot-0']);
        await tx.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', ['00000000-0000-4000-8000-000000000000']);
      });
      expect(lockOrderReport().violations.slice(before).map(v => v.rule)).toEqual(['worktrees_before_sources', 'sources_in_id_order']);
    });
  }, 120_000);

  test('real publications lock the brain row before worktrees, sources and counters; a later brain read is reported', async () => {
    await robotBrain(async ({ world }) => {
      installLockOrderTrace();
      const before = lockOrderReport().violations.length;
      await runSchedule(world, crossBoundarySequences(ROBOT_TOPOLOGY)[1]);
      const clean = lockOrderReport();
      expect(clean.violations.slice(before)).toEqual([]);
      expect(clean.publications_reading_brain_for_share).toBeGreaterThan(0);
      // The request row is locked by one statement per publication: the `publication_started` stamp takes the lock
      // (two statements, a bare FOR UPDATE and then the stamp, is the shape before v0.60.142.0).
      expect(clean.publication_row_lock_statements_max).toBe(1);
      await world.engine.transaction(async tx => {
        await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR SHARE', ['robot-0']);
        await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE');
      });
      await world.engine.transaction(async tx => {
        await tx.executeRaw(LOCK_COUNTERS_SQL, [['brain']]);
        await tx.executeRaw('UPDATE persistence_requests SET updated_at=updated_at WHERE false');
      });
      await world.engine.transaction(async tx => {
        await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
        await tx.executeRaw('SELECT id FROM persistence_worktrees ORDER BY id FOR UPDATE');
        await tx.executeRaw('SELECT id FROM sources WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [['robot-0', 'robot-1']]);
        await tx.executeRaw(LOCK_COUNTERS_SQL, [['brain']]);
      });
      expect(lockOrderReport().violations.slice(before).map(v => v.rule)).toEqual(['brain_before_rows', 'brain_before_rows']);
    });
  }, 120_000);
});

// TODOS.md "A held sync lock reaches agents as internal_error": fails until the agent rows map the lock errors.
test.skip('a held sync lock reaches agents as the retryable sync_in_progress code', () => {
  const envelope = toAgentError(new LockUnavailableError('gbrain-sync:robot-gh'), { transport: 'http', op: 'sync_brain', mutating: true,
    idempotent: true, outcome: 'unknown', render: dispatchRenderContext({ transport: 'http', remote: true } as DispatchOpts) });
  expect(envelope.code).toBe('sync_in_progress');
});

describe('PGLite releases claims a dead owner left behind', () => {
  test('a claim written before this owner started is released; a newer one is kept', async () => {
    await robotBrain(async ({ world, checkouts }) => {
      const engine = world.engine;
      // A Git effect that failed on a stale index.lock is queued for a later attempt.
      const lock = join(checkouts[0], '.git', 'index.lock'); writeFileSync(lock, '');
      const seen = await executeOp(world, descriptor('p', 'put_page', 'local', 'robot-0', { slug: 'notes/claim', content: '---\ntype: note\ntitle: c\n---\n\nBody.\n' }));
      expect(seen.status).toBe('committed');
      let effect: { id: string } | undefined;
      for (let i = 0; i < 200 && !effect; i++) {
        [effect] = await engine.executeRaw<{ id: string }>("SELECT id::text FROM persistence_effects WHERE kind='git' AND state='queued' AND attempts>0");
        if (!effect) await Bun.sleep(50);
      }
      await disposePersistenceConsumer(engine); rmSync(lock);
      await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE id=$1', [effect!.id]); // what retry-effects does
      const [owner] = await engine.executeRaw<{ host: string }>('SELECT owner_host_id::text AS host FROM persistence_worktrees LIMIT 1');
      const claimed = await claimPersistenceEffect(engine, owner.host);
      expect({ id: String(claimed?.id), state: claimed?.state }).toEqual({ id: effect!.id, state: 'running' });
      expect(await releaseAbandonedClaims(engine, new Date(Date.now() - 60_000))).toBe(0);
      expect(await releaseAbandonedClaims(engine, new Date(Date.now() + 1_000))).toBe(1);
      const [row] = await engine.executeRaw<{ state: string; token: string | null }>('SELECT state,execution_token AS token FROM persistence_effects WHERE id=$1', [effect!.id]);
      expect(row).toEqual({ state: 'queued', token: null });
    });
  }, 60_000);
});

describe('requested faults are reported, never silently skipped (#6584)', () => {
  const replayRun = (fault: { point: FaultPoint; nth: number }): RobotRun =>
    ({ schedule: 'caller_bound_replay', seed: 5105, length: 0, fault, crashed: false, violations: [], duration_ms: 0 });
  function fakeSpawn(script: Record<string, Record<string, unknown>>[]) {
    const spawned: { role: string; killed: boolean }[] = [];
    const spawn = ((_path: string, _home: string, _mode: string, [role]: string[]) => {
      const events = script[spawned.length] ?? {}; const entry = { role, killed: false }; spawned.push(entry);
      const event = (name: string) => name in events ? Promise.resolve({ event: name, ...events[name] }) : new Promise<never>(() => {});
      return { child: { pid: 0 }, event, done: () => event('done'), failureDiagnostics: () => [], async kill() { entry.killed = true; } };
    }) as unknown as typeof spawnWorker;
    return { spawn, spawned };
  }
  async function phase(spawn: typeof spawnWorker, fault: { point: FaultPoint; nth: number }) {
    const scratch = mkdtempSync(join(tmpdir(), 'gbrain-crash-robot-fake-'));
    try {
      return await runRobotPhase({ engine: 'pglite', seed: 0, seconds: 0, scratch, home: scratch, databases: [],
        spawn, track: () => {}, replay: [replayRun(fault)], log: () => {} });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const clean = { result: { violations: [], deferred: [] } };

  test('faultPoint hands the hook a Postgres bigserial effect id as its decimal string', async () => {
    const seen: FaultDetail[] = [];
    installFaultHook((_point, detail) => { seen.push(detail); });
    try { await faultPoint('effect:git:mid', { effectId: 9007199254740993n, requestId: 'r1' }); }
    finally { installFaultHook(undefined); }
    expect(seen).toEqual([{ effectId: '9007199254740993', requestId: 'r1' }]);
  });

  async function hookChild(detail: string) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-crash-robot-hook-'));
    const path = join(dir, 'hook.ts');
    writeFileSync(path, `import { faultPoint, installFaultHook } from ${JSON.stringify(join(import.meta.dir, '../src/core/persistence/fault-points.ts'))};
import { robotFaultHook } from ${JSON.stringify(join(import.meta.dir, '../scripts/persistence/crash-robot.ts'))};
installFaultHook(robotFaultHook({ point: 'effect:git:mid', nth: 2 }));
await faultPoint('effect:git:mid', { effectId: 41n });
${detail}
process.stdout.write('{"event":"continued"}\\n');
`);
    const child = Bun.spawn([process.execPath, '--no-env-file', path], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const lines: Record<string, unknown>[] = [];
    try {
      const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let pending = '';
      const deadline = Date.now() + 60_000;
      while (!lines.length && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
        if (!chunk || chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
          lines.push(JSON.parse(pending.slice(0, newline))); pending = pending.slice(newline + 1);
        }
      }
      reader.releaseLock();
      await Bun.sleep(500);
      return { lines, alive: child.exitCode === null, stderr: child.exitCode === null ? '' : await new Response(child.stderr).text() };
    } finally { child.kill('SIGKILL'); await child.exited; rmSync(dir, { recursive: true, force: true }); }
  }

  test('the run hook freezes at the requested seam with a BigInt effect id and reports it', async () => {
    const { lines, alive, stderr } = await hookChild(`await faultPoint('effect:git:mid', { effectId: 42n, requestId: 'r1' });`);
    expect({ lines, alive, stderr }).toEqual({ lines: [{ event: 'fault', point: 'effect:git:mid', nth: 2, detail: { effectId: '42', requestId: 'r1' } }], alive: true, stderr: '' });
  }, 90_000);

  test('a re-run preparation of the same request does not advance nth: count and run agree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-crash-robot-prep-'));
    const path = join(dir, 'prep.ts');
    writeFileSync(path, `import { faultPoint, installFaultHook } from ${JSON.stringify(join(import.meta.dir, '../src/core/persistence/fault-points.ts'))};
import { robotFaultHook, seamCounter } from ${JSON.stringify(join(import.meta.dir, '../scripts/persistence/crash-robot.ts'))};
const counted = seamCounter(); const counts: Record<string, number> = {};
installFaultHook((point, detail) => { if (counted(point, detail)) counts[point] = (counts[point] ?? 0) + 1; });
for (const requestId of ['a', 'a', 'b', 'b', 'b']) await faultPoint('consumer:preparing', { requestId });
for (const requestId of ['a', 'a']) await faultPoint('publication:after_commit', { requestId });
for (const writeId of ['w1', 'w1', 'w2']) await faultPoint('consumer:prepared', { requestId: 'shared', writeId });
process.stdout.write(JSON.stringify({ event: 'counts', counts }) + '\\n');
installFaultHook(robotFaultHook({ point: 'consumer:preparing', nth: 2 }));
await faultPoint('consumer:preparing', { requestId: 'a' });
await faultPoint('consumer:preparing', { requestId: 'a' });
await faultPoint('consumer:preparing', { requestId: 'b' });
process.stdout.write('{"event":"continued"}\\n');
`);
    const child = Bun.spawn([process.execPath, '--no-env-file', path], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    try {
      const lines: Record<string, unknown>[] = [];
      const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let pending = '';
      const deadline = Date.now() + 60_000;
      while (lines.length < 2 && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
        if (!chunk || chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
          lines.push(JSON.parse(pending.slice(0, newline))); pending = pending.slice(newline + 1);
        }
      }
      reader.releaseLock();
      expect(lines).toEqual([
        { event: 'counts', counts: { 'consumer:preparing': 2, 'publication:after_commit': 2, 'consumer:prepared': 2 } },
        { event: 'fault', point: 'consumer:preparing', nth: 2, detail: { requestId: 'b' } },
      ]);
    } finally { child.kill('SIGKILL'); await child.exited; rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

  test('#6896: consumer:claiming counts claim epochs, so a run with fewer idle claim passes still reaches every slot the count role saw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-crash-robot-claim-'));
    const path = join(dir, 'claim.ts');
    // Count role: busy and idle claim attempts around two preparations (and a re-run one). Run: the same requests, no idle ticks.
    writeFileSync(path, `import { faultPoint, installFaultHook } from ${JSON.stringify(join(import.meta.dir, '../src/core/persistence/fault-points.ts'))};
import { robotFaultHook, seamCounter } from ${JSON.stringify(join(import.meta.dir, '../scripts/persistence/crash-robot.ts'))};
const counted = seamCounter(); let slots = 0;
installFaultHook((point, detail) => { const advanced = counted(point, detail); if (point === 'consumer:claiming') slots += advanced; });
const claim = () => faultPoint('consumer:claiming');
const prepare = (writeId: string) => faultPoint('consumer:preparing', { requestId: writeId, writeId });
await claim(); await claim(); await prepare('w1'); await claim(); await claim(); await claim(); await prepare('w1'); await prepare('w2'); await claim(); await claim();
process.stdout.write(JSON.stringify({ event: 'counts', slots }) + '\\n');
installFaultHook(robotFaultHook({ point: 'consumer:claiming', nth: slots }));
await claim(); await prepare('w1'); await claim(); await prepare('w2'); await claim();
process.stdout.write('{"event":"continued"}\\n');
`);
    const child = Bun.spawn([process.execPath, '--no-env-file', path], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    try {
      const lines: Record<string, unknown>[] = [];
      const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let pending = '';
      const deadline = Date.now() + 60_000;
      while (lines.length < 2 && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
        if (!chunk || chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
          lines.push(JSON.parse(pending.slice(0, newline))); pending = pending.slice(newline + 1);
        }
      }
      reader.releaseLock();
      expect(lines).toEqual([
        { event: 'counts', slots: 3 },
        { event: 'fault', point: 'consumer:claiming', nth: 3, detail: {} },
      ]);
    } finally { child.kill('SIGKILL'); await child.exited; rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

  test('#6957: finish waits for the claim pass after its probe, so the last claim epoch a count role sees is reached in every run', async () => {
    await robotBrain(async ({ world }) => {
      const counted = seamCounter(); const prepared = new Set<string>(); let slots = 0;
      world.claimPasses = 0;
      // Every claim pass is slow to start, so the one the consumer makes after the probe commits lands only when finish waits for it.
      installFaultHook(async (point, detail) => {
        if (point === 'consumer:preparing' && detail.writeId) prepared.add(detail.writeId);
        if (point !== 'consumer:claiming') { counted(point, detail); return; }
        await Bun.sleep(1000);
        world.claimPasses!++; slots += counted(point, detail);
      });
      try { await finish(world, new ReferenceModel(world), 'probe only'); }
      finally { installFaultHook(undefined); }
      expect({ prepared: prepared.size, slots }).toEqual({ prepared: 1, slots: 2 });
    });
  }, 90_000);

  test('seed 5105: finish drains its probe\'s effects, so the probe\'s effect:git:mid a count role may see is reached in every run', async () => {
    await robotBrain(async ({ world }) => {
      const reached: string[] = [];
      world.claimPasses = 0;
      // Every effect seam is slow, so the probe's git effect reaches its seam only when finish waits for it.
      installFaultHook(async (point, detail) => {
        if (point === 'consumer:claiming') { world.claimPasses!++; return; }
        if (!point.startsWith('effect:')) return;
        await Bun.sleep(1500);
        reached.push(`${point}:${detail.requestId}`);
      });
      try { await finish(world, new ReferenceModel(world), 'probe only'); }
      finally { installFaultHook(undefined); }
      expect(reached.filter(seam => seam.startsWith('effect:git:mid:'))).toHaveLength(1);
    });
  }, 90_000);

  test('a hook that cannot report its fault emits fault_hook_error and still freezes', async () => {
    const { lines, alive } = await hookChild(`const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
await faultPoint('effect:git:mid', { requestId: 'r1', signal: cyclic as never });`);
    expect(alive).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'fault_hook_error', point: 'effect:git:mid', nth: 2 });
    expect(String(lines[0].message)).toMatch(/cyclic|circular/i);
  }, 90_000);

  test('a worker that finishes before its requested fault fails the run and the full gate', async () => {
    const { spawn, spawned } = fakeSpawn([{ done: clean }]);
    const robot = await phase(spawn, { point: 'effect:git:mid', nth: 1 });
    expect(spawned.map(s => s.role)).toEqual(['run']);
    expect(robot.runs[0]).toMatchObject({ crashed: false, fault_not_reached: true });
    expect({ crashed: robot.crashed_runs, unreached: robot.faults_not_reached.length, failing: robot.failing_runs.length })
      .toEqual({ crashed: 0, unreached: 1, failing: 1 });
    expect(robotFullGate(robot, FULL_ROBOT_SECONDS)).toBe(false);
    expect(robotFailure(robot.failing_runs, { engine: 'pglite' })).toContain('fault_not_reached');
  });

  test('a fault_hook_error kills the worker and fails the run and the full gate', async () => {
    const { spawn, spawned } = fakeSpawn([{ fault_hook_error: { point: 'effect:git:mid', nth: 1, message: 'JSON.stringify cannot serialize BigInt.' } }]);
    const robot = await phase(spawn, { point: 'effect:git:mid', nth: 1 });
    expect(spawned).toEqual([{ role: 'run', killed: true }]);
    expect(robot.fault_hook_errors.map(r => r.hook_error)).toEqual(['JSON.stringify cannot serialize BigInt.']);
    expect(robot.failing_runs).toHaveLength(1);
    expect(robotFullGate(robot, FULL_ROBOT_SECONDS)).toBe(false);
    expect(robotFailure(robot.failing_runs, { engine: 'pglite' })).toContain('fault_hook_error: JSON.stringify cannot serialize BigInt.');
  });

  test('control: a reached fault that recovers cleanly keeps the full gate', async () => {
    const { spawn, spawned } = fakeSpawn([{ fault: { point: 'effect:git:mid', nth: 1 } }, { done: clean }]);
    const robot = await phase(spawn, { point: 'effect:git:mid', nth: 1 });
    expect(spawned).toEqual([{ role: 'run', killed: true }, { role: 'recover', killed: false }]);
    expect({ crashed: robot.crashed_runs, failing: robot.failing_runs.length }).toEqual({ crashed: 1, failing: 0 });
    expect(robotFullGate(robot, FULL_ROBOT_SECONDS)).toBe(true);
  });

  test('validation exits nonzero when a replayed fault is never reached by a real worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-crash-robot-unreached-'));
    try {
      const manifest = join(dir, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ engine: 'pglite', robot: { runs: [replayRun({ point: 'effect:git:mid', nth: 9999 })] } }));
      const out = join(dir, 'out.json');
      const error = await runValidation({ engine: 'pglite', replay: manifest, manifest: out }).then(() => null, (e: Error) => e);
      expect(error?.message).toContain('fault_not_reached');
      expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ status: 'failed', full_gate: false });
      rmSync(JSON.parse(readFileSync(`${out}.retained.json`, 'utf8')).scratch_root, { recursive: true, force: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);
});

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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { descriptor, executeOp, parseDescriptor, SessionDrops } from '../scripts/persistence/ops.ts';
import { ReferenceModel } from '../scripts/persistence/model.ts';
import { crossBoundarySequences, pageBody, randomSchedule } from '../scripts/persistence/generator.ts';
import { ROBOT_TOPOLOGY, restrict } from '../scripts/persistence/robot-driver.ts';
import { shrinkRun } from '../scripts/persistence/shrink.ts';
import { runSchedule, runSteps } from '../scripts/persistence/crash-robot.ts';
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

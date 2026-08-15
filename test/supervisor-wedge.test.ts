/**
 * issue #1801 — supervisor progress watchdog.
 *
 * Two layers:
 *   1. Decision logic (counter / thresholds / startup grace / loop budget) via
 *      the MinionSupervisor test seams + a stub engine — no DB, no spawn.
 *   2. SQL semantics of `queryWedgeSignals` against a real PGLite engine —
 *      pins Codex #6 (expired-lock active row does NOT count as active_healthy),
 *      #7 (due-delayed counts as claimable), #5 (name-scoping).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { MinionSupervisor, queryWedgeSignals } from '../src/core/minions/supervisor.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// ---------------------------------------------------------------------------
// Layer 1: decision logic (stub engine + fake child supervisor)
// ---------------------------------------------------------------------------

interface WedgeRow {
  stalled?: string;
  active_healthy?: string;
  waiting?: string;
  waiting_claimable?: string;
  last_completed?: string | null;
  last_completed_claimable?: string | null;
}

function minutesAgoIso(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function makeSup(opts?: {
  row?: WedgeRow;
  childAlive?: boolean;
  inBackoff?: boolean;
  wedgeRestartMinutes?: number;
  wedgeRestartChecks?: number;
  wedgeRestartLoopBudget?: number;
  childStartedAtMsAgo?: number;
}) {
  const events: Array<{ event: string; reason?: string; [k: string]: unknown }> = [];
  let restartCalls = 0;
  const rowRef: { current: WedgeRow } = {
    current: opts?.row ?? {},
  };

  const stubEngine = {
    kind: 'postgres',
    async executeRaw() {
      const r = rowRef.current;
      return [{
        stalled: r.stalled ?? '0',
        active_healthy: r.active_healthy ?? '0',
        waiting: r.waiting ?? '0',
        waiting_claimable: r.waiting_claimable ?? '0',
        last_completed: r.last_completed ?? null,
        last_completed_claimable: r.last_completed_claimable ?? null,
      }];
    },
  } as unknown as BrainEngine;

  const sup = new MinionSupervisor(stubEngine, {
    cliPath: '/bin/true',
    maxRssMb: 0, // skip cgroup auto-size
    healthInterval: 60_000,
    wedgeRestartMinutes: opts?.wedgeRestartMinutes ?? 15,
    wedgeRestartChecks: opts?.wedgeRestartChecks ?? 3,
    wedgeRestartLoopBudget: opts?.wedgeRestartLoopBudget ?? 3,
    startupGraceMs: 120_000,
    onEvent: (e) => events.push(e as { event: string; reason?: string }),
  });

  sup._setChildSupervisorForTests({
    childAlive: opts?.childAlive ?? true,
    inBackoff: opts?.inBackoff ?? false,
    restartCurrentChild: async () => { restartCalls++; },
  } as never);

  sup._setWedgeStateForTests({
    handlerNames: ['cycle'],
    childStartedAt: Date.now() - (opts?.childStartedAtMsAgo ?? 600_000), // 10 min ago
  });

  return {
    sup,
    events,
    getRestartCalls: () => restartCalls,
    setRow: (r: WedgeRow) => { rowRef.current = r; },
  };
}

const WEDGE_ROW: WedgeRow = {
  active_healthy: '0',
  waiting: '0',
  waiting_claimable: '5',
  last_completed_claimable: minutesAgoIso(20), // stale > 15
};

describe('issue #1801 — supervisor wedge decision logic', () => {
  it('restarts a wedged worker after wedgeRestartChecks consecutive checks', async () => {
    const h = makeSup({ row: WEDGE_ROW });
    await h.sup._healthCheckOnceForTests();
    await h.sup._healthCheckOnceForTests();
    expect(h.getRestartCalls()).toBe(0); // not yet (default 3 checks)
    await h.sup._healthCheckOnceForTests();
    expect(h.getRestartCalls()).toBe(1);
    expect(h.events.some((e) => e.event === 'health_warn' && e.reason === 'restarting_wedged_worker')).toBe(true);
  });

  it('never escalates when a job holds a live lock (active_healthy > 0)', async () => {
    const h = makeSup({ row: { ...WEDGE_ROW, active_healthy: '2' } });
    for (let i = 0; i < 5; i++) await h.sup._healthCheckOnceForTests();
    expect(h.getRestartCalls()).toBe(0);
  });

  it('suppresses restart during the startup grace window (Codex #9/#10)', async () => {
    const h = makeSup({ row: WEDGE_ROW, childStartedAtMsAgo: 1_000 }); // just spawned
    for (let i = 0; i < 4; i++) await h.sup._healthCheckOnceForTests();
    expect(h.getRestartCalls()).toBe(0);
  });

  it('wedgeRestartMinutes <= 0 disables the watchdog', async () => {
    const h = makeSup({ row: WEDGE_ROW, wedgeRestartMinutes: 0 });
    for (let i = 0; i < 4; i++) await h.sup._healthCheckOnceForTests();
    expect(h.getRestartCalls()).toBe(0);
  });

  it('inBackoff suppresses escalation (respawn window)', async () => {
    const h = makeSup({ row: WEDGE_ROW, inBackoff: true });
    for (let i = 0; i < 4; i++) await h.sup._healthCheckOnceForTests();
    expect(h.getRestartCalls()).toBe(0);
  });

  it('resets the counter when the wedge clears', async () => {
    const h = makeSup({ row: WEDGE_ROW, wedgeRestartChecks: 3 });
    await h.sup._healthCheckOnceForTests(); // wedged 1
    await h.sup._healthCheckOnceForTests(); // wedged 2
    h.setRow({ ...WEDGE_ROW, active_healthy: '1' }); // healthy → reset
    await h.sup._healthCheckOnceForTests();
    expect(h.sup._consecutiveWedgedChecksForTests).toBe(0);
    h.setRow(WEDGE_ROW); // wedged again
    await h.sup._healthCheckOnceForTests(); // 1
    await h.sup._healthCheckOnceForTests(); // 2
    expect(h.getRestartCalls()).toBe(0); // still under 3 after the reset
    await h.sup._healthCheckOnceForTests(); // 3
    expect(h.getRestartCalls()).toBe(1);
  });

  it('loop budget (>=) stops restarting and emits wedge_restart_loop ONCE (Codex #13 + loop-spam fix)', async () => {
    const h = makeSup({ row: WEDGE_ROW, wedgeRestartChecks: 1, wedgeRestartLoopBudget: 2 });
    await h.sup._healthCheckOnceForTests(); // restart 1 (timestamps: 0 < 2 → push)
    await h.sup._healthCheckOnceForTests(); // restart 2 (timestamps: 1 < 2 → push)
    await h.sup._healthCheckOnceForTests(); // budget: 2 >= 2 → no restart, loop warn
    await h.sup._healthCheckOnceForTests(); // still exhausted → MUST NOT re-warn
    await h.sup._healthCheckOnceForTests(); // still exhausted → MUST NOT re-warn
    expect(h.getRestartCalls()).toBe(2);
    const loopWarns = h.events.filter((e) => e.event === 'health_warn' && e.reason === 'wedge_restart_loop');
    expect(loopWarns.length).toBe(1); // fired once on entry, not every tick (no audit flood)
  });

  it('null last_completed_claimable wedges only after the startup grace', async () => {
    // Never-completed claimable work, child past grace → treated as stale.
    const h = makeSup({
      row: { active_healthy: '0', waiting_claimable: '3', last_completed_claimable: null },
      wedgeRestartChecks: 3,
    });
    for (let i = 0; i < 3; i++) await h.sup._healthCheckOnceForTests();
    expect(h.getRestartCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: SQL semantics of queryWedgeSignals (real PGLite)
// ---------------------------------------------------------------------------

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seed(
  queue: string,
  name: string,
  status: string,
  extra: { lockUntilSql?: string; delayUntilSql?: string; updatedAtSql?: string } = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, queue, status, lock_until, delay_until, updated_at)
     VALUES ($1, $2, $3, ${extra.lockUntilSql ?? 'NULL'}, ${extra.delayUntilSql ?? 'NULL'}, ${extra.updatedAtSql ?? 'now()'})`,
    [name, queue, status],
  );
}

describe('issue #1801 — queryWedgeSignals SQL semantics (PGLite)', () => {
  it('scopes claimable by name, counts due-delayed, excludes not-due-delayed (Codex #5/#7)', async () => {
    const q = 'sql-a';
    await seed(q, 'cycle', 'waiting');                                            // claimable
    await seed(q, 'cycle', 'delayed', { delayUntilSql: "now() - interval '1 min'" }); // due → claimable
    await seed(q, 'cycle', 'delayed', { delayUntilSql: "now() + interval '1 hour'" }); // not due → not
    await seed(q, 'other', 'waiting');                                            // wrong name → not claimable
    await seed(q, 'cycle', 'completed', { updatedAtSql: 'now()' });

    const sig = await queryWedgeSignals(engine, q, ['cycle']);
    expect(sig.waitingClaimable).toBe(2);          // waiting + due-delayed
    expect(sig.waiting).toBe(2);                    // total waiting (cycle + other)
    expect(sig.lastCompletedClaimable).not.toBeNull();
  });

  it('expired-lock active row counts as stalled, NOT active_healthy (Codex #6)', async () => {
    const q = 'sql-b';
    await seed(q, 'cycle', 'active', { lockUntilSql: "now() - interval '1 min'" }); // expired
    await seed(q, 'cycle', 'waiting');

    const sig = await queryWedgeSignals(engine, q, ['cycle']);
    expect(sig.activeHealthy).toBe(0);   // expired lock does NOT suppress the wedge
    expect(sig.stalled).toBe(1);
    expect(sig.waitingClaimable).toBe(1);
  });

  it('live-lock active row counts as active_healthy', async () => {
    const q = 'sql-c';
    await seed(q, 'cycle', 'active', { lockUntilSql: "now() + interval '5 min'" }); // live
    await seed(q, 'cycle', 'waiting');

    const sig = await queryWedgeSignals(engine, q, ['cycle']);
    expect(sig.activeHealthy).toBe(1);
    expect(sig.stalled).toBe(0);
  });

  it('is queue-scoped — other queues do not bleed in', async () => {
    await seed('q1', 'cycle', 'waiting');
    await seed('q2', 'cycle', 'waiting');
    const sig = await queryWedgeSignals(engine, 'q1', ['cycle']);
    expect(sig.waitingClaimable).toBe(1);
  });
});

/**
 * v0.41 E2E — budget cathedral (D4 projection + D5 enforcement + Eng D7 reservation).
 *
 * Two end-to-end scenarios:
 *
 *   1. Mid-batch budget exhaustion halts the subtree cleanly (Eng D7
 *      recursive halt). 10 children of one budget-bearing parent;
 *      reservations drain the cap; remaining children get halted via
 *      `haltBudgetSubtree`.
 *
 *   2. Parallel-children reservation prevents overspend (the failure mode
 *      CAS-only would NOT bound). 8 concurrent reserves at the limit
 *      cannot exceed the budget.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import {
  setOwnerBudget,
  inheritBudgetOwner,
  reserveBudget,
  haltBudgetSubtree,
  getBudgetOwner,
} from '../../src/core/minions/budget-tracker.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_budget_log');
  await engine.executeRaw('DELETE FROM minion_jobs');
}, 30_000);

describe('v0.41 budget cathedral E2E', () => {
  test('mid-batch budget exhaustion halts subtree; surviving children = dead', async () => {
    const owner = await queue.add('subagent', { prompt: 'parent' }, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 0.50); // 50¢ — small budget

    // Spawn 10 children inheriting the owner.
    const children: number[] = [];
    for (let i = 0; i < 10; i++) {
      const c = await queue.add(
        'subagent',
        { prompt: `child ${i}` },
        { parent_job_id: owner.id },
        { allowProtectedSubmit: true },
      );
      await inheritBudgetOwner(engine, c.id, owner.id);
      children.push(c.id);
    }

    // Reserve 10¢ per child, in serial. After 5 children consume
    // 5 × 10¢ = 50¢, the budget is exhausted.
    const outcomes: string[] = [];
    for (const id of children) {
      const r = await reserveBudget(engine, id, 10);
      outcomes.push(r.kind);
    }
    // First 5 succeed; remaining 5 see CAS miss.
    expect(outcomes.filter(o => o === 'reserved').length).toBe(5);
    expect(outcomes.filter(o => o === 'exhausted').length).toBe(5);

    // Now haltBudgetSubtree → all remaining waiting children flip to dead.
    const halted = await haltBudgetSubtree(engine, owner.id, 'budget_exhausted');
    expect(halted).toBe(10); // every CHILD (not the owner) gets halted
    // Owner stays in its own status.
    const ownerAfter = await queue.getJob(owner.id);
    expect(ownerAfter!.status).not.toBe('dead');

    // Owner balance is 0.
    const ownerInfo = await getBudgetOwner(engine, owner.id);
    expect(ownerInfo!.budget_remaining_cents).toBe(0);

    // Audit rows: 5 reserved + 5 halted + N owner_deleted (0) + final halt rows.
    // We just check that audit rows were written for each reservation event.
    const auditCount = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_budget_log WHERE event_type IN ('reserved', 'halted')`,
    );
    expect(parseInt(auditCount[0]!.count, 10)).toBeGreaterThanOrEqual(10);
  });

  test('parallel reservations cannot exceed budget (CAS bounds N concurrent children)', async () => {
    const owner = await queue.add('subagent', { prompt: 'parent' }, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 0.30); // 30¢

    // 8 concurrent children all trying to reserve 10¢ each — total
    // would-spend = 80¢ if unbounded. CAS prevents the 30¢ owner
    // balance from going negative.
    const childIds: number[] = [];
    for (let i = 0; i < 8; i++) {
      const c = await queue.add(
        'subagent',
        { prompt: `c${i}` },
        { parent_job_id: owner.id },
        { allowProtectedSubmit: true },
      );
      await inheritBudgetOwner(engine, c.id, owner.id);
      childIds.push(c.id);
    }

    // Fire all 8 reservations in parallel.
    const outcomes = await Promise.all(childIds.map(id => reserveBudget(engine, id, 10)));
    const reserved = outcomes.filter(o => o.kind === 'reserved').length;
    const exhausted = outcomes.filter(o => o.kind === 'exhausted').length;

    // Exactly 3 should succeed (30¢ / 10¢ = 3); 5 should hit exhausted.
    expect(reserved).toBe(3);
    expect(exhausted).toBe(5);

    // Owner balance is 0 (not negative — that's the CAS guarantee).
    const ownerInfo = await getBudgetOwner(engine, owner.id);
    expect(ownerInfo!.budget_remaining_cents).toBe(0);
  });
});

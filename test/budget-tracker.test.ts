/**
 * v0.41 D5 + Eng D7 + Eng D10 — budget-tracker tests.
 *
 * Pins the reservation pattern's load-bearing contracts:
 *
 *   - reserveBudget: CAS UPDATE prevents overspend even across parallel
 *     children of the same owner.
 *   - Eng D10 NULL-bypass: jobs without an owner skip reservation cleanly.
 *   - Eng D10 owner-deleted disambiguation: pruned-owner orphans throw
 *     BudgetOwnerDeleted instead of silently bypassing.
 *   - refundBudget returns unspent cents to the owner row.
 *   - haltBudgetSubtree walks all waiting/delayed descendants of an owner.
 *   - Audit rows written to minion_budget_log per event.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  reserveBudget,
  refundBudget,
  setOwnerBudget,
  inheritBudgetOwner,
  haltBudgetSubtree,
  getBudgetOwner,
} from '../src/core/minions/budget-tracker.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_budget_log');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('reserveBudget (CAS pattern)', () => {
  test('reserves cents from owner balance; CAS succeeds when balance >= cost', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 1.0); // $1.00 = 100¢
    const child = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, child.id, owner.id);

    const outcome = await reserveBudget(engine, child.id, 30);
    expect(outcome.kind).toBe('reserved');
    if (outcome.kind === 'reserved') {
      expect(outcome.new_balance_cents).toBe(70);
      expect(outcome.reserved_cents).toBe(30);
    }
    // Audit row written.
    const audit = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_budget_log WHERE event_type = 'reserved'`,
    );
    expect(parseInt(audit[0]!.count, 10)).toBe(1);
  });

  test('CAS miss returns exhausted; balance + requested visible for audit', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 0.10); // $0.10 = 10¢
    const child = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, child.id, owner.id);

    const outcome = await reserveBudget(engine, child.id, 50);
    expect(outcome.kind).toBe('exhausted');
    if (outcome.kind === 'exhausted') {
      expect(outcome.balance_at_attempt).toBe(10);
      expect(outcome.requested_cents).toBe(50);
    }
    // Halted audit row written.
    const audit = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_budget_log WHERE event_type = 'halted'`,
    );
    expect(parseInt(audit[0]!.count, 10)).toBe(1);
  });

  test('Eng D10: job with no owner returns no_budget (clean bypass)', async () => {
    const child = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    // No setOwnerBudget call → budget_owner_job_id stays NULL.
    const outcome = await reserveBudget(engine, child.id, 50);
    expect(outcome.kind).toBe('no_budget');
  });

  test('Eng D10: deleted owner (FK NULL but root denormalized) throws owner_deleted', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 1.0);
    const child = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, child.id, owner.id);

    // Hard-delete the owner — simulates `gbrain jobs prune` race.
    // SET NULL FK fires on the child's budget_owner_job_id but the
    // immutable budget_root_owner_id persists.
    await engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [owner.id]);

    const outcome = await reserveBudget(engine, child.id, 50);
    expect(outcome.kind).toBe('owner_deleted');
    if (outcome.kind === 'owner_deleted') {
      expect(outcome.root_owner_id).toBe(owner.id);
    }
  });
});

describe('refundBudget', () => {
  test('returns unspent cents to owner', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 1.0);
    const child = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, child.id, owner.id);

    await reserveBudget(engine, child.id, 50); // balance 100→50
    await refundBudget(engine, child.id, owner.id, 30); // balance 50→80

    const after = await getBudgetOwner(engine, owner.id);
    expect(after!.budget_remaining_cents).toBe(80);

    // Refund audit row.
    const audit = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_budget_log WHERE event_type = 'refunded'`,
    );
    expect(parseInt(audit[0]!.count, 10)).toBe(1);
  });

  test('refund of 0 cents is a no-op', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 1.0);
    const child = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, child.id, owner.id);
    await reserveBudget(engine, child.id, 50);

    await refundBudget(engine, child.id, owner.id, 0);
    const after = await getBudgetOwner(engine, owner.id);
    expect(after!.budget_remaining_cents).toBe(50); // unchanged

    const audit = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_budget_log WHERE event_type = 'refunded'`,
    );
    expect(parseInt(audit[0]!.count, 10)).toBe(0); // no audit row either
  });
});

describe('haltBudgetSubtree', () => {
  test('flips waiting + delayed children to dead with reason', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 1.0);
    const c1 = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    const c2 = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    const c3 = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    for (const c of [c1, c2, c3]) {
      await inheritBudgetOwner(engine, c.id, owner.id);
    }

    // Move c2 to 'delayed' to verify both waiting AND delayed are halted.
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'delayed', delay_until = now() + interval '1 hour' WHERE id = $1`,
      [c2.id],
    );

    const halted = await haltBudgetSubtree(engine, owner.id, 'budget_exhausted');
    expect(halted).toBe(3);

    // Verify each child is dead.
    for (const c of [c1, c2, c3]) {
      const r = await engine.executeRaw<{ status: string; error_text: string }>(
        `SELECT status, error_text FROM minion_jobs WHERE id = $1`,
        [c.id],
      );
      expect(r[0]!.status).toBe('dead');
      expect(r[0]!.error_text).toContain('budget_exhausted');
    }
  });

  test('does NOT touch active children (they finish their current turn cleanly)', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 1.0);
    const c1 = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, c1.id, owner.id);
    // Move c1 to 'active' to simulate in-flight.
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_token = 'lock', lock_until = now() + interval '1 minute' WHERE id = $1`,
      [c1.id],
    );

    const halted = await haltBudgetSubtree(engine, owner.id, 'budget_exhausted');
    expect(halted).toBe(0); // active jobs not flipped

    const r = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM minion_jobs WHERE id = $1`,
      [c1.id],
    );
    expect(r[0]!.status).toBe('active');
  });
});

describe('inheritBudgetOwner', () => {
  test('child mirrors parent owner + root_owner; does NOT copy balance', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 1.0);
    const child = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, child.id, owner.id);

    const info = await getBudgetOwner(engine, child.id);
    expect(info!.budget_owner_job_id).toBe(owner.id);
    expect(info!.budget_root_owner_id).toBe(owner.id);
    // Critical: child's balance stays NULL — only owner row holds spendable cents.
    expect(info!.budget_remaining_cents).toBeNull();
  });

  test('grandchild inherits the original owner (chain depth 2)', async () => {
    const owner = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, owner.id, 1.0);
    const child = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, child.id, owner.id);
    const grand = await queue.add('subagent', {}, {}, { allowProtectedSubmit: true });
    await inheritBudgetOwner(engine, grand.id, child.id);

    const info = await getBudgetOwner(engine, grand.id);
    // Grandchild should point at the ORIGINAL owner, not its immediate parent.
    expect(info!.budget_owner_job_id).toBe(owner.id);
    expect(info!.budget_root_owner_id).toBe(owner.id);
  });
});

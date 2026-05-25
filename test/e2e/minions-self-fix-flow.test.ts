/**
 * v0.41 E2E — self-fix flow (E6 with narrowed classifier per codex pass-2 #4).
 *
 * End-to-end: parent fails with each recoverable cluster + non-recoverable
 * cluster + opt-out flag. Verifies the decision-then-submission chain
 * works against a real PGLite + the v93 audit table.
 *
 * Three scenarios per the eng plan:
 *   1. prompt_too_long → self-fix child submitted; chain depth=1
 *   2. tool_crash → NOT recoverable; NO child submitted; parent stays dead
 *   3. no_self_fix flag on parent → bypass even for recoverable cluster
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import {
  decideSelfFix,
  submitSelfFixChild,
} from '../../src/core/minions/self-fix.ts';

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
  await engine.executeRaw('DELETE FROM minion_self_fix_log');
  await engine.executeRaw('DELETE FROM minion_budget_log');
  await engine.executeRaw('DELETE FROM minion_jobs');
}, 30_000);

describe('v0.41 self-fix E2E', () => {
  test('prompt_too_long: parent fails → child submitted → chain depth=1 + audit row', async () => {
    const parent = await queue.add(
      'subagent',
      { prompt: 'massive prompt that exceeded context' },
      {},
      { allowProtectedSubmit: true },
    );
    const decision = await decideSelfFix(
      engine,
      parent.id,
      { prompt: 'massive prompt that exceeded context' },
      'prompt is too long: 1.8M tokens > 1M maximum',
    );
    expect(decision.should_fix).toBe(true);
    expect(decision.cluster).toBe('prompt_too_long');

    const result = await submitSelfFixChild(
      engine,
      queue,
      {
        id: parent.id,
        data: { prompt: 'massive prompt that exceeded context' },
        last_error: 'prompt is too long: 1.8M tokens > 1M maximum',
      },
      'prompt_too_long',
    );
    expect(result).not.toBeNull();

    const child = await queue.getJob(result!.child_id);
    expect(child).not.toBeNull();
    expect(child!.parent_job_id).toBe(parent.id);
    const data = child!.data as Record<string, unknown>;
    expect(data.is_self_fix_child).toBe(true);
    expect(data.self_fix_cluster).toBe('prompt_too_long');
    expect(String(data.prompt)).toContain('self-fix retry');
    expect(String(data.prompt)).toContain('prompt was too long');

    // Audit row.
    const audit = await engine.executeRaw<{ outcome: string }>(
      `SELECT outcome FROM minion_self_fix_log WHERE parent_id = $1`,
      [parent.id],
    );
    expect(audit.length).toBe(1);
    expect(audit[0]!.outcome).toBe('submitted');
  });

  test('tool_crash: NOT recoverable → no child submitted, parent stays dead-letter path', async () => {
    const parent = await queue.add(
      'subagent', { prompt: 'do thing with broken tool' },
      {}, { allowProtectedSubmit: true },
    );
    const decision = await decideSelfFix(
      engine,
      parent.id,
      { prompt: 'do thing with broken tool' },
      'tool "git_commit" failed: ENOENT spawn git',
    );
    expect(decision.should_fix).toBe(false);
    expect(decision.cluster).toBe('tool_crash');
    expect(decision.reason).toContain('cluster_not_recoverable');

    // No child should exist (decision short-circuits before submission).
    const childCount = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE parent_job_id = $1`,
      [parent.id],
    );
    expect(parseInt(childCount[0]!.count, 10)).toBe(0);
  });

  test('no_self_fix opt-out: even prompt_too_long bypasses', async () => {
    const parent = await queue.add(
      'subagent', { prompt: 'long', no_self_fix: true },
      {}, { allowProtectedSubmit: true },
    );
    const decision = await decideSelfFix(
      engine,
      parent.id,
      { prompt: 'long', no_self_fix: true },
      'prompt is too long: 1.8M tokens',
    );
    expect(decision.should_fix).toBe(false);
    expect(decision.reason).toBe('no_self_fix_flag_on_job');
  });

  test('chain depth cap (default=2): grandchild self-fix refused', async () => {
    // root -> sf-child-1 -> sf-child-2 → next attempt blocked
    const root = await queue.add('subagent', { prompt: 'r' }, {}, { allowProtectedSubmit: true });
    const c1 = await queue.add(
      'subagent', { prompt: 'c1', is_self_fix_child: true },
      { parent_job_id: root.id }, { allowProtectedSubmit: true },
    );
    const c2 = await queue.add(
      'subagent', { prompt: 'c2', is_self_fix_child: true },
      { parent_job_id: c1.id }, { allowProtectedSubmit: true },
    );
    const decision = await decideSelfFix(
      engine, c2.id, { prompt: 'c2', is_self_fix_child: true }, 'prompt is too long',
    );
    expect(decision.should_fix).toBe(false);
    expect(decision.reason).toContain('max_depth_reached');
  });
});

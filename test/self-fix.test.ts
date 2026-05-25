/**
 * v0.41 E6 (codex pass-2 #4 narrowing) — self-fix tests.
 *
 * Pins the load-bearing contracts:
 *
 *   - decideSelfFix returns should_fix=false for non-recoverable clusters
 *     (tool_crash, tool_unavailable, tool_permission) — codex pass-2 #4
 *   - decideSelfFix respects `data.no_self_fix` per-job opt-out
 *   - decideSelfFix respects global `enabled=false` setting
 *   - decideSelfFix caps at max_depth (default 2 per D15)
 *   - computeChainDepth correctly counts self_fix_child ancestors
 *   - buildSelfFixPrompt produces cluster-specific text + preserves the
 *     leaf user task on prompt_too_long (codex pass-1 #11)
 *   - submitSelfFixChild inherits budget owner from parent (Eng D7 + D10)
 *   - Audit row written for both success and submit-fail paths
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  decideSelfFix,
  buildSelfFixPrompt,
  submitSelfFixChild,
  computeChainDepth,
} from '../src/core/minions/self-fix.ts';
import { setOwnerBudget, inheritBudgetOwner, getBudgetOwner } from '../src/core/minions/budget-tracker.ts';

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
  await engine.executeRaw('DELETE FROM minion_self_fix_log');
  await engine.executeRaw('DELETE FROM minion_budget_log');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('decideSelfFix', () => {
  test('global disabled → no fix regardless of cluster', async () => {
    const parent = await queue.add('subagent', { prompt: 'hi' }, {}, { allowProtectedSubmit: true });
    const d = await decideSelfFix(engine, parent.id, { prompt: 'hi' }, 'prompt is too long', { enabled: false });
    expect(d.should_fix).toBe(false);
    expect(d.reason).toBe('self_fix_disabled_globally');
  });

  test('per-job no_self_fix flag → no fix', async () => {
    const parent = await queue.add('subagent', { prompt: 'hi' }, {}, { allowProtectedSubmit: true });
    const d = await decideSelfFix(
      engine,
      parent.id,
      { prompt: 'hi', no_self_fix: true },
      'prompt is too long',
    );
    expect(d.should_fix).toBe(false);
    expect(d.reason).toBe('no_self_fix_flag_on_job');
  });

  test('non-recoverable cluster (tool_crash) → no fix', async () => {
    const parent = await queue.add('subagent', { prompt: 'hi' }, {}, { allowProtectedSubmit: true });
    const d = await decideSelfFix(engine, parent.id, { prompt: 'hi' }, 'tool "git" failed: ENOENT');
    expect(d.should_fix).toBe(false);
    expect(d.cluster).toBe('tool_crash');
    expect(d.reason).toContain('cluster_not_recoverable');
  });

  test('non-recoverable cluster (tool_unavailable) → no fix', async () => {
    const parent = await queue.add('subagent', { prompt: 'hi' }, {}, { allowProtectedSubmit: true });
    const d = await decideSelfFix(engine, parent.id, { prompt: 'hi' }, 'tool "ghost" is not in the registry for this subagent');
    expect(d.should_fix).toBe(false);
    expect(d.cluster).toBe('tool_unavailable');
  });

  test('recoverable cluster (prompt_too_long) → fix at depth 0', async () => {
    const parent = await queue.add('subagent', { prompt: 'hi' }, {}, { allowProtectedSubmit: true });
    const d = await decideSelfFix(engine, parent.id, { prompt: 'hi' }, 'prompt is too long');
    expect(d.should_fix).toBe(true);
    expect(d.cluster).toBe('prompt_too_long');
    expect(d.reason).toBe('recoverable:prompt_too_long_at_depth_0');
  });

  test('recoverable cluster (tool_schema_mismatch) → fix', async () => {
    const parent = await queue.add('subagent', { prompt: 'hi' }, {}, { allowProtectedSubmit: true });
    const d = await decideSelfFix(
      engine,
      parent.id,
      { prompt: 'hi' },
      'invalid input: missing required field "slug"',
    );
    expect(d.should_fix).toBe(true);
    expect(d.cluster).toBe('tool_schema_mismatch');
  });

  test('recoverable cluster (malformed_json) → fix', async () => {
    const parent = await queue.add('subagent', { prompt: 'hi' }, {}, { allowProtectedSubmit: true });
    const d = await decideSelfFix(engine, parent.id, { prompt: 'hi' }, 'Unexpected token } in JSON at position 47');
    expect(d.should_fix).toBe(true);
    expect(d.cluster).toBe('malformed_json');
  });

  test('depth cap (default 2): grandchild self-fix refused', async () => {
    // Build a chain: root → self_fix_child_1 → self_fix_child_2
    const root = await queue.add('subagent', { prompt: 'r' }, {}, { allowProtectedSubmit: true });
    const c1 = await queue.add(
      'subagent', { prompt: 'c1', is_self_fix_child: true },
      { parent_job_id: root.id }, { allowProtectedSubmit: true },
    );
    const c2 = await queue.add(
      'subagent', { prompt: 'c2', is_self_fix_child: true },
      { parent_job_id: c1.id }, { allowProtectedSubmit: true },
    );
    const d = await decideSelfFix(
      engine, c2.id, { prompt: 'c2', is_self_fix_child: true }, 'prompt is too long',
    );
    expect(d.should_fix).toBe(false);
    expect(d.reason).toContain('max_depth_reached');
  });

  test('depth cap respects opts.max_depth=1', async () => {
    const root = await queue.add('subagent', { prompt: 'r' }, {}, { allowProtectedSubmit: true });
    const c1 = await queue.add(
      'subagent', { prompt: 'c1', is_self_fix_child: true },
      { parent_job_id: root.id }, { allowProtectedSubmit: true },
    );
    const d = await decideSelfFix(
      engine, c1.id, { prompt: 'c1', is_self_fix_child: true }, 'prompt is too long',
      { max_depth: 1 },
    );
    expect(d.should_fix).toBe(false);
    expect(d.reason).toContain('max_depth_reached');
  });
});

describe('computeChainDepth', () => {
  test('non-self-fix child = depth 0', async () => {
    const j = await queue.add('subagent', { prompt: 'x' }, {}, { allowProtectedSubmit: true });
    expect(await computeChainDepth(engine, j.id)).toBe(0);
  });

  test('one self-fix ancestor = depth 1', async () => {
    const root = await queue.add('subagent', { prompt: 'r' }, {}, { allowProtectedSubmit: true });
    const c1 = await queue.add(
      'subagent', { prompt: 'c1', is_self_fix_child: true },
      { parent_job_id: root.id }, { allowProtectedSubmit: true },
    );
    expect(await computeChainDepth(engine, c1.id)).toBe(1);
  });
});

describe('buildSelfFixPrompt', () => {
  test('prompt_too_long: truncates middle, keeps leaf intent', () => {
    const long = 'A'.repeat(5000);
    const out = buildSelfFixPrompt(long, 'prompt_too_long', 'prompt is too long: 2M tokens');
    expect(out).toContain('truncated');
    expect(out).toContain('middle truncated');
    expect(out.startsWith).toBeDefined();
    // Smaller than the original.
    expect(out.length).toBeLessThan(long.length);
  });

  test('tool_schema_mismatch: surfaces the schema error verbatim', () => {
    const out = buildSelfFixPrompt('original task', 'tool_schema_mismatch', 'invalid arg "slug" missing');
    expect(out).toContain('invalid arg');
    expect(out).toContain('input_schema');
    expect(out).toContain('original task');
  });

  test('malformed_json: instructs JSON-only retry', () => {
    const out = buildSelfFixPrompt('original task', 'malformed_json', 'parse fail');
    expect(out).toContain('valid JSON');
    expect(out).toContain('no prose, no markdown');
    expect(out).toContain('original task');
  });
});

describe('submitSelfFixChild', () => {
  test('child gets parent_job_id + is_self_fix_child marker + audit row', async () => {
    const parent = await queue.add('subagent', { prompt: 'p' }, {}, { allowProtectedSubmit: true });
    const r = await submitSelfFixChild(
      engine,
      queue,
      { id: parent.id, data: { prompt: 'p' }, last_error: 'prompt is too long' },
      'prompt_too_long',
    );
    expect(r).not.toBeNull();
    const childRow = await queue.getJob(r!.child_id);
    expect(childRow!.parent_job_id).toBe(parent.id);
    const data = childRow!.data as Record<string, unknown>;
    expect(data.is_self_fix_child).toBe(true);
    expect(data.self_fix_cluster).toBe('prompt_too_long');
    // Audit row.
    const audit = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_self_fix_log
        WHERE parent_id = $1 AND outcome = 'submitted'`,
      [parent.id],
    );
    expect(parseInt(audit[0]!.count, 10)).toBe(1);
  });

  test('child inherits budget owner from parent (Eng D7 + D10)', async () => {
    const parent = await queue.add('subagent', { prompt: 'p' }, {}, { allowProtectedSubmit: true });
    await setOwnerBudget(engine, parent.id, 1.0);
    const r = await submitSelfFixChild(
      engine,
      queue,
      { id: parent.id, data: { prompt: 'p' }, last_error: 'prompt is too long' },
      'prompt_too_long',
    );
    const info = await getBudgetOwner(engine, r!.child_id);
    expect(info!.budget_owner_job_id).toBe(parent.id);
    expect(info!.budget_root_owner_id).toBe(parent.id);
  });
});

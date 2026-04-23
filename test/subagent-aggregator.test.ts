/**
 * subagent_aggregator handler tests.
 *
 * The handler's contract is:
 *   - read child_done messages from the inbox (already posted by Lane 1B's
 *     queue changes on every terminal child transition)
 *   - render a markdown summary
 *   - return {children, summary, markdown}
 *
 * Tests use a synthetic MinionJobContext that serves a scripted inbox,
 * tracks progress/log writes, and records them so assertions can check
 * that the handler does the right bookkeeping.
 */

import { describe, test, expect } from 'bun:test';
import {
  subagentAggregatorHandler,
  __testing,
} from '../src/core/minions/handlers/subagent-aggregator.ts';
import type { MinionJobContext, ChildDoneMessage, InboxMessage, ChildOutcome } from '../src/core/minions/types.ts';

function ctxWithInbox(
  jobId: number,
  data: Record<string, unknown>,
  inbox: ChildDoneMessage[],
): MinionJobContext & { _progress: unknown[]; _logs: string[] } {
  const progress: unknown[] = [];
  const logs: string[] = [];
  const inboxMessages: InboxMessage[] = inbox.map((payload, i) => ({
    id: i + 1,
    job_id: jobId,
    sender: 'minions',
    payload: payload as unknown,
    sent_at: new Date(),
    read_at: null,
  }));
  const ctx = {
    id: jobId,
    name: 'subagent_aggregator',
    data,
    attempts_made: 0,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    async updateProgress(p: unknown) { progress.push(p); },
    async updateTokens() {},
    async log(m: string | unknown) { logs.push(typeof m === 'string' ? m : JSON.stringify(m)); },
    async isActive() { return true; },
    async readInbox() { return inboxMessages; },
    _progress: progress,
    _logs: logs,
  };
  return ctx as MinionJobContext & { _progress: unknown[]; _logs: string[] };
}

function done(child_id: number, outcome: ChildOutcome, overrides: Partial<ChildDoneMessage> = {}): ChildDoneMessage {
  return {
    type: 'child_done',
    child_id,
    job_name: `child_${child_id}`,
    result: overrides.result !== undefined ? overrides.result : (outcome === 'complete' ? { ok: true } : null),
    outcome,
    error: overrides.error ?? (outcome === 'complete' ? null : `${outcome}`),
  };
}

describe('subagent_aggregator happy paths', () => {
  test('empty children_ids returns no-children marker', async () => {
    const ctx = ctxWithInbox(1, {}, []);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.children).toEqual([]);
    expect(res.markdown).toContain('_(no children)_');
  });

  test('all children succeed → complete count + bracketed results', async () => {
    const ctx = ctxWithInbox(1, { children_ids: [10, 11] }, [
      done(10, 'complete', { result: { finding: 'a' } }),
      done(11, 'complete', { result: { finding: 'b' } }),
    ]);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.children.length).toBe(2);
    expect(res.summary.complete).toBe(2);
    expect(res.summary.failed).toBe(0);
    expect(res.markdown).toContain('## child 10');
    expect(res.markdown).toContain('"finding": "a"');
  });

  test('mixed outcomes tallied correctly', async () => {
    const ctx = ctxWithInbox(1, { children_ids: [1, 2, 3, 4] }, [
      done(1, 'complete'),
      done(2, 'failed', { error: 'boom' }),
      done(3, 'cancelled'),
      done(4, 'timeout'),
    ]);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.summary).toEqual({ complete: 1, failed: 1, dead: 0, cancelled: 1, timeout: 1 });
    expect(res.markdown).toContain('child 2');
    expect(res.markdown).toContain('error: boom');
  });

  test('result is null for non-complete outcomes (no leaked payload)', async () => {
    const ctx = ctxWithInbox(1, { children_ids: [42] }, [
      done(42, 'failed', { result: 'should-be-suppressed', error: 'x' }),
    ]);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.children[0]!.result).toBeNull();
  });

  test('missing child_done is counted as failed with clear error', async () => {
    const ctx = ctxWithInbox(1, { children_ids: [10, 11] }, [done(10, 'complete')]);
    const res = await subagentAggregatorHandler(ctx);
    const missing = res.children.find(c => c.child_id === 11);
    expect(missing?.outcome).toBe('failed');
    expect(missing?.error).toContain('no child_done message observed');
    expect(res.summary.failed).toBe(1);
  });

  test('preserves children_ids order in the output', async () => {
    const ctx = ctxWithInbox(1, { children_ids: [3, 1, 2] }, [
      done(1, 'complete'),
      done(2, 'complete'),
      done(3, 'complete'),
    ]);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.children.map(c => c.child_id)).toEqual([3, 1, 2]);
  });

  test('custom aggregate_prompt_template becomes the markdown header', async () => {
    const ctx = ctxWithInbox(1, {
      children_ids: [1],
      aggregate_prompt_template: '# My synthesis of the shard runs',
    }, [done(1, 'complete')]);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.markdown.startsWith('# My synthesis of the shard runs')).toBe(true);
  });

  test('updateProgress + log emit once per run', async () => {
    const ctx = ctxWithInbox(1, { children_ids: [1, 2] }, [done(1, 'complete'), done(2, 'complete')]);
    await subagentAggregatorHandler(ctx);
    expect(ctx._progress.length).toBe(1);
    expect(ctx._logs.length).toBe(1);
    expect(ctx._logs[0]).toContain('aggregated 2 children');
  });
});

describe('subagent_aggregator payload parsing', () => {
  test('handles stringified child_done payloads (from JSONB fetch)', async () => {
    const ctx = ctxWithInbox(1, { children_ids: [5] }, [
      // Simulate a stringified payload (PG returns JSONB as string in some paths).
      JSON.parse(JSON.stringify(done(5, 'complete'))) as ChildDoneMessage,
    ]);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.summary.complete).toBe(1);
  });

  test('ignores non-child_done inbox messages', async () => {
    const inboxHybrid = [
      done(1, 'complete'),
      // unrelated payload (e.g. from a future message type)
      { type: 'ping', echo: 'nope' } as unknown as ChildDoneMessage,
    ];
    const ctx = ctxWithInbox(1, { children_ids: [1] }, inboxHybrid);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.summary.complete).toBe(1);
  });

  test('falls back to complete when outcome field is absent (legacy writer)', async () => {
    const legacy: ChildDoneMessage = {
      type: 'child_done', child_id: 99, job_name: 'legacy', result: { ok: true },
    };
    const ctx = ctxWithInbox(1, { children_ids: [99] }, [legacy]);
    const res = await subagentAggregatorHandler(ctx);
    expect(res.children[0]!.outcome).toBe('complete');
  });
});

describe('internal helpers', () => {
  test('formatSummary skips zero counts', () => {
    const s = __testing.emptySummary();
    s.complete = 3;
    s.failed = 1;
    expect(__testing.formatSummary(s)).toBe('complete=3, failed=1');
  });

  test('parseChildDone rejects obviously-bogus payloads', () => {
    expect(__testing.parseChildDone(null)).toBeNull();
    expect(__testing.parseChildDone({ type: 'not_child_done' })).toBeNull();
    expect(__testing.parseChildDone({ type: 'child_done' })).toBeNull(); // missing child_id
    expect(__testing.parseChildDone('not json')).toBeNull();
  });
});

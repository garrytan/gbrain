/**
 * #5584 — reflect fails loud instead of silently proposing zero edits.
 *
 * Pins, through the real runReflect / runOneShotRewrite with a stubbed chat:
 *   - the output cap is threaded (Claude 5 32000, non-thinking 4096, explicit
 *     override sent verbatim even below the default);
 *   - each reflect call yields edits, a deliberate empty, or EXACTLY ONE error
 *     with the documented precedence (truncated > empty_reply >
 *     no_parseable_edits > invalid_edits), fenced empty is deliberate;
 *   - context budgeting (whole 33 KB body for a 1M window, disclosure +
 *     truncation record when it cannot fit, context_too_small with zero calls,
 *     provider context errors mapped, bounded rejected history, unknown window);
 *   - one-shot guards (length stop, cap too small, truncated body) never
 *     return a body and never call chat when refusing;
 *   - budget exhaustion is rethrown, never converted to a reflect error.
 */

import { describe, expect, test } from 'bun:test';
import { runReflect, runOneShotRewrite } from '../../src/core/skillopt/reflect.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { ScoredRollout } from '../../src/core/skillopt/types.ts';

const THINKING = 'anthropic:claude-fable-5-1'; // 1M window, thinking
const PLAIN = 'anthropic:claude-opus-4-7'; // 1M window, non-thinking
const SMALL_WINDOW = 'anthropic:claude-sonnet-4-6'; // 200k window
const UNKNOWN_WINDOW = 'stub:unregistered-model';

type ChatFn = NonNullable<Parameters<typeof runReflect>[0]['chatFn']>;

function scored(id: string, score: number): ScoredRollout {
  return {
    trajectory: {
      task_id: id, task: `Task ${id}`, final_text: `output ${id}`, tool_calls: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      turns: 1, stop_reason: 'end', duration_ms: 1,
    },
    score,
  };
}

function reply(text: string, stopReason: ChatResult['stopReason'] = 'end', outputTokens = 20): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason,
    usage: { input_tokens: 100, output_tokens: outputTokens, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: PLAIN, providerId: 'anthropic',
  };
}

function recorder(fn: (opts: ChatOpts) => ChatResult | Promise<ChatResult>): { chatFn: ChatFn; calls: ChatOpts[] } {
  const calls: ChatOpts[] = [];
  return { calls, chatFn: (async (opts: ChatOpts) => { calls.push(opts); return fn(opts); }) as ChatFn };
}

const userMsg = (o: ChatOpts): string => o.messages[0]!.content as string;

const FAILURE_ONLY = { successes: [] as ScoredRollout[], failures: [scored('f', 0)], rejected: [] };
const EDIT = { op: 'add', anchor: 'People', content: 'More.' };

describe('reflect output cap', () => {
  test('Claude 5 optimizer defaults to 32000; non-thinking to 4096; explicit override verbatim', async () => {
    for (const [model, maxTokens, expected] of [[THINKING, undefined, 32000], [PLAIN, undefined, 4096], [THINKING, 1000, 1000]] as const) {
      const r = recorder(() => reply('{"edits":[]}'));
      await runReflect({ skillBodyText: '# S', ...FAILURE_ONLY, optimizerModel: model, ...(maxTokens ? { maxTokens } : {}), chatFn: r.chatFn });
      expect(r.calls[0]!.maxTokens).toBe(expected);
    }
  });
});

describe('reflect reply classification (exactly one error per call)', () => {
  async function classify(text: string, stop: ChatResult['stopReason'] = 'end') {
    const r = recorder(() => reply(text, stop, 777));
    return runReflect({ skillBodyText: '# S\n## People\n', ...FAILURE_ONLY, optimizerModel: PLAIN, chatFn: r.chatFn });
  }

  test('length stop mid-JSON -> one truncated error naming tokens + cap', async () => {
    const res = await classify('{"edits":[{"op":"add",', 'length');
    expect(res.errors).toEqual(['reflect_failure_truncated: 777 output tokens, max_tokens=4096']);
    expect(res.failureEdits).toEqual([]);
    expect(res.calls).toBe(1);
    expect(res.usableReplies).toBe(0);
  });

  test('length stop drops even parseable edits (the array may be cut short)', async () => {
    const res = await classify(JSON.stringify({ edits: [EDIT] }), 'length');
    expect(res.failureEdits).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toStartWith('reflect_failure_truncated');
  });

  test('length stop + all-invalid edits -> truncated wins (one error)', async () => {
    const res = await classify(JSON.stringify({ edits: [{ op: 'bogus' }] }), 'length');
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toStartWith('reflect_failure_truncated');
  });

  test('empty / whitespace reply -> empty_reply', async () => {
    const res = await classify('   \n ');
    expect(res.errors).toEqual(['reflect_failure_empty_reply: stop=end']);
    expect(res.usableReplies).toBe(0);
  });

  test('prose with no edits array -> no_parseable_edits', async () => {
    const res = await classify('I think the skill is fine as it is.');
    expect(res.errors).toEqual(['reflect_failure_no_parseable_edits: 777 output tokens, stop=end']);
  });

  test('every proposed edit invalid -> invalid_edits', async () => {
    const res = await classify(JSON.stringify({ edits: [{ op: 'add' }, { op: 'rename', target: 'x' }] }));
    expect(res.errors).toEqual(['reflect_failure_invalid_edits: 2 proposed, 0 valid']);
  });

  test('partial drop -> no error, valid edits kept, dropped count reported', async () => {
    const res = await classify(JSON.stringify({ edits: [EDIT, { op: 'add' }] }));
    expect(res.errors).toEqual([]);
    expect(res.failureEdits).toHaveLength(1);
    expect(res.invalidEditsDropped).toBe(1);
    expect(res.usableReplies).toBe(1);
  });

  test('deliberate {"edits": []} and its fenced form are silent + usable', async () => {
    for (const text of ['{"edits": []}', '```json\n{"edits": []}\n```']) {
      const res = await classify(text);
      expect(res.errors).toEqual([]);
      expect(res.usableReplies).toBe(1);
      expect(res.calls).toBe(1);
    }
  });

  test('both modes errored -> two errors, zero usable replies', async () => {
    const r = recorder(() => reply('nope'));
    const res = await runReflect({ skillBodyText: '# S', successes: [scored('s', 1)], failures: [scored('f', 0)], rejected: [], optimizerModel: PLAIN, chatFn: r.chatFn });
    expect(res.calls).toBe(2);
    expect(res.usableReplies).toBe(0);
    expect(res.errors.map((e) => e.split(':')[0])).toEqual(['reflect_failure_no_parseable_edits', 'reflect_success_no_parseable_edits']);
  });
});

describe('reflect context budgeting', () => {
  const BIG_BODY = '# Skill\n' + 'x'.repeat(33_000) + '\nTAIL-MARKER';

  test('33 KB body is sent whole to a 1M-context optimizer', async () => {
    const r = recorder(() => reply('{"edits":[]}'));
    const res = await runReflect({ skillBodyText: BIG_BODY, ...FAILURE_ONLY, optimizerModel: PLAIN, chatFn: r.chatFn });
    expect(userMsg(r.calls[0]!)).toContain('TAIL-MARKER');
    expect(userMsg(r.calls[0]!)).not.toContain('skill body truncated');
    expect(res.skillBodyTruncated).toBeUndefined();
  });

  test('body that cannot fit is truncated WITH disclosure + truncation record', async () => {
    const r = recorder(() => reply('{"edits":[]}'));
    // 200k window minus a 190k output cap leaves ~10k tokens (~30k chars) of room.
    const res = await runReflect({ skillBodyText: BIG_BODY, ...FAILURE_ONLY, optimizerModel: SMALL_WINDOW, maxTokens: 190_000, chatFn: r.chatFn });
    const msg = userMsg(r.calls[0]!);
    expect(msg).not.toContain('TAIL-MARKER');
    expect(res.skillBodyTruncated!.total_chars).toBe(BIG_BODY.length);
    expect(res.skillBodyTruncated!.sent_chars).toBeLessThan(BIG_BODY.length);
    expect(msg).toContain(`(skill body truncated: sent ${res.skillBodyTruncated!.sent_chars} of ${BIG_BODY.length} chars)`);
  });

  test('output cap larger than the window -> context_too_small, zero chat calls', async () => {
    const r = recorder(() => reply('{"edits":[]}'));
    const res = await runReflect({ skillBodyText: '# S', ...FAILURE_ONLY, optimizerModel: SMALL_WINDOW, maxTokens: 300_000, chatFn: r.chatFn });
    expect(r.calls).toHaveLength(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/^reflect_failure_context_too_small: need \d+, window 200000$/);
    expect(res.calls).toBe(1);
    expect(res.usableReplies).toBe(0);
  });

  test('unknown context window -> 120k-char body cap with disclosure', async () => {
    const r = recorder(() => reply('{"edits":[]}'));
    const huge = 'y'.repeat(130_000);
    const res = await runReflect({ skillBodyText: huge, ...FAILURE_ONLY, optimizerModel: UNKNOWN_WINDOW, chatFn: r.chatFn });
    expect(res.skillBodyTruncated).toEqual({ sent_chars: 120_000, total_chars: 130_000 });
    expect(userMsg(r.calls[0]!)).toContain('(skill body truncated: sent 120000 of 130000 chars)');
  });

  test('oversized rejected-edit history is bounded', async () => {
    const r = recorder(() => reply('{"edits":[]}'));
    const rejected = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`, skill_sha8: 'deadbeef', reason: 'validation_gate_below_baseline', ts: '2026-01-01T00:00:00Z',
      edits: [{ op: 'add' as const, anchor: 'A', content: 'z'.repeat(5000) }],
    }));
    await runReflect({ skillBodyText: '# S', successes: [], failures: [scored('f', 0)], rejected, optimizerModel: PLAIN, chatFn: r.chatFn });
    const msg = userMsg(r.calls[0]!);
    expect(msg).toContain('PREVIOUSLY REJECTED EDITS');
    expect(msg.length).toBeLessThan(10_000);
  });

  test('provider context-length rejection -> context_overflow', async () => {
    const r = recorder(() => { throw new Error('prompt is too long: 1707509 tokens > 1000000 maximum'); });
    const res = await runReflect({ skillBodyText: '# S', ...FAILURE_ONLY, optimizerModel: PLAIN, chatFn: r.chatFn });
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toStartWith('reflect_failure_context_overflow: prompt is too long');
  });
});

describe('reflect must-abort rethrow', () => {
  const exhausted = () => new BudgetExhausted('skillopt:x: projected cost $2 exceeds --max-cost $1.00', { reason: 'cost', spent: 0.5, cap: 1 });

  test('BudgetExhausted from the optimizer call propagates (not a reflect error)', async () => {
    const r = recorder(() => { throw exhausted(); });
    await expect(runReflect({ skillBodyText: '# S', ...FAILURE_ONLY, optimizerModel: PLAIN, chatFn: r.chatFn })).rejects.toBeInstanceOf(BudgetExhausted);
  });

  test('exhaustion after one successful reflect call still propagates', async () => {
    let n = 0;
    const r = recorder(() => { n += 1; if (n === 2) throw exhausted(); return reply(JSON.stringify({ edits: [EDIT] })); });
    await expect(runReflect({ skillBodyText: '# S\n## People\n', successes: [scored('s', 1)], failures: [scored('f', 0)], rejected: [], optimizerModel: PLAIN, chatFn: r.chatFn }))
      .rejects.toBeInstanceOf(BudgetExhausted);
    expect(r.calls).toHaveLength(2);
  });

  test('runtime-deadline error propagates', async () => {
    const r = recorder(() => { throw new Error('skillopt_runtime_exceeded'); });
    await expect(runReflect({ skillBodyText: '# S', ...FAILURE_ONLY, optimizerModel: PLAIN, chatFn: r.chatFn })).rejects.toThrow('skillopt_runtime_exceeded');
  });
});

describe('one-shot rewrite guards', () => {
  const BASE = { successes: [] as ScoredRollout[], failures: [scored('f', 0)], rejected: [], optimizerModel: PLAIN };

  test('length stop -> one_shot_rewrite_truncated, no body returned', async () => {
    const r = recorder(() => reply('# Skill\n## People\nhalf a rewr', 'length', 4096));
    const res = await runOneShotRewrite({ ...BASE, skillBodyText: '# Skill', chatFn: r.chatFn });
    expect(res.newBody).toBe('');
    expect(res.error).toBe('one_shot_rewrite_truncated: 4096 output tokens, max_tokens=4096');
  });

  test('body too large for the cap -> refuses without calling chat', async () => {
    const r = recorder(() => reply('# never'));
    const res = await runOneShotRewrite({ ...BASE, skillBodyText: 'b'.repeat(33_000), chatFn: r.chatFn });
    expect(r.calls).toHaveLength(0);
    expect(res.newBody).toBe('');
    expect(res.error).toBe('one_shot_rewrite_output_cap_too_small: need ~12024 tokens, cap 4096; set skillopt.reflect_max_tokens');
  });

  test('truncated body -> refuses (one_shot_rewrite_body_truncated) without calling chat', async () => {
    const r = recorder(() => reply('# never'));
    const res = await runOneShotRewrite({ ...BASE, optimizerModel: UNKNOWN_WINDOW, maxTokens: 100_000, skillBodyText: 'b'.repeat(130_000), chatFn: r.chatFn });
    expect(r.calls).toHaveLength(0);
    expect(res.error).toBe('one_shot_rewrite_body_truncated: sent 120000 of 130000 chars');
  });

  test('empty reply -> one_shot_rewrite_empty_reply', async () => {
    const r = recorder(() => reply('  '));
    const res = await runOneShotRewrite({ ...BASE, skillBodyText: '# Skill', chatFn: r.chatFn });
    expect(res.error).toBe('one_shot_rewrite_empty_reply: stop=end');
  });

  test('cap threaded from opts and BudgetExhausted rethrown', async () => {
    const ok = recorder(() => reply('# Skill\n## People\n'));
    await runOneShotRewrite({ ...BASE, skillBodyText: '# Skill', maxTokens: 5000, chatFn: ok.chatFn });
    expect(ok.calls[0]!.maxTokens).toBe(5000);
    const boom = recorder(() => { throw new BudgetExhausted('cap', { reason: 'cost', spent: 0, cap: 1 }); });
    await expect(runOneShotRewrite({ ...BASE, skillBodyText: '# Skill', chatFn: boom.chatFn })).rejects.toBeInstanceOf(BudgetExhausted);
  });
});

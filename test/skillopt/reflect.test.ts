/**
 * SkillOpt reflect unit tests.
 *
 * Pinned regressions:
 *   - parseEditsResponse must NOT route through parseJudgeJson (which checks
 *     for a 'score' key and silently drops all optimizer output that has
 *     'edits' instead). v0.42.0.0 shipped with that bug; every optimizer
 *     call produced zero edits and the orchestrator could never accept
 *     anything. Fixed v0.42.0.1 by dropping the wrong-typed guard.
 *
 *   - runReflect must call FAILURE/SUCCESS reflect modes only when their
 *     batches are non-empty (D7 paper-faithful semantics).
 *
 *   - Token-usage accumulation across the two reflect calls must be additive.
 *
 *   - Errors in one mode (e.g. failure-reflect throws) must NOT swallow the
 *     other mode's edits.
 */

import { describe, expect, test } from 'bun:test';
import { parseEditsResponse, runReflect } from '../../src/core/skillopt/reflect.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { ScoredRollout, Trajectory } from '../../src/core/skillopt/types.ts';

// ─── parseEditsResponse ─────────────────────────────────────────────────────

describe('parseEditsResponse', () => {
  test('parses minimal {edits: [...]} shape', () => {
    const out = parseEditsResponse(
      JSON.stringify({ edits: [{ op: 'add', anchor: 'People', content: 'X', reason: 'r' }] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ op: 'add', anchor: 'People', content: 'X', reason: 'r' });
  });

  test('REGRESSION v0.42.0.1: edits-only JSON survives the parser', () => {
    // Pre-fix this returned [] because parseJudgeJson required a 'score' key.
    // If this regresses, every optimizer call silently produces zero edits.
    const out = parseEditsResponse('{"edits":[{"op":"delete","target":"foo","reason":"r"}]}');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ op: 'delete', target: 'foo' });
  });

  test('strips ```json``` fences', () => {
    const out = parseEditsResponse(
      '```json\n{"edits":[{"op":"replace","target":"x","replacement":"y"}]}\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ op: 'replace', target: 'x', replacement: 'y' });
  });

  test('extracts first {...} from prose-wrapped output', () => {
    const out = parseEditsResponse(
      'Here is the edit: {"edits":[{"op":"add","anchor":"H","content":"C"}]} hope this helps',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ op: 'add', anchor: 'H', content: 'C' });
  });

  test('contract scope: trailing-comma repair is NOT supported by tryExtractEdits', () => {
    // Documented limitation: trailing commas in optimizer JSON break parsing.
    // The optimizer prompt forbids them; if the model emits one anyway we lose
    // the batch this call. Tightening this would mean folding the repair pass
    // from parseJudgeJson back in — currently out of scope. Pin the limitation
    // so a future tightening intentionally lights this test up.
    const out = parseEditsResponse('{"edits":[{"op":"add","anchor":"H","content":"C",},]}');
    expect(out).toEqual([]);
  });

  test('returns [] for malformed JSON without throwing', () => {
    expect(parseEditsResponse('{not valid json at all')).toEqual([]);
    expect(parseEditsResponse('')).toEqual([]);
    expect(parseEditsResponse('   ')).toEqual([]);
    expect(parseEditsResponse('plain prose no braces')).toEqual([]);
  });

  test('returns [] when edits key is absent or wrong type', () => {
    expect(parseEditsResponse('{"score": 0.8}')).toEqual([]);
    expect(parseEditsResponse('{"edits": "not an array"}')).toEqual([]);
    expect(parseEditsResponse('{"edits": null}')).toEqual([]);
  });

  test('drops malformed individual edits but keeps valid ones', () => {
    const out = parseEditsResponse(JSON.stringify({
      edits: [
        { op: 'add', anchor: 'H', content: 'C' },           // valid
        { op: 'add' },                                       // missing anchor + content
        { op: 'delete', target: 'T' },                       // valid
        { op: 'replace', target: 'T' },                      // missing replacement
        { op: 'invalid_op', anchor: 'X', content: 'Y' },     // unknown op
        null,                                                 // garbage
        'string',                                             // garbage
      ],
    }));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ op: 'add' });
    expect(out[1]).toMatchObject({ op: 'delete', target: 'T' });
  });

  test('caps reason to string-only (drops non-string reasons)', () => {
    const out = parseEditsResponse(JSON.stringify({
      edits: [{ op: 'add', anchor: 'H', content: 'C', reason: 42 }],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBeUndefined();
  });
});

// ─── runReflect ─────────────────────────────────────────────────────────────

function makeTrajectory(task_id: string, final_text: string): Trajectory {
  return {
    task_id,
    task: `Task ${task_id}`,
    final_text,
    tool_calls: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    turns: 1,
    stop_reason: 'end',
    duration_ms: 10,
  };
}

function makeScored(task_id: string, score: number, text = ''): ScoredRollout {
  return { trajectory: makeTrajectory(task_id, text), score };
}

function makeChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 5, cache_creation_tokens: 1 },
    model: 'anthropic:claude-opus-4-7',
    providerId: 'anthropic',
  };
}

describe('runReflect (D7 two-call contract)', () => {
  test('non-empty failures + non-empty successes: both modes fire, edits collected', async () => {
    const calls: Array<{ mode: 'failure' | 'success' }> = [];
    const chatFn = async (opts: ChatOpts): Promise<ChatResult> => {
      const isFailure = (opts.system ?? '').includes('FAILURE TRAJECTORIES');
      calls.push({ mode: isFailure ? 'failure' : 'success' });
      const edit = isFailure
        ? { op: 'add', anchor: 'Failures', content: 'C1' }
        : { op: 'add', anchor: 'Successes', content: 'C2' };
      return makeChatResult(JSON.stringify({ edits: [edit] }));
    };

    const result = await runReflect({
      skillBodyText: '# Test',
      successes: [makeScored('s-1', 1.0)],
      failures: [makeScored('f-1', 0.0)],
      rejected: [],
      optimizerModel: 'anthropic:claude-opus-4-7',
      chatFn,
    });

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.mode).sort()).toEqual(['failure', 'success']);
    expect(result.failureEdits).toHaveLength(1);
    expect(result.failureEdits[0]).toMatchObject({ anchor: 'Failures' });
    expect(result.successEdits).toHaveLength(1);
    expect(result.successEdits[0]).toMatchObject({ anchor: 'Successes' });
    // Token usage is additive across the two calls.
    expect(result.usage.input_tokens).toBe(200);
    expect(result.usage.output_tokens).toBe(40);
    expect(result.usage.cache_read_tokens).toBe(10);
    expect(result.usage.cache_creation_tokens).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  test('empty failures skips failure call; non-empty successes still fires success', async () => {
    const callModes: string[] = [];
    const chatFn = async (opts: ChatOpts): Promise<ChatResult> => {
      callModes.push((opts.system ?? '').includes('FAILURE') ? 'failure' : 'success');
      return makeChatResult(JSON.stringify({ edits: [{ op: 'delete', target: 'x' }] }));
    };

    const result = await runReflect({
      skillBodyText: '# Test',
      successes: [makeScored('s-1', 1.0)],
      failures: [],
      rejected: [],
      optimizerModel: 'anthropic:claude-opus-4-7',
      chatFn,
    });

    expect(callModes).toEqual(['success']);
    expect(result.failureEdits).toHaveLength(0);
    expect(result.successEdits).toHaveLength(1);
  });

  test('empty successes skips success call; non-empty failures still fires failure', async () => {
    const callModes: string[] = [];
    const chatFn = async (opts: ChatOpts): Promise<ChatResult> => {
      callModes.push((opts.system ?? '').includes('FAILURE') ? 'failure' : 'success');
      return makeChatResult(JSON.stringify({ edits: [{ op: 'add', anchor: 'H', content: 'C' }] }));
    };

    const result = await runReflect({
      skillBodyText: '# Test',
      successes: [],
      failures: [makeScored('f-1', 0.0)],
      rejected: [],
      optimizerModel: 'anthropic:claude-opus-4-7',
      chatFn,
    });

    expect(callModes).toEqual(['failure']);
    expect(result.failureEdits).toHaveLength(1);
    expect(result.successEdits).toHaveLength(0);
  });

  test('both empty: neither call fires (cost-conscious short-circuit)', async () => {
    let callCount = 0;
    const chatFn = async (): Promise<ChatResult> => {
      callCount += 1;
      return makeChatResult('{"edits":[]}');
    };

    const result = await runReflect({
      skillBodyText: '# Test',
      successes: [],
      failures: [],
      rejected: [],
      optimizerModel: 'anthropic:claude-opus-4-7',
      chatFn,
    });

    expect(callCount).toBe(0);
    expect(result.failureEdits).toHaveLength(0);
    expect(result.successEdits).toHaveLength(0);
  });

  test('one mode throws: error recorded, other mode still produces edits', async () => {
    const chatFn = async (opts: ChatOpts): Promise<ChatResult> => {
      const isFailure = (opts.system ?? '').includes('FAILURE');
      if (isFailure) throw new Error('rate_limit on failure call');
      return makeChatResult(JSON.stringify({ edits: [{ op: 'add', anchor: 'OK', content: 'C' }] }));
    };

    const result = await runReflect({
      skillBodyText: '# Test',
      successes: [makeScored('s-1', 1.0)],
      failures: [makeScored('f-1', 0.0)],
      rejected: [],
      optimizerModel: 'anthropic:claude-opus-4-7',
      chatFn,
    });

    expect(result.failureEdits).toEqual([]);
    expect(result.successEdits).toHaveLength(1);
    expect(result.successEdits[0]).toMatchObject({ anchor: 'OK' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('reflect_failure_failed');
    expect(result.errors[0]).toContain('rate_limit');
  });

  test('rejected-buffer context flows into the user message (anti-bias)', async () => {
    let observedUserMsg = '';
    const chatFn = async (opts: ChatOpts): Promise<ChatResult> => {
      const userMsg = opts.messages[0]?.content;
      if (typeof userMsg === 'string') observedUserMsg = userMsg;
      return makeChatResult('{"edits":[]}');
    };

    await runReflect({
      skillBodyText: '# Test',
      successes: [],
      failures: [makeScored('f-1', 0.0)],
      rejected: [
        {
          key: 'k1',
          skill_sha8: 'deadbeef',
          edits: [{ op: 'add', anchor: 'X', content: 'Y' }],
          reason: 'validation_gate_below_baseline',
          ts: '2026-01-01T00:00:00Z',
        },
      ],
      optimizerModel: 'anthropic:claude-opus-4-7',
      chatFn,
    });

    expect(observedUserMsg).toContain('PREVIOUSLY REJECTED EDITS');
    expect(observedUserMsg).toContain('validation_gate_below_baseline');
  });
});

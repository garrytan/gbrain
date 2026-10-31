/**
 * #7257 — the success-reflect call states the same edit schema as the
 * failure-reflect call. Its system prompt used to say only that the format is
 * "identical to the failure-reflect mode", a prompt that call never sends, so
 * the optimizer guessed field names (find/replace) and parseEdits dropped
 * every success-only edit.
 */
import { describe, expect, test } from 'bun:test';
import { runReflect } from '../../src/core/skillopt/reflect.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import type { ScoredRollout } from '../../src/core/skillopt/types.ts';

const MODEL = 'anthropic:claude-opus-4-7';
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

function reply(text: string): ChatResult {
  return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic' };
}

async function systemsFor(successes: ScoredRollout[], failures: ScoredRollout[]): Promise<string[]> {
  const systems: string[] = [];
  const chatFn = (async (opts: ChatOpts) => { systems.push(String(opts.system)); return reply('{"edits":[]}'); }) as ChatFn;
  await runReflect({ skillBodyText: '# S\n## People\n', successes, failures, rejected: [], optimizerModel: MODEL, chatFn });
  return systems;
}

const EDIT_OPS = /Edit ops:[\s\S]*?delete:[^\n]*\n/;

describe('#7257: both reflect modes send the edit schema', () => {
  test('a success-only batch sends the op and field names parseEdits accepts', async () => {
    const systems = await systemsFor([scored('s', 1)], []);
    expect(systems).toHaveLength(1);
    for (const field of ['"op"', '"anchor"', '"content"', '"target"', '"replacement"', '{"edits": [']) {
      expect(systems[0]).toContain(field);
    }
  });

  test('the success and failure prompts carry the identical output format and edit ops', async () => {
    const systems = await systemsFor([scored('s', 1)], [scored('f', 0)]);
    expect(systems).toHaveLength(2);
    const [failure, success] = systems.map(p => EDIT_OPS.exec(p)?.[0]);
    expect(failure).toBeDefined();
    expect(success).toBe(failure);
  });

  test('a success-only reply written in that schema parses into edits', async () => {
    const text = JSON.stringify({ edits: [{ op: 'replace', target: '## People', replacement: '## People and roles', reason: 'clearer' }] });
    const chatFn = (async () => reply(text)) as ChatFn;
    const res = await runReflect({ skillBodyText: '# S\n## People\n', successes: [scored('s', 1)], failures: [], rejected: [], optimizerModel: MODEL, chatFn });
    expect(res.successEdits).toHaveLength(1);
    expect(res.errors).toEqual([]);
  });
});

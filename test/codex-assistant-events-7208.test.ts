/** #7208: completed assistant events must survive archive + hook parsing once.
 * Wire fields pinned to openai/codex e6ebdfe00b520e21ed50ac0362656f32dd64d2fc,
 * codex-rs/protocol/src/{items,protocol}.rs. All conversation text is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter } from '../src/core/transcripts/codex.ts';
import { parseCodexHookTranscript } from '../src/core/transcripts/codex-hook-lane.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

let dir: string;
let engine: PGLiteEngine;
let sequence = 0;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-events-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});
const line = (type: string, payload: unknown) => ({ timestamp: '2026-10-21T10:00:01.000Z', type, payload });
const event = (type: string, fields: Record<string, unknown> = {}) => line('event_msg', { type, ...fields });
const user = (message = 'Check the synthetic release.') => event('user_message', { message });
const response = (text: string, id?: string) => line('response_item', {
  type: 'message', role: 'assistant', ...(id ? { id } : {}), content: [{ type: 'output_text', text }],
});
const item = (text: string, id = 'a1', turn_id = 't1') => event('item_completed', {
  turn_id, item: { type: 'AgentMessage', id, content: [{ type: 'text', text }] },
});
const agent = (message: string) => event('agent_message', { message });
const complete = (last_agent_message: string, turn_id = 't1') => event('task_complete', { turn_id, last_agent_message });
function rollout(rows: unknown[]): string {
  const path = join(dir, `rollout-${++sequence}.jsonl`);
  writeFileSync(path, [line('session_meta', { id: `events-${sequence}`, source: 'cli', timestamp: '2026-10-21T10:00:00.000Z' }), ...rows].map(row => JSON.stringify(row)).join('\n') + '\n');
  return path;
}
async function archive(path: string) {
  const gen = codexAdapter.parse(path);
  const sessions: ParsedSession[] = [];
  let next = await gen.next();
  while (!next.done) { sessions.push(next.value); next = await gen.next(); }
  return { sessions, diag: next.value };
}
async function both(rows: unknown[], expected: Array<[string, string]>) {
  const path = rollout(rows);
  const parsed = await archive(path);
  expect(parsed.sessions[0]?.messages.map(m => [m.role, m.text])).toEqual(expected);
  expect(parseCodexHookTranscript(path).turns.map(m => [m.role, m.text])).toEqual(expected);
  return { path, ...parsed };
}

describe('#7208 assistant completion encodings', () => {
  for (const [name, row] of [
    ['item_completed AgentMessage', item('The synthetic build passed.')],
    ['agent_message', agent('The synthetic build passed.')],
    ['task_complete last_agent_message', complete('The synthetic build passed.')],
    ['protocol Text content', event('item_completed', { turn_id: 't1', item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'The synthetic build passed.' }] } })],
  ] as const) {
    test(`keeps ${name} without a response_item`, async () => {
      const { sessions, diag } = await both([user(), row], [
        ['user', 'Check the synthetic release.'], ['assistant', 'The synthetic build passed.'],
      ]);
      expect(sessions[0]!.messages[1]!.timestamp).toBe('2026-10-21T10:00:01.000Z');
      expect(diag.userTurnsMissing).toBeUndefined();
    });
  }

  test('deduplicates dual encodings in either order and repeated terminal events, not distinct same-text items', async () => {
    for (const reverse of [false, true]) {
      const first = [response('Checking.', 'a1'), item('Checking.', 'a1'), agent('Checking.')];
      await both([user(), ...(reverse ? first.reverse() : first),
        response('Checking.', 'a2'), item('Checking.', 'a2'), agent('Checking.'),
        response('Passed.', 'a3'), item('Passed.', 'a3'), agent('Passed.'), complete('Passed.'), complete('Passed.'),
      ], [['user', 'Check the synthetic release.'], ['assistant', 'Checking.'], ['assistant', 'Checking.'], ['assistant', 'Passed.']]);
    }
  });

  test('same reply in a new turn survives, but a replay of the same item does not', async () => {
    await both([event('task_started', { turn_id: 't1' }), user(), item('OK', 'a1'), item('OK', 'a1'), complete('OK'),
      event('task_started', { turn_id: 't2' }), user(), item('OK', 'a2', 't2'), complete('OK', 't2'),
    ], [['user', 'Check the synthetic release.'], ['assistant', 'OK'], ['user', 'Check the synthetic release.'], ['assistant', 'OK']]);
  });

  test('does not promote deltas, reasoning, injected input, malformed items or empty terminal results', async () => {
    await both([user(), event('agent_message_delta', { delta: 'NEVER-ARCHIVE' }),
      event('item_started', { item: { type: 'AgentMessage', content: [{ type: 'text', text: 'NEVER-ARCHIVE' }] } }),
      event('item_completed', { item: { type: 'Reasoning', text: 'NEVER-ARCHIVE' } }),
      event('item_completed', { item: { type: 'AgentMessage', content: [{ type: 'image', text: 'NEVER-ARCHIVE' }] } }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'NEVER-ARCHIVE' }] }),
      event('agent_message', { message: {} }), complete(''), item('Actual reply.'),
    ], [['user', 'Check the synthetic release.'], ['assistant', 'Actual reply.']]);
  });

  test('late turn ids after legacy user events do not duplicate terminal echoes', async () => {
    await both([user('First'), response('OK'), complete('OK'),
      user('Second'), response('OK'), complete('OK', 't2'), complete('OK', 't2'),
    ], [['user', 'First'], ['assistant', 'OK'], ['user', 'Second'], ['assistant', 'OK']]);
  });

  test('assistant-only event rollouts still report missing user turns; failed user-only turns still import', async () => {
    const reply = await both([item('No user record.')], [['assistant', 'No user record.']]);
    expect(reply.diag.userTurnsMissing).toBe(true);
    const failed = await both([user(), event('task_complete', { turn_id: 't1', last_agent_message: null })], [['user', 'Check the synthetic release.']]);
    expect(failed.diag.userTurnsMissing).toBeUndefined();
  });

  test('hook tool and compaction indexes count deduplicated turns', async () => {
    const path = rollout([user(), response('Checking.', 'a1'), item('Checking.', 'a1'), agent('Checking.'),
      line('response_item', { type: 'function_call', name: 'test', arguments: '{}' }),
      line('compacted', {}), item('Done.', 'a2'), complete('Done.'),
    ]);
    const parsed = parseCodexHookTranscript(path, { collectToolCalls: true });
    expect(parsed.turns.map(t => t.text)).toEqual(['Check the synthetic release.', 'Checking.', 'Done.']);
    expect(parsed.genuineUserTurnIndexes).toEqual([0]);
    expect(parsed.toolCallTurnIndexes).toEqual([2]);
    expect(parsed.boundaryTurnIndexes).toEqual([2]);
  });

  test('real ingest stores a searchable assistant reply and unchanged retry does not duplicate it', async () => {
    const path = rollout([user(), item('The quasarfixture release passed.'), complete('The quasarfixture release passed.')]);
    const options = { paths: [path], sourceId: 'default', userPatternsPath: join(dir, 'no-patterns') };
    const first = await runTranscriptsIngest(engine, options);
    expect(first.sessionsImported).toBe(1);
    const page = await engine.getPage(first.slugsTouched[0]!, { sourceId: 'default' });
    expect(page!.compiled_truth.match(/The quasarfixture release passed\./g)).toHaveLength(1);
    const results = await engine.searchKeyword('quasarfixture', { sourceId: 'default' });
    expect(results.some(r => r.slug === first.slugsTouched[0])).toBe(true);
    const retry = await runTranscriptsIngest(engine, options);
    expect(retry.pages.imported).toBe(0);
    expect(retry.pages.skipped).toBe(1);
  });
});

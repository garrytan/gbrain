import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';
import { buildHermesClarifyFixture } from './helpers/hermes-clarify-fixture.ts';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'hermes-clarify-'));
  return buildHermesClarifyFixture(dir);
}
async function read(path: string): Promise<ParsedSession> {
  for await (const session of hermesAdapter.parse(path)) {
    if (session.meta.sessionId === 'clarify-session') return session;
  }
  throw new Error('missing synthetic session');
}
function changeResult(path: string, value: unknown, sql = '') {
  const db = new Database(path);
  try {
    db.prepare("UPDATE messages SET content = ? WHERE session_id = 'clarify-session' AND role = 'tool'")
      .run(typeof value === 'string' ? value : JSON.stringify(value));
    if (sql) db.exec(sql);
  } finally { db.close(); }
}
const answered = (user_response: unknown, extra = {}) => ({
  question: 'Which rollout?', choices_offered: ['Broad', 'Canary'], status: 'answered', user_response, ...extra,
});

describe('Hermes native clarification answers (#7396)', () => {
  test('imports selected single/multi values in order at the result instant, with native linkage', async () => {
    const session = await read(fixture());
    expect(session.messages.map(m => [m.role, m.text])).toEqual([
      ['user', 'Choose the widget rollout.'], ['user', 'Canary'], ['user', 'East\nWest'],
      ['assistant', 'The rollout is Canary in East and West.'],
    ]);
    expect(session.messages[1].timestamp).toBe(new Date(1786057201000).toISOString());
    expect(session.meta.raw).toMatchObject({
      clarify_0_tool_call_id: 'clarify-call', clarify_0_question: 'Which rollout?',
      clarify_0_original_role: 'tool', clarify_0_tool_name: 'clarify',
      clarify_0_message_index: 1, clarify_0_response_index: 0,
      clarify_1_message_index: 2, clarify_1_response_index: 1,
      clarify_1_selection_0: 'East', clarify_1_selection_1: 'West',
    });
    expect(typeof session.meta.raw!.clarify_0_message_id).toBe('number');
    expect(JSON.stringify(session)).not.toContain('North');
    expect(JSON.stringify(session)).not.toContain('Broad');
  });

  test('preserves exact typed Unicode/multiline answers, not the offered choices', async () => {
    const path = fixture();
    const answer = '  No — use the Canary.\nKeep 日本語 intact.  ';
    changeResult(path, { outcome: 'submitted', responses: [answered(answer)] });
    const session = await read(path);
    expect(session.messages[1].text).toBe(answer);
  });

  test.each(['cancelled', 'timed_out', 'undelivered', '', 'unknown'])('does not promote %s forms', async outcome => {
    const path = fixture();
    changeResult(path, { outcome, responses: [answered('NEVER-IMPORT')] });
    expect((await read(path)).messages).toHaveLength(2);
  });

  test('skips empty, skipped, unanswered and malformed entries without losing answered siblings', async () => {
    const path = fixture();
    changeResult(path, { outcome: 'submitted', responses: [
      answered('Canary'), answered('NO-SKIPPED', { status: 'skipped' }),
      answered('NO-UNANSWERED', { status: 'unanswered' }), answered('  '), answered([]),
      answered(['East', 42]), answered({ text: 'NO-OBJECT' }), null,
      answered('NO-QUESTION', { question: '' }),
    ] });
    const session = await read(path);
    expect(session.messages.map(m => m.text)).toEqual([
      'Choose the widget rollout.', 'Canary', 'The rollout is Canary in East and West.',
    ]);
  });

  test.each([
    "UPDATE messages SET tool_name = 'terminal' WHERE role = 'tool'",
    "UPDATE messages SET tool_call_id = 'unrelated-call' WHERE role = 'tool'",
    "UPDATE messages SET tool_calls = 'not-json' WHERE role = 'assistant'",
    "UPDATE messages SET tool_calls = replace(tool_calls, 'clarify', 'terminal') WHERE role = 'assistant'",
    "UPDATE messages SET timestamp = 1786057203 WHERE tool_calls IS NOT NULL",
  ])('rejects ordinary/unlinked tool output (%s)', async sql => {
    const path = fixture();
    changeResult(path, { outcome: 'submitted', responses: [answered('NEVER-IMPORT')] }, sql);
    expect((await read(path)).messages).toHaveLength(2);
  });

  test('does not borrow a call from another session or import a duplicate result twice', async () => {
    const path = fixture();
    const db = new Database(path);
    try {
      db.exec(`INSERT INTO messages(session_id,role,content,timestamp,tool_name,tool_call_id)
        SELECT session_id,role,content,timestamp + 0.1,tool_name,tool_call_id FROM messages
        WHERE session_id = 'clarify-session' AND role = 'tool'`);
    } finally { db.close(); }
    expect((await read(path)).messages).toHaveLength(4);
    const db2 = new Database(path);
    try {
      db2.exec("UPDATE messages SET session_id = 'hermes-fixture-1' WHERE tool_calls IS NOT NULL");
    } finally { db2.close(); }
    expect((await read(path)).messages).toHaveLength(2);
  });

  test.each(['not-json', '[]', 'null', '{"outcome":"submitted","responses":"NO"}'])('ignores malformed envelope %s', async value => {
    const path = fixture();
    changeResult(path, value);
    expect((await read(path)).messages).toHaveLength(2);
  });
});

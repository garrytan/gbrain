import { Database } from 'bun:sqlite';
import { buildHermesFixture } from '../fixtures/transcripts/hermes-fixture-builder.ts';

/** Synthetic native clarify wire shape from NousResearch/hermes-agent tools/clarify_tool.py. */
export function buildHermesClarifyFixture(dir: string): string {
  const path = buildHermesFixture(dir);
  const db = new Database(path);
  try {
    db.exec('ALTER TABLE messages ADD COLUMN tool_name TEXT');
    db.exec('ALTER TABLE messages ADD COLUMN tool_call_id TEXT');
    db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT');
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)')
      .run('clarify-session', 'cli', 1786057199);
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, tool_name, tool_call_id, tool_calls) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('clarify-session', 'user', 'Choose the widget rollout.', 1786057199, null, null, null);
    insert.run('clarify-session', 'assistant', '', 1786057200, null, null, JSON.stringify([
      { id: 'clarify-call', type: 'function', function: { name: 'clarify', arguments: JSON.stringify({ questions: [
        { question: 'Which rollout?', choices: ['Broad', 'Canary'] },
        { question: 'Which regions?', choices: ['East', 'West', 'North'], multi_select: true },
      ] }) } },
    ]));
    insert.run('clarify-session', 'tool', JSON.stringify({ outcome: 'submitted', responses: [
      { question: 'Which rollout?', choices_offered: ['Broad', 'Canary'], status: 'answered', user_response: 'Canary' },
      { question: 'Which regions?', choices_offered: ['East', 'West', 'North'], status: 'answered', user_response: ['East', 'West'] },
    ] }), 1786057201, 'clarify', 'clarify-call', null);
    insert.run('clarify-session', 'assistant', 'The rollout is Canary in East and West.', 1786057202, null, null, null);
  } finally {
    db.close();
  }
  return path;
}

/**
 * #7396: Hermes stores a user's answer to a native clarification form as a
 * `role=tool`, `tool_name=clarify` result, never as a `role=user` row, so the
 * adapter's `role IN ('user','assistant')` filter dropped the answer and the
 * imported conversation kept the assistant's interpretation without the
 * user's intervening correction.
 *
 * Protects: an answered response of a submitted form (hermes-agent
 * tools/clarify_tool.py `_result`: `{responses: [{question, choices_offered,
 * status, user_response}], outcome}`, and the earlier batch shape without
 * `status`/`outcome`) imports as the user's message at the result's event
 * time, after the question as the assistant's turn, with the question and
 * tool-call id kept as provenance in raw metadata; the answers a timed-out
 * form already locked import too; unselected choices, skipped/unanswered/empty
 * responses, cancelled/undelivered forms, a timed-out earlier batch shape, the legacy single-question shape
 * (which serializes a timeout as text) and every other tool's output never
 * become user speech; a store without the tool columns imports as before;
 * replay is idempotent.
 * Seams: none; the ingest case runs on PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { buildTranscriptSlug, type ParsedSession } from '../src/core/transcripts/types.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SESSION = 'clarify-session-example';
const STARTED = 1786057199;
const ANSWERED_AT = 1786057201;

const submitted = {
  outcome: 'submitted',
  responses: [
    { question: 'Which rollout?', choices_offered: ['Broad', 'Canary'], status: 'answered', user_response: 'Canary' },
    { question: 'Which regions?', choices_offered: ['East', 'West', 'North'], status: 'answered', user_response: ['East', 'West'] },
  ],
};

let dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = []; });

/** A synthetic store with the current hermes-agent messages columns (tool_call_id, tool_calls, tool_name). */
function clarifyStore(result: unknown, toolName = 'clarify'): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-clarify-'));
  dirs.push(dir);
  const path = join(dir, 'state.db');
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, display_name TEXT, model TEXT,
        started_at REAL NOT NULL, ended_at REAL, cwd TEXT, title TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);
    `);
    db.prepare('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)').run(SESSION, 'cli', STARTED);
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run(SESSION, 'user', 'Plan the widget rollout.', null, null, null, STARTED);
    insert.run(SESSION, 'assistant', '', null, JSON.stringify([{ id: 'call-clarify-1', type: 'function',
      function: { name: toolName, arguments: JSON.stringify({ questions: [{ question: 'Which rollout?' }] }) } }]), null, STARTED + 1);
    insert.run(SESSION, 'tool', typeof result === 'string' ? result : JSON.stringify(result), 'call-clarify-1', null, toolName, ANSWERED_AT);
    insert.run(SESSION, 'assistant', 'Proceeding with the rollout you chose.', null, null, null, ANSWERED_AT + 1);
  } finally {
    db.close();
  }
  return path;
}

async function parseSession(path: string): Promise<ParsedSession> {
  for await (const session of hermesAdapter.parse(path)) if (session.meta.sessionId === SESSION) return session;
  throw new Error('synthetic session missing');
}
const texts = (session: ParsedSession) => session.messages.map(m => [m.role, m.text]);
const UNANSWERED = [['user', 'Plan the widget rollout.'], ['assistant', 'Proceeding with the rollout you chose.']];

describe('Hermes clarify answers (#7396)', () => {
  test('a submitted form imports each answered value as the user, at the result time, with provenance', async () => {
    const session = await parseSession(clarifyStore(submitted));
    expect(texts(session)).toEqual([
      ['user', 'Plan the widget rollout.'],
      ['assistant', 'Which rollout?'],
      ['user', 'Canary'],
      ['assistant', 'Which regions?'],
      ['user', 'East\nWest'],
      ['assistant', 'Proceeding with the rollout you chose.'],
    ]);
    const at = new Date(ANSWERED_AT * 1000).toISOString();
    expect(session.messages[2].timestamp).toBe(at);
    expect(session.messages[4].timestamp).toBe(at);
    expect(session.meta.raw).toMatchObject({
      clarify_0_tool_call_id: 'call-clarify-1', clarify_0_question: 'Which rollout?', clarify_0_message_index: 2,
      clarify_1_tool_call_id: 'call-clarify-1', clarify_1_question: 'Which regions?', clarify_1_message_index: 4,
    });
    const userText = session.messages.filter(m => m.role === 'user').map(m => m.text).join('\n');
    for (const unselected of ['Broad', 'North', 'Which rollout?']) expect(userText).not.toContain(unselected);
  });

  test('a typed answer is kept exactly', async () => {
    const answer = 'No — use the canary.\nKeep 日本語 intact.';
    const session = await parseSession(clarifyStore({ outcome: 'submitted', responses: [
      { question: 'Which rollout?', choices_offered: null, status: 'answered', user_response: answer }] }));
    expect(session.messages[2]).toEqual({ role: 'user', timestamp: new Date(ANSWERED_AT * 1000).toISOString(), text: answer });
  });

  test('the earlier batch shape (no status/outcome) imports non-empty answers of a form that did not time out', async () => {
    const batch = { responses: [
      { question: 'Which rollout?', choices_offered: ['Broad', 'Canary'], user_response: 'Canary' },
      { question: 'Which regions?', choices_offered: ['East', 'West'], user_response: '' },
    ] };
    expect(texts(await parseSession(clarifyStore(batch)))).toEqual([
      ['user', 'Plan the widget rollout.'], ['assistant', 'Which rollout?'], ['user', 'Canary'], ['assistant', 'Proceeding with the rollout you chose.'],
    ]);
    expect(texts(await parseSession(clarifyStore({ ...batch, timed_out: true, notice: 'user did not respond' })))).toEqual(UNANSWERED);
  });

  test.each(['cancelled', 'undelivered', ''])('a %s form imports nothing', async outcome => {
    const session = await parseSession(clarifyStore({ ...submitted, outcome }));
    expect(texts(session)).toEqual(UNANSWERED);
  });

  test('a form that timed out part-way keeps the answers the user already locked', async () => {
    const session = await parseSession(clarifyStore({ outcome: 'timed_out', notice: '[user did not respond within 5m]', responses: [
      { question: 'Which rollout?', choices_offered: ['Broad', 'Canary'], status: 'answered', user_response: 'Canary' },
      { question: 'Which regions?', choices_offered: ['East', 'West'], status: 'unanswered', user_response: null },
    ] }));
    expect(texts(session)).toEqual([
      ['user', 'Plan the widget rollout.'], ['assistant', 'Which rollout?'], ['user', 'Canary'], ['assistant', 'Proceeding with the rollout you chose.'],
    ]);
  });

  test('skipped, unanswered, empty and malformed responses import nothing; answered siblings survive', async () => {
    const response = (status: string, user_response: unknown) => ({ question: 'Which rollout?', choices_offered: ['Broad'], status, user_response });
    const session = await parseSession(clarifyStore({ outcome: 'submitted', responses: [
      response('skipped', 'NOT-SPEECH-1'), response('unanswered', 'NOT-SPEECH-2'), response('answered', null),
      response('answered', ''), response('answered', '   '), response('answered', []), response('answered', ['East', 7]),
      response('answered', { text: 'NOT-SPEECH-3' }), null, 'NOT-SPEECH-4', response('answered', 'Canary'),
    ] }));
    expect(texts(session)).toEqual([
      ['user', 'Plan the widget rollout.'], ['assistant', 'Which rollout?'], ['user', 'Canary'], ['assistant', 'Proceeding with the rollout you chose.'],
    ]);
  });

  test.each([
    ['legacy single-question shape', JSON.stringify({ question: 'Which rollout?', choices_offered: ['Broad'], user_response: 'None' })],
    ['tool error', JSON.stringify({ error: 'Clarify tool is not available in this execution context.' })],
    ['plain text', 'The user did not provide a response within the time limit.'],
    ['malformed JSON', '{"outcome":"submitted","responses":['],
    ['non-array responses', JSON.stringify({ outcome: 'submitted', responses: 'Canary' })],
  ])('a %s result imports nothing', async (_label, content) => {
    expect(texts(await parseSession(clarifyStore(content)))).toEqual(UNANSWERED);
  });

  test('another tool with the same envelope is never user speech', async () => {
    expect(texts(await parseSession(clarifyStore(submitted, 'terminal')))).toEqual(UNANSWERED);
  });

  test('a store without the tool columns imports as before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-clarify-legacy-'));
    dirs.push(dir);
    const sessions: ParsedSession[] = [];
    for await (const session of hermesAdapter.parse(buildHermesFixture(dir))) sessions.push(session);
    expect(sessions.map(s => [s.meta.sessionId, s.messages.length])).toEqual([['hermes-fixture-1', 2], ['hermes-fixture-2', 2]]);
    expect(JSON.stringify(sessions)).not.toContain('TOOL-ONLY-TEXT');
  });
});

describe('Hermes clarify answers through ingest (#7396)', () => {
  const engines: Array<{ backend: string; engine: BrainEngine; close: () => Promise<void> }> = [];
  beforeAll(async () => {
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine, close: () => engine.disconnect() });
      } else {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engines.push({ backend, engine: isolated.engine, close: isolated.close });
      }
    }
  }, 120_000);
  afterAll(async () => { for (const { close } of engines) await close(); });

  test('the answer lands as a User turn, provenance rides raw_data, and replay is a no-op', async () => {
    const slug = buildTranscriptSlug('hermes', new Date(STARTED * 1000).toISOString(), { sessionId: SESSION });
    for (const { backend, engine } of engines) {
      const path = clarifyStore(submitted);
      const opts = { paths: [path], sourceId: 'default', userPatternsPath: '/nonexistent-patterns.txt' };
      const first = await runTranscriptsIngest(engine, opts);
      expect(first.pages.imported, backend).toBe(1);
      const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
      expect(page.compiled_truth, backend).toMatch(/\*\*Assistant\*\* \([^)]*\): Which rollout\?\n+\*\*User\*\* \([^)]*\): Canary/);
      expect(page.compiled_truth, backend).not.toContain('Broad');
      const raw = await engine.getRawData(slug, 'transcript:hermes', { sourceId: 'default' });
      expect(raw[0].data, backend).toMatchObject({ clarify_0_tool_call_id: 'call-clarify-1', clarify_0_question: 'Which rollout?' });

      const again = await runTranscriptsIngest(engine, opts);
      expect(again.pages.imported, backend).toBe(0);
      expect(again.pages.skipped, backend).toBe(1);
      expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth, backend).toBe(page.compiled_truth);
      expect((await engine.getRawData(slug, 'transcript:hermes', { sourceId: 'default' }))[0].data, backend).toEqual(raw[0].data);
    }
  }, 120_000);
});

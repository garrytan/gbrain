/**
 * #5163 + E-N4: codex >= 0.153 records the typed turn only as an
 * `event_msg`/`item_completed` UserMessage. Both the import adapter and the
 * SessionEnd hook lane must keep it; an assistant-only parse must be loud.
 *
 * The fixture copies the line shapes quoted in #5163 (0.154.0 and the 0.159.3
 * `ordinal`/`started_at_ms` extras) with synthetic text.
 *
 * SERIAL: mutates GBRAIN_HOME / CODEX_HOME for the hook-lane cases.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter, mapCodexLine } from '../src/core/transcripts/codex.ts';
import { parseCodexHookTranscript } from '../src/core/transcripts/codex-hook-lane.ts';
import { claudeCodeAdapter } from '../src/core/transcripts/claude-code.ts';
import type { FileDiagnostics, ParsedSession } from '../src/core/transcripts/types.ts';
import { readHeartbeatTail, runHook } from '../src/commands/hook.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';

const FIXTURE_0154 = join(import.meta.dir, 'fixtures', 'transcripts', 'codex-rollout-0154.jsonl');

async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>) {
  const sessions: ParsedSession[] = [];
  let step = await gen.next();
  while (!step.done) {
    sessions.push(step.value);
    step = await gen.next();
  }
  return { sessions, diag: step.value };
}

const ENV_KEYS = ['GBRAIN_HOME', 'CODEX_HOME', 'GBRAIN_SEAT', 'GBRAIN_MEMORABLE', 'GBRAIN_HOOKS'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-cdx154-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp;
  mkdirSync(join(tmp, 'ws'), { recursive: true });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const meta = JSON.stringify({
  timestamp: '2026-10-01T09:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'r-154', session_id: 'r-154', timestamp: '2026-10-01T09:00:00.000Z', cwd: '/repo', cli_version: '0.154.0' },
});
const userMessageItem = (text: string, ts = '2026-10-01T09:00:01.000Z') =>
  JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'th', turn_id: 'tu', item: { type: 'UserMessage', id: 'i', content: [{ type: 'text', text, text_elements: [] }] } },
  });
const legacyUser = (text: string, ts = '2026-10-01T09:00:01.000Z') =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: text } });
const assistant = (text: string, ts = '2026-10-01T09:00:02.000Z') =>
  JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });

function writeRollout(name: string, lines: string[]): string {
  const p = join(tmp, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('#5163 import adapter: item_completed UserMessage is a user turn', () => {
  test('a 0.154 rollout parses to its user and assistant turns; injected rows, other items and non-text blocks stay out', async () => {
    const { sessions, diag } = await drain(codexAdapter.parse(FIXTURE_0154));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Which fund led the widget-co seed round?'],
      ['assistant', 'fund-a led the widget-co seed.'],
      ['user', 'Note that the bridge check-in is every Thursday.'],
      ['assistant', 'Noted: bridge check-in every Thursday.'],
    ]);
    expect(s.messages[0]!.timestamp).toBe('2026-10-01T09:00:03.000Z');
    const all = s.messages.map((m) => m.text).join('\n');
    for (const leak of ['PREAMBLE-ONLY-TEXT', 'ENV-CONTEXT-ONLY-TEXT', 'IMAGE-BLOCK-ONLY', 'COMMAND-OUTPUT-ONLY-TEXT']) {
      expect(all).not.toContain(leak);
    }
    expect(diag.userTurnsMissing).toBeUndefined();
  });

  test('a failed exec (user turn, no assistant reply) still yields its one user turn', async () => {
    const p = writeRollout('failed-exec.jsonl', [meta, userMessageItem('run the migration')]);
    const { sessions, diag } = await drain(codexAdapter.parse(p));
    expect(diag.sessions).toBe(1);
    expect(sessions[0]!.messages.map((m) => [m.role, m.text])).toEqual([['user', 'run the migration']]);
  });

  test('a rollout that records one turn in both shapes keeps it once; a genuine repeat after a reply stays', async () => {
    const p = writeRollout('both-shapes.jsonl', [
      meta,
      legacyUser('same turn'),
      userMessageItem('same turn'),
      assistant('reply'),
      userMessageItem('same turn'),
      assistant('second reply'),
    ]);
    const { sessions } = await drain(codexAdapter.parse(p));
    expect(sessions[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  test('mapCodexLine: AgentMessage, other item types and empty or non-text UserMessage content are skipped', () => {
    const item = (it: unknown) => ({ type: 'event_msg', payload: { type: 'item_completed', item: it } });
    expect(mapCodexLine(item({ type: 'AgentMessage', content: [{ type: 'text', text: 'dup' }] })).kind).toBe('skip');
    expect(mapCodexLine(item({ type: 'CommandExecution', command: 'ls' })).kind).toBe('skip');
    expect(mapCodexLine(item({ type: 'UserMessage', content: [{ type: 'image', image_url: 'x' }] })).kind).toBe('skip');
    expect(mapCodexLine(item({ type: 'UserMessage', content: [{ type: 'text', text: '   ' }] })).kind).toBe('skip');
    expect(mapCodexLine(item(null)).kind).toBe('skip');
    expect(mapCodexLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected' }] } }).kind).toBe('skip');
  });
});

describe('#5163 hook lane: the SessionEnd parser keeps the typed turn', () => {
  test('parseCodexHookTranscript yields user turns from item_completed UserMessage, deduped across shapes', () => {
    const parsed = parseCodexHookTranscript(FIXTURE_0154);
    expect(parsed.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(parsed.genuineUserTurnIndexes).toEqual([0, 2]);
    const both = writeRollout('both.jsonl', [meta, legacyUser('one'), userMessageItem('one'), assistant('two')]);
    expect(parseCodexHookTranscript(both).turns.map((t) => t.text)).toEqual(['one', 'two']);
  });

  test('session-end banks a corpus file with the user turn', async () => {
    const codexHome = join(tmp, 'codex');
    process.env.CODEX_HOME = codexHome;
    const day = join(codexHome, 'sessions', '2026', '10', '01');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, 'rollout-2026-10-01T09-00-00-r-154.jsonl');
    writeFileSync(rollout, readFileSync(FIXTURE_0154));
    expect(await runHook(['session-end'], {
      harness: 'codex',
      stdin: JSON.stringify({ session_id: 'r-154', transcript_path: rollout, cwd: join(tmp, 'ws') }),
    })).toBe(0);
    const corpus = join(tmp, '.gbrain', 'transcripts', 'corpus', 'r-154.txt');
    expect(existsSync(corpus)).toBe(true);
    const text = readFileSync(corpus, 'utf8');
    expect(text).toContain('[user]');
    expect(text).toContain('Which fund led the widget-co seed round?');
    const hb = (await readHeartbeatTail(1))[0]!;
    expect(hb.event).toBe('session-end');
    expect(hb.reason).not.toBe('no_user_turns');
  });
});

describe('E-N4: assistant turns with no user turn are flagged, never silent', () => {
  test('codex adapter: an assistant-only rollout reports userTurnsMissing', async () => {
    const p = writeRollout('assistant-only.jsonl', [meta, assistant('ok')]);
    const { sessions, diag } = await drain(codexAdapter.parse(p));
    expect(sessions).toHaveLength(1);
    expect(diag.userTurnsMissing).toBe(true);
  });

  test('claude-code adapter: an assistant-only session reports userTurnsMissing', async () => {
    const p = writeRollout('claude-assistant-only.jsonl', [
      JSON.stringify({ type: 'assistant', sessionId: 's-1', isSidechain: false, timestamp: '2026-10-01T09:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    ]);
    const { diag } = await drain(claudeCodeAdapter.parse(p));
    expect(diag.sessions).toBe(1);
    expect(diag.userTurnsMissing).toBe(true);
  });

  test('claude-code adapter: a session started by automation (non-human or meta user records) is not flagged', async () => {
    const p = writeRollout('claude-automation.jsonl', [
      JSON.stringify({ type: 'user', sessionId: 's-2', origin: { kind: 'task-notification' }, timestamp: '2026-10-01T09:00:00.000Z', message: { role: 'user', content: 'scheduled run' } }),
      JSON.stringify({ type: 'user', sessionId: 's-2', isMeta: true, timestamp: '2026-10-01T09:00:01.000Z', message: { role: 'user', content: 'expanded command' } }),
      JSON.stringify({ type: 'assistant', sessionId: 's-2', isSidechain: false, timestamp: '2026-10-01T09:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    ]);
    const { diag } = await drain(claudeCodeAdapter.parse(p));
    expect(diag.sessions).toBe(1);
    expect(diag.userTurnsMissing).toBeUndefined();
  });

  test('session-end heartbeats degraded:no_user_turns for an assistant-only rollout and still banks the corpus', async () => {
    const codexHome = join(tmp, 'codex');
    process.env.CODEX_HOME = codexHome;
    const day = join(codexHome, 'sessions', '2026', '10', '01');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, 'rollout-2026-10-01T09-00-00-r-ao.jsonl');
    writeFileSync(rollout, [meta.replace('r-154', 'r-ao'), assistant('ok')].join('\n') + '\n');
    expect(await runHook(['session-end'], {
      harness: 'codex',
      stdin: JSON.stringify({ session_id: 'r-ao', transcript_path: rollout, cwd: join(tmp, 'ws') }),
    })).toBe(0);
    const hb = (await readHeartbeatTail(1))[0]!;
    expect(hb).toMatchObject({ event: 'session-end', outcome: 'degraded', reason: 'no_user_turns' });
    expect(existsSync(join(tmp, '.gbrain', 'transcripts', 'corpus', 'r-ao.txt'))).toBe(true);
  });

  describe('ingest', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
    });
    afterAll(async () => {
      await engine.disconnect();
    });

    test('an assistant-only file imports but counts as drift and holds the watermark', async () => {
      await resetPgliteState(engine);
      const p = writeRollout('assistant-only.jsonl', [meta, assistant('ok')]);
      const r = await runTranscriptsIngest(engine, { paths: [p], sourceId: 'default', userPatternsPath: '/nonexistent-patterns.txt' });
      expect(r.sessionsImported).toBe(1);
      expect(r.driftFiles).toBe(1);
      expect(r.files[0]!.userTurnsMissing).toBe(true);
      expect(r.cleanScan).toBe(false);
      const ok = await runTranscriptsIngest(engine, { paths: [FIXTURE_0154], sourceId: 'default', userPatternsPath: '/nonexistent-patterns.txt' });
      expect(ok.driftFiles).toBe(0);
      expect(ok.cleanScan).toBe(true);
    });
  });
});

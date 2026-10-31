/**
 * #8064: a launcher marks a session's user turns as an agent's
 * (GBRAIN_SESSION_AGENT) or opts it out; unmarked headless sessions launched
 * by another harness process are detected. Banked agent sessions carry a
 * speaker sidecar written before any corpus file, and their extracted claims
 * are saved as 'other' with a speaker note, never as the owner's.
 * Also #8028 (harness prompts skip turn context) and #8016 (Codex bookkeeping
 * events read as an empty session; a later save clears a drift status).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook, hookStatusPath, readHeartbeatTail } from '../src/commands/hook.ts';
import {
  corpusFileSpeaker, detectAgentLaunched, readSpeakerSidecar, resolveSessionSpeaker, type AncestorProcess,
} from '../src/core/context/session-speaker.ts';
import { parseCodexHookTranscript } from '../src/core/transcripts/codex-hook-lane.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { FactAttribution } from '../src/core/engine.ts';
import { asAgentSpoken, runFactsPipeline } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { withSpeakerNote } from '../src/core/facts/speaker-context.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_STOP_PUSH', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SESSION_AGENT'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-speaker-'));
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GBRAIN_HOME = tmp;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');
const corpus = () => join(home(), 'transcripts', 'corpus', 'sourced');
const BRIEF = 'You are a lander. Change no code and repair nothing; a red caused by the branch ends the land, and leave the dev server alone.';

function writeConfig(): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(tmp, 'pglite-data'), memory: { auto_writeback: 'all' } }));
}
function writeTurns(turns: Array<{ role: 'user' | 'assistant'; text: string }>): { path: string; root: string } {
  const root = join(tmp, 'projects-root');
  mkdirSync(join(root, 'app'), { recursive: true });
  const p = join(root, 'app', 'session.jsonl');
  writeFileSync(p, turns.map((t, i) => JSON.stringify({
    parentUuid: i === 0 ? null : 't-' + (i - 1), isSidechain: false, type: t.role,
    message: { role: t.role, content: t.role === 'user' ? t.text : [{ type: 'text', text: t.text }] },
    uuid: 't-' + i, sessionId: 's-agent', timestamp: '2026-09-01T10:00:0' + i + '.000Z',
  })).join('\n') + '\n');
  return { path: p, root };
}
const files = () => (existsSync(corpus()) ? readdirSync(corpus()) : []);
const io = { write: () => {} };
const ORCH: AncestorProcess = { pid: 10, args: ['/usr/local/bin/claude'] };
const WORKER: AncestorProcess = { pid: 20, args: ['/usr/local/bin/claude', '-p', 'brief'] };
const SHELL: AncestorProcess = { pid: 15, args: ['/bin/bash', '-c', 'claude -p brief'] };

describe('resolveSessionSpeaker', () => {
  test('the launcher env names the agent, opts out, or declares the owner', () => {
    expect(resolveSessionSpeaker({ env: { GBRAIN_SESSION_AGENT: 'Fleet-Worker' }, ancestry: () => [] }))
      .toEqual({ kind: 'agent', principal: 'fleet-worker', source: 'env' });
    expect(resolveSessionSpeaker({ env: { GBRAIN_SESSION_AGENT: 'off' } })).toEqual({ kind: 'skip' });
    expect(resolveSessionSpeaker({ env: { GBRAIN_SESSION_AGENT: 'owner' }, ancestry: () => [WORKER, SHELL, ORCH] })).toEqual({ kind: 'owner' });
    expect(resolveSessionSpeaker({ env: { GBRAIN_SESSION_AGENT: 'bad label!' } }))
      .toEqual({ kind: 'agent', principal: 'agent', source: 'env', invalid: true });
  });

  test('detection needs a headless harness process AND a harness ancestor', () => {
    expect(detectAgentLaunched([WORKER, SHELL, ORCH])).toBe(true);
    expect(detectAgentLaunched([{ pid: 1, args: ['sh', '-c', 'gbrain hook stop'] }, WORKER, SHELL, ORCH])).toBe(true);
    expect(detectAgentLaunched([WORKER, { pid: 3, args: ['zsh'] }])).toBe(false);
    expect(detectAgentLaunched([ORCH, SHELL, { pid: 9, args: ['/usr/local/bin/claude'] }])).toBe(false);
    expect(detectAgentLaunched([{ pid: 4, args: ['/opt/codex', 'exec', 'task'] }, ORCH])).toBe(true);
    expect(detectAgentLaunched([{ pid: 5, args: ['node', '/x/node_modules/@anthropic-ai/claude-code/cli.js', '--print'] }, ORCH])).toBe(true);
    expect(resolveSessionSpeaker({ env: {}, ancestry: () => [WORKER, SHELL, ORCH] }))
      .toEqual({ kind: 'agent', principal: 'agent-launched', source: 'detected' });
    expect(resolveSessionSpeaker({ env: {}, ancestry: () => [WORKER] })).toEqual({ kind: 'owner' });
  });
});

describe('hook banking with a session speaker', () => {
  test('stop: an agent session banks its turn with the speaker sidecar beside it', async () => {
    writeConfig();
    const t = writeTurns([{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'ok' }]);
    await runHook(['stop'], { ...io, transcriptRoot: t.root, env: { GBRAIN_SESSION_AGENT: 'fleet-worker' }, processAncestry: () => [],
      stdin: JSON.stringify({ session_id: 's-agent', transcript_path: t.path }) });
    const wb = files().find((f) => f.includes('.wb-'));
    expect(wb).toBeDefined();
    expect(readSpeakerSidecar(corpus(), 's-agent')).toMatchObject({ principal: 'fleet-worker', source: 'env' });
    expect(corpusFileSpeaker(join(corpus(), wb!))).toEqual({ principal: 'fleet-worker' });
  });

  test('stop: detection marks an unflagged worker launched by another claude process', async () => {
    writeConfig();
    const t = writeTurns([{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'ok' }]);
    await runHook(['stop'], { ...io, transcriptRoot: t.root, env: {}, processAncestry: () => [WORKER, SHELL, ORCH],
      stdin: JSON.stringify({ session_id: 's-agent', transcript_path: t.path }) });
    expect(readSpeakerSidecar(corpus(), 's-agent')).toMatchObject({ principal: 'agent-launched', source: 'detected' });
  });

  test('stop: the owner banks with no sidecar', async () => {
    writeConfig();
    const t = writeTurns([{ role: 'user', text: 'I prefer dark mode in every editor, please set it up.' }, { role: 'assistant', text: 'ok' }]);
    await runHook(['stop'], { ...io, transcriptRoot: t.root, env: {}, processAncestry: () => [ORCH],
      stdin: JSON.stringify({ session_id: 's-agent', transcript_path: t.path }) });
    expect(files().some((f) => f.includes('.wb-'))).toBe(true);
    expect(readSpeakerSidecar(corpus(), 's-agent')).toBeNull();
  });

  test('stop: off banks nothing (by design)', async () => {
    writeConfig();
    const t = writeTurns([{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'ok' }]);
    await runHook(['stop'], { ...io, transcriptRoot: t.root, env: { GBRAIN_SESSION_AGENT: 'off' },
      stdin: JSON.stringify({ session_id: 's-agent', transcript_path: t.path }) });
    expect(files().filter((f) => f.endsWith('.txt'))).toEqual([]);
    const hb = (await readHeartbeatTail(20)).filter((e) => e.event === 'writeback-bank');
    expect(hb.map((e) => [e.reason, e.outcome])).toEqual([['capture_opt_out', 'ok']]);
  });

  test('stop: a speaker sidecar that cannot be written banks nothing', async () => {
    writeConfig();
    mkdirSync(join(corpus(), 's-agent.speaker.json'), { recursive: true }); // a directory where the sidecar goes
    const t = writeTurns([{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'ok' }]);
    await runHook(['stop'], { ...io, transcriptRoot: t.root, env: { GBRAIN_SESSION_AGENT: 'fleet-worker' },
      stdin: JSON.stringify({ session_id: 's-agent', transcript_path: t.path }) });
    expect(files().filter((f) => f.endsWith('.txt'))).toEqual([]);
    const hb = (await readHeartbeatTail(20)).filter((e) => e.event === 'writeback-bank');
    expect(hb.map((e) => [e.reason, e.outcome])).toEqual([['speaker_write_failed', 'degraded']]);
  });

  test('session-end: agent session writes the sidecar and the corpus file; off writes neither', async () => {
    writeConfig();
    const t = writeTurns([{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'ok' }]);
    const ws = join(tmp, 'ws'); mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], { ...io, transcriptRoot: t.root, env: { GBRAIN_SESSION_AGENT: 'off' },
      stdin: JSON.stringify({ session_id: 's-off', transcript_path: t.path, cwd: ws }) });
    expect(files().filter((f) => f.startsWith('s-off') && f.endsWith('.txt'))).toEqual([]);
    expect((await readHeartbeatTail(1))[0]?.segment).toBe('capture_opt_out');
    await runHook(['session-end'], { ...io, transcriptRoot: t.root, env: { GBRAIN_SESSION_AGENT: 'fleet-worker' },
      stdin: JSON.stringify({ session_id: 's-agent', transcript_path: t.path, cwd: ws }) });
    const txt = files().find((f) => f.startsWith('s-agent') && f.endsWith('.txt'));
    expect(txt).toBeDefined();
    expect(corpusFileSpeaker(join(corpus(), txt!))).toEqual({ principal: 'fleet-worker' });
  });
});

describe('#8080 speaker notes: first record wins, a differing speaker is reported', () => {
  const ws = () => { const w = join(tmp, 'ws'); mkdirSync(w, { recursive: true }); return w; };
  const end = (env: Record<string, string>, ancestry: AncestorProcess[], sid = 's-agent', more: { role: 'user' | 'assistant'; text: string }[] = []) => {
    const t = writeTurns([{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'ok' }, ...more]);
    return runHook(['session-end'], { ...io, transcriptRoot: t.root, env, processAncestry: () => ancestry,
      stdin: JSON.stringify({ session_id: sid, transcript_path: t.path, cwd: ws() }) });
  };
  const last = async () => { const hb = (await readHeartbeatTail(1))[0]; return [hb?.outcome, hb?.reason]; };

  test('the owner resuming an agent session banks as before and notes speaker_mismatch; the sidecar stays', async () => {
    writeConfig();
    await end({ GBRAIN_SESSION_AGENT: 'fleet-worker' }, []);
    expect((await last())[1]).not.toBe('speaker_mismatch');
    await end({}, [ORCH]);
    expect(await last()).toEqual(['degraded', 'speaker_mismatch']);
    expect(readSpeakerSidecar(corpus(), 's-agent')).toMatchObject({ principal: 'fleet-worker', source: 'env' });
    expect(files().some((f) => f.startsWith('s-agent') && f.endsWith('.txt'))).toBe(true);
  });

  test('a different agent label notes speaker_mismatch and keeps the first record', async () => {
    writeConfig();
    await end({ GBRAIN_SESSION_AGENT: 'fleet-worker' }, []);
    await end({ GBRAIN_SESSION_AGENT: 'other-worker' }, []);
    expect(await last()).toEqual(['degraded', 'speaker_mismatch']);
    expect(readSpeakerSidecar(corpus(), 's-agent')?.principal).toBe('fleet-worker');
  });

  test('an agent continuing a session the owner already banked banks nothing and notes speaker_mismatch', async () => {
    writeConfig();
    await end({}, [ORCH]);
    expect(readSpeakerSidecar(corpus(), 's-agent')).toBeNull();
    const banked = files().filter((f) => f.startsWith('s-agent') && f.endsWith('.txt'));
    expect(banked.length).toBeGreaterThan(0);
    await end({}, [WORKER, SHELL, ORCH], 's-agent', [{ role: 'user', text: 'continue the sweep' }, { role: 'assistant', text: 'done' }]);
    expect(await last()).toEqual(['degraded', 'speaker_mismatch']);
    expect(readSpeakerSidecar(corpus(), 's-agent')).toBeNull();
    expect(files().filter((f) => f.startsWith('s-agent') && f.endsWith('.txt'))).toEqual(banked);
  });

  test('GBRAIN_SESSION_AGENT=owner still saves as the owner, and notes a session detection finds agent-launched', async () => {
    writeConfig();
    await end({ GBRAIN_SESSION_AGENT: 'owner' }, [WORKER, SHELL, ORCH]);
    expect(await last()).toEqual(['degraded', 'speaker_owner_override_detected']);
    expect(readSpeakerSidecar(corpus(), 's-agent')).toBeNull();
    expect(files().some((f) => f.startsWith('s-agent') && f.endsWith('.txt'))).toBe(true);
    await end({ GBRAIN_SESSION_AGENT: 'owner' }, [ORCH], 's-own');
    expect((await last())[1]).toBeUndefined();
  });
});

describe('#8028 user-prompt skips harness prompts', () => {
  for (const prompt of ['<task-notification>\n<task-id>t1</task-id> done</task-notification>', '  <teammate-message from="lead">rebase now</teammate-message>']) {
    test('no turn context for ' + prompt.trim().slice(0, 20), async () => {
      mkdirSync(home(), { recursive: true });
      writeFileSync(join(home(), 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(tmp, 'pglite-data') }));
      let out = '';
      await runHook(['user-prompt'], { write: (s: string) => { out += s; }, turnRule: null, disablePushBanner: true,
        stdin: JSON.stringify({ prompt, session_id: 's-n', cwd: tmp }) });
      const hb = (await readHeartbeatTail(1))[0];
      expect([hb?.outcome, hb?.reason]).toEqual(['ok', 'harness_prompt']);
      expect(out).toBe('');
    });
  }
});

describe('#8016 codex bookkeeping and the drift status', () => {
  test('session_meta plus thread_settings_applied is recognized-only (empty session), an unknown event is not', () => {
    const dir = join(tmp, 'cdx'); mkdirSync(dir, { recursive: true });
    const meta = JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { id: 'r-1', session_id: 'c-1', cwd: '/repo', cli_version: '0.165.0' } });
    const settings = JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'thread_settings_applied' } });
    const unknown = JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'brand_new_event' } });
    writeFileSync(join(dir, 'a.jsonl'), [meta, settings].join('\n') + '\n');
    writeFileSync(join(dir, 'b.jsonl'), [meta, unknown].join('\n') + '\n');
    const a = parseCodexHookTranscript(join(dir, 'a.jsonl'));
    expect([a.turns.length, a.recognizedOnly]).toEqual([0, true]);
    expect(parseCodexHookTranscript(join(dir, 'b.jsonl')).recognizedOnly).toBe(false);
  });

  test('a later session-end of the same lane that saves turns clears the parser_drift status', async () => {
    writeConfig();
    const status = await hookStatusPath();
    writeFileSync(join(status), JSON.stringify({ ts: 'x', error: 'parser_drift', bytes: 9, harness: 'codex' }));
    const t = writeTurns([{ role: 'user', text: 'Please summarize the launch plan for the team.' }, { role: 'assistant', text: 'ok' }]);
    const ws = join(tmp, 'ws'); mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], { ...io, transcriptRoot: t.root, env: {}, processAncestry: () => [],
      stdin: JSON.stringify({ session_id: 's-ok', transcript_path: t.path, cwd: ws }) });
    expect(existsSync(status)).toBe(true); // another lane's alert stays
    writeFileSync(status, JSON.stringify({ ts: 'x', error: 'parser_drift', bytes: 9, harness: 'claude-code' }));
    await runHook(['session-end'], { ...io, transcriptRoot: t.root, env: {}, processAncestry: () => [],
      stdin: JSON.stringify({ session_id: 's-ok2', transcript_path: t.path, cwd: ws }) });
    expect(existsSync(status)).toBe(false);
  });
});

describe('extraction from an agent session', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { __setChatTransportForTests(null); resetGateway(); __resetFactsQueueForTests(); await engine.disconnect(); });

  test('asAgentSpoken: user and unknown become other; the assistant stays', () => {
    const row = (attributed_to: FactAttribution | null) => ({ attributed_to });
    expect(asAgentSpoken(row('user'))).toEqual({ attributed_to: 'other' });
    expect(asAgentSpoken(row(null)).attributed_to).toBe('other');
    expect(asAgentSpoken(row('assistant'))).toEqual({ attributed_to: 'assistant' });
    expect(withSpeakerNote({ principal: 'fleet-worker' }, 'meetings/x')).toContain('speaker: agent fleet-worker, not the owner');
    expect(withSpeakerNote(undefined, 'meetings/x')).toBe('meetings/x');
  });

  test('the pipeline saves the brief as the agent\'s, and the extractor is told who spoke', async () => {
    let request = '';
    __setChatTransportForTests(async (req: unknown): Promise<ChatResult> => {
      request = JSON.stringify(req);
      return {
        text: JSON.stringify({ facts: [{ fact: 'User stated the fleet lands nothing on reds of its own making', kind: 'preference', entity: null,
          confidence: 1, notability: 'high', attributed_to: 'user' }] }),
        blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub', providerId: 'test',
      };
    });
    await runFactsPipeline(BRIEF, { engine, sourceId: 'default', sessionId: 's-agent', source: 'mcp:extract_facts', mode: 'inline',
      remote: false, speaker: { principal: 'fleet-worker' } });
    expect(request).toContain('written by the automated agent \\"fleet-worker\\"');
    const rows = await engine.executeRaw<{ attributed_to: string | null; context: string | null }>('SELECT attributed_to, context FROM facts');
    expect(rows).toHaveLength(1);
    expect(rows[0].attributed_to).toBe('other');
    expect(rows[0].context).toContain('speaker: agent fleet-worker, not the owner');
  });
});

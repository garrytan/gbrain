/**
 * Ambient-writeback Stop-hook lane (WP4): file-plane gated, deterministic
 * zero-LLM salience gate, content-addressed banking, IPC prompt-harvest ask,
 * fail-open always (exit 0 whatever happens — the conversational path is
 * never blocked; requirement/test bullet 11). Serve-side extraction is
 * covered in test/checkpoint-harvest.serial.test.ts; THIS file covers the
 * hook child.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type net from 'node:net';

import { runHook } from '../src/commands/hook.ts';
import { readHeartbeatTail } from '../src/core/context/hook-heartbeat.ts';
import { CLAUDE_CLI_CWD_PREFIX } from '../src/core/ai/providers/claude-cli-scratch.ts';
import { startResolveIpcServer, ensureIpcSecret, resolveSocketPath, type ContextPackRequest, } from '../src/core/context/resolve-ipc.ts';
import type { TurnContextResult } from '../src/core/context/turn-context.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_STOP_PUSH', 'DATABASE_URL', 'GBRAIN_DATABASE_URL'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let servers: net.Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-wbstop-'));
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  for (const s of servers) { try { s.close(); } catch { /* noop */ } }
  servers = [];
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');
const corpus = () => join(home(), 'transcripts', 'corpus');

function writeConfig(opts: { writeback?: string; dataDir?: string }): string {
  mkdirSync(home(), { recursive: true });
  const dataDir = opts.dataDir ?? join(tmp, 'pglite-data');
  writeFileSync(join(home(), 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: dataDir,
    ...(opts.writeback ? { memory: { auto_writeback: opts.writeback } } : {}),
  }));
  return dataDir;
}

/** Minimal claude-code JSONL transcript with one user turn (+ assistant reply). */
function writeTranscript(userText: string, opts: { assistantOnly?: boolean; assistantFillerChars?: number } = {}): { path: string; root: string } {
  const root = join(tmp, 'projects-root');
  mkdirSync(root, { recursive: true });
  const p = join(root, 'session.jsonl');
  const lines = [
    ...(opts.assistantOnly ? [] : [JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: userText },
      uuid: 'u-1', sessionId: 's-wb', timestamp: '2026-09-01T10:00:00.000Z',
    })]),
    JSON.stringify({
      parentUuid: 'u-1', isSidechain: false, type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: opts.assistantFillerChars ? 'x'.repeat(opts.assistantFillerChars) : 'Done — noted.',
        }],
      },
      uuid: 'a-1', sessionId: 's-wb', timestamp: '2026-09-01T10:00:05.000Z',
    }),
  ];
  writeFileSync(p, lines.join('\n') + '\n');
  return { path: p, root };
}

function writeTranscriptWithToolResult(userText: string, resultChars: number): { path: string; root: string } {
  const root = join(tmp, 'projects-root');
  mkdirSync(root, { recursive: true });
  const p = join(root, 'session.jsonl');
  const lines = [
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: userText },
      uuid: 'u-1', sessionId: 's-wb', timestamp: '2026-09-01T10:00:00.000Z',
    }),
    JSON.stringify({
      parentUuid: 'u-1', isSidechain: false, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } }] },
      uuid: 'a-1', sessionId: 's-wb', timestamp: '2026-09-01T10:00:01.000Z',
    }),
    JSON.stringify({
      parentUuid: 'a-1', isSidechain: false, type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'x'.repeat(resultChars) }] },
      uuid: 'u-tool-1', sessionId: 's-wb', timestamp: '2026-09-01T10:00:02.000Z',
    }),
    JSON.stringify({
      parentUuid: 'u-tool-1', isSidechain: false, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done — noted.' }] },
      uuid: 'a-2', sessionId: 's-wb', timestamp: '2026-09-01T10:00:03.000Z',
    }),
  ];
  writeFileSync(p, lines.join('\n') + '\n');
  return { path: p, root };
}

/** A claude-code JSONL transcript of alternating turns under `<root>/<project>/session.jsonl`. */
function writeTurns(turns: Array<{ role: 'user' | 'assistant'; text: string }>, project = 'app'): { path: string; root: string } {
  const root = join(tmp, 'projects-root');
  mkdirSync(join(root, project), { recursive: true });
  const p = join(root, project, 'session.jsonl');
  writeFileSync(p, turns.map((t, i) => JSON.stringify({
    parentUuid: i === 0 ? null : `t-${i - 1}`, isSidechain: false, type: t.role,
    message: { role: t.role, content: t.role === 'user' ? t.text : [{ type: 'text', text: t.text }] },
    uuid: `t-${i}`, sessionId: 's-wb', timestamp: `2026-09-01T10:00:0${i}.000Z`,
  })).join('\n') + '\n');
  return { path: p, root };
}

const PASTE = '<pasted_content id="2830">\nForwarded: the offsite moves to March and the budget is final.\n</pasted_content id="2830">';

function bankedTexts(): string[] {
  if (!existsSync(corpus())) return [];
  return readdirSync(corpus()).filter((f) => f.includes('.wb-')).map((f) => readFileSync(join(corpus(), f), 'utf8'));
}

const io = { write: () => {} };

async function wbHeartbeats() {
  return (await readHeartbeatTail(20)).filter((e) => e.event === 'writeback-bank');
}

describe('hook stop — ambient writeback banking', () => {
  test('gate off (no memory config): exit 0, no wb file, no writeback-bank heartbeat', async () => {
    writeConfig({});
    const t = writeTranscript('I prefer dark mode in every editor, please set it up.');
    const code = await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path, last_assistant_message: 'ok' }),
    });
    expect(code).toBe(0);
    expect(existsSync(corpus())).toBe(false);
    expect((await wbHeartbeats()).length).toBe(0);
  });

  test('"Thanks" produces NOTHING: no file, zero LLM — the typed too_short skip is the only trace', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTranscript('Thanks');
    const code = await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }),
    });
    expect(code).toBe(0);
    const files = existsSync(corpus()) ? readdirSync(corpus()).filter((f) => f.includes('.wb-')) : [];
    expect(files).toEqual([]);
    const hb = await wbHeartbeats();
    expect(hb.length).toBe(1);
    expect(hb[0].reason).toBe('too_short');
    // A deterministic gate skip is BY DESIGN, not an infra fault — 'ok'
    // keeps doctor's skipped/failed counters (and any alerting on
    // 'degraded') from firing on every "Thanks" (adversarial review).
    expect(hb[0].outcome).toBe('ok');
  });

  test('assistant-only stop payload → no_user_turn skip', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTranscript('', { assistantOnly: true });
    expect(await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }),
    })).toBe(0);
    expect((await wbHeartbeats())[0]?.reason).toBe('no_user_turn');
  });

  test('tool_result user entries do not shadow the genuine user prompt', async () => {
    writeConfig({ writeback: 'salient' });
    const prompt = 'I prefer dark mode in every editor, and I want weekly summaries.';
    const t = writeTranscriptWithToolResult(prompt, 20);
    expect(await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }),
    })).toBe(0);
    const file = readdirSync(corpus()).find((f) => /^s-wb\.wb-[0-9a-f]{24}\.txt$/.test(f));
    expect(file).toBeDefined();
    expect(await Bun.file(join(corpus(), file!)).text()).toBe(prompt + '\n');
  });

  test('tool_result beyond the cheap tail triggers the wide retry for the genuine prompt', async () => {
    writeConfig({ writeback: 'salient' });
    const prompt = 'I prefer dark mode in every editor, and I want weekly summaries.';
    const t = writeTranscriptWithToolResult(prompt, 140_000);
    expect(await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }),
    })).toBe(0);
    const file = readdirSync(corpus()).find((f) => /^s-wb\.wb-[0-9a-f]{24}\.txt$/.test(f));
    expect(file).toBeDefined();
    expect(await Bun.file(join(corpus(), file!)).text()).toBe(prompt + '\n');
  });

  test('user turn pushed past the 128KB tail by ONE huge assistant payload: wide retry finds it — banked, NOT no_user_turn', async () => {
    writeConfig({ writeback: 'salient' });
    // The assistant turn between the last user turn and EOF exceeds
    // WRITEBACK_TRANSCRIPT_TAIL_BYTES (128KB), so the cheap tail parse sees
    // only a partial assistant line and NO user turn (turn OFFSET from EOF ≠
    // turn SIZE). The one-shot retry at the 2MB user-prompt cap must recover
    // the turn instead of skipping with no_user_turn.
    const t = writeTranscript(
      'I am allergic to peanuts and I prefer dark mode in every editor, please remember this context',
      { assistantFillerChars: 140_000 },
    );
    const code = await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }),
    });
    expect(code).toBe(0);
    // The durable artifact exists — the user turn WAS found and banked.
    const files = readdirSync(corpus()).filter((f) => /^s-wb\.wb-[0-9a-f]{24}\.txt$/.test(f));
    expect(files.length).toBe(1);
    const hb = await wbHeartbeats();
    expect(hb.length).toBe(1);
    const reason = String(hb[0].reason);
    expect(reason).not.toBe('no_user_turn');
    // Serve is down in this hermetic setup, so post-bank the infra lane
    // reports no_serve; any banked/scheduled-family reason is acceptable —
    // what this test pins is that the turn was FOUND and banked.
    expect(
      ['wb_banked', 'wb_scheduled', 'wb_dup', 'no_serve', 'ipc_unavailable', 'stale_serve'].includes(reason) ||
        reason.startsWith('flush_skip_'),
    ).toBe(true);
  });

  test('substantive turn, serve DOWN: wb file banked (redacted, content-addressed), degraded no_serve, exit 0 — sweep picks it up later', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTranscript('I prefer dark mode in every editor, and I want weekly summaries.');
    const code = await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }),
    });
    expect(code).toBe(0);
    const files = readdirSync(corpus()).filter((f) => /^s-wb\.wb-[0-9a-f]{24}\.txt$/.test(f));
    expect(files.length).toBe(1);
    const hb = await wbHeartbeats();
    expect(hb[0].reason).toBe('no_serve');
    expect(hb[0].outcome).toBe('degraded');
  });

  test('duplicate turn re-fire: same wb filename, second run is wb_dup — no second file, no re-submit storm', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTranscript('I decided to consolidate the staging environments next week.');
    const payload = JSON.stringify({ session_id: 's-wb', transcript_path: t.path });
    expect(await runHook(['stop'], { ...io, transcriptRoot: t.root, stdin: payload })).toBe(0);
    expect(await runHook(['stop'], { ...io, transcriptRoot: t.root, stdin: payload })).toBe(0);
    const files = readdirSync(corpus()).filter((f) => f.includes('.wb-'));
    expect(files.length).toBe(1);
    const hb = await wbHeartbeats();
    expect(hb.length).toBe(2);
    expect(hb.map((e) => e.reason).sort()).toEqual(['no_serve', 'wb_dup']);
  });

  test('serve UP: prompt-harvest ask rides the compact-bank IPC lane with bankOnly + wb basename + trigger + GBRAIN_SOURCE (OV-A6)', async () => {
    const dataDir = writeConfig({ writeback: 'salient' });
    process.env.GBRAIN_SOURCE = 'wiki';
    mkdirSync(dataDir, { recursive: true });
    const secret = ensureIpcSecret(dataDir);
    const seen: ContextPackRequest[] = [];
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      {
        resolve: async () => null,
        turn_context: async () => null,
        context_pack: async (req: ContextPackRequest) => {
          seen.push(req);
          return { text: '', pointers: [], factsCount: 0, checkpointFlush: { status: 'scheduled' } } as unknown as TurnContextResult;
        },
      },
      { secret },
    );
    expect(server).not.toBeNull();
    servers.push(server!);

    const t = writeTranscript('I moved our weekly sync to Tuesdays at 10am going forward.');
    const code = await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }),
    });
    expect(code).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0].bankOnly).toBe(true);
    expect(seen[0].trigger).toBe('writeback-bank');
    expect(seen[0].sourceId).toBe('wiki');
    // `.src-wiki` banks GBRAIN_SOURCE in the NAME so the sweep fallback
    // files the turn into the same source the IPC lane carries here
    // (source-isolation invariant — adversarial review, this wave).
    expect(seen[0].flushCorpusFile).toMatch(/^s-wb\.wb-[0-9a-f]{24}\.src-wiki\.txt$/);
    const hb = await wbHeartbeats();
    expect(hb.some((e) => e.reason === 'wb_scheduled' && e.outcome === 'ok')).toBe(true);
  });
});

describe('hook stop — pasted content (#5812)', () => {
  const OWN = 'I prefer dark roast coffee and I want it on every order.';

  test('a mixed last turn banks only the user\'s own words', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTurns([{ role: 'user', text: `Please remember this note I got: \n\n${PASTE}\n\n ${OWN}` }, { role: 'assistant', text: 'Saved.' }]);
    expect(await runHook(['stop'], { ...io, transcriptRoot: t.root, stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }) })).toBe(0);
    expect(bankedTexts()).toEqual([`Please remember this note I got: ${OWN}\n`]);
  });

  test('a paste-only last turn banks nothing new: the previous genuine turn is the candidate (wb_dup)', async () => {
    writeConfig({ writeback: 'salient' });
    const first = [{ role: 'user' as const, text: OWN }, { role: 'assistant' as const, text: 'Saved.' }];
    let t = writeTurns(first);
    const payload = () => JSON.stringify({ session_id: 's-wb', transcript_path: t.path });
    expect(await runHook(['stop'], { ...io, transcriptRoot: t.root, stdin: payload() })).toBe(0);
    t = writeTurns([...first, { role: 'user', text: `\n\n${PASTE}\n` }, { role: 'assistant', text: 'Is this the same email?' }]);
    expect(await runHook(['stop'], { ...io, transcriptRoot: t.root, stdin: payload() })).toBe(0);
    expect(bankedTexts()).toEqual([`${OWN}\n`]);
    expect((await wbHeartbeats()).map((e) => e.reason)).toEqual(['no_serve', 'wb_dup']);
  });

  test('a session whose only user turn is a paste → no_user_turn, no file', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTurns([{ role: 'user', text: PASTE }, { role: 'assistant', text: 'Got it.' }]);
    expect(await runHook(['stop'], { ...io, transcriptRoot: t.root, stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }) })).toBe(0);
    expect(bankedTexts()).toEqual([]);
    expect((await wbHeartbeats())[0]?.reason).toBe('no_user_turn');
  });
});

describe('hook stop — gbrain claude-cli self-capture (#5820)', () => {
  const PROMPT = 'Extract the facts from the following page and return them as JSON objects.';

  test('a Stop payload from a claude-cli scratch session banks nothing: by-design self_capture', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTurns([{ role: 'user', text: PROMPT }, { role: 'assistant', text: '{"facts":[]}' }], `-tmp-${CLAUDE_CLI_CWD_PREFIX}4242`);
    expect(await runHook(['stop'], { ...io, transcriptRoot: t.root, stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path }) })).toBe(0);
    expect(bankedTexts()).toEqual([]);
    const hb = await wbHeartbeats();
    expect(hb.map((e) => [e.reason, e.outcome])).toEqual([['self_capture', 'ok']]);
  });

  test('the payload cwd fingerprint alone is enough', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTurns([{ role: 'user', text: PROMPT }, { role: 'assistant', text: '{"facts":[]}' }]);
    const cwd = join(tmpdir(), `${CLAUDE_CLI_CWD_PREFIX}4242`);
    expect(await runHook(['stop'], { ...io, transcriptRoot: t.root, stdin: JSON.stringify({ session_id: 's-wb', transcript_path: t.path, cwd }) })).toBe(0);
    expect(bankedTexts()).toEqual([]);
    expect((await wbHeartbeats())[0]?.reason).toBe('self_capture');
  });
});

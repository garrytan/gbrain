/**
 * `gbrain hook user-prompt|session-end --harness hermes`: Hermes' pre_llm_call
 * and on_session_finalize shell hooks (agent/shell_hooks.py, v0.21.7). In-process
 * stdin→stdout contract against an in-process IPC server, like
 * test/hook-command.serial.test.ts for Claude Code and Codex.
 *
 * Authoring gate:
 *  1. Protects: the Hermes payload shape ({hook_event_name, session_id, cwd,
 *     extra:{user_message,is_first_turn}}) is parsed, the answer is exactly
 *     Hermes' {"context": "..."} envelope under the output cap, the first turn
 *     of a session (and the first turn gbrain sees of a resumed one) also
 *     carries the session-start pack, and every failure is silent exit 0.
 *     The session-end lane reads the pinned state.db by session id, never a
 *     payload path, and skips non-human sessions.
 *  2. Fails on: Claude-shaped hookSpecificOutput printed to Hermes, a digest
 *     repeated on every turn, a digest lost on resume, output over the spill
 *     threshold, a payload path steering the transcript read, a cron session
 *     captured.
 *  3. Serial: sets GBRAIN_HOME / HERMES_HOME in process.env.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Database } from 'bun:sqlite';
import { runHook, readHeartbeatTail } from '../src/commands/hook.ts';
import { ensureIpcSecret, resolveSocketPath, startResolveIpcServer, type ContextPackRequest, type TurnContextRequest } from '../src/core/context/resolve-ipc.ts';
import { captureSpecFor, CAPTURE_SPECS } from '../src/core/transcripts/capture-spec.ts';
import { confineHermesStateDb, parseHermesHookSession } from '../src/core/transcripts/hermes-hook-lane.ts';
import { HERMES_CONTEXT_MAX_CHARS, parseHermesPromptPayload, parseHermesStdin } from '../src/core/context/hermes-hook.ts';
import { configDir } from '../src/core/config.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'HERMES_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_CORE', 'GBRAIN_MEMORABLE'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;
let servers: net.Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-hh-'));
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GBRAIN_HOME = tmp;
  process.env.HERMES_HOME = join(tmp, 'hermes');
  mkdirSync(process.env.HERMES_HOME, { recursive: true });
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch { /* noop */ } }
  servers = [];
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');
const collect = () => { let buf = ''; return { io: { write: (s: string) => { buf += s; } }, get: () => buf }; };
const lastHeartbeat = async () => (await readHeartbeatTail(1))[0];

function writePgliteConfig(dataDir: string): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
}

async function startServer(dataDir: string, opts: { turn?: string | null; pack?: string | null; core?: string; onTurn?: (r: TurnContextRequest) => void; onPack?: (r: ContextPackRequest) => void } = {}): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const secret = ensureIpcSecret(dataDir);
  const server = await startResolveIpcServer(resolveSocketPath(dataDir), {
    resolve: async () => null,
    turn_context: async (req) => { opts.onTurn?.(req); return opts.turn == null ? null : { text: opts.turn, pointers: [], factsCount: 0 }; },
    context_pack: async (req) => { opts.onPack?.(req); return opts.pack == null ? null : { text: opts.pack, pointers: [], factsCount: 0, ...(opts.core ? { core: { text: opts.core, revision: 'r1', chars_used: opts.core.length, chars_limit: 4000, truncated: false } } : {}) }; },
  }, { secret });
  expect(server).not.toBeNull();
  servers.push(server!);
}

/** Hermes' real pre_llm_call stdin: one JSON object, the user message and is_first_turn under extra. */
const payload = (over: { prompt?: string; first?: boolean; session?: string; event?: string; extra?: Record<string, unknown> } = {}) => JSON.stringify({
  hook_event_name: over.event ?? 'pre_llm_call', tool_name: null, tool_input: null, session_id: over.session ?? 'sess-h1', cwd: tmp, profile: 'default',
  extra: { task_id: 't1', turn_id: 'u1', user_message: over.prompt ?? 'what do we know about Acme?', conversation_history: [{ role: 'user', content: 'x'.repeat(2000) }], is_first_turn: over.first ?? false, model: 'm', platform: 'cli', ...over.extra },
});

describe('parseHermesPromptPayload', () => {
  test('reads the user message, session, cwd and first-turn flag from extra; ignores the conversation history', () => {
    const p = parseHermesPromptPayload(JSON.parse(payload({ first: true })));
    expect(p).toEqual({ prompt: 'what do we know about Acme?', sessionId: 'sess-h1', cwd: tmp, firstTurn: true, nonHuman: false });
  });
  test('another event, an empty message or a missing extra is null (a misregistered hook stays silent)', () => {
    expect(parseHermesPromptPayload(JSON.parse(payload({ event: 'post_llm_call' })))).toBeNull();
    expect(parseHermesPromptPayload(JSON.parse(payload({ prompt: '   ' })))).toBeNull();
    expect(parseHermesPromptPayload({ hook_event_name: 'pre_llm_call', session_id: 'x' })).toBeNull();
    expect(parseHermesPromptPayload({ hook_event_name: 'pre_llm_call', extra: { user_message: 5 } })).toBeNull();
  });
});

describe('user-prompt --harness hermes', () => {
  test('answers with exactly {"context": ...}, attributes the delivery to the hermes channel, and sends the prompt as the window', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    const seen: TurnContextRequest[] = [];
    await startServer(dataDir, { turn: 'RELEVANT-ACME-BLOCK', onTurn: (r) => seen.push(r) });
    const out = collect();
    expect(await runHook(['user-prompt', '--harness', 'hermes'], { ...out.io, stdin: payload() })).toBe(0);
    const line = out.get();
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed)).toEqual(['context']);
    expect(parsed.context).toBe('RELEVANT-ACME-BLOCK');
    expect(line).not.toContain('hookSpecificOutput');
    expect(seen).toHaveLength(1);
    expect(seen[0].channel).toBe('hermes');
    expect(seen[0].sessionId).toBe('sess-h1');
    expect(seen[0].window).toEqual([{ role: 'user', text: 'what do we know about Acme?' }]);
    expect((await lastHeartbeat())?.outcome).toBe('ok');
  });

  test('the first turn also carries the session-start pack (core first); later turns of the same session do not', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    const packs: ContextPackRequest[] = [];
    await startServer(dataDir, { turn: 'TURN-BLOCK', pack: 'RECENT-WORLD-FACTS', core: 'CORE-MEMORY', onPack: (r) => packs.push(r) });
    const first = collect();
    await runHook(['user-prompt', '--harness', 'hermes'], { ...first.io, stdin: payload({ first: true }) });
    const ctx = JSON.parse(first.get()).context as string;
    expect(ctx).toContain('CORE-MEMORY');
    expect(ctx).toContain('RECENT-WORLD-FACTS');
    expect(ctx).toContain('TURN-BLOCK');
    expect(ctx.indexOf('CORE-MEMORY')).toBeLessThan(ctx.indexOf('TURN-BLOCK'));
    expect(packs).toHaveLength(1);
    expect(packs[0].trigger).toBe('session-start:hermes');
    expect(packs[0].sessionId).toBe('sess-h1');

    const second = collect();
    await runHook(['user-prompt', '--harness', 'hermes'], { ...second.io, stdin: payload({ first: false }) });
    expect(JSON.parse(second.get()).context).toBe('TURN-BLOCK');
    expect(packs).toHaveLength(1);
  });

  test('a resumed session (Hermes reports is_first_turn=false) gets the digest once, on the first turn gbrain sees', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    const packs: ContextPackRequest[] = [];
    await startServer(dataDir, { turn: 'TURN-BLOCK', pack: 'RECENT-WORLD-FACTS', onPack: (r) => packs.push(r) });
    const a = collect();
    await runHook(['user-prompt', '--harness', 'hermes'], { ...a.io, stdin: payload({ first: false, session: 'resumed-1' }) });
    expect(JSON.parse(a.get()).context).toContain('RECENT-WORLD-FACTS');
    expect(existsSync(join(home(), 'integrations', 'hermes', 'sessions', 'resumed-1'))).toBe(true);
    const b = collect();
    await runHook(['user-prompt', '--harness', 'hermes'], { ...b.io, stdin: payload({ first: false, session: 'resumed-1' }) });
    expect(JSON.parse(b.get()).context).toBe('TURN-BLOCK');
    const c = collect();
    await runHook(['user-prompt', '--harness', 'hermes'], { ...c.io, stdin: payload({ first: false, session: 'other-session' }) });
    expect(JSON.parse(c.get()).context).toContain('RECENT-WORLD-FACTS');
    expect(packs).toHaveLength(2);
  });

  test('the whole context stays under the spill threshold even when the serve returns a huge block', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer(dataDir, { turn: 'T'.repeat(30_000), pack: 'P'.repeat(30_000), core: 'C'.repeat(30_000) });
    const out = collect();
    await runHook(['user-prompt', '--harness', 'hermes'], { ...out.io, stdin: payload({ first: true }) });
    const ctx = JSON.parse(out.get()).context as string;
    expect(ctx.length).toBeLessThanOrEqual(HERMES_CONTEXT_MAX_CHARS);
    expect(out.get().length).toBeLessThan(10_000);
  });

  test('fail-open: no stdin, garbage, another event, no serve, no config, an empty block — all exit 0 with empty stdout', async () => {
    const dataDir = join(tmp, 'data');
    const cases: Array<[string, string | undefined]> = [['no stdin', ''], ['garbage', '{nope'], ['wrong event', payload({ event: 'post_llm_call' })], ['array', '[]'], ['no config', payload()]];
    for (const [, stdin] of cases) {
      const out = collect();
      expect(await runHook(['user-prompt', '--harness', 'hermes'], { ...out.io, stdin })).toBe(0);
      expect(out.get()).toBe('');
    }
    writePgliteConfig(dataDir);
    const noServe = collect();
    expect(await runHook(['user-prompt', '--harness', 'hermes'], { ...noServe.io, stdin: payload() })).toBe(0);
    expect(noServe.get()).toBe('');
    expect((await lastHeartbeat())?.outcome).toBe('degraded');
    await startServer(dataDir, { turn: '' });
    const empty = collect();
    expect(await runHook(['user-prompt', '--harness', 'hermes'], { ...empty.io, stdin: payload() })).toBe(0);
    expect(empty.get()).toBe('');
  });

  test('GBRAIN_HOOKS=0 is an immediate silent exit 0 with no heartbeat', async () => {
    process.env.GBRAIN_HOOKS = '0';
    const out = collect();
    expect(await runHook(['user-prompt', '--harness', 'hermes'], { ...out.io, stdin: payload() })).toBe(0);
    expect(out.get()).toBe('');
    expect(existsSync(join(home(), 'integrations', 'hooks', 'heartbeat.jsonl'))).toBe(false);
  });

  test('the default and other harnesses keep the Claude-shaped envelope (no regression)', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer(dataDir, { turn: 'ok' });
    const out = collect();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hello Acme' }) });
    expect(JSON.parse(out.get()).hookSpecificOutput.additionalContext).toContain('ok');
  });
});

describe('review finding 3: the serve wait is paid once per session, not on every turn', () => {
  const receipt = () => writeFileSync(join(process.env.HERMES_HOME!, '.gbrain-connection-hermes-gbrain.json'), JSON.stringify({
    harness: 'hermes', connection: 'local-stdio', setup_receipt_version: 3, status: 'installed', name: 'gbrain', gbrain_home: configDir(),
    consent: { providers: { value: 'declined', source: 'default' } } }));
  const noServe = () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    mkdirSync(dataDir, { recursive: true });
    ensureIpcSecret(dataDir); // a secret without a listening serve: the shape of `hermes -z -t` or a serve that never starts
  };

  test('with no serve answering, the first turn may wait but later turns of the session take the plain path and the sentinel is written', async () => {
    receipt();
    noServe();
    const t0 = Date.now();
    const a = collect();
    expect(await runHook(['user-prompt', '--harness', 'hermes'], { ...a.io, stdin: payload({ first: true, session: 'sess-wait' }) })).toBe(0);
    const firstMs = Date.now() - t0;
    expect(a.get()).toBe('');
    expect((await lastHeartbeat())).toMatchObject({ outcome: 'degraded', reason: 'serve_not_ready' });
    expect(existsSync(join(home(), 'integrations', 'hermes', 'sessions', 'sess-wait'))).toBe(true);
    expect(firstMs).toBeGreaterThan(1500); // the one allowed wait actually happened (otherwise this test proves nothing)
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      const o = collect();
      await runHook(['user-prompt', '--harness', 'hermes'], { ...o.io, stdin: payload({ first: false, session: 'sess-wait' }) });
      expect(Date.now() - t).toBeLessThan(1200);
      expect(o.get()).toBe('');
    }
  }, 30_000);

  test('an empty digest (serve up, nothing to say) also ends the first-turn attempt: the next turn is not first', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    const packs: ContextPackRequest[] = [];
    await startServer(dataDir, { turn: null, pack: null, onPack: (r) => packs.push(r) });
    await runHook(['user-prompt', '--harness', 'hermes'], { ...collect().io, stdin: payload({ first: true, session: 'sess-empty' }) });
    expect(packs).toHaveLength(1);
    expect(existsSync(join(home(), 'integrations', 'hermes', 'sessions', 'sess-empty'))).toBe(true);
    await runHook(['user-prompt', '--harness', 'hermes'], { ...collect().io, stdin: payload({ first: false, session: 'sess-empty' }) });
    expect(packs).toHaveLength(1);
  });

  test('a resumed session (is_first_turn=false, no sentinel) never pays the serve wait', async () => {
    receipt();
    noServe();
    const t = Date.now();
    await runHook(['user-prompt', '--harness', 'hermes'], { ...collect().io, stdin: payload({ first: false, session: 'sess-resumed-nowait' }) });
    expect(Date.now() - t).toBeLessThan(2500);
  }, 30_000);
});

describe('review finding 4: large Hermes payloads still work', () => {
  const big = (mb: number, over: Parameters<typeof payload>[0] = {}) => {
    const body = JSON.parse(payload(over));
    body.extra.conversation_history = [{ role: 'tool', content: 'x'.repeat(mb * 1024 * 1024) }];
    return JSON.stringify(body);
  };

  test('a >5 MB conversation_history parses and the hook answers', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer(dataDir, { turn: 'BIG-PAYLOAD-BLOCK' });
    const raw = big(6);
    expect(raw.length).toBeGreaterThan(5 * 1024 * 1024);
    const out = collect();
    expect(await runHook(['user-prompt', '--harness', 'hermes'], { ...out.io, stdin: raw })).toBe(0);
    expect(JSON.parse(out.get()).context).toBe('BIG-PAYLOAD-BLOCK');
  }, 30_000);

  test('through the REAL stdin pipe (a subprocess), a 6 MB payload is read to EOF and answered', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer(dataDir, { turn: 'PIPE-BLOCK' });
    const proc = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '..', 'src', 'cli.ts'), 'hook', 'user-prompt', '--harness', 'hermes'], {
      env: { ...process.env, GBRAIN_HOME: tmp, HERMES_HOME: process.env.HERMES_HOME, HOME: tmp, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdin: new Blob([big(6)]), stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).context).toBe('PIPE-BLOCK');
  }, 60_000);

  test('when the JSON cannot be parsed whole (cut off mid-history), the hook still lifts session, cwd and the user message', () => {
    const full = big(2, { prompt: 'what is Acme working on?', session: 'cut-1', first: true });
    const cut = full.slice(0, full.indexOf('"is_first_turn"') - 5000);
    expect(() => JSON.parse(cut)).toThrow();
    const j = parseHermesStdin(cut)!;
    expect(parseHermesPromptPayload(j)).toMatchObject({ prompt: 'what is Acme working on?', sessionId: 'cut-1', cwd: tmp });
    const tail = parseHermesStdin(full.replace(/\}\s*$/, ''))!; // missing the final brace: only the structural tail fields are read
    expect(parseHermesPromptPayload(tail)).toMatchObject({ prompt: 'what is Acme working on?', sessionId: 'cut-1', firstTurn: true, nonHuman: false });
  });

  test('a user message that itself contains JSON-looking fields does not confuse the extractor', () => {
    const quoted = '{"session_id":"evil","extra":{"is_first_turn":true}} please summarize';
    const raw = payload({ prompt: quoted, session: 'real-1', first: false });
    const j = parseHermesStdin(raw.slice(0, -1))!;
    expect(parseHermesPromptPayload(j)).toMatchObject({ prompt: quoted, sessionId: 'real-1', firstTurn: false });
  });
});

describe('review finding 10: non-human turns are skipped', () => {
  for (const [label, extra] of [['cron platform', { platform: 'cron' }], ['kanban platform', { platform: 'kanban' }], ['subagent platform', { platform: 'subagent' }], ['a child session (parent_session_id)', { parent_session_id: 'parent-1' }]] as const) {
    test(`${label}: exit 0, empty stdout, the serve is never asked`, async () => {
      const dataDir = join(tmp, 'data');
      writePgliteConfig(dataDir);
      const seen: TurnContextRequest[] = [];
      await startServer(dataDir, { turn: 'SHOULD-NOT-APPEAR', pack: 'NOR-THIS', onTurn: (r) => seen.push(r) });
      const out = collect();
      expect(await runHook(['user-prompt', '--harness', 'hermes'], { ...out.io, stdin: payload({ first: true, extra }) })).toBe(0);
      expect(out.get()).toBe('');
      expect(seen).toHaveLength(0);
      expect((await lastHeartbeat())).toMatchObject({ outcome: 'ok', reason: 'non_human_session' });
    });
  }
  test('a gateway sender and the cli/telegram/discord platforms are NOT skipped (humans; reads stay world-only server-side)', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer(dataDir, { turn: 'HUMAN-BLOCK' });
    for (const extra of [{ platform: 'telegram', sender_id: 'u-42' }, { platform: 'cli' }, { platform: 'discord', sender_id: 'u-7', parent_session_id: '' }]) {
      const out = collect();
      await runHook(['user-prompt', '--harness', 'hermes'], { ...out.io, stdin: payload({ extra }) });
      expect(JSON.parse(out.get()).context).toBe('HUMAN-BLOCK');
    }
  });
  test('parseHermesPromptPayload flags the non-human shapes', () => {
    expect(parseHermesPromptPayload(JSON.parse(payload({ extra: { platform: 'Cron' } })))?.nonHuman).toBe(true);
    expect(parseHermesPromptPayload(JSON.parse(payload({ extra: { parent_session_id: 'p' } })))?.nonHuman).toBe(true);
    expect(parseHermesPromptPayload(JSON.parse(payload({ extra: { platform: 'cli', parent_session_id: '' } })))?.nonHuman).toBe(false);
  });
});

describe('session-end --harness hermes (on_session_finalize)', () => {
  const hermesHome = () => process.env.HERMES_HOME!;
  const spooled = (id: string) => join(home(), 'transcripts', 'corpus', 'sourced', `${id}.src-_unresolved.txt`);

  test('captures the session by id from the pinned state.db, secret-scanned; a payload transcript_path is ignored', async () => {
    buildHermesFixture(hermesHome());
    const outside = join(tmp, 'evil.jsonl');
    writeFileSync(outside, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'EVIL-PAYLOAD-PATH' } })}\n`);
    expect(await runHook(['session-end', '--harness', 'hermes'], {
      stdin: JSON.stringify({ hook_event_name: 'on_session_finalize', session_id: 'hermes-fixture-1', cwd: tmp, transcript_path: outside, extra: { platform: 'cli', reason: 'exit' } }),
    })).toBe(0);
    const body = readFileSync(spooled('hermes-fixture-1'), 'utf8');
    expect(body).toContain('Draft the widget-co launch checklist.');
    expect(body).toContain('Launch checklist drafted');
    expect(body).not.toContain('EVIL-PAYLOAD-PATH');
    expect(body).not.toContain('TOOL-ONLY-TEXT');
    expect((await lastHeartbeat())).toMatchObject({ event: 'session-end', outcome: 'ok', turns: 2 });
  });

  test('a planted secret in the conversation is redacted at write time', async () => {
    buildHermesFixture(hermesHome());
    const planted = `sk-${'FAKEfakeFAKEfake1234567890'}`;
    const db = new Database(join(hermesHome(), 'state.db'));
    db.run("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('hermes-fixture-1', 'user', ?, 1785916820)", [`my key is ${planted}`]);
    db.close();
    await runHook(['session-end', '--harness', 'hermes'], { stdin: JSON.stringify({ session_id: 'hermes-fixture-1', cwd: tmp }) });
    const body = readFileSync(spooled('hermes-fixture-1'), 'utf8');
    expect(body).not.toContain(planted);
    expect(body).toContain('<REDACTED:openai>');
  });

  test('non-human sessions (cron, subagent, kanban) and unknown ids are not captured', async () => {
    buildHermesFixture(hermesHome());
    const db = new Database(join(hermesHome(), 'state.db'));
    for (const [id, source] of [['cron-1', 'cron'], ['sub-1', 'subagent'], ['kan-1', 'kanban']] as const) {
      db.run('INSERT INTO sessions (id, source, started_at) VALUES (?, ?, 1785916900)', [id, source]);
      db.run("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', 'automated prompt', 1785916901)", [id]);
      db.run("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', 'automated reply', 1785916902)", [id]);
    }
    db.close();
    for (const id of ['cron-1', 'sub-1', 'kan-1', 'no-such-session']) {
      expect(await runHook(['session-end', '--harness', 'hermes'], { stdin: JSON.stringify({ session_id: id, cwd: tmp }) })).toBe(0);
      expect(existsSync(spooled(id))).toBe(false);
    }
    // The gateway source is a human conversation and is captured.
    expect(await runHook(['session-end', '--harness', 'hermes'], { stdin: JSON.stringify({ session_id: 'hermes-fixture-2', cwd: tmp }) })).toBe(0);
    expect(readFileSync(spooled('hermes-fixture-2'), 'utf8')).toContain('acme-seed closes');
  });

  test('a missing state.db is a degraded, silent exit 0', async () => {
    expect(await runHook(['session-end', '--harness', 'hermes'], { stdin: JSON.stringify({ session_id: 'x', cwd: tmp }) })).toBe(0);
    expect((await lastHeartbeat())?.outcome).toBe('degraded');
  });

  test('GBRAIN_HOOKS=0 captures nothing', async () => {
    buildHermesFixture(hermesHome());
    process.env.GBRAIN_HOOKS = '0';
    expect(await runHook(['session-end', '--harness', 'hermes'], { stdin: JSON.stringify({ session_id: 'hermes-fixture-1', cwd: tmp }) })).toBe(0);
    expect(existsSync(spooled('hermes-fixture-1'))).toBe(false);
  });
});

describe('hermes capture spec', () => {
  test('captureSpecFor routes hermes to its own spec; every other value keeps today\'s routing', () => {
    expect(captureSpecFor('hermes')).toBe(CAPTURE_SPECS.hermes);
    expect(captureSpecFor('codex')).toBe(CAPTURE_SPECS.codex);
    expect(captureSpecFor('opencode')).toBe(CAPTURE_SPECS['claude-code']);
    expect(captureSpecFor(undefined)).toBe(CAPTURE_SPECS['claude-code']);
    expect(captureSpecFor('hermes').discover).toBeUndefined();
  });

  test('confineHermesStateDb always means <hermes home>/state.db: the payload path is ignored; a symlink, a directory or a missing store is refused', () => {
    const root = join(tmp, 'h');
    mkdirSync(root, { recursive: true });
    expect(confineHermesStateDb('/etc/passwd', { root })).toEqual({ ok: false, reason: 'missing_path' });
    buildHermesFixture(root);
    expect(confineHermesStateDb('/etc/passwd', { root })).toMatchObject({ ok: true, path: join(root, 'state.db') });
    expect(confineHermesStateDb(undefined, { root })).toMatchObject({ ok: true, path: join(root, 'state.db') });
    const linked = join(tmp, 'linked');
    mkdirSync(linked);
    symlinkSync(join(root, 'state.db'), join(linked, 'state.db'));
    expect(confineHermesStateDb(null, { root: linked })).toEqual({ ok: false, reason: 'symlink' });
    const dirStore = join(tmp, 'dirstore');
    mkdirSync(join(dirStore, 'state.db'), { recursive: true });
    expect(confineHermesStateDb(null, { root: dirStore })).toEqual({ ok: false, reason: 'not_file' });
  });

  test('parseHermesHookSession returns the human turns oldest first, and empty for no session id', () => {
    const root = join(tmp, 'h2');
    mkdirSync(root, { recursive: true });
    buildHermesFixture(root);
    const p = parseHermesHookSession(join(root, 'state.db'), { sessionId: 'hermes-fixture-2' });
    expect(p.turns).toEqual([{ role: 'user', text: 'When is the acme-seed close?' }, { role: 'assistant', text: 'acme-seed closes at the end of the month.' }]);
    expect(p.genuineUserTurnIndexes).toEqual([0]);
    expect(parseHermesHookSession(join(root, 'state.db')).turns).toEqual([]);
  });
});

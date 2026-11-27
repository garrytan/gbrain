/**
 * Roadmap PR 2 (d7, d8, d13, d14): the first-session section rides the SessionStart pack as a named section, and the
 * hook acknowledges it only after the payload that held it was written.
 *
 * Hermetic: the serve is an in-process IPC listener answering with the real context_pack handler over an in-memory
 * PGLite brain whose install receipt a setup run wrote. Serial: env and sockets.
 *
 * 1. Protects: a startup session gets the section once and it counts only after the hook's receipt; resume, clear
 *    and compact take no slot; an older hook (no `sections⟧B⟧) gets nothing and reserves nothing; a new hook names why it
 *    got nothing from an older serve, a stale serve or no serve; a member-bound lane gets no section; the receipt is
 *    retried once, and a receipt that never lands counts nothing.
 * 2. Fails when: a section counts without a receipt, a non-startup session consumes a slot, an old hook reserves, a
 *    member-bound serve pushes the section, or the outcome log misnames what happened.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import type net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runHook } from '../src/commands/hook.ts';
import {
  ensureIpcSecretForConfig, requestContextPack, resolveSocketPathForConfig, startResolveIpcServer, type IpcPathConfig,
} from '../src/core/context/resolve-ipc.ts';
import { acknowledgeSessionStartSection, settleFirstSession } from '../src/core/context/session-start-pack.ts';
import { readFirstSessionOutcomes } from '../src/core/context/session-start-sections.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { INSTALL_RECEIPT_KEY } from '../src/core/onboard/setup-history.ts';
import {
  FIRST_SESSION_KEY, __resetFirstSessionQuietForTests, firstSessionCoachingQuiet, firstSessionStatus, reserveFirstSession,
  type FirstSessionLane,
} from '../src/core/onboard/first-session.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_HOOK_LANE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
const SECTION_HEAD = 'First sessions on this brain';

let engine: PGLiteEngine;
let tmp: string;
let ws: string;
let saved: Record<string, string | undefined>;
let servers: net.Server[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  __resetHotMemoryCacheForTests();
  __resetFirstSessionQuietForTests();
  tmp = mkdtempSync(join(tmpdir(), 'gb-fss-'));
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GBRAIN_HOME = tmp;
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
  process.env.CODEX_HOME = join(tmp, 'codex');
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  ws = join(tmp, 'ws');
  mkdirSync(ws, { recursive: true });
  await engine.executeRaw('DELETE FROM config WHERE key IN ($1, $2)', [INSTALL_RECEIPT_KEY, FIRST_SESSION_KEY]);
  await engine.setConfig(INSTALL_RECEIPT_KEY, JSON.stringify({
    version: 1, install_id: randomUUID(), created_at: new Date().toISOString(), created_by: 'setup', harness: 'claude-code', eligible: true, stages: {},
  }));
});

afterEach(() => {
  for (const s of servers) { try { s.close(); } catch { /* noop */ } }
  servers = [];
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

function config(): IpcPathConfig {
  const cfg: IpcPathConfig = { engine: 'pglite', database_path: join(tmp, 'db') };
  mkdirSync(join(tmp, 'db'), { recursive: true });
  mkdirSync(join(tmp, '.gbrain'), { recursive: true });
  writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify(cfg));
  return cfg;
}

async function serve(cfg: IpcPathConfig, lane: FirstSessionLane | 'none' = 'owner', path = resolveSocketPathForConfig(cfg, 'resolve')!): Promise<void> {
  const secret = ensureIpcSecretForConfig(cfg)!;
  const server = await startResolveIpcServer(path, { resolve: async () => null, context_pack: makeContextPackIpcHandler(engine, 'default', lane === 'none' ? {} : { firstSessionLane: lane }) }, { secret, boundSourceId: 'default' });
  if (!server) throw new Error(`the test serve did not start at ${path}`);
  servers.push(server);
}

/** A raw listener at the serve's socket: `answer` maps the request line to a reply line (or null: say nothing). */
async function rawServe(cfg: IpcPathConfig, answer: (line: string, n: number) => string | null, path = resolveSocketPathForConfig(cfg, 'resolve')!): Promise<void> {
  ensureIpcSecretForConfig(cfg);
  let n = 0;
  const server = createServer((sock) => {
    const i = n++;
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (!buf.includes('\n')) return;
      const reply = answer(buf.slice(0, buf.indexOf('\n')), i);
      if (reply !== null) sock.end(reply + '\n');
    });
    sock.on('error', () => {});
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  servers.push(server);
}

async function sessionStart(source: string, sessionId = `sess-${source}-${randomUUID()}`, harness: 'claude-code' | 'codex' = 'claude-code'): Promise<string> {
  let out = '';
  const code = await runHook(['session-start'], {
    stdin: JSON.stringify({ session_id: sessionId, source, cwd: ws, hook_event_name: 'SessionStart' }),
    cwd: ws, harness,
    write: (s: string) => { out += s; },
    spawnPush: () => {},
    spawnBackupCheck: () => {},
  } as never);
  expect(code).toBe(0);
  return out;
}

const lastOutcome = () => readFirstSessionOutcomes().at(-1);

/** Codex's SessionStart stdout rule (codex-rs/hooks/src/engine/output_parser.rs): stdout that starts with `{` or `[`
 *  must parse as a JSON object, or the hook fails and its context is dropped; context rides hookSpecificOutput. */
function codexSessionStartContext(stdout: string): string {
  const trimmed = stdout.trimStart();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return stdout;
  const value = JSON.parse(stdout.trim()) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: unknown } };
  expect(value !== null && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  expect(value.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  expect(typeof value.hookSpecificOutput?.additionalContext).toBe('string');
  expect((value.hookSpecificOutput!.additionalContext as string).isWellFormed()).toBe(true);
  return value.hookSpecificOutput!.additionalContext as string;
}

describe('SessionStart first-session section', () => {
  test('startup: the section is in the payload, counts after the receipt, and the outcome is delivered', async () => {
    const cfg = config();
    await serve(cfg);
    const out = await sessionStart('startup');
    expect(out).toContain(SECTION_HEAD + ' (1 of 3)');
    expect(out).toContain('gbrain onboarding off');
    expect((await firstSessionStatus(engine)).delivered_sessions).toBe(1);
    expect(lastOutcome()).toMatchObject({ harness: 'claude-code', outcome: 'delivered' });
    expect(lastOutcome()!.session).toMatch(/^[0-9a-f]{12}$/);
    expect(firstSessionCoachingQuiet()).toBe(true);
  }, 20_000);

  test('a Codex startup is delivered and counted too', async () => {
    const cfg = config();
    await serve(cfg);
    const out = await sessionStart('startup', 'codex-session-1', 'codex');
    const context = codexSessionStartContext(out);
    expect(context).toContain(SECTION_HEAD);
    expect(context).toContain('gbrain setup codex --history 30');
    expect(lastOutcome()).toMatchObject({ harness: 'codex', outcome: 'delivered' });
  }, 20_000);

  test('a fresh brain with no core: Codex gets a JSON envelope its parser accepts, Claude Code keeps plain text', async () => {
    const cfg = config();
    await serve(cfg);
    const plain = await sessionStart('startup', 'claude-fresh-1');
    expect(plain.trimStart().startsWith('[gbrain]')).toBe(true);
    expect(plain).toContain(SECTION_HEAD);
    const codex = await sessionStart('startup', 'codex-fresh-1', 'codex');
    expect(JSON.parse(codex).hookSpecificOutput.hookEventName).toBe('SessionStart');
    const context = codexSessionStartContext(codex);
    expect(context.trimStart().startsWith('[gbrain]')).toBe(true);
    expect(context).toContain(SECTION_HEAD);
  }, 20_000);

  test('a pack trimmed inside an emoji still gives Codex well-formed JSON (serde rejects a lone surrogate)', async () => {
    for (const lead of ['', 'a']) {
      const cfg = config();
      const text = lead + '\u{1F600}'.repeat(6000);
      await rawServe(cfg, () => JSON.stringify({ ok: true, protocol: 2, block: { text, pointers: [], factsCount: 0, mode: 'pack' } }));
      const context = codexSessionStartContext(await sessionStart('resume', `codex-trim-${lead || 'even'}`, 'codex'));
      expect(context).toContain('\u{1F600}');
      await Promise.all(servers.map(s => new Promise<void>(done => s.close(() => done()))));
      servers = [];
    }
  }, 20_000);

  test('resume, clear and compact consume no slot', async () => {
    const cfg = config();
    await serve(cfg);
    for (const source of ['resume', 'clear', 'compact']) expect(await sessionStart(source)).not.toContain(SECTION_HEAD);
    const status = await firstSessionStatus(engine);
    expect(status.delivered_sessions).toBe(0);
    expect(JSON.parse((await engine.getConfig(FIRST_SESSION_KEY)) ?? '{"reservations":[]}').reservations).toEqual([]);
    expect(readFirstSessionOutcomes()).toEqual([]);
  }, 20_000);

  test('an older hook (no sections declared) gets no section and reserves nothing', async () => {
    const cfg = config();
    await serve(cfg);
    const secret = ensureIpcSecretForConfig(cfg)!;
    const res = await requestContextPack(resolveSocketPathForConfig(cfg, 'resolve')!, {
      secret, sessionId: 'old-hook', sourceId: 'default', trigger: 'session-start:startup',
    });
    if (typeof res === 'symbol' || 'degraded' in res || !res.ok) throw new Error('pack failed');
    expect(res.block?.sections).toBeUndefined();
    expect(res.block?.firstSession).toBeUndefined();
    expect(res.block?.text ?? '').not.toContain(SECTION_HEAD);
    expect(await engine.getConfig(FIRST_SESSION_KEY)).toBeNull();
  }, 20_000);

  test('a new hook against an older serve (no sections in its answer): unsupported, nothing counted', async () => {
    const cfg = config();
    await rawServe(cfg, () => JSON.stringify({ ok: true, protocol: 2, block: { text: '', pointers: [], factsCount: 0, mode: 'pack' } }));
    expect(await sessionStart('startup')).not.toContain(SECTION_HEAD);
    expect(lastOutcome()).toMatchObject({ outcome: 'unsupported', reason: 'no_sections' });
  }, 20_000);

  test('a stale serve with no protocol echo: stale_protocol', async () => {
    const cfg = config();
    await rawServe(cfg, () => JSON.stringify({ ok: true, block: null }));
    await sessionStart('startup');
    expect(lastOutcome()?.outcome).toBe('stale_protocol');
  }, 20_000);

  test('no serve: no_ipc', async () => {
    config();
    expect(await sessionStart('startup')).not.toContain(SECTION_HEAD);
    expect(lastOutcome()?.outcome).toBe('no_ipc');
  }, 20_000);

  test('a member-bound serve and an HTTP-style serve (no lane) push no section and reserve nothing', async () => {
    for (const lane of ['member', 'none'] as const) {
      const cfg = config();
      await serve(cfg, lane);
      const out = await sessionStart('startup');
      expect(out).not.toContain(SECTION_HEAD);
      expect(lastOutcome()).toMatchObject({ outcome: 'not_due', reason: 'not_personal' });
      expect(await engine.getConfig(FIRST_SESSION_KEY)).toBeNull();
      await Promise.all(servers.map(s => new Promise<void>(done => s.close(() => done()))));
      servers = [];
    }
  }, 20_000);

  test('the receipt is retried once when the first connection drops', async () => {
    const cfg = config();
    const real = join(tmp, 'real.sock');
    await serve(cfg, 'owner', real);
    const reserved = await reserveFirstSession(engine, { sessionId: 'drop-first', harness: 'claude-code', lane: 'owner' });
    if (!reserved.ok) throw new Error(reserved.reason);
    let n = 0;
    const proxy = createServer((sock) => {
      sock.on('error', () => {});
      if (n++ === 0) { sock.destroy(); return; }
      const up = connect(real);
      up.on('error', () => sock.destroy());
      sock.pipe(up).pipe(sock);
    });
    await new Promise<void>(resolve => proxy.listen(resolveSocketPathForConfig(cfg, 'resolve')!, resolve));
    servers.push(proxy);
    const ack = await acknowledgeSessionStartSection(cfg, { sessionId: 'drop-first', section: 'first_session', receipt: reserved.token });
    expect(ack).toMatchObject({ result: 'recorded', retried: true });
    expect(n).toBe(2);
    expect((await firstSessionStatus(engine)).delivered_sessions).toBe(1);
  }, 20_000);

  test('a receipt that never gets an answer is ack_failed and counts nothing', async () => {
    const cfg = config();
    const reserved = await reserveFirstSession(engine, { sessionId: 'silent', harness: 'claude-code', lane: 'owner' });
    if (!reserved.ok) throw new Error(reserved.reason);
    await rawServe(cfg, () => null);
    const settled = await settleFirstSession(cfg, {
      reached: true, sections: [], firstSession: { due: true }, deadline: false, emitted: true, receipt: reserved.token, sessionId: 'silent',
    });
    expect(settled).toMatchObject({ outcome: 'ack_failed', retried: true });
    expect((await firstSessionStatus(engine)).delivered_sessions).toBe(0);
  }, 20_000);

  test('a receipt the serve refused on purpose is not_due; one it could not record is ack_failed', async () => {
    const cfg = config();
    let reason = '';
    await rawServe(cfg, () => JSON.stringify({ ok: true, protocol: 2, block: { text: '', pointers: [], factsCount: 0, mode: 'pack', sectionAck: { recorded: 'refused', reason } } }));
    const settle = () => settleFirstSession(cfg, { reached: true, sections: [], firstSession: { due: true }, deadline: false, emitted: true, receipt: 'r', sessionId: 'refused' });
    for (reason of ['stopped', 'sessions_exhausted', 'not_owner_lane']) expect(await settle()).toMatchObject({ outcome: 'not_due', reason });
    for (reason of ['contended', 'unknown_reservation', 'error']) expect(await settle()).toMatchObject({ outcome: 'ack_failed', reason });
  }, 20_000);

  test('a startup with no session id gets no section and reserves nothing', async () => {
    const cfg = config();
    await serve(cfg);
    expect(await sessionStart('startup', '')).not.toContain(SECTION_HEAD);
    expect((await firstSessionStatus(engine)).delivered_sessions).toBe(0);
    expect(JSON.parse((await engine.getConfig(FIRST_SESSION_KEY)) ?? '{"reservations":[]}').reservations).toEqual([]);
    expect(lastOutcome()).toMatchObject({ outcome: 'not_due', reason: 'no_session' });
  }, 20_000);

  test('a section the payload did not hold is trimmed and never acknowledged', async () => {
    const settled = await settleFirstSession(config(), { reached: true, sections: [], firstSession: { due: true }, deadline: false, emitted: false, receipt: 'r', sessionId: 's' });
    expect(settled.outcome).toBe('trimmed');
    expect((await firstSessionStatus(engine)).delivered_sessions).toBe(0);
  });
});

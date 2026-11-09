/**
 * Mid-session context refresh (hooks.context_refresh_every_turns): the
 * user-prompt hook pulls the session's boundary pack every Nth prompt and
 * never otherwise. In-process IPC server, same seams as
 * ambient-recall-hooks.serial.test.ts. Serial: env + sockets.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from '../src/commands/hook.ts';
import { ensureIpcSecret, resolveSocketPath, startResolveIpcServer, type ContextPackRequest } from '../src/core/context/resolve-ipc.ts';
import { countTurnAndCheckRefresh, refreshEveryTurns } from '../src/commands/hook-turn-refresh.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_CONTEXT_REFRESH_EVERY_TURNS'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;
let servers: net.Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-tr-'));
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  for (const s of servers) { try { s.close(); } catch { /* noop */ } }
  servers = [];
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('refreshEveryTurns', () => {
  test('unset, 0, negative and junk mean SessionStart only', () => {
    for (const v of [undefined, 0, -3, 2.5, 'abc', '']) {
      expect(refreshEveryTurns({ hooks: { context_refresh_every_turns: v as number | string | undefined } }, {})).toBe(0);
    }
    expect(refreshEveryTurns(null, {})).toBe(0);
  });
  test('reads the file plane (number or string) and env wins', () => {
    expect(refreshEveryTurns({ hooks: { context_refresh_every_turns: 5 } }, {})).toBe(5);
    expect(refreshEveryTurns({ hooks: { context_refresh_every_turns: '3' } }, {})).toBe(3);
    expect(refreshEveryTurns({ hooks: { context_refresh_every_turns: 5 } }, { GBRAIN_CONTEXT_REFRESH_EVERY_TURNS: '2' })).toBe(2);
  });
});

describe('countTurnAndCheckRefresh', () => {
  test('due on every Nth prompt, per session', () => {
    const dir = join(tmp, 'counts');
    mkdirSync(dir);
    expect([1, 2, 3, 4, 5, 6].map(() => countTurnAndCheckRefresh(dir, 's1', 3))).toEqual([false, false, true, false, false, true]);
    expect(countTurnAndCheckRefresh(dir, 's2', 3)).toBe(false); // separate session, separate count
    expect(countTurnAndCheckRefresh(dir, 's3', 0)).toBe(false);
  });
});

describe('user-prompt hook refresh', () => {
  async function run(prompts: number): Promise<{ packs: ContextPackRequest[]; outputs: string[] }> {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const secret = ensureIpcSecret(dataDir);
    const packs: ContextPackRequest[] = [];
    const server = await startResolveIpcServer(resolveSocketPath(dataDir), {
      resolve: async () => null,
      turn_context: async () => ({ text: 'TURN', pointers: [], factsCount: 0 }),
      context_pack: async (req) => { packs.push(req); return { text: 'NEW FACTS', pointers: [], factsCount: 1, mode: 'pack' as const }; },
    }, { secret });
    servers.push(server!);
    const outputs: string[] = [];
    for (let i = 1; i <= prompts; i++) {
      let out = '';
      await runHook(['user-prompt'], {
        write: (s) => { out += s; },
        stdin: JSON.stringify({ prompt: `question ${i}`, session_id: 'sess-r' }),
        cwd: tmp,
        configOverride: { engine: 'pglite', database_path: dataDir } as never,
        turnRule: null,
        disablePushBanner: true,
        disableTelemetry: true,
      });
      outputs.push(out);
    }
    return { packs, outputs };
  }

  test('default: no mid-session pack request', async () => {
    const { packs, outputs } = await run(3);
    expect(packs).toEqual([]);
    for (const o of outputs) expect(o).not.toContain('NEW FACTS');
  });

  test('every 2: prompts 2 and 4 carry the session pack, keyed to the session', async () => {
    process.env.GBRAIN_CONTEXT_REFRESH_EVERY_TURNS = '2';
    const { packs, outputs } = await run(4);
    expect(packs.length).toBe(2);
    expect(packs.every((p) => p.sessionId === 'sess-r' && p.trigger === 'turn-refresh' && !p.bankOnly)).toBe(true);
    expect(outputs.map((o) => o.includes('NEW FACTS'))).toEqual([false, true, false, true]);
    for (const o of outputs) expect(o).toContain('TURN'); // the per-turn block still rides every prompt
  });
});

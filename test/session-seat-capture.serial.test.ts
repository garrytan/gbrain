/**
 * #4618 seat identity on session capture: `gbrain hook session-end`,
 * `gbrain hook compact` and the OpenClaw context-engine compact record a
 * `<sessionId>.seat.json` sidecar beside the dream corpus, before any corpus
 * file of the session is renamed into place, and the hook GC reaps it with
 * the session's last corpus file.
 *
 * Authoring gate: protects the corpus-side seat contract dream synthesis reads
 * (the sidecar's existence, content, ordering and lifetime). A regression that
 * drops the write, leaks a raw home path, reorders it after the corpus rename,
 * overwrites a session's first seat, or reaps a live session's seat fails here.
 * No existing test covers the sidecar; no production seam is added.
 *
 * SERIAL: mutates GBRAIN_HOME / GBRAIN_SEAT / CLAUDE_CONFIG_DIR / CODEX_HOME
 * (check-test-isolation R1 quarantine).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeartbeatTail, runHook } from '../src/commands/hook.ts';
import { __resetSdkLoadStateForTests, createGBrainContextEngine } from '../src/core/context-engine.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_SEAT', 'GBRAIN_HOOK_LANE', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GBRAIN_MEMORABLE'] as const;
let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-seat-'));
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

// #6268: session files and their seat live in the corpus spool; no GBRAIN_SOURCE or serve here, so stamps are unresolved.
const corpus = () => join(tmp, '.gbrain', 'transcripts', 'corpus', 'sourced');
const sidecar = (sid: string) => join(corpus(), `${sid}.seat.json`);
const readSeat = (sid: string) => JSON.parse(readFileSync(sidecar(sid), 'utf8')) as Record<string, unknown>;
const expectedHomeSeat = (dir: string) =>
  `home-${createHash('sha256').update(realpathSync(dir), 'utf8').digest('hex').slice(0, 8)}`;

const userLine = (text: string) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const assistantLine = (text: string) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const boundaryLine = () => JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'conversation compacted' });

/** A Claude Code transcript under `<harnessHome>/projects/p1/`. */
function seedTranscript(harnessHome: string, name: string, lines: string[]): string {
  const dir = join(harnessHome, 'projects', 'p1');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

async function sessionEnd(sid: string, harnessHome: string, transcript: string): Promise<void> {
  expect(await runHook(['session-end'], {
    stdin: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: join(tmp, 'ws') }),
    transcriptRoot: join(harnessHome, 'projects'),
  })).toBe(0);
}

const lastHeartbeat = async () => (await readHeartbeatTail(1))[0];
// #6316: every OpenClaw compaction also appends its own `openclaw-compact` checkpoint entry after the seat entry.
const openclawHeartbeats = async () => {
  const tail = await readHeartbeatTail(10);
  return { lane: tail.filter((e) => e.event !== 'openclaw-compact').at(-1), checkpoint: tail.at(-1) };
};

describe('seat sidecar on session capture (#4618)', () => {
  test('1. GBRAIN_SEAT: a 0600 env-sourced sidecar is written before the corpus file is renamed into place', async () => {
    process.env.GBRAIN_SEAT = 'alice-desk';
    const transcript = seedTranscript(tmp, 's.jsonl', [userLine('a question'), assistantLine('an answer')]);
    // A directory squatting on the corpus filename makes the corpus rename
    // fail: whatever exists afterwards was written BEFORE the rename.
    mkdirSync(join(corpus(), 'sess-order.src-_unresolved.txt'), { recursive: true });
    await sessionEnd('sess-order', tmp, transcript);
    expect(statSync(join(corpus(), 'sess-order.src-_unresolved.txt')).isDirectory()).toBe(true);
    expect(existsSync(sidecar('sess-order'))).toBe(true);
    expect(statSync(sidecar('sess-order')).mode & 0o777).toBe(0o600);
    expect(readSeat('sess-order')).toMatchObject({
      version: 1, seat: 'alice-desk', seat_source: 'env', hook_lane: 'workspace', harness: 'claude-code',
    });

    // The ordinary path: corpus file and sidecar side by side, label lowercased.
    process.env.GBRAIN_SEAT = 'Alice-Desk';
    await sessionEnd('sess-env', tmp, seedTranscript(tmp, 't.jsonl', [userLine('another question')]));
    expect(existsSync(join(corpus(), 'sess-env.src-_unresolved.txt'))).toBe(true);
    expect(readSeat('sess-env')).toMatchObject({ seat: 'alice-desk', seat_source: 'env' });
  });

  test('2. no GBRAIN_SEAT: a deterministic home-<8 hex> seat and no path in the sidecar', async () => {
    const homeA = join(tmp, 'claude-home-a');
    await sessionEnd('sess-a1', homeA, seedTranscript(homeA, 'a.jsonl', [userLine('first session')]));
    await sessionEnd('sess-a2', homeA, seedTranscript(homeA, 'b.jsonl', [userLine('second session')]));
    const first = readSeat('sess-a1');
    expect(first.seat).toBe(expectedHomeSeat(homeA));
    expect(first.seat).toMatch(/^home-[0-9a-f]{8}$/);
    expect(first.seat_source).toBe('harness_home');
    expect(readSeat('sess-a2').seat).toBe(first.seat);
    const raw = readFileSync(sidecar('sess-a1'), 'utf8');
    expect(raw).not.toContain(tmp);
    expect(raw).not.toContain('/');
  });

  test('3. an invalid GBRAIN_SEAT falls back to the home seat and reports seat_label_invalid with a recovery hint', async () => {
    process.env.GBRAIN_SEAT = 'Not A Seat!';
    await sessionEnd('sess-bad', tmp, seedTranscript(tmp, 'bad.jsonl', [userLine('hello')]));
    expect(readSeat('sess-bad')).toMatchObject({ seat: expectedHomeSeat(tmp), seat_source: 'harness_home' });
    const hb = await lastHeartbeat();
    expect(hb?.event).toBe('session-end');
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('seat_label_invalid');
    expect(hb?.hint).toContain('gbrain bootstrap hooks --seat');
  });

  test('GBRAIN_SEAT=off is the opt-out: the corpus is captured with no seat sidecar', async () => {
    process.env.GBRAIN_SEAT = 'off';
    await sessionEnd('sess-off', tmp, seedTranscript(tmp, 'off.jsonl', [userLine('no seat please')]));
    expect(existsSync(join(corpus(), 'sess-off.src-_unresolved.txt'))).toBe(true);
    expect(existsSync(sidecar('sess-off'))).toBe(false);
    expect((await lastHeartbeat())?.reason ?? '').not.toMatch(/^seat_/);
  });

  test('4. a session resumed from another harness home keeps its first seat and reports seat_conflict', async () => {
    const homeA = join(tmp, 'home-a');
    const homeB = join(tmp, 'home-b');
    await sessionEnd('sess-moved', homeA, seedTranscript(homeA, 'm.jsonl', [userLine('started at desk A')]));
    const before = readFileSync(sidecar('sess-moved'), 'utf8');
    await sessionEnd('sess-moved', homeB, seedTranscript(homeB, 'm.jsonl', [userLine('started at desk A'), assistantLine('resumed at desk B')]));
    expect(readFileSync(sidecar('sess-moved'), 'utf8')).toBe(before);
    expect(readSeat('sess-moved').seat).toBe(expectedHomeSeat(homeA));
    expect(readFileSync(join(corpus(), 'sess-moved.src-_unresolved.txt'), 'utf8')).toContain('resumed at desk B');
    const hb = await lastHeartbeat();
    expect(hb?.reason).toBe('seat_conflict');
    expect(hb?.hint).toContain('first seat is kept');
  });

  test('5. compaction banks a segment and writes the session sidecar once; session-end reuses it', async () => {
    process.env.GBRAIN_SEAT = 'alice-desk';
    const lines = [userLine('OLD window'), boundaryLine(), userLine('NEW window text'), assistantLine('reply in the new window')];
    const transcript = seedTranscript(tmp, 'c.jsonl', lines);
    const compact = () => runHook(['compact'], {
      stdin: JSON.stringify({ session_id: 'sess-cmp', transcript_path: transcript }),
      transcriptRoot: join(tmp, 'projects'),
    });
    expect(await compact()).toBe(0);
    expect(readdirSync(corpus()).filter((f) => f.startsWith('sess-cmp.seg-'))).toHaveLength(1);
    const bytes = readFileSync(sidecar('sess-cmp'), 'utf8');
    const mtime = statSync(sidecar('sess-cmp')).mtimeMs;
    expect(JSON.parse(bytes)).toMatchObject({ seat: 'alice-desk', seat_source: 'env' });
    await new Promise((r) => setTimeout(r, 20));
    expect(await compact()).toBe(0);
    await sessionEnd('sess-cmp', tmp, transcript);
    expect(readFileSync(sidecar('sess-cmp'), 'utf8')).toBe(bytes);
    expect(statSync(sidecar('sess-cmp')).mtimeMs).toBe(mtime);
    expect(readdirSync(corpus()).filter((f) => f.endsWith('.seat.json'))).toEqual(['sess-cmp.seat.json']);
    expect((await lastHeartbeat())?.reason).not.toBe('seat_conflict');
  });

  test('6. GC removes a seat sidecar with its session\'s last corpus file and keeps live or just-written ones', async () => {
    mkdirSync(corpus(), { recursive: true });
    const old = Date.now() / 1000 - 1000 * 24 * 60 * 60;
    for (const name of ['old.txt', 'old.seat.json', 'oldseg.seg-0123456789abcdef01234567.txt', 'oldseg.seat.json']) {
      writeFileSync(join(corpus(), name), name.endsWith('.json') ? '{"version":1,"seat":"alice-desk"}\n' : 'old corpus\n');
      utimesSync(join(corpus(), name), old, old);
    }
    writeFileSync(join(corpus(), 'live.txt'), 'live corpus\n');
    writeFileSync(join(corpus(), 'live.seat.json'), '{"version":1,"seat":"alice-desk"}\n');
    utimesSync(join(corpus(), 'live.seat.json'), old, old);
    writeFileSync(join(corpus(), 'pending.seat.json'), '{"version":1,"seat":"alice-desk"}\n');
    await sessionEnd('sess-gc', tmp, seedTranscript(tmp, 'g.jsonl', [userLine('triggers the GC')]));
    const left = readdirSync(corpus());
    expect(left).not.toContain('old.txt');
    expect(left).not.toContain('old.seat.json');
    expect(left).not.toContain('oldseg.seat.json');
    expect(left).toContain('live.seat.json');
    expect(left).toContain('pending.seat.json');
    expect(left).toContain('sess-gc.seat.json');
  });

  test('a writeback turn banked by the stop hook gets the session sidecar too', async () => {
    process.env.GBRAIN_SEAT = 'alice-desk';
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite', database_path: join(tmp, 'pglite-data'), memory: { auto_writeback: 'salient' },
    }));
    const transcript = seedTranscript(tmp, 'wb.jsonl', [userLine('I prefer dark mode in every editor, please set it up.'), assistantLine('Done.')]);
    expect(await runHook(['stop'], {
      write: () => {}, transcriptRoot: join(tmp, 'projects'),
      stdin: JSON.stringify({ session_id: 'sess-wb', transcript_path: transcript }),
    })).toBe(0);
    expect(readdirSync(corpus()).filter((f) => /^sess-wb\.wb-[0-9a-f]{24}\.src-_unresolved\.txt$/.test(f))).toHaveLength(1);
    expect(readSeat('sess-wb')).toMatchObject({ seat: 'alice-desk', seat_source: 'env' });
  });

  async function openclawCompact(sessionId: string): Promise<string> {
    __resetSdkLoadStateForTests();
    const ws = join(tmp, 'oc-ws');
    mkdirSync(join(ws, 'memory'), { recursive: true });
    writeFileSync(join(ws, 'memory', 'heartbeat-state.json'), '{}');
    const agentDir = join(tmp, 'openclaw', 'agents', 'agent-a');
    mkdirSync(join(agentDir, 'sessions'), { recursive: true });
    const sessionFile = join(agentDir, 'sessions', `${sessionId}.jsonl`);
    const msg = (text: string) =>
      JSON.stringify({ type: 'message', timestamp: '2026-08-01T10:00:01Z', message: { role: 'user', content: [{ type: 'text', text }] } });
    writeFileSync(sessionFile, [
      JSON.stringify({ type: 'session', id: sessionId, cwd: '/w', timestamp: '2026-08-01T10:00:00Z' }),
      msg('PRE-BOUNDARY text'),
      JSON.stringify({ type: 'compaction', timestamp: '2026-08-01T10:00:02Z' }),
      msg('POST-BOUNDARY window text'),
    ].join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: ws });
    await engine.compact({ sessionId, sessionFile });
    return agentDir;
  }

  test('the OpenClaw context-engine compaction writes the same sidecar, keyed to the agent directory', async () => {
    const agentDir = await openclawCompact('oc-sess');
    expect(readdirSync(corpus()).filter((f) => f.startsWith('oc-sess.seg-'))).toHaveLength(1);
    expect(readSeat('oc-sess')).toMatchObject({
      seat: expectedHomeSeat(agentDir), seat_source: 'harness_home', harness: 'openclaw', hook_lane: 'context-engine',
    });
  });

  test('the OpenClaw lane reports a seat write failure in the heartbeat and still banks the segment', async () => {
    mkdirSync(sidecar('oc-fail'), { recursive: true });
    await openclawCompact('oc-fail');
    expect(readdirSync(corpus()).filter((f) => f.startsWith('oc-fail.seg-'))).toHaveLength(1);
    const { lane: hb, checkpoint } = await openclawHeartbeats();
    expect(hb).toMatchObject({ event: 'compact', outcome: 'degraded', reason: 'seat_write_failed' });
    expect(checkpoint).toMatchObject({ event: 'openclaw-compact', segment: 'banked' });
    expect(hb?.hint).toContain('make the corpus dir');
  });

  test('the OpenClaw lane reports an invalid GBRAIN_SEAT like the hook lane does', async () => {
    process.env.GBRAIN_SEAT = 'Not A Seat!';
    await openclawCompact('oc-bad');
    const { lane: hb, checkpoint } = await openclawHeartbeats();
    expect(hb).toMatchObject({ event: 'compact', outcome: 'degraded', reason: 'seat_label_invalid' });
    expect(checkpoint).toMatchObject({ event: 'openclaw-compact', segment: 'banked' });
    expect(hb?.hint).toContain('gbrain bootstrap hooks --seat');
  });
});

/**
 * #6316 — OpenClaw 2026.9.x calls compact() with a `sessionTarget` and no
 * `sessionFile`; the checkpoint reads the transcript through the host's
 * `session-transcript-runtime`, keeps the JSONL path for older hosts, and
 * writes one heartbeat per compaction. The runtime module is faked here; the
 * pinned host covers it for real in openclaw-context-engine-native.serial.
 * SERIAL: mutates GBRAIN_HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetSdkLoadStateForTests,
  __setTranscriptRuntimeLoaderForTests,
  createGBrainContextEngine,
} from '../src/core/context-engine.ts';
import { OPENCLAW_COMPACT_EVENT, readHeartbeatTail } from '../src/core/context/hook-heartbeat.ts';

const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, timestamp: '2026-10-01T10:00:00Z', ...extra });
const message = (text: string) => event('message', { id: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'text', text }] } });
const target = { agentId: 'main', sessionId: 'oc-target', sessionKey: 'agent:main:one', storePath: '/x/agents/main/sessions/sessions.json' };

describe('compact() through the host session-transcript-runtime (#6316)', () => {
  let home: string;
  let workspace: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    __resetSdkLoadStateForTests();
    savedHome = process.env.GBRAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'gb-oc-runtime-'));
    workspace = join(home, 'ws');
    mkdirSync(workspace, { recursive: true });
    process.env.GBRAIN_HOME = home;
  });

  afterEach(() => {
    __setTranscriptRuntimeLoaderForTests(undefined);
    if (savedHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const spool = () => join(home, '.gbrain', 'transcripts', 'corpus', 'sourced');
  const segments = () => (existsSync(spool()) ? readdirSync(spool()).filter((n) => n.includes('.seg-') && n.endsWith('.txt')) : []);
  const checkpoint = (r: { result?: unknown }) => (r.result as { gbrain_checkpoint?: { status: string; reason?: string } }).gbrain_checkpoint;
  const compactions = async () => (await readHeartbeatTail(100)).filter((e) => e.event === OPENCLAW_COMPACT_EVENT);

  it('banks the since-last-boundary window read by session target, with the target identity only', async () => {
    const seen: unknown[] = [];
    __setTranscriptRuntimeLoaderForTests(async () => ({
      readSessionTranscriptEvents: async (t: unknown) => {
        seen.push(t);
        return [event('session', { id: 'oc-target' }), message('PRE-BOUNDARY text'), event('compaction'), message('POST-BOUNDARY window text')];
      },
    }));
    const engine = createGBrainContextEngine({ workspaceDir: workspace });
    const r = await engine.compact({ sessionId: 'oc-target', sessionTarget: { ...target, expectedWriterRunId: 'run-1' } } as never);
    expect(checkpoint(r)).toMatchObject({ status: 'banked' });
    expect(seen).toEqual([target]);
    const [seg] = segments();
    expect(seg).toBeDefined();
    const body = readFileSync(join(spool(), seg!), 'utf8');
    expect(body).toContain('POST-BOUNDARY');
    expect(body).not.toContain('PRE-BOUNDARY');
    expect(await compactions()).toMatchObject([{ outcome: 'ok', segment: 'banked' }]);
  });

  it('keeps the JSONL sessionFile path for older hosts and never calls the runtime', async () => {
    let called = false;
    __setTranscriptRuntimeLoaderForTests(async () => ({ readSessionTranscriptEvents: async () => { called = true; return []; } }));
    const sessionFile = join(home, 'oc.jsonl');
    writeFileSync(sessionFile, [event('session', { id: 'oc-file' }), message('FILE window text')].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: workspace });
    const r = await engine.compact({ sessionId: 'oc-file', sessionFile, sessionTarget: target } as never);
    expect(checkpoint(r)).toMatchObject({ status: 'banked' });
    expect(called).toBe(false);
    expect(readFileSync(join(spool(), segments()[0]!), 'utf8')).toContain('FILE window text');
  });

  it('a host that passes neither a file nor a target is a no_session skip, counted in the heartbeat', async () => {
    const engine = createGBrainContextEngine({ workspaceDir: workspace });
    const r = await engine.compact({ sessionId: 'oc-none' } as never);
    expect(checkpoint(r)).toEqual({ status: 'skipped', reason: 'no_session' });
    expect(segments()).toEqual([]);
    expect(await compactions()).toMatchObject([{ outcome: 'degraded', reason: 'no_session', segment: 'skipped' }]);
  });

  it('a missing runtime module or a runtime without the reader is transcript_runtime_unavailable', async () => {
    const engine = createGBrainContextEngine({ workspaceDir: workspace });
    __setTranscriptRuntimeLoaderForTests(async () => { throw new Error('Cannot find module'); });
    expect(checkpoint(await engine.compact({ sessionId: 'oc-a', sessionTarget: target } as never))).toEqual({ status: 'skipped', reason: 'transcript_runtime_unavailable' });
    __setTranscriptRuntimeLoaderForTests(async () => ({}));
    expect(checkpoint(await engine.compact({ sessionId: 'oc-b', sessionTarget: target } as never))).toEqual({ status: 'skipped', reason: 'transcript_runtime_unavailable' });
    expect(segments()).toEqual([]);
  });

  it('a reader that throws is transcript_read_failed; a target without a session id is no_session', async () => {
    __setTranscriptRuntimeLoaderForTests(async () => ({ readSessionTranscriptEvents: async () => { throw new Error('projection_rebuilding'); } }));
    const engine = createGBrainContextEngine({ workspaceDir: workspace });
    expect(checkpoint(await engine.compact({ sessionId: 'oc-c', sessionTarget: target } as never))).toEqual({ status: 'skipped', reason: 'transcript_read_failed' });
    expect(checkpoint(await engine.compact({ sessionId: 'oc-d', sessionTarget: { agentId: 'main' } } as never))).toEqual({ status: 'skipped', reason: 'no_session' });
  });

  it('events with nothing the mapper knows are unparseable, not an empty bank', async () => {
    __setTranscriptRuntimeLoaderForTests(async () => ({ readSessionTranscriptEvents: async () => [{ type: 'custom' }, 'x', null] }));
    const engine = createGBrainContextEngine({ workspaceDir: workspace });
    expect(checkpoint(await engine.compact({ sessionId: 'oc-e', sessionTarget: target } as never))).toEqual({ status: 'skipped', reason: 'unparseable' });
  });
});

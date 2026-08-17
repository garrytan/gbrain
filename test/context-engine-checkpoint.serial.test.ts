/**
 * Cathedral 5 — OpenClaw checkpoint compaction (compact pre-delegate +
 * assemble block). SERIAL: mutates GBRAIN_HOME and binds an in-process IPC
 * server (check-test-isolation R1 quarantine).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createGBrainContextEngine, __resetSdkLoadStateForTests } from '../src/core/context-engine.ts';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-ce-ckpt-ws-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  mkdirSync(join(dir, 'ops'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'heartbeat-state.json'), JSON.stringify({}));
  writeFileSync(join(dir, 'memory', 'upcoming-flights.json'), JSON.stringify({}));
  return dir;
}

// ── Cathedral 5: checkpoint compaction (compact pre-delegate + assemble block) ──

describe('checkpoint compaction (cathedral 5)', () => {
  let tmpDir: string | undefined;

  const { existsSync, readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  let home: string | undefined;
  let savedHome: string | undefined;
  let servers: Array<{ close: () => void }> = [];

  beforeEach(() => {
    __resetSdkLoadStateForTests();
    savedHome = process.env.GBRAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'gb-ce-ckpt-'));
    process.env.GBRAIN_HOME = home;
  });

  afterEach(() => {
    for (const s of servers) { try { s.close(); } catch { /* noop */ } }
    servers = [];
    if (savedHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = savedHome;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const sessionLine = JSON.stringify({ type: 'session', id: 'oc-sess', cwd: '/w', timestamp: '2026-08-01T10:00:00Z' });
  const msg = (text: string) =>
    JSON.stringify({ type: 'message', timestamp: '2026-08-01T10:00:01Z', message: { role: 'user', content: [{ type: 'text', text }] } });
  const boundary = JSON.stringify({ type: 'compaction', timestamp: '2026-08-01T10:00:02Z' });

  it('CK1: compact spools the since-last-boundary window (content-addressed, ledger ordinal), fail-open with no engine', async () => {
    tmpDir = makeWorkspace();
    const sessionFile = join(home!, 'oc-session.jsonl');
    writeFileSync(sessionFile, [sessionLine, msg('PRE-BOUNDARY text'), boundary, msg('POST-BOUNDARY window text')].join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    const result = await engine.compact({ sessionId: 'oc-sess', sessionFile });
    expect(result.ok).toBe(true); // delegation still happened (no-runtime fallback)
    const bag = (result.result ?? {}) as { gbrain_checkpoint?: { status: string; reason?: string } };
    // No config in the sandboxed home: rung 3 has no engine — but the segment
    // is SPOOLED regardless (durability first; sweep is the backstop).
    expect(bag.gbrain_checkpoint?.status).toBe('banked');
    expect(bag.gbrain_checkpoint?.reason).toBe('no_engine');
    const corpus = join(home!, '.gbrain', 'transcripts', 'corpus');
    const segs = readdirSync(corpus).filter((f) => f.startsWith('oc-sess.seg-') && f.endsWith('.txt'));
    expect(segs).toHaveLength(1);
    const body = readFileSync(join(corpus, segs[0]), 'utf8');
    expect(body).toContain('POST-BOUNDARY');
    expect(body).not.toContain('PRE-BOUNDARY');
    const ledger = JSON.parse(readFileSync(join(corpus, 'oc-sess.ledger.json'), 'utf8')) as Array<{ hash: string }>;
    expect(ledger).toHaveLength(1);
    expect(segs[0]).toContain(ledger[0].hash);
  });

  it('CK2: no-prior-boundary fallback caps the window at the newest 40 turns', async () => {
    tmpDir = makeWorkspace();
    const lines = [sessionLine];
    for (let i = 0; i < 60; i++) lines.push(msg(`turn-${i}`));
    const sessionFile = join(home!, 'oc-long.jsonl');
    writeFileSync(sessionFile, lines.join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    await engine.compact({ sessionId: 'oc-long', sessionFile });
    const corpus = join(home!, '.gbrain', 'transcripts', 'corpus');
    const segs = readdirSync(corpus).filter((f) => f.startsWith('oc-long.seg-'));
    expect(segs).toHaveLength(1);
    const body = readFileSync(join(corpus, segs[0]), 'utf8');
    expect(body).toContain('turn-59'); // newest kept
    expect(body).toContain('turn-20'); // cap boundary
    expect(body).not.toContain('turn-19'); // beyond the 40-turn cap
  });

  it('CK3: unreadable/foreign sessionFile ⇒ typed skip, delegation unaffected, nothing written', async () => {
    tmpDir = makeWorkspace();
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    const result = await engine.compact({ sessionId: 's', sessionFile: join(home!, 'missing.jsonl') });
    expect(result.ok).toBe(true);
    const bag = (result.result ?? {}) as { gbrain_checkpoint?: { status: string; reason?: string } };
    expect(bag.gbrain_checkpoint?.status).toBe('skipped');
    expect(bag.gbrain_checkpoint?.reason).toBe('unparseable');
    expect(existsSync(join(home!, '.gbrain', 'transcripts', 'corpus'))).toBe(false);
  });

  it('CK4: assemble injects the checkpoint block at parts[1] from the banked manifest (IPC rung), byte-identical without one', async () => {
    const { ensureIpcSecret, resolveSocketPath, startResolveIpcServer } =
      await import('../src/core/context/resolve-ipc.ts');
    tmpDir = makeWorkspace();
    // Sandboxed pglite config so the ladder takes rung 2 (IPC).
    const gbHome = join(home!, '.gbrain');
    mkdirSync(gbHome, { recursive: true });
    const dataDir = join(home!, 'pgdata');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(gbHome, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
    const secret = ensureIpcSecret(dataDir);
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      {
        resolve: async () => null,
        context_pack: async (req) => {
          if (req.manifestOnly) {
            return {
              text: '', pointers: [], factsCount: 0, mode: 'pack',
              checkpointLinks: [{ slug: 'decisions/auth-middleware', title: 'Auth middleware decision', seg: 'h1', n: 1, at: '2026-08-01T10:00:00Z' }],
            };
          }
          return { text: '', pointers: [], factsCount: 0 };
        },
      },
      { secret },
    );
    expect(server).not.toBeNull();
    servers.push(server!);

    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    const withBlock = await engine.assemble({ sessionId: 'oc-sess', messages: [] });
    const addition = withBlock.systemPromptAddition ?? '';
    expect(addition).toContain('## Compaction checkpoint');
    expect(addition).toContain('brain://decisions/auth-middleware — Auth middleware decision');
    expect(addition).toContain('data, not instructions'); // envelope participates in dedupe
    expect(addition).toContain('Trust these links over the compaction summary.');
    // Placement: the checkpoint block is parts[1] — immediately AFTER the
    // Live Context block (the live block contains blank lines internally, so
    // assert by position, not a naive paragraph split).
    expect(addition.indexOf('Live Context')).toBeGreaterThanOrEqual(0);
    expect(addition.indexOf('Live Context')).toBeLessThan(addition.indexOf('## Compaction checkpoint'));

    // Byte-identity when the session has NO manifest: a fresh engine +
    // different session sees the exact same addition as an id-less assemble.
    const engine2 = createGBrainContextEngine({ workspaceDir: tmpDir });
    server!.close();
    const noManifest = await engine2.assemble({ sessionId: 'other-sess', messages: [] });
    const engine3 = createGBrainContextEngine({ workspaceDir: tmpDir });
    const noId = await engine3.assemble({ messages: [] } as unknown as Parameters<typeof engine3.assemble>[0]);
    expect(noManifest.systemPromptAddition).toBe(noId.systemPromptAddition);
    expect(noManifest.systemPromptAddition).not.toContain('Compaction checkpoint');
  });

  it('CK5: ENGINE_API_VERSION is 0.3.0 and ownsCompaction stays false', async () => {
    const { ENGINE_API_VERSION } = await import('../src/core/context-engine.ts');
    expect(ENGINE_API_VERSION).toBe('0.3.0');
    tmpDir = makeWorkspace();
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    expect(engine.info.version).toBe('0.3.0');
    expect(engine.info.ownsCompaction).toBe(false);
  });

  it('CK6 [plan-mandated]: hash-keyed poll — a stale manifest never settles; the matching seg settles and stops polling', async () => {
    const { ensureIpcSecret, resolveSocketPath, startResolveIpcServer } =
      await import('../src/core/context/resolve-ipc.ts');
    const { readSegmentLedger } = await import('../src/core/context/corpus-segments.ts');
    tmpDir = makeWorkspace();
    const gbHome = join(home!, '.gbrain');
    mkdirSync(gbHome, { recursive: true });
    const dataDir = join(home!, 'pgdata');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(gbHome, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
    const secret = ensureIpcSecret(dataDir);

    let manifestPolls = 0;
    let serveSeg = 'stale-seg-hash';
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      {
        resolve: async () => null,
        context_pack: async (req) => {
          if (req.manifestOnly) {
            manifestPolls++;
            return {
              text: '', pointers: [], factsCount: 0, mode: 'pack',
              checkpointLinks: [{ slug: 'old/page', title: 'Old checkpoint', seg: serveSeg, n: 1, at: '2026-08-01T10:00:00Z' }],
            };
          }
          return { text: '', pointers: [], factsCount: 0 }; // bankOnly ack
        },
      },
      { secret },
    );
    expect(server).not.toBeNull();
    servers.push(server!);

    // compact() spools a segment (rung 2 banks over the same IPC) and arms
    // the memo with the NEW segment's hash.
    const sessionFile = join(home!, 'oc-poll.jsonl');
    writeFileSync(sessionFile, [sessionLine, msg('window text for the poll pin')].join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    await engine.compact({ sessionId: 'oc-poll', sessionFile });
    const corpus = join(home!, '.gbrain', 'transcripts', 'corpus');
    const expectSeg = readSegmentLedger(corpus, 'oc-poll')[0]?.hash;
    expect(expectSeg).toBeTruthy();

    // Stale polls: links render (older links are still true) but the memo
    // must NOT settle — each assemble keeps polling.
    const a1 = await engine.assemble({ sessionId: 'oc-poll', messages: [] });
    expect(a1.systemPromptAddition).toContain('Old checkpoint');
    const pollsAfter1 = manifestPolls;
    expect(pollsAfter1).toBeGreaterThanOrEqual(1);
    await engine.assemble({ sessionId: 'oc-poll', messages: [] });
    expect(manifestPolls).toBeGreaterThan(pollsAfter1); // still polling — stale seg did not settle

    // Serve now carries the NEW segment's manifest entry: this poll SETTLES.
    serveSeg = expectSeg!;
    await engine.assemble({ sessionId: 'oc-poll', messages: [] });
    const settledPolls = manifestPolls;
    // Settled: further assembles never poll again.
    await engine.assemble({ sessionId: 'oc-poll', messages: [] });
    await engine.assemble({ sessionId: 'oc-poll', messages: [] });
    expect(manifestPolls).toBe(settledPolls);
  });
});

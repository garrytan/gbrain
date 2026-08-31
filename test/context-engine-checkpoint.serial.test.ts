/**
 * Cathedral 5 — OpenClaw checkpoint compaction (compact pre-delegate +
 * assemble block). SERIAL: mutates GBRAIN_HOME and binds an in-process IPC
 * server (check-test-isolation R1 quarantine).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createGBrainContextEngine,
  __resetSdkLoadStateForTests,
  sanitizeEngineSessionId,
} from '../src/core/context-engine.ts';

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

  // ── F5: unsafe-session-id round-trip + sanitizer contract + drift guard ──

  it('F5/CK7: unsafe session id ("oc:sess/2026-08") round-trips compact() → assemble() under ONE sanitized key', async () => {
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

    const RAW_ID = 'oc:sess/2026-08';
    const SAFE_ID = 'oc-sess-2026-08';
    expect(sanitizeEngineSessionId(RAW_ID)).toBe(SAFE_ID);

    // Capture EVERY sessionId that crosses the wire — compact's bank arm and
    // assemble's manifest poll must both carry the SANITIZED key, or the
    // manifest gets banked under a key the poll can never find.
    const seen: Array<{ manifest: boolean; sessionId?: string; flushCorpusFile?: string }> = [];
    let serveSeg = ''; // set from the ledger after compact() spools
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      {
        resolve: async () => null,
        context_pack: async (req) => {
          seen.push({
            manifest: !!req.manifestOnly,
            ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
            ...(req.flushCorpusFile !== undefined ? { flushCorpusFile: req.flushCorpusFile } : {}),
          });
          if (req.manifestOnly) {
            return {
              text: '', pointers: [], factsCount: 0, mode: 'pack',
              checkpointLinks: [{ slug: 'notes/unsafe-id', title: 'Unsafe id checkpoint', seg: serveSeg, n: 1, at: '2026-08-01T10:00:00Z' }],
            };
          }
          return { text: '', pointers: [], factsCount: 0 }; // bankOnly ack
        },
      },
      { secret },
    );
    expect(server).not.toBeNull();
    servers.push(server!);

    const sessionFile = join(home!, 'oc-unsafe.jsonl');
    writeFileSync(sessionFile, [sessionLine, msg('PRE-BOUNDARY text'), boundary, msg('UNSAFE-ID window text')].join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    const result = await engine.compact({ sessionId: RAW_ID, sessionFile });
    expect(result.ok).toBe(true);
    const bag = (result.result ?? {}) as { gbrain_checkpoint?: { status: string } };
    expect(bag.gbrain_checkpoint?.status).toBe('banked'); // rung 2 IPC acked

    // The spool landed under the SANITIZED key — never a path-shaped filename.
    const corpus = join(home!, '.gbrain', 'transcripts', 'corpus');
    const files = readdirSync(corpus);
    const segs = files.filter((f) => f.startsWith(`${SAFE_ID}.seg-`) && f.endsWith('.txt'));
    expect(segs).toHaveLength(1);
    for (const f of files) {
      expect(f).not.toContain(':');
      expect(f).not.toContain('/');
    }
    const ledger = readSegmentLedger(corpus, SAFE_ID);
    expect(ledger).toHaveLength(1);
    serveSeg = ledger[0].hash;

    // assemble() with the SAME RAW id: the lookup maps to the same safe key,
    // the served seg matches the spooled hash, and the block renders.
    const assembled = await engine.assemble({ sessionId: RAW_ID, messages: [] });
    const addition = assembled.systemPromptAddition ?? '';
    expect(addition).toContain('## Compaction checkpoints');
    expect(addition).toContain('brain://notes/unsafe-id — Unsafe id checkpoint');

    // Both directions hit the wire, under the IDENTICAL sanitized key.
    const banks = seen.filter((s) => !s.manifest);
    const polls = seen.filter((s) => s.manifest);
    expect(banks.length).toBeGreaterThanOrEqual(1);
    expect(polls.length).toBeGreaterThanOrEqual(1);
    for (const s of seen) expect(s.sessionId).toBe(SAFE_ID);
    // The flush ask names the sanitized segment file — same key end to end.
    expect(banks[0].flushCorpusFile).toBe(`${SAFE_ID}.seg-${serveSeg}.txt`);
  });

  it('F5/CK8: sanitizeEngineSessionId — null for empty/all-dots/non-strings; real charset + clamp pins', () => {
    // Degenerate → null (the engine SKIPS the checkpoint lane; hook.ts
    // buckets the same inputs under its 'unknown' sentinel — pinned in CK9).
    expect(sanitizeEngineSessionId('')).toBeNull();
    expect(sanitizeEngineSessionId('.')).toBeNull();
    expect(sanitizeEngineSessionId('..')).toBeNull();
    expect(sanitizeEngineSessionId('...')).toBeNull();
    expect(sanitizeEngineSessionId(null)).toBeNull();
    expect(sanitizeEngineSessionId(undefined)).toBeNull();
    expect(sanitizeEngineSessionId(42)).toBeNull();
    expect(sanitizeEngineSessionId({})).toBeNull();
    expect(sanitizeEngineSessionId(['a'])).toBeNull();
    expect(sanitizeEngineSessionId(true)).toBeNull();
    // Real contract (pins, not aspirations): unsafe chars map to '-'; dots are
    // IN the safe charset (only an ALL-dots residue nulls); 120-char clamp.
    expect(sanitizeEngineSessionId('oc:sess/2026-08')).toBe('oc-sess-2026-08');
    expect(sanitizeEngineSessionId(':::')).toBe('---'); // unsafe-only input still yields a key
    expect(sanitizeEngineSessionId('./.')).toBe('.-.'); // not all-dots AFTER mapping
    expect(sanitizeEngineSessionId('abc._-XYZ09')).toBe('abc._-XYZ09'); // safe charset unchanged
    expect(sanitizeEngineSessionId('x'.repeat(300))).toBe('x'.repeat(120));
  });

  it('F5/CK9 drift guard: hook.ts sanitizeSessionId, corpus-segments safeIdComponent, and sanitizeEngineSessionId map an identical probe set to IDENTICAL keys', async () => {
    const { runHook } = await import('../src/commands/hook.ts');
    const { segmentFileName, parseSegmentFileName } = await import('../src/core/context/corpus-segments.ts');

    // hook.ts's copy is module-private; its stop lane names the live-buffer
    // file `${sanitizeSessionId(id)}.txt` — the filename IS the mapping seam
    // (same seam test/hook-command.serial.test.ts already pins for one id).
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ['GBRAIN_HOOKS', 'GBRAIN_HOOK_LANE', 'GBRAIN_STOP_PUSH']) savedEnv[k] = process.env[k];
    delete process.env.GBRAIN_HOOKS;
    delete process.env.GBRAIN_HOOK_LANE;
    process.env.GBRAIN_STOP_PUSH = '0'; // stop-push arm skips instantly
    const ws = mkdtempSync(join(tmpdir(), 'gb-ckpt-drift-ws-'));
    try {
      let probeN = 0;
      const hookKey = async (probe: unknown): Promise<string> => {
        const marker = `drift-probe-${++probeN}-marker`;
        const code = await runHook(['stop'], {
          stdin: JSON.stringify({ session_id: probe, last_assistant_message: marker }),
          cwd: ws, // non-bootstrap workspace: no push machinery runs
          spawnPush: () => { /* never spawns */ },
          disableTelemetry: true,
        });
        expect(code).toBe(0);
        const liveDir = join(home!, '.gbrain', 'transcripts', 'live');
        const hit = readdirSync(liveDir).filter(
          (f) => f.endsWith('.txt') && readFileSync(join(liveDir, f), 'utf8').includes(marker),
        );
        expect(hit).toHaveLength(1);
        return hit[0].slice(0, -'.txt'.length);
      };
      // Third copy (corpus-segments safeIdComponent) read back through its
      // exported filename builder + parser.
      const segKey = (probe: string): string => {
        const parsed = parseSegmentFileName(segmentFileName(probe, 'a'.repeat(24)));
        expect(parsed).not.toBeNull();
        return parsed!.sessionId;
      };

      const probes = ['oc:sess/2026-08', 'a b', '../x', 'UPPER', 'L'.repeat(300)];
      for (const probe of probes) {
        const engineKey = sanitizeEngineSessionId(probe);
        expect(engineKey).not.toBeNull(); // every probe keeps a safe residue
        expect(await hookKey(probe)).toBe(engineKey!);
        expect(segKey(probe)).toBe(engineKey!);
      }

      // Deliberate divergence, pinned so it can only change LOUDLY: degenerate
      // ids map to hook.ts's 'unknown' sentinel but to engine null — compact()
      // treats a shared-'unknown' bucket as ABSENT (cross-session pollution),
      // per the hook.ts compact lane's own sentinel check.
      expect(sanitizeEngineSessionId('...')).toBeNull();
      expect(await hookKey('...')).toBe('unknown');
      expect(sanitizeEngineSessionId(1234)).toBeNull();
      expect(await hookKey(1234)).toBe('unknown');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ── Memorable receipts on the openclaw compaction lane (A-3) ────────────────
//
// OpenClaw has no session end; capture is per-compaction. These tests drive
// the REAL engine.compact() path under a temp GBRAIN_HOME with the full
// consent chain seeded (config gate + gbrain disclosure stamp + CLI-side
// evidence + stub binary), asserting the do-no-harm default and the
// per-compaction receipt semantics.

describe('memorable receipts from compact() (openclaw lane)', () => {
  const { existsSync, readFileSync, mkdirSync: mkd, writeFileSync: wf, chmodSync: chm } = require('node:fs') as typeof import('node:fs');
  let tmpDir: string | undefined;
  let home: string | undefined;
  const SAVED: Record<string, string | undefined> = {};
  const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_MEMORABLE', 'GBRAIN_MEMORABLE_CONFIG', 'MEMORABLE_BIN', 'PATH'];

  beforeEach(() => {
    __resetSdkLoadStateForTests();
    for (const k of ENV_KEYS) SAVED[k] = process.env[k];
    home = mkdtempSync(join(tmpdir(), 'gb-ce-mem-'));
    process.env.GBRAIN_HOME = home;
    delete process.env.GBRAIN_MEMORABLE;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const sessionLine = JSON.stringify({ type: 'session', id: 'oc-mem', cwd: '/w', timestamp: 't0' });
  const msg = (text: string, call?: string) =>
    JSON.stringify({
      type: 'message',
      timestamp: 't1',
      message: { role: 'assistant', content: [{ type: 'text', text }, ...(call ? [{ type: 'toolCall', id: 'tc', name: call }] : [])] },
    });

  /** Seed the FULL consent chain; returns the marker file the stub relay touches. */
  async function optIn(): Promise<string> {
    const gb = join(home!, '.gbrain');
    mkd(gb, { recursive: true });
    wf(join(gb, 'config.json'), JSON.stringify({ engine: 'pglite', integrations: { memorable: { enabled: true } } }));
    const { writeMemorableConsent } = await import('../src/core/context/hook-heartbeat.ts');
    await writeMemorableConsent();
    const cli = join(home!, 'memorable-cli');
    mkd(cli, { recursive: true });
    wf(join(cli, 'config.json'), JSON.stringify({ backend: 'local', consent: 'read-write' }));
    process.env.GBRAIN_MEMORABLE_CONFIG = cli;
    const marker = join(home!, 'relay-marker.txt');
    const bin = join(home!, 'memorable');
    wf(bin, `#!/bin/sh\necho "$@" >> ${marker}\n`);
    chm(bin, 0o755);
    process.env.MEMORABLE_BIN = bin;
    return marker;
  }

  async function receipts(): Promise<Array<{ session_id: string; harness: string; content_hash: string; tool_calls_json: string }>> {
    const { readSessionReceiptsTail } = await import('../src/core/context/hook-heartbeat.ts');
    return readSessionReceiptsTail(50);
  }

  it('MR1: default-off — compact writes segments but NO receipt, NO spawn', async () => {
    tmpDir = makeWorkspace();
    const sessionFile = join(home!, 'oc-mem.jsonl');
    wf(sessionFile, [sessionLine, msg('some work', 'exec')].join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    await engine.compact({ sessionId: 'oc-mem', sessionFile });
    expect(await receipts()).toEqual([]);
    expect(existsSync(join(home!, 'relay-marker.txt'))).toBe(false);
  });

  it('MR2: opted in — one receipt per compaction, harness openclaw, span-filtered calls; second checkpoint ⇒ second receipt; identical retry ⇒ no dup', async () => {
    tmpDir = makeWorkspace();
    const marker = await optIn();
    const sessionFile = join(home!, 'oc-mem.jsonl');
    wf(sessionFile, [sessionLine, msg('window one', 'search_brain')].join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    await engine.compact({ sessionId: 'oc-mem', sessionFile });

    let r = await receipts();
    expect(r).toHaveLength(1);
    expect(r[0]!.harness).toBe('openclaw');
    expect(r[0]!.session_id).toBe('oc-mem');
    expect(JSON.parse(r[0]!.tool_calls_json)).toEqual([{ name: 'search_brain', input: null }]);

    // Identical retried compaction: same window hash ⇒ deduped, no second relay.
    await engine.compact({ sessionId: 'oc-mem', sessionFile });
    expect(await receipts()).toHaveLength(1);

    // Real new work behind a boundary ⇒ a SECOND receipt with a new hash,
    // carrying only the post-boundary call (span rule).
    const boundaryLine = JSON.stringify({ type: 'compaction', timestamp: 't2' });
    wf(sessionFile, [sessionLine, msg('window one', 'search_brain'), boundaryLine, msg('window two', 'read_file')].join('\n') + '\n');
    await engine.compact({ sessionId: 'oc-mem', sessionFile });
    r = await receipts();
    expect(r).toHaveLength(2);
    expect(r[1]!.content_hash).not.toBe(r[0]!.content_hash);
    expect(JSON.parse(r[1]!.tool_calls_json)).toEqual([{ name: 'read_file', input: null }]);

    // The relay child actually ran (fire-and-forget: poll briefly).
    const deadline = Date.now() + 3000;
    let body = '';
    while (Date.now() < deadline) {
      if (existsSync(marker)) { body = readFileSync(marker, 'utf8'); if (body.trim().split('\n').length >= 2) break; }
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(body).toContain('record --session oc-mem');
  });

  it('MR3: enabled flag WITHOUT the disclosure stamp (out-of-band write) ⇒ no receipt, no spawn', async () => {
    tmpDir = makeWorkspace();
    await optIn();
    const { clearMemorableConsent } = await import('../src/core/context/hook-heartbeat.ts');
    await clearMemorableConsent();
    const sessionFile = join(home!, 'oc-mem.jsonl');
    wf(sessionFile, [sessionLine, msg('work', 'exec')].join('\n') + '\n');
    const engine = createGBrainContextEngine({ workspaceDir: tmpDir });
    const result = await engine.compact({ sessionId: 'oc-mem', sessionFile });
    expect(result.ok).toBe(true); // the checkpoint itself is untouched
    expect(await receipts()).toEqual([]);
    expect(existsSync(join(home!, 'relay-marker.txt'))).toBe(false);
  });
});

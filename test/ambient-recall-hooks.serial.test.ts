/**
 * Ambient recall — Layer 3 boundary runtime (issue #1): the context_pack IPC
 * kind, the PreCompact banking hook, the session-start pack arm, and the
 * compact_boundary transcript signal. In-process IPC servers (never a spawned
 * serve), same seams as hook-command.serial.test.ts. Serial: env + sockets.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook, readHeartbeatTail } from '../src/commands/hook.ts';
import {
  ensureIpcSecret,
  resolveSocketPath,
  startResolveIpcServer,
  requestContextPack,
  IPC_UNAVAILABLE,
  type ContextPackRequest,
  type ContextPackResponse,
} from '../src/core/context/resolve-ipc.ts';
import type { WindowTurn } from '../src/core/context/entity-salience.ts';
import { parseTranscript } from '../src/core/transcripts/claude-code-jsonl.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'claude-code.jsonl');
const ENV_KEYS = ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let servers: net.Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-ar-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  for (const s of servers) {
    try { s.close(); } catch { /* noop */ }
  }
  servers = [];
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');

function writePgliteConfig(dataDir: string): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
}

/** A Postgres brain carrying a LEFTOVER database_path (e.g. a pglite→postgres migration). */
function writePostgresConfigWithLeftoverPath(dataDir: string): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'config.json'), JSON.stringify({ engine: 'postgres', database_path: dataDir }));
}

function collectStdout(): { io: { write: (s: string) => void }; get: () => string } {
  let buf = '';
  return { io: { write: (s: string) => { buf += s; } }, get: () => buf };
}

/** In-process v2 IPC server with a canned context_pack block. */
async function startPackServer(opts: {
  dataDir: string;
  blockText?: string | null;
  onRequest?: (req: ContextPackRequest) => void;
}): Promise<void> {
  mkdirSync(opts.dataDir, { recursive: true });
  const secret = ensureIpcSecret(opts.dataDir);
  const server = await startResolveIpcServer(
    resolveSocketPath(opts.dataDir),
    {
      resolve: async () => null,
      context_pack: async (req) => {
        opts.onRequest?.(req);
        if (opts.blockText == null) return null;
        return { text: opts.blockText, pointers: [], factsCount: 0, mode: 'pack' as const };
      },
    },
    { secret },
  );
  expect(server).not.toBeNull();
  servers.push(server!);
}

// ── IPC context_pack kind ───────────────────────────────────────────────────

describe('context_pack over IPC', () => {
  test('round-trips a block; bankOnly + window + sessionId pass through', async () => {
    const dataDir = join(tmp, 'data');
    let seen: ContextPackRequest | undefined;
    await startPackServer({ dataDir, blockText: 'PACKED', onRequest: (r) => { seen = r; } });
    const secret = ensureIpcSecret(dataDir);
    const res = await requestContextPack(resolveSocketPath(dataDir), {
      secret,
      sessionId: 'sess-9',
      window: [{ role: 'user', text: 'talk about acme-example' }],
      bankOnly: false,
      trigger: 'session-start:startup',
    });
    expect(res).not.toBe(IPC_UNAVAILABLE);
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(true);
    expect(resp.protocol).toBe(2);
    expect(resp.block?.text).toBe('PACKED');
    expect(seen?.sessionId).toBe('sess-9');
    expect(seen?.window?.length).toBe(1);
    expect(seen?.trigger).toBe('session-start:startup');
  });

  test('wrong secret → unauthorized (fail closed)', async () => {
    const dataDir = join(tmp, 'data');
    await startPackServer({ dataDir, blockText: 'X' });
    const res = await requestContextPack(resolveSocketPath(dataDir), { secret: 'wrong' });
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('unauthorized');
  });

  test('server without a context_pack handler → unsupported_kind', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const secret = ensureIpcSecret(dataDir);
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      { resolve: async () => null },
      { secret },
    );
    servers.push(server!);
    const res = await requestContextPack(resolveSocketPath(dataDir), { secret });
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('unsupported_kind');
  });

  test('no server → IPC_UNAVAILABLE (never throws)', async () => {
    const res = await requestContextPack(join(tmp, 'nope', '.gbrain-resolve.sock'), { secret: 's' });
    expect(res).toBe(IPC_UNAVAILABLE);
  });

  test('source binding fails closed: cross-source request → source_mismatch', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const secret = ensureIpcSecret(dataDir);
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      { resolve: async () => null, context_pack: async () => ({ text: 'X', pointers: [], factsCount: 0 }) },
      { secret, boundSourceId: 'brain-a' },
    );
    servers.push(server!);
    const res = await requestContextPack(resolveSocketPath(dataDir), { secret, sourceId: 'brain-b' });
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('source_mismatch');
  });

  test('handler that exceeds the server backstop → server_budget degrade, never a hang', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const secret = ensureIpcSecret(dataDir);
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      {
        resolve: async () => null,
        context_pack: async () => {
          await new Promise((r) => setTimeout(r, 60_000));
          return { text: 'late', pointers: [], factsCount: 0 };
        },
      },
      { secret },
    );
    servers.push(server!);
    const res = await requestContextPack(resolveSocketPath(dataDir), { secret }, { timeoutMs: 5000 });
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(true);
    expect(resp.block).toBeNull();
    expect(resp.degradedReason).toBe('server_budget');
  }, 10_000);

  test('handler throw → ok:false error, connection survives', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const secret = ensureIpcSecret(dataDir);
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      { resolve: async () => null, context_pack: async () => { throw new Error('boom-pack'); } },
      { secret },
    );
    servers.push(server!);
    const res = await requestContextPack(resolveSocketPath(dataDir), { secret });
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('boom-pack');
  });

  test('oversized window is trimmed oldest-first below the 256KB cap [G11]', async () => {
    const dataDir = join(tmp, 'data');
    let received: WindowTurn[] | undefined;
    await startPackServer({ dataDir, blockText: 'OK', onRequest: (r) => { received = r.window; } });
    const secret = ensureIpcSecret(dataDir);
    const turns: WindowTurn[] = [];
    for (let i = 0; i < 600; i++) {
      turns.push({ role: 'user', text: `turn-${i} ${'x'.repeat(1000)}` });
    }
    const res = await requestContextPack(
      resolveSocketPath(dataDir),
      { secret, window: turns },
      { timeoutMs: 5000 },
    );
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(true);
    expect(received!.length).toBeGreaterThan(0);
    expect(received!.length).toBeLessThan(600);
    // Oldest-first trim: the NEWEST turn always survives.
    expect(received![received!.length - 1].text.startsWith('turn-599 ')).toBe(true);
    expect(received![0].text.startsWith('turn-0 ')).toBe(false);
  });

  test('request that cannot fit even after trimming → IPC_UNAVAILABLE, never a throw [G11]', async () => {
    const dataDir = join(tmp, 'data');
    let handlerHit = false;
    await startPackServer({ dataDir, blockText: 'OK', onRequest: () => { handlerHit = true; } });
    const secret = ensureIpcSecret(dataDir);
    // The clamp loop only evicts window turns; a giant non-window field
    // (entities) can never fit under the message cap, so the client bails
    // to IPC_UNAVAILABLE without ever touching the socket.
    const entities = Array.from({ length: 300 }, (_, i) => `e${i}-${'y'.repeat(1000)}`);
    const res = await requestContextPack(resolveSocketPath(dataDir), {
      secret,
      entities,
      window: [{ role: 'user', text: 'small' }],
    });
    expect(res).toBe(IPC_UNAVAILABLE);
    expect(handlerHit).toBe(false);
  });

  test('server with a context_pack handler but NO configured secret → unauthorized (fail closed)', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      { resolve: async () => null, context_pack: async () => ({ text: 'X', pointers: [], factsCount: 0 }) },
      {}, // no opts.secret — no configured secret means NO service, not open service
    );
    servers.push(server!);
    const res = await requestContextPack(resolveSocketPath(dataDir), { secret: 'anything' });
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('unauthorized');
  });

  test('partial pack propagates: block text AND top-level degradedReason survive the wire', async () => {
    // eng 4A: an assembler deadline overrun returns a PARTIAL pack, never an
    // empty hard failure — the server spreads block.degradedReason to the top.
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const secret = ensureIpcSecret(dataDir);
    const server = await startResolveIpcServer(
      resolveSocketPath(dataDir),
      {
        resolve: async () => null,
        context_pack: async () => ({ text: 'PARTIAL', pointers: [], factsCount: 0, degradedReason: 'deadline' }),
      },
      { secret },
    );
    servers.push(server!);
    const res = await requestContextPack(resolveSocketPath(dataDir), { secret });
    const resp = res as ContextPackResponse;
    expect(resp.ok).toBe(true);
    expect(resp.block?.text).toBe('PARTIAL');
    expect(resp.degradedReason).toBe('deadline');
  });
});

// ── compact (PreCompact banking) ────────────────────────────────────────────

describe('hook compact', () => {
  test('banks the window: bankOnly=true + non-empty window + sessionId reach the server', async () => {
    const dataDir = join(tmp, 'data');
    let seen: ContextPackRequest | undefined;
    await startPackServer({ dataDir, blockText: '', onRequest: (r) => { seen = r; } });
    writePgliteConfig(dataDir);
    const tr = join(tmp, 'tr');
    mkdirSync(tr, { recursive: true });
    const transcript = join(tr, 'sess.jsonl');
    copyFileSync(FIXTURE, transcript);

    const out = collectStdout();
    const code = await runHook(['compact'], {
      ...out.io,
      stdin: JSON.stringify({ transcript_path: transcript, session_id: 'sess-c1' }),
      transcriptRoot: tr,
    });
    expect(code).toBe(0);
    expect(out.get()).toBe(''); // PreCompact emits nothing
    expect(seen?.bankOnly).toBe(true);
    expect(seen?.sessionId).toBe('sess-c1');
    expect((seen?.window?.length ?? 0)).toBeGreaterThan(0);
    expect(seen?.trigger).toBe('compact-bank');
    const hb = (await readHeartbeatTail(1))[0];
    expect(hb?.event).toBe('compact');
    expect(hb?.outcome).toBe('ok');
  });

  test('fail-open without config: exit 0, degraded heartbeat, no stdout', async () => {
    const tr = join(tmp, 'tr');
    mkdirSync(tr, { recursive: true });
    const transcript = join(tr, 'sess.jsonl');
    copyFileSync(FIXTURE, transcript);
    const out = collectStdout();
    const code = await runHook(['compact'], {
      ...out.io,
      stdin: JSON.stringify({ transcript_path: transcript, session_id: 's' }),
      transcriptRoot: tr,
    });
    expect(code).toBe(0);
    expect(out.get()).toBe('');
    const hb = (await readHeartbeatTail(1))[0];
    expect(hb?.event).toBe('compact');
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('no_pglite_path');
  });

  test('GBRAIN_HOOKS=0 short-circuits compact: exit 0, no output, no heartbeat', async () => {
    process.env.GBRAIN_HOOKS = '0';
    const out = collectStdout();
    expect(await runHook(['compact'], { ...out.io, stdin: '{}' })).toBe(0);
    expect(out.get()).toBe('');
    expect((await readHeartbeatTail(1)).length).toBe(0);
  });

  test('config present but no IPC secret → degraded no_serve', async () => {
    const dataDir = join(tmp, 'data-nosecret');
    mkdirSync(dataDir, { recursive: true }); // no ensureIpcSecret call
    writePgliteConfig(dataDir);
    const tr = join(tmp, 'tr');
    mkdirSync(tr, { recursive: true });
    const transcript = join(tr, 'sess.jsonl');
    copyFileSync(FIXTURE, transcript);
    const out = collectStdout();
    expect(await runHook(['compact'], {
      ...out.io,
      stdin: JSON.stringify({ transcript_path: transcript, session_id: 's' }),
      transcriptRoot: tr,
    })).toBe(0);
    const hb = (await readHeartbeatTail(1))[0];
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('no_serve');
  });

  test('stdin without session_id → reason no_session, exit 0', async () => {
    const dataDir = join(tmp, 'data');
    await startPackServer({ dataDir, blockText: '' });
    writePgliteConfig(dataDir);
    const tr = join(tmp, 'tr');
    mkdirSync(tr, { recursive: true });
    const transcript = join(tr, 'sess.jsonl');
    copyFileSync(FIXTURE, transcript);
    const out = collectStdout();
    expect(await runHook(['compact'], {
      ...out.io,
      stdin: JSON.stringify({ transcript_path: transcript }),
      transcriptRoot: tr,
    })).toBe(0);
    const hb = (await readHeartbeatTail(1))[0];
    expect(hb?.reason).toBe('no_session');
  });

  test('Postgres engine with a leftover database_path never probes the socket (v0.45.7 symmetry)', async () => {
    // Same engine gate as the session-start pack arm: a live serve behind the
    // leftover path must NOT be reached — there is no PGLite brain here.
    const dataDir = join(tmp, 'data');
    let handlerHit = false;
    await startPackServer({ dataDir, blockText: '', onRequest: () => { handlerHit = true; } });
    writePostgresConfigWithLeftoverPath(dataDir);
    const tr = join(tmp, 'tr');
    mkdirSync(tr, { recursive: true });
    const transcript = join(tr, 'sess.jsonl');
    copyFileSync(FIXTURE, transcript);
    const out = collectStdout();
    const code = await runHook(['compact'], {
      ...out.io,
      stdin: JSON.stringify({ transcript_path: transcript, session_id: 's' }),
      transcriptRoot: tr,
    });
    expect(code).toBe(0);
    expect(out.get()).toBe('');
    expect(handlerHit).toBe(false);
    const hb = (await readHeartbeatTail(1))[0];
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('no_pglite_path');
  });

  test('unconfined transcript path aborts (S3#8), never best-effort', async () => {
    const dataDir = join(tmp, 'data');
    await startPackServer({ dataDir, blockText: '' });
    writePgliteConfig(dataDir);
    const out = collectStdout();
    const code = await runHook(['compact'], {
      ...out.io,
      stdin: JSON.stringify({ transcript_path: '/etc/passwd', session_id: 's' }),
      transcriptRoot: join(tmp, 'tr'),
    });
    expect(code).toBe(0);
    const hb = (await readHeartbeatTail(1))[0];
    expect(hb?.outcome).toBe('degraded');
    expect(String(hb?.reason)).toStartWith('transcript_');
  });
});

// ── session-start pack arm ──────────────────────────────────────────────────

describe('hook session-start pack arm', () => {
  test('appends the pack block after the digest when serve is up', async () => {
    const dataDir = join(tmp, 'data');
    await startPackServer({ dataDir, blockText: 'BRAIN-PACK-BLOCK' });
    writePgliteConfig(dataDir);
    const out = collectStdout();
    const code = await runHook(['session-start'], {
      ...out.io,
      cwd: tmp,
      stdin: JSON.stringify({ session_id: 'sess-s1', source: 'compact' }),
    });
    expect(code).toBe(0);
    expect(out.get()).toContain('BRAIN-PACK-BLOCK');
  });

  test('fail-open when no serve: exit 0, no pack, no crash', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    ensureIpcSecret(dataDir); // secret exists but no server listening
    writePgliteConfig(dataDir);
    const out = collectStdout();
    const code = await runHook(['session-start'], {
      ...out.io,
      cwd: tmp,
      stdin: JSON.stringify({ session_id: 'sess-s2', source: 'startup' }),
    });
    expect(code).toBe(0);
    expect(out.get()).not.toContain('BRAIN-PACK-BLOCK');
  });

  test('Postgres engine with a leftover database_path: digest-only stdout, no pack attempt (v0.45.7 symmetry)', async () => {
    const dataDir = join(tmp, 'data');
    let handlerHit = false;
    await startPackServer({ dataDir, blockText: 'BRAIN-PACK-BLOCK', onRequest: () => { handlerHit = true; } });
    writePostgresConfigWithLeftoverPath(dataDir);
    writeFileSync(join(tmp, 'MEMORY.md'), '## Standing rules\n- always ship tests\n');
    const out = collectStdout();
    const code = await runHook(['session-start'], {
      ...out.io,
      cwd: tmp,
      stdin: JSON.stringify({ session_id: 'sess-pg', source: 'startup' }),
    });
    expect(code).toBe(0);
    expect(out.get()).toContain('From MEMORY.md');
    expect(out.get()).not.toContain('BRAIN-PACK-BLOCK');
    expect(handlerHit).toBe(false);
  });

  test('trigger carries the SessionStart source discriminator', async () => {
    const dataDir = join(tmp, 'data');
    let seen: ContextPackRequest | undefined;
    await startPackServer({ dataDir, blockText: null, onRequest: (r) => { seen = r; } });
    writePgliteConfig(dataDir);
    const out = collectStdout();
    await runHook(['session-start'], {
      ...out.io,
      cwd: tmp,
      stdin: JSON.stringify({ session_id: 'sess-s3', source: 'compact' }),
    });
    expect(seen?.trigger).toBe('session-start:compact');
    expect(seen?.sessionId).toBe('sess-s3');
  });
});

// ── documented harness payload shapes ───────────────────────────────────────

describe('documented hook payload shapes (extra fields tolerated)', () => {
  test('full PreCompact payload banks identically to the minimal shape', async () => {
    const dataDir = join(tmp, 'data');
    let seen: ContextPackRequest | undefined;
    await startPackServer({ dataDir, blockText: '', onRequest: (r) => { seen = r; } });
    writePgliteConfig(dataDir);
    const tr = join(tmp, 'tr');
    mkdirSync(tr, { recursive: true });
    const transcript = join(tr, 'sess.jsonl');
    copyFileSync(FIXTURE, transcript);
    const out = collectStdout();
    const code = await runHook(['compact'], {
      ...out.io,
      stdin: JSON.stringify({
        session_id: 'sess-full',
        transcript_path: transcript,
        cwd: tmp,
        hook_event_name: 'PreCompact',
        trigger: 'auto',
        custom_instructions: '',
      }),
      transcriptRoot: tr,
    });
    expect(code).toBe(0);
    expect(out.get()).toBe(''); // PreCompact emits nothing
    expect(seen?.bankOnly).toBe(true);
    expect(seen?.sessionId).toBe('sess-full');
    expect((seen?.window?.length ?? 0)).toBeGreaterThan(0);
    const hb = (await readHeartbeatTail(1))[0];
    expect(hb?.event).toBe('compact');
    expect(hb?.outcome).toBe('ok');
  });

  test('full SessionStart payload packs identically to the minimal shape', async () => {
    const dataDir = join(tmp, 'data');
    let seen: ContextPackRequest | undefined;
    await startPackServer({ dataDir, blockText: 'BRAIN-PACK-BLOCK', onRequest: (r) => { seen = r; } });
    writePgliteConfig(dataDir);
    const out = collectStdout();
    // No io.cwd — the documented payload's cwd field carries the workspace.
    const code = await runHook(['session-start'], {
      ...out.io,
      stdin: JSON.stringify({
        session_id: 'sess-full-ss',
        transcript_path: join(tmp, 'unused.jsonl'),
        cwd: tmp,
        hook_event_name: 'SessionStart',
        source: 'compact',
      }),
    });
    expect(code).toBe(0);
    expect(out.get()).toContain('BRAIN-PACK-BLOCK');
    expect(seen?.trigger).toBe('session-start:compact');
    expect(seen?.sessionId).toBe('sess-full-ss');
  });
});

// ── compact_boundary transcript signal ──────────────────────────────────────

describe('compact_boundary surfacing', () => {
  test('parseTranscript counts compact boundaries without turning them into turns', () => {
    const p = join(tmp, 'cb.jsonl');
    writeFileSync(
      p,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'after compaction' } }),
      ].join('\n') + '\n',
    );
    const parsed = parseTranscript(p);
    expect(parsed.compactBoundaries).toBe(1);
    expect(parsed.turns.length).toBe(2);
  });

  test('counts the shared fixture’s known boundary (and still yields turns)', () => {
    // The conversation-formats fixture deliberately carries ONE
    // compact_boundary line (it exercises entryToTurn's skip path).
    const parsed = parseTranscript(FIXTURE);
    expect(parsed.compactBoundaries).toBe(1);
    expect(parsed.turns.length).toBeGreaterThan(0);
  });
});

/**
 * `gbrain hook <event>` (agent-bootstrap D5, A3, A9, G3, G4, G15, B3, B4,
 * ENG-1, S3#2, S3#7, S3#8): in-process stdin→stdout contract against an
 * in-process IPC server (never a spawned serve — the hook-under-serve e2e is
 * a separate task). Fail-open everywhere, heartbeat schema allowlist, digest
 * section allowlist + cap, corpus redaction/dedup/retention, parser drift.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runHook,
  heartbeatPath,
  hookStatusPath,
  readHeartbeatTail,
  HEARTBEAT_ALLOWED_KEYS,
  HEARTBEAT_MAX_LINES,
  DIGEST_MEMORY_CAP_BYTES,
  memoryDigest,
  PUSH_ANNOUNCE_REFIRE_MS,
  type HookHeartbeatEntry,
} from '../src/commands/hook.ts';
import { pushStatusPathForRoot } from '../src/core/workspace-push.ts';
import {
  ensureIpcSecret,
  resolveSocketPath,
  startResolveIpcServer,
  type TurnContextRequest,
} from '../src/core/context/resolve-ipc.ts';
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../src/core/bootstrap/host-specs.ts';
import { writeReceipt } from '../src/core/bootstrap/format.ts';
import type { RepoReceipt } from '../src/core/bootstrap/repo.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'claude-code.jsonl');
const ENV_KEYS = [
  'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS',
  // stop-push [D3/D17/D20] + banner [D5] + cloud detection knobs
  'GBRAIN_STOP_PUSH', 'GBRAIN_STOP_PUSH_DEBOUNCE_MIN', 'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID', 'GH_TOKEN', 'GITHUB_TOKEN',
  // optional Memorable integration: config gate + env kill switch
  'GBRAIN_MEMORABLE',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
let servers: net.Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-hk-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp; // config/heartbeat/corpus all under tmp/.gbrain
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

function collectStdout(): { io: { write: (s: string) => void }; get: () => string } {
  let buf = '';
  return { io: { write: (s: string) => { buf += s; } }, get: () => buf };
}

async function lastHeartbeat(): Promise<HookHeartbeatEntry | undefined> {
  const tail = await readHeartbeatTail(1);
  return tail[0];
}

/** In-process v2 IPC server with a canned turn_context block. */
async function startServer(opts: {
  dataDir: string;
  blockText?: string | null;
  secretOverride?: string;
  boundSourceId?: string;
  onRequest?: (req: TurnContextRequest) => void;
}): Promise<void> {
  mkdirSync(opts.dataDir, { recursive: true });
  const secret = opts.secretOverride ?? ensureIpcSecret(opts.dataDir);
  if (opts.secretOverride) ensureIpcSecret(opts.dataDir); // client still reads the file secret
  const server = await startResolveIpcServer(
    resolveSocketPath(opts.dataDir),
    {
      resolve: async () => null,
      turn_context: async (req) => {
        opts.onRequest?.(req);
        if (opts.blockText == null) return null;
        return { text: opts.blockText, pointers: [], factsCount: 0 };
      },
    },
    { secret, ...(opts.boundSourceId ? { boundSourceId: opts.boundSourceId } : {}) },
  );
  expect(server).not.toBeNull();
  servers.push(server!);
}

// ── Dispatch + kill switch ──────────────────────────────────────────────────

describe('dispatch', () => {
  test('GBRAIN_HOOKS=0 short-circuits every event: exit 0, no output, no heartbeat', async () => {
    process.env.GBRAIN_HOOKS = '0';
    for (const event of ['session-start', 'user-prompt', 'stop', 'session-end']) {
      const out = collectStdout();
      expect(await runHook([event], { ...out.io, stdin: '{}' })).toBe(0);
      expect(out.get()).toBe('');
    }
    expect(existsSync(join(home(), 'integrations', 'hooks', 'heartbeat.jsonl'))).toBe(false);
  });

  test('unknown/missing event → usage + exit 1; --help → exit 0', async () => {
    expect(await runHook(['no-such-event'], { stdin: '' })).toBe(1);
    expect(await runHook([], { stdin: '' })).toBe(1);
    const out = collectStdout();
    expect(await runHook(['--help'], out.io)).toBe(0);
    expect(out.get()).toContain('session-start');
  });

  test('harness lane yields to a workspace bootstrap install: exit 0, no output, no heartbeat (#4043 C6)', async () => {
    // Claude Code merges user- and project-scope hook settings; a harness
    // (user-scope) entry plus a workspace bootstrap-v1 entry would fire the
    // same event twice. The workspace install wins — the harness lane must
    // yield SILENTLY on every event.
    process.env.GBRAIN_HOOK_LANE = 'harness';
    try {
      const ws = mkdtempSync(join(tmpdir(), 'gb-lane-ws-'));
      mkdirSync(join(ws, '.claude'), { recursive: true });
      // A real workspace install wires all five events — the guard is now
      // PER-EVENT (an event the workspace does not wire must run normally),
      // so the fixture mirrors the full install.
      const entry = (sub: string) => [
        { hooks: [{ type: 'command', command: `env GBRAIN_SOURCE=ws /opt/g hook ${sub}`, _gbrain: 'bootstrap-v1' }] },
      ];
      writeFileSync(
        join(ws, '.claude', 'settings.local.json'),
        JSON.stringify({
          hooks: {
            SessionStart: entry('session-start'),
            UserPromptSubmit: entry('user-prompt'),
            Stop: entry('stop'),
            SessionEnd: entry('session-end'),
            PreCompact: entry('compact'),
          },
        }),
      );
      for (const event of ['session-start', 'user-prompt', 'stop', 'session-end', 'compact']) {
        const out = collectStdout();
        expect(await runHook([event], { ...out.io, stdin: '{}', cwd: ws })).toBe(0);
        expect(out.get()).toBe('');
      }
      expect(existsSync(join(home(), 'integrations', 'hooks', 'heartbeat.jsonl'))).toBe(false);
    } finally {
      delete process.env.GBRAIN_HOOK_LANE;
    }
  });

  test('harness lane runs normally when the cwd has no workspace install (fail-open both ways)', async () => {
    process.env.GBRAIN_HOOK_LANE = 'harness';
    try {
      // plain dir: no .claude/settings.local.json at all
      const plain = mkdtempSync(join(tmpdir(), 'gb-lane-plain-'));
      const out = collectStdout();
      // session-start in a plain dir runs the normal handler (exit 0, and it
      // WRITES a heartbeat — proof the guard did not swallow the event).
      expect(await runHook(['session-start'], { ...out.io, stdin: '', cwd: plain })).toBe(0);
      expect(existsSync(join(home(), 'integrations', 'hooks', 'heartbeat.jsonl'))).toBe(true);

      // harness-marker-only settings (its OWN entries) must NOT trigger the
      // yield — only the workspace bootstrap-v1 marker does.
      const harnessOnly = mkdtempSync(join(tmpdir(), 'gb-lane-harness-'));
      mkdirSync(join(harnessOnly, '.claude'), { recursive: true });
      writeFileSync(
        join(harnessOnly, '.claude', 'settings.local.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'env GBRAIN_SOURCE=default /opt/g hook session-start', _gbrain: 'bootstrap-harness-v1' }] }],
          },
        }),
      );
      const out2 = collectStdout();
      expect(await runHook(['session-start'], { ...out2.io, stdin: '', cwd: harnessOnly })).toBe(0);
      // still ran: a fresh heartbeat line was appended for this invocation
      const hb = readFileSync(join(home(), 'integrations', 'hooks', 'heartbeat.jsonl'), 'utf8').trim().split('\n');
      expect(hb.length).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.GBRAIN_HOOK_LANE;
    }
  });

  test('harness lane yields to the COMMITTED settings.json carrier too ([D12] — local strips carried events)', async () => {
    // A D12 workspace can carry its bootstrap-v1 hooks ONLY in the committed
    // .claude/settings.json (the local writer skips carried events). Checking
    // settings.local.json alone would double-fire those events against the
    // user-scope harness wiring.
    process.env.GBRAIN_HOOK_LANE = 'harness';
    try {
      const ws = mkdtempSync(join(tmpdir(), 'gb-lane-committed-'));
      mkdirSync(join(ws, '.claude'), { recursive: true });
      writeFileSync(
        join(ws, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'gbrain hook session-start', _gbrain: 'bootstrap-v1' }] }],
          },
        }),
      );
      const out = collectStdout();
      expect(await runHook(['session-start'], { ...out.io, stdin: '{}', cwd: ws })).toBe(0);
      expect(out.get()).toBe('');
      expect(existsSync(join(home(), 'integrations', 'hooks', 'heartbeat.jsonl'))).toBe(false);
    } finally {
      delete process.env.GBRAIN_HOOK_LANE;
    }
  });
});

// ── user-prompt [ENG-1, S3#8, A9] ───────────────────────────────────────────

describe('user-prompt', () => {
  test('fail-open on missing config: exit 0, empty stdout, degraded heartbeat', async () => {
    const out = collectStdout();
    expect(await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hello' }) })).toBe(0);
    expect(out.get()).toBe('');
    const hb = await lastHeartbeat();
    expect(hb?.event).toBe('user-prompt');
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('no_pglite_path');
  });

  test('no stdin → degraded no_stdin, exit 0 empty', async () => {
    const out = collectStdout();
    expect(await runHook(['user-prompt'], { ...out.io, stdin: '' })).toBe(0);
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('no_stdin');
  });

  test('pull-mode when no serve has minted a secret: no_serve', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    writePgliteConfig(dataDir);
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('no_serve');
  });

  test('happy path: additionalContext JSON contract, ≤10000 chars [ENG-1]', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'CTX: alice-example runs widget-co' });
    const out = collectStdout();
    expect(
      await runHook(['user-prompt'], {
        ...out.io,
        stdin: JSON.stringify({ prompt: 'what does alice-example do?', session_id: 's-1' }),
      }),
    ).toBe(0);
    const payload = out.get().trim();
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length).toBeLessThanOrEqual(CLAUDE_HOOK_OUTPUT_CAP_CHARS);
    const parsed = JSON.parse(payload);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'CTX: alice-example runs widget-co',
      },
    });
    const hb = await lastHeartbeat();
    expect(hb?.outcome).toBe('ok');
    expect(hb?.turns).toBe(1);
  });

  test('window = last 4 transcript turns + the current prompt', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    let seen: TurnContextRequest | null = null;
    await startServer({ dataDir, blockText: 'ok', onRequest: (r) => { seen = r; } });
    // Confinement seam: fixture copied under a fake projects root.
    const projRoot = join(tmp, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const transcript = join(projRoot, 'p1', 'sess.jsonl');
    copyFileSync(FIXTURE, transcript);
    const out = collectStdout();
    await runHook(['user-prompt'], {
      ...out.io,
      stdin: JSON.stringify({ prompt: 'and now?', transcript_path: transcript, session_id: 's-2' }),
      transcriptRoot: projRoot,
    });
    expect(seen).not.toBeNull();
    const win = seen!.window;
    expect(win).toHaveLength(5); // fixture has 5 turns → slice(-4) + prompt
    expect(win[win.length - 1]).toEqual({ role: 'user', text: 'and now?' });
    expect(win.map((t) => t.text).join(' ')).not.toContain('SIDECHAIN-ONLY-TEXT');
    expect((await lastHeartbeat())?.turns).toBe(5);
  });

  test('cross-turn dedupe: previously-injected blocks ride priorContextText; channel defaults to claude-code', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    let seen: TurnContextRequest | null = null;
    await startServer({ dataDir, blockText: 'ok', onRequest: (r) => { seen = r; } });
    // Real captured transcript (claude CLI 2.1.224, hook installed): two
    // hook_additional_context attachments naming companies/acme-example.
    const projRoot = join(tmp, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const transcript = join(projRoot, 'p1', 'sess.jsonl');
    copyFileSync(join(import.meta.dir, 'fixtures', 'hook-transcript.jsonl'), transcript);
    const out = collectStdout();
    await runHook(['user-prompt'], {
      ...out.io,
      stdin: JSON.stringify({ prompt: 'more about Acme Example?', transcript_path: transcript, session_id: 's-3' }),
      transcriptRoot: projRoot,
    });
    expect(seen).not.toBeNull();
    // Dedupe input = ONLY the structured injections (both blocks, joined) —
    // the serve suppresses re-volunteering companies/acme-example this turn.
    expect(seen!.priorContextText).toContain('companies/acme-example');
    expect(seen!.priorContextText).not.toContain('Reply with exactly'); // never raw turn text
    // Feedback-loop attribution: default channel is claude-code (the only
    // harness bootstrap registers hooks for today).
    expect(seen!.channel).toBe('claude-code');
  });

  test('priorContextText is deduped and byte-capped: an injection-heavy session can never blow the IPC message cap', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    let seen: TurnContextRequest | null = null;
    await startServer({ dataDir, blockText: 'ok', onRequest: (r) => { seen = r; } });
    const projRoot = join(tmp, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const transcript = join(projRoot, 'p1', 'sess.jsonl');
    // 60 injections: 50 identical (per-turn re-records of one block) + 10
    // distinct 8KB blocks — raw join would be ~90KB+; the cap keeps ≤32KB
    // of NEWEST distinct blocks.
    const bigBlock = (i: number) =>
      `## Brain pages mentioned this turn\n- **Page ${i}** → \`pages/p${i}\` — ${'x'.repeat(8000)}`;
    const lines = [
      ...Array.from({ length: 50 }, () =>
        JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['## Brain pages mentioned this turn\n- **Dup** → `pages/dup` — same block every turn'] } })),
      ...Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [bigBlock(i)] } })),
    ];
    writeFileSync(transcript, lines.join('\n') + '\n');
    const out = collectStdout();
    await runHook(['user-prompt'], {
      ...out.io,
      stdin: JSON.stringify({ prompt: 'more about Acme?', transcript_path: transcript, session_id: 's-cap' }),
      transcriptRoot: projRoot,
    });
    expect(seen).not.toBeNull();
    const prior = seen!.priorContextText!;
    expect(Buffer.byteLength(prior, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    // Newest-first retention: the newest distinct block survives the cap...
    expect(prior).toContain('pages/p9');
    // ...and identical re-records collapsed to one occurrence.
    expect(prior.split('pages/dup').length - 1).toBeLessThanOrEqual(1);
  });

  test('--harness codex/opencode flags the channel; unknown values fall back to the default', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    const seen: TurnContextRequest[] = [];
    await startServer({ dataDir, blockText: 'ok', onRequest: (r) => { seen.push(r); } });
    const out = collectStdout();
    await runHook(['user-prompt', '--harness', 'codex'], {
      ...out.io,
      stdin: JSON.stringify({ prompt: 'hello Acme' }),
    });
    // opencode widening (v0.45.x): pins the hook.ts flag parse — a regression
    // there silently rebadges opencode deliveries as claude-code (the wire
    // guard half is pinned in volunteer-events-delivery.test.ts).
    await runHook(['user-prompt', '--harness', 'opencode'], {
      ...out.io,
      stdin: JSON.stringify({ prompt: 'hello Acme' }),
    });
    await runHook(['user-prompt', '--harness', 'vim'], {
      ...out.io,
      stdin: JSON.stringify({ prompt: 'hello Acme' }),
    });
    expect(seen).toHaveLength(3);
    expect(seen[0].channel).toBe('codex');
    expect(seen[1].channel).toBe('opencode');
    expect(seen[2].channel).toBe('claude-code'); // fail-open to the default
  });

  test('hook ∈ STARTUP_HOOK_SKIP_COMMANDS (source grep — maybeEmitUpdateMarker no-ops under NODE_ENV=test, so no runtime test can pin this)', () => {
    const cliSrc = readFileSync(join(import.meta.dir, '..', 'src', 'cli.ts'), 'utf8');
    const m = cliSrc.match(/const STARTUP_HOOK_SKIP_COMMANDS = new Set\(\[[\s\S]*?\]\);/);
    expect(m).not.toBeNull();
    // user-prompt fires once per user PROMPT: a stale update cache would
    // otherwise spawn a detached check-update child per prompt.
    expect(m![0]).toContain("'hook'");
  });

  test('confinement rejection aborts: heartbeat + exit 0 empty [S3#8]', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    const outside = join(tmp, 'outside.jsonl');
    writeFileSync(outside, '{}\n');
    const out = collectStdout();
    expect(
      await runHook(['user-prompt'], {
        ...out.io,
        stdin: JSON.stringify({ prompt: 'x', transcript_path: outside }),
        transcriptRoot: join(tmp, 'projects-root'),
      }),
    ).toBe(0);
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('transcript_outside_projects_dir');
  });

  test('unauthorized (server holds a different secret) degrades cleanly', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'x', secretOverride: 'not-the-file-secret' });
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('unauthorized');
  });

  test('source_mismatch when GBRAIN_SOURCE differs from the bound source [CX2-10]', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'x', boundSourceId: 'other-source' });
    process.env.GBRAIN_SOURCE = 'mine';
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('source_mismatch');
  });

  test('stale (v1) serve without the protocol echo degrades LOUDLY [A9]', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    writePgliteConfig(dataDir);
    ensureIpcSecret(dataDir);
    // Raw v1-shaped server: answers everything as a resolve response.
    const server = net.createServer((conn) => {
      conn.on('data', () => conn.write(JSON.stringify({ ok: true, block: null }) + '\n'));
    });
    await new Promise<void>((r) => server.listen(resolveSocketPath(dataDir), r));
    servers.push(server);
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
    expect((await lastHeartbeat())?.reason).toBe('stale_serve');
  });

  test('oversized block is trimmed under the 10000-char stdout cap [ENG-1]', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'line of context\n'.repeat(700) }); // ~11K raw, ~12K escaped
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    const payload = out.get().trim();
    expect(payload.length).toBeGreaterThan(0);
    expect(payload.length).toBeLessThanOrEqual(CLAUDE_HOOK_OUTPUT_CAP_CHARS);
    expect(JSON.parse(payload).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });
});

// ── session-start [A3, B3, B4, G3] ──────────────────────────────────────────

describe('session-start', () => {
  test('digest respects the section allowlist [A3]', async () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'MEMORY.md'),
      [
        '# Memory',
        '## Standing rules',
        '- always verify before claiming done',
        '## Security boundary',
        'NEVER-IN-DIGEST: this section stays out of injected context',
        '## Open commitments',
        '- ship the follow-up to charlie-example',
        '## Active context',
        '- migrating widget-co notes',
        '## Scratch',
        'SCRATCH-NOT-ELIGIBLE',
      ].join('\n'),
    );
    const out = collectStdout();
    expect(await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws })).toBe(0);
    const text = out.get();
    expect(text).toContain('always verify before claiming done');
    expect(text).toContain('charlie-example');
    expect(text).toContain('migrating widget-co notes');
    expect(text).not.toContain('NEVER-IN-DIGEST');
    expect(text).not.toContain('SCRATCH-NOT-ELIGIBLE');
    expect((await lastHeartbeat())?.outcome).toBe('ok');
  });

  test('digest capped at 3KB [A3]', () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const memPath = join(ws, 'MEMORY.md');
    writeFileSync(memPath, '## Standing rules\n' + 'a very long standing rule line\n'.repeat(400));
    const digest = memoryDigest(memPath);
    expect(digest).not.toBeNull();
    expect(Buffer.byteLength(digest!, 'utf8')).toBeLessThanOrEqual(DIGEST_MEMORY_CAP_BYTES + 4);
  });

  test('missing MEMORY.md: fail-open, exit 0, heartbeat ok', async () => {
    const ws = join(tmp, 'empty-ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    expect(await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws })).toBe(0);
    expect((await lastHeartbeat())?.outcome).toBe('ok');
  });

  test('B3 visible degradation: >50% trailing errors → doctor notice', async () => {
    const hbPath = await heartbeatPath();
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) {
      lines.push(JSON.stringify({ ts: new Date().toISOString(), event: 'user-prompt', outcome: 'error', reason: 'exception:Error', duration_ms: 5 }));
    }
    for (let i = 0; i < 3; i++) {
      lines.push(JSON.stringify({ ts: new Date().toISOString(), event: 'user-prompt', outcome: 'ok', duration_ms: 5 }));
    }
    writeFileSync(hbPath, lines.join('\n') + '\n');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws });
    expect(out.get()).toContain('run gbrain doctor');
  });

  test('degraded-only history does NOT trigger the notice (designed fallbacks)', async () => {
    const hbPath = await heartbeatPath();
    const lines = Array.from({ length: 20 }, () =>
      JSON.stringify({ ts: new Date().toISOString(), event: 'user-prompt', outcome: 'degraded', reason: 'no_serve', duration_ms: 3 }));
    writeFileSync(hbPath, lines.join('\n') + '\n');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws });
    expect(out.get()).not.toContain('run gbrain doctor');
  });

  test('last-session line + stale push-status surfaced [B4]', async () => {
    const liveDir = join(home(), 'transcripts', 'live');
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'prev.txt'), JSON.stringify({ ts: '2026-08-07T09:00:00Z', session_id: 'prev', exchange: 'wrapped up the acme-example memo' }) + '\n');
    const bootDir = join(home(), 'bootstrap');
    mkdirSync(bootDir, { recursive: true });
    writeFileSync(join(bootDir, 'push-status.json'), JSON.stringify({ ts: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(), ok: true }));
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws });
    const text = out.get();
    expect(text).toContain('Last session activity');
    expect(text).toContain('acme-example memo');
    expect(text).toContain('>48h ago');
  });

  test('parser-drift status file surfaced at session start [G3]', async () => {
    const statusPath = await hookStatusPath();
    writeFileSync(statusPath, JSON.stringify({ ts: new Date().toISOString(), error: 'parser_drift', bytes: 1234 }));
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: ws });
    expect(out.get()).toContain('Hook alert: parser_drift');
  });
});

// ── stop [G15] ──────────────────────────────────────────────────────────────

describe('stop', () => {
  test('appends to the per-session buffer (sanitized id) and GCs stale buffers', async () => {
    const liveDir = join(home(), 'transcripts', 'live');
    mkdirSync(liveDir, { recursive: true });
    const stale = join(liveDir, 'stale.txt');
    writeFileSync(stale, 'old\n');
    const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(stale, old, old);

    expect(
      await runHook(['stop'], {
        stdin: JSON.stringify({ session_id: 'abc/../def', last_assistant_message: 'the widget-co answer' }),
      }),
    ).toBe(0);
    const files = readdirSync(liveDir);
    expect(files).toContain('abc-..-def.txt'); // '/' sanitized, no traversal possible
    expect(files).not.toContain('stale.txt');
    const body = readFileSync(join(liveDir, 'abc-..-def.txt'), 'utf8');
    expect(body).toContain('the widget-co answer');
    expect((await lastHeartbeat())?.outcome).toBe('ok');
  });
});

// ── session-end [S3#2, G3, G15, A6] ─────────────────────────────────────────

function seedTranscript(dir: string, name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const userLine = (text: string) =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const assistantLine = (text: string) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('session-end', () => {
  test('corpus write redacts a planted secret at write time [S3#2]', async () => {
    const projRoot = join(tmp, 'projects');
    const planted = 'sk-' + 'FAKEfakeFAKEfake1234567890';
    const transcript = seedTranscript(join(projRoot, 'p1'), 's.jsonl', [
      userLine(`my key is ${planted} — keep it safe`),
      assistantLine('I will not repeat that.'),
    ]);
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    expect(
      await runHook(['session-end'], {
        stdin: JSON.stringify({ session_id: 'sess-red', transcript_path: transcript, cwd: ws }),
        transcriptRoot: projRoot,
      }),
    ).toBe(0);
    const corpus = join(home(), 'transcripts', 'corpus', 'sess-red.txt');
    expect(existsSync(corpus)).toBe(true);
    const body = readFileSync(corpus, 'utf8');
    expect(body).not.toContain(planted);
    expect(body).toContain('<REDACTED:openai>');
    expect(body).toContain('I will not repeat that.');
    const hb = await lastHeartbeat();
    expect(hb?.outcome).toBe('ok');
    expect(hb?.turns).toBe(2);
    expect(hb?.bytes).toBeGreaterThan(0);
    // COUNT only in telemetry — one planted secret, one redaction [S3#2, S3#7].
    expect(hb?.redactions).toBe(1);
  });

  test('session-id-keyed dedup: resumed session overwrites its corpus file [A6]', async () => {
    const projRoot = join(tmp, 'projects');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const t1 = seedTranscript(join(projRoot, 'p1'), 'a.jsonl', [userLine('first pass content')]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-dup', transcript_path: t1, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const t2 = seedTranscript(join(projRoot, 'p1'), 'a.jsonl', [userLine('first pass content'), assistantLine('resumed pass content')]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-dup', transcript_path: t2, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const corpusDir = join(home(), 'transcripts', 'corpus');
    const files = readdirSync(corpusDir).filter((f) => f.startsWith('sess-dup'));
    expect(files).toEqual(['sess-dup.txt']);
    expect(readFileSync(join(corpusDir, 'sess-dup.txt'), 'utf8')).toContain('resumed pass content');
  });

  test('resumed session rewrite drops the stale .ingested/.in-progress sidecars so the sweep re-ingests', async () => {
    const projRoot = join(tmp, 'projects');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });

    // First pass: session-end writes the corpus file.
    const t1 = seedTranscript(join(projRoot, 'p1'), 'r.jsonl', [userLine('first pass content')]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-resume', transcript_path: t1, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const corpusDir = join(home(), 'transcripts', 'corpus');
    const corpusFile = join(corpusDir, 'sess-resume.txt');
    expect(existsSync(corpusFile)).toBe(true);

    // Simulate the sweep having ingested it (completion sidecar) and a stale
    // claim being left behind.
    writeFileSync(corpusFile + '.ingested', JSON.stringify({ ingested_at: new Date().toISOString() }) + '\n');
    writeFileSync(corpusFile + '.in-progress', JSON.stringify({ claimed_at: new Date().toISOString() }) + '\n');
    expect(existsSync(corpusFile + '.ingested')).toBe(true);

    // Second pass: the session resumes with appended content.
    const t2 = seedTranscript(join(projRoot, 'p1'), 'r.jsonl', [
      userLine('first pass content'),
      assistantLine('appended resumed content'),
    ]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-resume', transcript_path: t2, cwd: ws }),
      transcriptRoot: projRoot,
    });

    // The corpus reflects the appended content …
    expect(readFileSync(corpusFile, 'utf8')).toContain('appended resumed content');
    // … and the stale sidecars are GONE so the next sweep re-processes it.
    expect(existsSync(corpusFile + '.ingested')).toBe(false);
    expect(existsSync(corpusFile + '.in-progress')).toBe(false);
    // No torn tmp file left behind by the atomic write.
    expect(readdirSync(corpusDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  test('retention prune: corpus files past the default 30d window are removed [G15]', async () => {
    const corpusDir = join(home(), 'transcripts', 'corpus');
    mkdirSync(corpusDir, { recursive: true });
    const oldFile = join(corpusDir, 'ancient.txt');
    writeFileSync(oldFile, 'old corpus\n');
    const old = (Date.now() - 40 * 24 * 3600 * 1000) / 1000;
    utimesSync(oldFile, old, old);
    const freshFile = join(corpusDir, 'fresh.txt');
    writeFileSync(freshFile, 'fresh corpus\n');

    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 's.jsonl', [userLine('hello')]);
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-ret', transcript_path: transcript, cwd: ws }),
      transcriptRoot: projRoot,
    });
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });

  test('bytes>0 && turns==0 → parser_drift heartbeat error + status file [G3]', async () => {
    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 'drift.jsonl', [
      JSON.stringify({ type: 'summary', summary: 'format changed under us' }),
      JSON.stringify({ type: 'summary', summary: 'no user/assistant lines at all' }),
    ]);
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-drift', transcript_path: transcript, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const hb = await lastHeartbeat();
    expect(hb?.outcome).toBe('error');
    expect(hb?.reason).toBe('parser_drift');
    expect(hb?.bytes).toBeGreaterThan(0);
    expect(hb?.turns).toBe(0);
    const status = JSON.parse(readFileSync(await hookStatusPath(), 'utf8'));
    expect(status.error).toBe('parser_drift');
    // No corpus file for a drift session.
    expect(existsSync(join(home(), 'transcripts', 'corpus', 'sess-drift.txt'))).toBe(false);
  });

  test('confinement rejection: degraded heartbeat, no corpus write [S3#8]', async () => {
    const outside = join(tmp, 'outside.jsonl');
    writeFileSync(outside, userLine('outside content') + '\n');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-out', transcript_path: outside, cwd: ws }),
      transcriptRoot: join(tmp, 'projects'),
    });
    expect((await lastHeartbeat())?.reason).toBe('transcript_outside_projects_dir');
    expect(existsSync(join(home(), 'transcripts', 'corpus', 'sess-out.txt'))).toBe(false);
  });

  test('GCs this session\'s stop buffer [G15]', async () => {
    const liveDir = join(home(), 'transcripts', 'live');
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'sess-gc.txt'), '{"ts":"x"}\n');
    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 's.jsonl', [userLine('bye')]);
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-gc', transcript_path: transcript, cwd: ws }),
      transcriptRoot: projRoot,
    });
    expect(existsSync(join(liveDir, 'sess-gc.txt'))).toBe(false);
  });
});

// ── heartbeat [S3#7] ────────────────────────────────────────────────────────

describe('heartbeat', () => {
  test('schema allowlist: every key on every line is allowlisted, never text payloads', async () => {
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    await runHook(['session-start'], { stdin: '', cwd: ws, write: () => {} });
    await runHook(['user-prompt'], { stdin: JSON.stringify({ prompt: 'secret prompt text' }), write: () => {} });
    await runHook(['stop'], { stdin: JSON.stringify({ session_id: 's', prompt: 'secret prompt text' }) });
    const raw = readFileSync(await heartbeatPath(), 'utf8');
    const allowed = new Set<string>(HEARTBEAT_ALLOWED_KEYS);
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(3);
    for (const line of lines) {
      for (const key of Object.keys(JSON.parse(line))) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    // The prompt text itself never lands in telemetry.
    expect(raw).not.toContain('secret prompt text');
  });

  test('per-event writes are append-only below the compaction threshold', async () => {
    const p = await heartbeatPath();
    const seed = JSON.stringify({ ts: 't', event: 'stop', outcome: 'ok', duration_ms: 1 });
    // Above the nominal cap but below the 2x compaction trigger: the hot path
    // must stay a single O_APPEND write (no read-modify-write per prompt).
    writeFileSync(p, Array.from({ length: HEARTBEAT_MAX_LINES + 100 }, () => seed).join('\n') + '\n');
    await runHook(['stop'], { stdin: JSON.stringify({ session_id: 'cap' }) });
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(HEARTBEAT_MAX_LINES + 101);
    expect(JSON.parse(lines[lines.length - 1]).event).toBe('stop');
  });

  test('file compacted to HEARTBEAT_MAX_LINES once it exceeds 2x the cap', async () => {
    const p = await heartbeatPath();
    const seed = JSON.stringify({ ts: 't', event: 'stop', outcome: 'ok', duration_ms: 1 });
    writeFileSync(p, Array.from({ length: 2 * HEARTBEAT_MAX_LINES + 100 }, () => seed).join('\n') + '\n');
    await runHook(['stop'], { stdin: JSON.stringify({ session_id: 'cap' }) });
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(HEARTBEAT_MAX_LINES);
    // The newest entry survived the compaction.
    expect(JSON.parse(lines[lines.length - 1]).event).toBe('stop');
  });

  test('readHeartbeatTail returns the last n entries oldest→newest', async () => {
    const p = await heartbeatPath();
    const mk = (i: number) => JSON.stringify({ ts: `t${i}`, event: 'stop', outcome: 'ok', duration_ms: i });
    writeFileSync(p, [mk(1), mk(2), mk(3), mk(4)].join('\n') + '\n');
    const tail = await readHeartbeatTail(2);
    expect(tail.map((e) => e.duration_ms)).toEqual([3, 4]);
  });
});

// ── bootstrap-workspace push gate [G4] ──────────────────────────────────────
//
// The initialized agent.json manifest is THE security boundary: `gbrain hook
// <event>` run inside an arbitrary git repo must never spawn the workspace
// push (which commits). Spawns are observed via the io.spawnPush seam.

function initGitRepoWithDirtyTree(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'untracked-work.txt'), 'unsaved work\n');
}

function gitStatus(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
}

const INITIALIZED_MANIFEST = {
  format_version: 1,
  initialized: true,
  agent_name: 'test-agent',
  created_by: 'test',
  created_at: '2026-01-01T00:00:00.000Z',
  source_id: 'workspace',
};

/** Simulate a COMPLETED repo phase: a receipt for this workspace carrying a
 * recorded repo_url. Without this the no-daemon push is deferred (a
 * create-repo-first install must not push to an unverified-privacy origin). */
function markRepoPhaseComplete(repo: string): void {
  const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const repoUrl = 'https://github.com/alice/boot-repo';
  // The push gate binds to the recorded repo: origin must resolve to repo_url.
  try {
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin'], { stdio: 'ignore' });
  } catch {
    /* no origin yet */
  }
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', repoUrl]);
  mkdirSync(join(home(), 'bootstrap'), { recursive: true });
  writeReceipt(home(), {
    receipt_version: 1,
    workspace_dir: toplevel,
    source_id: 'workspace',
    agent_name: 'test-agent',
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: 'test',
    brain_created_by_bootstrap: false,
    created_paths: [],
    registrations: [],
    repo_url: repoUrl,
  } as RepoReceipt);
}

describe('bootstrap push gate [G4]', () => {
  test('git repo + dirty tree + NO agent.json: session-start and session-end never spawn a push, repo untouched', async () => {
    const repo = join(tmp, 'plain-repo');
    initGitRepoWithDirtyTree(repo);
    const before = gitStatus(repo);
    const spawned: string[] = [];
    const io = { spawnPush: (root: string) => { spawned.push(root); } };

    const startOut = collectStdout();
    expect(await runHook(['session-start'], { ...startOut.io, ...io, stdin: '', cwd: repo })).toBe(0);
    expect(startOut.get()).not.toContain('Unpushed work');

    const endOut = collectStdout();
    expect(
      await runHook(['session-end'], {
        ...endOut.io,
        ...io,
        stdin: JSON.stringify({ session_id: 'sess-plain', cwd: repo }),
      }),
    ).toBe(0);

    expect(spawned).toEqual([]);
    expect(gitStatus(repo)).toBe(before); // repo untouched — nothing staged/committed
  });

  test('initialized:false (template clone) manifest: same untouched guarantee', async () => {
    const repo = join(tmp, 'template-repo');
    initGitRepoWithDirtyTree(repo);
    writeFileSync(
      join(repo, 'agent.json'),
      JSON.stringify({ ...INITIALIZED_MANIFEST, initialized: false }, null, 2) + '\n',
    );
    const before = gitStatus(repo);
    const spawned: string[] = [];
    const io = { spawnPush: (root: string) => { spawned.push(root); } };

    const startOut = collectStdout();
    await runHook(['session-start'], { ...startOut.io, ...io, stdin: '', cwd: repo });
    expect(startOut.get()).not.toContain('Unpushed work');
    await runHook(['session-end'], {
      ...io,
      write: () => {},
      stdin: JSON.stringify({ session_id: 'sess-template', cwd: repo }),
    });

    expect(spawned).toEqual([]);
    expect(gitStatus(repo)).toBe(before);
  });

  test('initialized bootstrap workspace + dirty tree: session-start prints the recovery note and spawns the detached push', async () => {
    const repo = join(tmp, 'boot-repo');
    initGitRepoWithDirtyTree(repo);
    writeFileSync(join(repo, 'agent.json'), JSON.stringify(INITIALIZED_MANIFEST, null, 2) + '\n');
    markRepoPhaseComplete(repo); // repo phase done → push is allowed
    const spawned: string[] = [];

    const out = collectStdout();
    expect(
      await runHook(['session-start'], {
        ...out.io,
        spawnPush: (root: string) => { spawned.push(root); },
        stdin: '',
        cwd: repo,
      }),
    ).toBe(0);

    expect(out.get()).toContain('Unpushed work from a previous session detected');
    expect(spawned).toHaveLength(1);
    // The spawned root is the git toplevel of the workspace (macOS may prefix
    // /private on tmpdir paths — compare via git itself).
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    expect(spawned[0]).toBe(toplevel);
    expect((await lastHeartbeat())?.reason).toBe('push_spawned');
  });

  test('initialized workspace: session-end also spawns the backstop push', async () => {
    const repo = join(tmp, 'boot-repo-end');
    initGitRepoWithDirtyTree(repo);
    writeFileSync(join(repo, 'agent.json'), JSON.stringify(INITIALIZED_MANIFEST, null, 2) + '\n');
    markRepoPhaseComplete(repo); // repo phase done → push is allowed
    const spawned: string[] = [];
    await runHook(['session-end'], {
      write: () => {},
      spawnPush: (root: string) => { spawned.push(root); },
      stdin: JSON.stringify({ session_id: 'sess-boot-end', cwd: repo }),
    });
    expect(spawned).toHaveLength(1);
  });

  test('create-repo-first BEFORE the repo phase (no repo_url yet): session-start defers the push, never publishes to an unverified origin', async () => {
    const repo = join(tmp, 'boot-repo-pending');
    initGitRepoWithDirtyTree(repo);
    writeFileSync(join(repo, 'agent.json'), JSON.stringify(INITIALIZED_MANIFEST, null, 2) + '\n');
    // NB: no markRepoPhaseComplete — the repo phase has not run yet.
    const spawned: string[] = [];
    const out = collectStdout();
    await runHook(['session-start'], {
      ...out.io,
      spawnPush: (root: string) => { spawned.push(root); },
      stdin: '',
      cwd: repo,
    });
    expect(spawned).toEqual([]); // deferred, not spawned
    expect((await lastHeartbeat())?.reason).toBe('push_deferred_repo_pending');
  });

  test('create-repo-first BEFORE the repo phase (no repo_url yet): session-end defers the backstop push', async () => {
    const repo = join(tmp, 'boot-repo-pending-end');
    initGitRepoWithDirtyTree(repo);
    writeFileSync(join(repo, 'agent.json'), JSON.stringify(INITIALIZED_MANIFEST, null, 2) + '\n');
    const spawned: string[] = [];
    await runHook(['session-end'], {
      write: () => {},
      spawnPush: (root: string) => { spawned.push(root); },
      stdin: JSON.stringify({ session_id: 'sess-boot-end-pending', cwd: repo }),
    });
    expect(spawned).toEqual([]); // deferred until `gbrain bootstrap repo`
  });
});

// ── stop-hook per-turn push [D3/D17/D20] ────────────────────────────────────
//
// SessionEnd never fires on /exit and a cloud VM can be reclaimed between
// turns; the Stop boundary is the only always-runs cadence. These tests pin:
// the security gate (same as session-end), per-root debounce isolation, the
// kill switch, the failing-status bypass, and fail-open state handling.

function stopIo(repo: string, spawned: string[]) {
  return {
    write: () => {},
    spawnPush: (root: string) => { spawned.push(root); },
    stdin: JSON.stringify({ session_id: 'sess-stop-push', cwd: repo }),
  };
}

function bootRepo(name: string, opts: { repoPhase?: boolean; clean?: boolean } = {}): string {
  const repo = join(tmp, name);
  initGitRepoWithDirtyTree(repo);
  writeFileSync(join(repo, 'agent.json'), JSON.stringify(INITIALIZED_MANIFEST, null, 2) + '\n');
  if (opts.repoPhase !== false) markRepoPhaseComplete(repo);
  if (opts.clean) {
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { stdio: 'ignore' });
    // Model a FULLY-PUSHED clean repo: origin/<branch> == HEAD, so treeNeedsPush
    // measures zero commits ahead (a committed-but-never-pushed repo correctly
    // reports needs-push under the new origin-ref-based measure).
    const branch = execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', repo, 'update-ref', `refs/remotes/origin/${branch}`, head], { stdio: 'ignore' });
  }
  return repo;
}

const stopPushStateFiles = () => {
  try {
    return readdirSync(join(home(), 'bootstrap')).filter((n) => n.startsWith('stop-push-'));
  } catch {
    return [];
  }
};

describe('stop-hook per-turn push [D3]', () => {
  test('dirty initialized workspace: stop spawns the detached push, records per-root state (0600), heartbeat push_spawned', async () => {
    const repo = bootRepo('stop-boot');
    const spawned: string[] = [];
    expect(await runHook(['stop'], stopIo(repo, spawned))).toBe(0);
    expect(spawned).toHaveLength(1);
    expect((await lastHeartbeat())?.reason).toBe('push_spawned');
    const states = stopPushStateFiles();
    expect(states).toHaveLength(1);
    const mode = statSync(join(home(), 'bootstrap', states[0]!)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('second stop inside the debounce window: push_debounced, no second spawn', async () => {
    process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN = '5';
    const repo = bootRepo('stop-debounce');
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toHaveLength(1);
    expect((await lastHeartbeat())?.reason).toBe('push_debounced');
  });

  test('GBRAIN_STOP_PUSH_DEBOUNCE_MIN=0 pushes every turn', async () => {
    process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN = '0';
    const repo = bootRepo('stop-zero');
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toHaveLength(2);
  });

  test('cloud-sandbox default is debounce 0 (CLAUDE_CODE_REMOTE=true, no explicit knob) [D17]', async () => {
    process.env.CLAUDE_CODE_REMOTE = 'true';
    const repo = bootRepo('stop-cloud');
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toHaveLength(2);
  });

  test('GBRAIN_STOP_PUSH=0 disables the per-turn push (buffer append still runs)', async () => {
    process.env.GBRAIN_STOP_PUSH = '0';
    const repo = bootRepo('stop-disabled');
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toEqual([]);
    expect((await lastHeartbeat())?.reason).toBe('push_disabled');
  });

  test('non-bootstrap git repo: never spawns (same security boundary as session-end)', async () => {
    const repo = join(tmp, 'stop-plain');
    initGitRepoWithDirtyTree(repo);
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toEqual([]);
    expect((await lastHeartbeat())?.reason).toBe('push_skipped_not_bootstrap');
  });

  test('repo phase pending (no repo_url): defers, never publishes to an unverified origin', async () => {
    const repo = bootRepo('stop-pending', { repoPhase: false });
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toEqual([]);
    expect((await lastHeartbeat())?.reason).toBe('push_deferred_repo_pending');
  });

  test('clean tree with nothing ahead: push_clean, no spawn (CRITICAL regression: buffer append unchanged)', async () => {
    const repo = bootRepo('stop-clean', { clean: true });
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toEqual([]);
    expect((await lastHeartbeat())?.reason).toBe('push_clean');
    // the live-buffer append still happened (stop's original contract)
    const bufDir = join(home(), 'transcripts', 'live');
    expect(readdirSync(bufDir).some((n) => n.includes('sess-stop-push'))).toBe(true);
  });

  test('corrupt per-root state file is treated as due (fail-open)', async () => {
    process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN = '5';
    const repo = bootRepo('stop-corrupt');
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    const state = stopPushStateFiles()[0]!;
    writeFileSync(join(home(), 'bootstrap', state), 'not json');
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toHaveLength(2);
  });

  test('[D20] a failing push-status bypasses the debounce (retry next turn)', async () => {
    process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN = '60';
    const repo = bootRepo('stop-retry');
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toHaveLength(1);
    // Simulate the detached child recording a refusal for THIS root.
    writeFileSync(
      pushStatusPathForRoot(toplevel),
      JSON.stringify({ ts: new Date().toISOString(), ok: false, reason: 'refused_visibility', repoRoot: toplevel }) + '\n',
      { mode: 0o600 },
    );
    // Inside the 60s failing-retry floor: still debounced (no spawn storm)…
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toHaveLength(1);
    // …but once the floor passes, the failing status bypasses the 60-MINUTE
    // debounce window (age the state file past the floor).
    const stateFile = join(home(), 'bootstrap', stopPushStateFiles()[0]!);
    const aged = JSON.parse(readFileSync(stateFile, 'utf8')) as { ts: string; root: string };
    writeFileSync(stateFile, JSON.stringify({ ...aged, ts: new Date(Date.now() - 90_000).toISOString() }) + '\n');
    await runHook(['stop'], stopIo(repo, spawned));
    expect(spawned).toHaveLength(2); // floor passed → failing status bypassed the 60min window
  });

  test('[D3] two workspaces debounce independently (per-root state, no clobber)', async () => {
    process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN = '60';
    const a = bootRepo('stop-ws-a');
    const b = join(tmp, 'stop-ws-b');
    initGitRepoWithDirtyTree(b);
    writeFileSync(join(b, 'agent.json'), JSON.stringify(INITIALIZED_MANIFEST, null, 2) + '\n');
    // B gets its own receipt? One receipt per home — markRepoPhaseComplete
    // overwrites. Root-binding means only the receipt's workspace pushes; the
    // OTHER workspace must be treated as repo-phase-pending, not crash.
    const spawned: string[] = [];
    await runHook(['stop'], stopIo(a, spawned));
    expect(spawned).toHaveLength(1);
    await runHook(['stop'], stopIo(b, spawned));
    expect(spawned).toHaveLength(1); // b defers (no receipt binding) — and does NOT clobber a's state
    expect((await lastHeartbeat())?.reason).toBe('push_deferred_repo_pending');
    await runHook(['stop'], stopIo(a, spawned));
    expect(spawned).toHaveLength(1); // a still debounced — b's activity didn't reset a
    expect((await lastHeartbeat())?.reason).toBe('push_debounced');
  });
});

// ── push-failure banner [D5/D13/D19] ────────────────────────────────────────

describe('user-prompt push-failure banner [D5]', () => {
  // repoRoot must EXIST on disk: entries for deleted workspaces are ghosts
  // the reader filters out by design (they could never be cleared).
  const bannerRoot = () => {
    const r = join(tmp, 'banner-brain');
    mkdirSync(r, { recursive: true });
    return r;
  };
  const failingStatus = (root: string, ts = new Date().toISOString()) => {
    mkdirSync(join(home(), 'bootstrap'), { recursive: true });
    writeFileSync(
      pushStatusPathForRoot(root),
      JSON.stringify({ ts, ok: false, reason: 'refused_visibility: origin unverifiable', repoRoot: root }) + '\n',
      { mode: 0o600 },
    );
  };

  test('failing push-status → banner-only payload on a degraded path, with BOTH additionalContext and systemMessage', async () => {
    const root = bannerRoot();
    failingStatus(root);
    const out = collectStdout();
    // No config at all → degraded no_pglite_path; the banner must still land.
    expect(await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) })).toBe(0);
    const payload = JSON.parse(out.get()) as {
      hookSpecificOutput?: { additionalContext?: string };
      systemMessage?: string;
    };
    expect(payload.hookSpecificOutput?.additionalContext).toContain('FAILING');
    expect(payload.hookSpecificOutput?.additionalContext).toContain('banner-brain');
    expect(payload.systemMessage).toContain('NOT on GitHub');
  });

  test('banner announces once per failure ts, then stays quiet [D19]', async () => {
    const root = bannerRoot();
    failingStatus(root);
    const first = collectStdout();
    await runHook(['user-prompt'], { ...first.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(first.get()).toContain('FAILING');
    const second = collectStdout();
    await runHook(['user-prompt'], { ...second.io, stdin: JSON.stringify({ prompt: 'hi again' }) });
    expect(second.get()).toBe(''); // announced — no re-fire inside the floor
  });

  test('a NEW failure ts re-announces immediately; a persisting one re-fires after the 30-min floor [D19]', async () => {
    const root = bannerRoot();
    failingStatus(root, '2026-08-12T00:00:00.000Z');
    const first = collectStdout();
    await runHook(['user-prompt'], { ...first.io, stdin: JSON.stringify({ prompt: 'x' }) });
    expect(first.get()).toContain('FAILING');
    // Same ts + fresh announce → quiet. Age the announce past the floor → re-fires.
    const announced = `${pushStatusPathForRoot(root)}.announced`;
    const state = JSON.parse(readFileSync(announced, 'utf8')) as { announced_ts: string };
    writeFileSync(
      announced,
      JSON.stringify({ announced_ts: state.announced_ts, last_announce_at: new Date(Date.now() - PUSH_ANNOUNCE_REFIRE_MS - 60_000).toISOString() }) + '\n',
    );
    const third = collectStdout();
    await runHook(['user-prompt'], { ...third.io, stdin: JSON.stringify({ prompt: 'z' }) });
    expect(third.get()).toContain('FAILING');
  });

  test('CRITICAL regression: ok push-status → NO banner, stdout empty on degraded paths', async () => {
    mkdirSync(join(home(), 'bootstrap'), { recursive: true });
    const okRoot = bannerRoot();
    writeFileSync(
      pushStatusPathForRoot(okRoot),
      JSON.stringify({ ts: new Date().toISOString(), ok: true, repoRoot: okRoot }) + '\n',
    );
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi' }) });
    expect(out.get()).toBe('');
  });

  test('banner rides INSIDE the main context payload when serve answers (one JSON doc, systemMessage present)', async () => {
    const dataDir = join(tmp, 'data');
    writePgliteConfig(dataDir);
    await startServer({ dataDir, blockText: 'BRAIN CONTEXT BLOCK' });
    const root = bannerRoot();
    failingStatus(root);
    const out = collectStdout();
    await runHook(['user-prompt'], { ...out.io, stdin: JSON.stringify({ prompt: 'hi', session_id: 'sess-banner' }) });
    const payload = JSON.parse(out.get()) as {
      hookSpecificOutput?: { additionalContext?: string };
      systemMessage?: string;
    };
    expect(payload.hookSpecificOutput?.additionalContext).toContain('FAILING');
    expect(payload.hookSpecificOutput?.additionalContext).toContain('BRAIN CONTEXT BLOCK');
    expect(payload.systemMessage).toContain('FAILING');
  });
});

// ── user-prompt deadline degradation [D5/ENG-1] ─────────────────────────────

describe('user-prompt deadline', () => {
  test('IPC server that accepts but never responds → exit 0, empty stdout, heartbeat reason deadline', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    writePgliteConfig(dataDir);
    ensureIpcSecret(dataDir); // client finds the secret, so it proceeds to the socket
    // A black-hole server: accepts the connection, never writes a byte.
    const blackHole = net.createServer(() => { /* accept and stall */ });
    await new Promise<void>((r) => blackHole.listen(resolveSocketPath(dataDir), r));
    servers.push(blackHole);

    const out = collectStdout();
    expect(
      await runHook(['user-prompt'], {
        ...out.io,
        stdin: JSON.stringify({ prompt: 'hello?' }),
        // Injected deadline seam (below the 600ms IPC client timeout) so the
        // test pins the DEADLINE path, not the client-timeout path, without
        // an 800ms wall-clock wait.
        userPromptDeadlineMs: 250,
      }),
    ).toBe(0);
    expect(out.get()).toBe(''); // late writes are suppressed post-deadline
    const hb = await lastHeartbeat();
    expect(hb?.event).toBe('user-prompt');
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('deadline');
  });
});

// ── compact segment lane + session-end remainder [cathedral 5] ──────────────

const boundaryLine = () =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'conversation compacted' });

describe('compact segment lane (cathedral 5)', () => {
  const corpus = () => join(home(), 'transcripts', 'corpus');

  test('banks a content-addressed since-last-boundary segment + ledger; heartbeat carries the code', async () => {
    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 'c.jsonl', [
      userLine('OLD-WINDOW-TEXT before the prior boundary'),
      boundaryLine(),
      userLine('NEW-WINDOW-TEXT after the prior boundary'),
      assistantLine('assistant reply in the new window'),
    ]);
    expect(
      await runHook(['compact'], {
        stdin: JSON.stringify({ session_id: 'sess-seg', transcript_path: transcript }),
        transcriptRoot: projRoot,
      }),
    ).toBe(0);
    const files = readdirSync(corpus()).filter((f) => f.startsWith('sess-seg.seg-') && f.endsWith('.txt'));
    expect(files).toHaveLength(1);
    const body = readFileSync(join(corpus(), files[0]), 'utf8');
    expect(body).toContain('NEW-WINDOW-TEXT');
    expect(body).not.toContain('OLD-WINDOW-TEXT');
    const ledger = JSON.parse(readFileSync(join(corpus(), 'sess-seg.ledger.json'), 'utf8')) as Array<{ hash: string }>;
    expect(ledger).toHaveLength(1);
    expect(files[0]).toContain(ledger[0].hash);
    const hb = await lastHeartbeat();
    expect(hb?.event).toBe('compact');
    expect(hb?.segment).toBe('segment_banked');
    // No serve configured in this test home — the banking IPC degrades AFTER
    // the segment was durably written (durability-first ordering).
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('no_pglite_path');
  });

  test('identical retry is idempotent: same file, segment_dup, single ledger entry', async () => {
    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 'd.jsonl', [
      userLine('window content that will retry'),
    ]);
    const io = {
      stdin: JSON.stringify({ session_id: 'sess-dup2', transcript_path: transcript }),
      transcriptRoot: projRoot,
    };
    await runHook(['compact'], io);
    await runHook(['compact'], { ...io });
    const files = readdirSync(corpus()).filter((f) => f.startsWith('sess-dup2.seg-'));
    expect(files).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(join(corpus(), 'sess-dup2.ledger.json'), 'utf8')) as unknown[];
    expect(ledger).toHaveLength(1);
    expect((await lastHeartbeat())?.segment).toBe('segment_dup');
  });

  test('transcript ending AT a boundary ⇒ empty_window, no segment written', async () => {
    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 'e.jsonl', [
      userLine('everything is before the boundary'),
      boundaryLine(),
    ]);
    await runHook(['compact'], {
      stdin: JSON.stringify({ session_id: 'sess-empty', transcript_path: transcript }),
      transcriptRoot: projRoot,
    });
    expect(readdirSync(corpus()).filter((f) => f.startsWith('sess-empty.seg-'))).toEqual([]);
    expect((await lastHeartbeat())?.segment).toBe('empty_window');
  });

  test('deadline below the scan budget ⇒ deadline_scan, nothing written (never unscanned)', async () => {
    const projRoot = join(tmp, 'projects');
    const transcript = seedTranscript(join(projRoot, 'p1'), 'f.jsonl', [userLine('some window text')]);
    await runHook(['compact'], {
      stdin: JSON.stringify({ session_id: 'sess-dl', transcript_path: transcript }),
      transcriptRoot: projRoot,
      compactDeadlineMs: 500, // < SEGMENT_MIN_BUDGET_MS(600) ⇒ deterministic deadline_scan
    });
    expect(existsSync(join(corpus(), 'sess-dl.ledger.json'))).toBe(false);
    expect(readdirSync(existsSync(corpus()) ? corpus() : tmp).filter((f) => f.startsWith('sess-dl.seg-'))).toEqual([]);
    expect((await lastHeartbeat())?.segment).toBe('deadline_scan');
  });

  test('segment content is secret-scanned at write time', async () => {
    const projRoot = join(tmp, 'projects');
    const planted = 'sk-' + 'FAKEfakeFAKEfake1234567890';
    const transcript = seedTranscript(join(projRoot, 'p1'), 'g.jsonl', [
      userLine(`the key is ${planted} in the compact window`),
    ]);
    await runHook(['compact'], {
      stdin: JSON.stringify({ session_id: 'sess-red2', transcript_path: transcript }),
      transcriptRoot: projRoot,
    });
    const files = readdirSync(corpus()).filter((f) => f.startsWith('sess-red2.seg-'));
    expect(files).toHaveLength(1);
    const body = readFileSync(join(corpus(), files[0]), 'utf8');
    expect(body).not.toContain(planted);
    expect(body).toContain('<REDACTED:openai>');
  });
});

describe('session-end remainder (cathedral 5 dedup contract)', () => {
  const corpus = () => join(home(), 'transcripts', 'corpus');

  test('remainder-only when the compact-banked segment covers the boundary window', async () => {
    const projRoot = join(tmp, 'projects');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    // 1. Compact fires BEFORE the boundary is written: window = w1.
    const preCompact = seedTranscript(join(projRoot, 'p1'), 'r1.jsonl', [
      userLine('W1-ONLY-TEXT first window'),
    ]);
    await runHook(['compact'], {
      stdin: JSON.stringify({ session_id: 'sess-rem', transcript_path: preCompact }),
      transcriptRoot: projRoot,
    });
    expect((await lastHeartbeat())?.segment).toBe('segment_banked');
    // 2. The harness appends the boundary + the post-compaction turns.
    const full = seedTranscript(join(projRoot, 'p1'), 'r1.jsonl', [
      userLine('W1-ONLY-TEXT first window'),
      boundaryLine(),
      userLine('REMAINDER-TEXT second window'),
    ]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-rem', transcript_path: full, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const body = readFileSync(join(corpus(), 'sess-rem.txt'), 'utf8');
    expect(body).toContain('REMAINDER-TEXT');
    expect(body).not.toContain('W1-ONLY-TEXT'); // already segment-banked — not re-written
    expect((await lastHeartbeat())?.segment).toBe('remainder');
  });

  test('no ledger coverage ⇒ full-transcript fallback exactly as before', async () => {
    const projRoot = join(tmp, 'projects');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const full = seedTranscript(join(projRoot, 'p1'), 'r2.jsonl', [
      userLine('W1-TEXT'),
      boundaryLine(),
      userLine('W2-TEXT'),
    ]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-fb', transcript_path: full, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const body = readFileSync(join(corpus(), 'sess-fb.txt'), 'utf8');
    expect(body).toContain('W1-TEXT');
    expect(body).toContain('W2-TEXT');
    expect((await lastHeartbeat())?.segment).toBe('full_fallback');
  });

  test('covered with empty remainder ⇒ skip_covered, no session corpus file written', async () => {
    const projRoot = join(tmp, 'projects');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    const preCompact = seedTranscript(join(projRoot, 'p1'), 'r3.jsonl', [
      userLine('ALL-BANKED-TEXT'),
    ]);
    await runHook(['compact'], {
      stdin: JSON.stringify({ session_id: 'sess-skip', transcript_path: preCompact }),
      transcriptRoot: projRoot,
    });
    const full = seedTranscript(join(projRoot, 'p1'), 'r3.jsonl', [
      userLine('ALL-BANKED-TEXT'),
      boundaryLine(),
    ]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-skip', transcript_path: full, cwd: ws }),
      transcriptRoot: projRoot,
    });
    expect(existsSync(join(corpus(), 'sess-skip.txt'))).toBe(false);
    expect((await lastHeartbeat())?.segment).toBe('skip_covered');
  });

  test('orphaned sidecars are GC-ed at session-end; live pairs kept', async () => {
    const projRoot = join(tmp, 'projects');
    const ws = join(tmp, 'ws');
    mkdirSync(ws, { recursive: true });
    mkdirSync(corpus(), { recursive: true });
    writeFileSync(join(corpus(), 'gone.txt.ingested'), '');
    writeFileSync(join(corpus(), 'live.txt'), 'x');
    writeFileSync(join(corpus(), 'live.txt.in-progress'), '');
    const t1 = seedTranscript(join(projRoot, 'p1'), 'r4.jsonl', [userLine('gc trigger content')]);
    await runHook(['session-end'], {
      stdin: JSON.stringify({ session_id: 'sess-gc', transcript_path: t1, cwd: ws }),
      transcriptRoot: projRoot,
    });
    const names = readdirSync(corpus());
    expect(names).not.toContain('gone.txt.ingested');
    expect(names).toContain('live.txt');
    expect(names).toContain('live.txt.in-progress');
  });
});

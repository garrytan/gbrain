/**
 * `gbrain sources push` CLI wrapper (sources.ts:runPush, via the exported
 * runSources dispatcher) — the seams the core workspace-push serial suite
 * does NOT cover:
 *
 *   - exit-code contract: 0 pushed / 0 skipped-in-flight, 5 blocked/refused,
 *     1 fail (push_failed / no local_path), 2 usage, 4 unknown source
 *   - `<id>` → sources.local_path resolution (stub engine; no PGLite)
 *   - --json output (machine-readable result on stdout, human lines absent)
 *
 * Harness: same real-git fixture pair as test/workspace-push.serial.test.ts
 * (bare origin + work clone over the file transport). runPush calls
 * process.exit() on the non-zero paths, so the driver patches process.exit
 * to throw a sentinel and captures console.log/console.error; everything is
 * restored in a finally. Serial file: mutates HOME/GBRAIN_HOME per test
 * (Bun snapshots env at startup — spawned git must see the swap, #2943).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { runSources } from '../src/commands/sources.ts';
import { acquirePushLock, resolveWorkspaceRoot } from '../src/core/workspace-push.ts';
import { SCAN_ALLOW_FILENAME } from '../src/core/secret-scan.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const T = 60_000; // explicit per-test timeout — bun ignores bunfig.toml's key
const OPENAI = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';

// #2943: env: process.env is REQUIRED — Bun snapshots env at startup, so
// spawned git would otherwise be blind to beforeEach's HOME/GBRAIN_HOME swap.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env,
  }).trim();
}
function originHead(bareRepo: string): string {
  return git(bareRepo, 'rev-parse', 'refs/heads/main');
}

let root: string;
let work: string;
let bare: string;
let saved: Record<string, string | undefined> = {};

function makePair(): void {
  bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore', env: process.env });
  work = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], {
    stdio: 'ignore', env: process.env,
  });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  writeFileSync(join(work, 'README.md'), 'init\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  try { git(work, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spc-'));
  saved = {
    HOME: process.env.HOME,
    GBRAIN_HOME: process.env.GBRAIN_HOME,
    GBRAIN_GIT_ALLOW_FILE_TRANSPORT: process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT,
  };
  process.env.HOME = mkdtempSync(join(root, 'home-'));
  // CX2-8: GBRAIN_HOME is a PARENT dir → effective home is $HOME/.gbrain.
  process.env.GBRAIN_HOME = process.env.HOME;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  makePair();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

// ── driver: run the wrapper, capture exit code + stdout/stderr ──────────────

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

interface CliRun {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

async function runPushCli(engine: BrainEngine, args: string[]): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  (process as { exit: (code?: number) => never }).exit = ((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never;
  console.log = (...a: unknown[]) => { stdout.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
  try {
    await runSources(engine, ['push', ...args]);
  } catch (e) {
    if (e instanceof ExitSentinel) exitCode = e.code;
    else throw e;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { exitCode, stdout, stderr };
}

/** Engine stub whose executeRaw serves canned source rows (and records params). */
function stubEngine(rows: Array<Record<string, unknown>>, calls: unknown[][] = []): BrainEngine {
  return {
    executeRaw: async (_sql: string, params?: unknown[]) => {
      calls.push(params ?? []);
      return rows;
    },
  } as unknown as BrainEngine;
}

/** Engine that throws on ANY use — proves --path never touches the DB. */
const untouchableEngine = new Proxy({}, {
  get(_t, prop) {
    return () => { throw new Error(`engine.${String(prop)} must not be called`); };
  },
}) as BrainEngine;

// ── exit 2: usage ────────────────────────────────────────────────────────────

describe('usage errors → exit 2', () => {
  test('neither <id> nor --path → exit 2 with usage line; engine untouched', async () => {
    const r = await runPushCli(untouchableEngine, []);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toContain('Usage: gbrain sources push');
  }, T);

  test('BOTH <id> and --path → exit 2 (mutually exclusive)', async () => {
    const r = await runPushCli(untouchableEngine, ['wiki', '--path', work]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toContain('Usage:');
  }, T);

  test('unknown flag → exit 2 naming the flag', async () => {
    const r = await runPushCli(untouchableEngine, ['--bogus']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toContain('Unknown flag: --bogus');
  }, T);
});

// ── exit 4 / exit 1: <id> resolution failures ───────────────────────────────

describe('<id> resolution failures', () => {
  test('unknown source id → exit 4', async () => {
    const r = await runPushCli(stubEngine([]), ['nope']);
    expect(r.exitCode).toBe(4);
    expect(r.stderr.join('\n')).toContain('Source "nope" not found');
  }, T);

  test('source with NULL local_path → exit 1 (nothing to push)', async () => {
    const r = await runPushCli(stubEngine([{ id: 'wiki', local_path: null }]), ['wiki']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.join('\n')).toContain('no local_path');
  }, T);
});

// ── <id> → local_path resolution happy path ─────────────────────────────────

describe('<id> → local_path resolution', () => {
  test('resolves the source row local_path and pushes THAT dir; exit 0', async () => {
    const calls: unknown[][] = [];
    const engine = stubEngine([{ id: 'wiki', local_path: work }], calls);
    writeFileSync(join(work, 'note.md'), 'remember this\n');
    const r = await runPushCli(engine, ['wiki', '--allow-unverified-remote']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join('\n')).toContain(`Pushed`);
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD')); // the row's dir got pushed
    expect(calls[0]).toEqual(['wiki']); // fetched by the given id
  }, T);
});

// ── exit 0: pushed / skipped-in-flight ──────────────────────────────────────

describe('exit 0 — pushed and clean skip', () => {
  test('--path push succeeds → exit 0, human summary, no DB access', async () => {
    writeFileSync(join(work, 'note.md'), 'n\n');
    const r = await runPushCli(untouchableEngine, ['--path', work, '--allow-unverified-remote']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join('\n')).toContain('Pushed');
    expect(r.stdout.join('\n')).toContain('(new commit)');
    expect(originHead(bare)).toBe(git(work, 'rev-parse', 'HEAD'));
  }, T);

  test('push already in flight → clean skip, exit 0 [G14/A5]', async () => {
    // Lock the RESOLVED repo root — workspacePush locks the realpath'd root,
    // and mkdtemp dirs on macOS sit behind the /var → /private/var symlink.
    const lock = acquirePushLock(resolveWorkspaceRoot(work)!);
    expect(lock.acquired).toBe(true);
    try {
      const r = await runPushCli(untouchableEngine, ['--path', work, '--allow-unverified-remote']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.join('\n')).toContain('skipped: push in flight');
      expect(r.stdout.join('\n')).toContain(String(process.pid));
    } finally {
      if (lock.acquired) lock.handle.release();
    }
  }, T);
});

// ── exit 5: blocked / refused ───────────────────────────────────────────────

describe('exit 5 — blocked and refused', () => {
  test('secret-scan findings → exit 5, names file+pattern+allowlist hint', async () => {
    writeFileSync(join(work, 'notes.md'), `my key: ${OPENAI}\n`);
    const r = await runPushCli(untouchableEngine, ['--path', work, '--allow-unverified-remote']);
    expect(r.exitCode).toBe(5);
    const err = r.stderr.join('\n');
    expect(err).toContain('PUSH BLOCKED');
    expect(err).toContain('notes.md');
    expect(err).toContain(SCAN_ALLOW_FILENAME);
    expect(err.includes(OPENAI)).toBe(false); // the value never surfaces
  }, T);

  test('tracked deny-glob match → exit 5 with the git rm --cached hint', async () => {
    writeFileSync(join(work, '.env'), 'SECRETISH=value\n');
    git(work, 'add', '-f', '.env');
    git(work, 'commit', '-qm', 'oops tracked env');
    const r = await runPushCli(untouchableEngine, ['--path', work, '--allow-unverified-remote']);
    expect(r.exitCode).toBe(5);
    const err = r.stderr.join('\n');
    expect(err).toContain('PUSH BLOCKED');
    expect(err).toContain('.env');
    expect(err).toContain('git rm --cached');
  }, T);

  test('unverifiable remote WITHOUT --allow-unverified-remote → exit 5, PUSH REFUSED', async () => {
    writeFileSync(join(work, 'note.md'), 'n\n');
    const before = originHead(bare);
    const r = await runPushCli(untouchableEngine, ['--path', work]);
    expect(r.exitCode).toBe(5);
    expect(r.stderr.join('\n')).toContain('PUSH REFUSED');
    expect(originHead(bare)).toBe(before); // nothing left the machine
  }, T);

  test('unscannable staged blob (over the scan cap) → exit 5, fail-closed', async () => {
    writeFileSync(join(work, 'big.bin'), Buffer.alloc(26 * 1024 * 1024, 0x61));
    const before = originHead(bare);
    const r = await runPushCli(untouchableEngine, ['--path', work, '--allow-unverified-remote']);
    expect(r.exitCode).toBe(5);
    const err = r.stderr.join('\n');
    expect(err).toContain('PUSH BLOCKED');
    expect(err).toContain('big.bin');
    expect(originHead(bare)).toBe(before); // nothing left the machine
  }, T);
});

// ── exit 1: push failure ────────────────────────────────────────────────────

describe('exit 1 — push failure', () => {
  test('unreachable origin → exit 1 with the failure status', async () => {
    git(work, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    writeFileSync(join(work, 'note.md'), 'n\n');
    const r = await runPushCli(untouchableEngine, ['--path', work, '--allow-unverified-remote']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.join('\n')).toContain('push failed (push_failed)');
  }, T);
});

// ── --json output ───────────────────────────────────────────────────────────

describe('--json output', () => {
  test('pushed → single JSON payload on stdout, human lines suppressed, exit 0', async () => {
    writeFileSync(join(work, 'note.md'), 'n\n');
    const r = await runPushCli(untouchableEngine, ['--path', work, '--allow-unverified-remote', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBe(1); // exactly the JSON blob — no "Pushed …" line
    const res = JSON.parse(r.stdout[0]);
    expect(res.status).toBe('pushed');
    expect(res.ok).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.branch).toBe('main');
  }, T);

  test('blocked_secrets → exit 5 AND machine-readable findings on stdout', async () => {
    writeFileSync(join(work, 'notes.md'), `my key: ${OPENAI}\n`);
    const r = await runPushCli(untouchableEngine, ['--path', work, '--allow-unverified-remote', '--json']);
    expect(r.exitCode).toBe(5);
    expect(r.stdout.length).toBe(1);
    const res = JSON.parse(r.stdout[0]);
    expect(res.status).toBe('blocked_secrets');
    expect(res.findings?.length).toBe(1);
    expect(res.findings[0].file).toBe('notes.md');
    expect(r.stdout[0].includes(OPENAI)).toBe(false); // redacted in JSON too
    // json mode suppresses the wrapper's human finding dump (the core logger
    // line still reaches stderr via `[gbrain]` — that one is expected).
    expect(r.stderr.join('\n')).not.toContain('allow this finding:');
  }, T);
});

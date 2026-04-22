import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { shellHandler } from '../src/core/minions/handlers/shell.ts';
import { computeAuditFilename, resolveAuditDir, logShellSubmission } from '../src/core/minions/handlers/shell-audit.ts';
import { isProtectedJobName, PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

// Build a minimal MinionJobContext for unit tests. Real worker provides this;
// here we mock it so the handler can be exercised without spinning up Postgres.
function makeCtx(
  data: Record<string, unknown>,
  opts: { signal?: AbortSignal; shutdownSignal?: AbortSignal } = {},
): MinionJobContext {
  return {
    id: 1,
    name: 'shell',
    data,
    attempts_made: 0,
    signal: opts.signal ?? new AbortController().signal,
    shutdownSignal: opts.shutdownSignal ?? new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

// ---- protected-names ---------------------------------------------------------

describe('protected-names', () => {
  test('shell is protected', () => {
    expect(isProtectedJobName('shell')).toBe(true);
    expect(PROTECTED_JOB_NAMES.has('shell')).toBe(true);
  });
  test('normalization: whitespace is trimmed before check', () => {
    expect(isProtectedJobName(' shell ')).toBe(true);
    expect(isProtectedJobName('\tshell\n')).toBe(true);
  });
  test('case-sensitive: Shell is NOT protected', () => {
    expect(isProtectedJobName('Shell')).toBe(false);
    expect(isProtectedJobName('SHELL')).toBe(false);
  });
  test('non-protected names pass through', () => {
    expect(isProtectedJobName('sync')).toBe(false);
    expect(isProtectedJobName('embed')).toBe(false);
    expect(isProtectedJobName('')).toBe(false);
  });
});

// ---- MinionQueue.add trusted guard ------------------------------------------

describe('MinionQueue.add protected-name guard', () => {
  test('add("shell", ...) without trusted arg throws', async () => {
    expect(queue.add('shell', { cmd: 'echo', cwd: '/tmp' })).rejects.toThrow(/protected job name/);
  });
  test('add("shell", ..., opts, {allowProtectedSubmit:true}) succeeds', async () => {
    const job = await queue.add('shell', { cmd: 'echo', cwd: '/tmp' }, undefined, { allowProtectedSubmit: true });
    expect(job.name).toBe('shell');
    expect(job.status).toBe('waiting');
  });
  // Whitespace bypass defense (Codex #1)
  test('add(" shell ", ...) without trusted arg throws (whitespace bypass defense)', async () => {
    expect(queue.add(' shell ', { cmd: 'echo', cwd: '/tmp' })).rejects.toThrow(/protected job name/);
  });
  test('add(" shell ", ...) with trusted arg inserts normalized name "shell"', async () => {
    const job = await queue.add(' shell ', { cmd: 'echo', cwd: '/tmp' }, undefined, { allowProtectedSubmit: true });
    expect(job.name).toBe('shell');
  });
  test('add("Shell", ...) is treated as non-protected (case-sensitive)', async () => {
    const job = await queue.add('Shell', {});
    expect(job.name).toBe('Shell');
    expect(job.status).toBe('waiting');
  });
  // Regression: non-protected names unaffected (Codex iron-rule)
  test('REGRESSION: add("sync", ...) without trusted arg still succeeds', async () => {
    const job = await queue.add('sync', { full: true });
    expect(job.name).toBe('sync');
    expect(job.status).toBe('waiting');
  });
  test('REGRESSION: trusted flag does NOT bypass empty-name check', async () => {
    expect(queue.add('', {}, undefined, { allowProtectedSubmit: true })).rejects.toThrow(/cannot be empty/);
  });
});

// ---- Shell handler: validation ----------------------------------------------

describe('shell handler: validation', () => {
  test('both cmd and argv → UnrecoverableError', async () => {
    const p = shellHandler(makeCtx({ cmd: 'echo', argv: ['echo'], cwd: '/tmp' }));
    expect(p).rejects.toThrow(UnrecoverableError);
  });
  test('neither cmd nor argv → UnrecoverableError', async () => {
    const p = shellHandler(makeCtx({ cwd: '/tmp' }));
    expect(p).rejects.toThrow(UnrecoverableError);
  });
  test('cwd missing → UnrecoverableError', async () => {
    const p = shellHandler(makeCtx({ cmd: 'echo ok' }));
    expect(p).rejects.toThrow(UnrecoverableError);
  });
  test('cwd not absolute → UnrecoverableError', async () => {
    const p = shellHandler(makeCtx({ cmd: 'echo ok', cwd: 'relative/path' }));
    expect(p).rejects.toThrow(UnrecoverableError);
  });
  test('argv non-array (string) → UnrecoverableError', async () => {
    const p = shellHandler(makeCtx({ argv: 'echo ok', cwd: '/tmp' }));
    expect(p).rejects.toThrow(UnrecoverableError);
  });
  test('argv with non-string entries → UnrecoverableError', async () => {
    const p = shellHandler(makeCtx({ argv: ['echo', 42], cwd: '/tmp' }));
    expect(p).rejects.toThrow(UnrecoverableError);
  });
  test('env with non-string values → UnrecoverableError', async () => {
    const p = shellHandler(makeCtx({ cmd: 'echo', cwd: '/tmp', env: { FOO: 42 } }));
    expect(p).rejects.toThrow(UnrecoverableError);
  });
});

// ---- Shell handler: spawn + output ------------------------------------------

describe('shell handler: spawn', () => {
  test('cmd happy path: echo ok → exit 0, stdout captured', async () => {
    const res = await shellHandler(makeCtx({ cmd: 'echo ok', cwd: '/tmp' })) as any;
    expect(res.exit_code).toBe(0);
    expect(res.stdout_tail).toBe('ok\n');
    expect(res.stderr_tail).toBe('');
    expect(typeof res.duration_ms).toBe('number');
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof res.pid).toBe('number');
  });
  test('argv happy path: ["echo","hi"] → exit 0, stdout "hi\\n"', async () => {
    const res = await shellHandler(makeCtx({ argv: ['echo', 'hi'], cwd: '/tmp' })) as any;
    expect(res.exit_code).toBe(0);
    expect(res.stdout_tail).toBe('hi\n');
  });
  test('non-zero exit → Error with stderr in message', async () => {
    const p = shellHandler(makeCtx({ cmd: 'echo fail 1>&2; exit 7', cwd: '/tmp' }));
    await expect(p).rejects.toThrow(/exit 7/);
  });
  test('argv with bogus binary → Error (retryable)', async () => {
    const p = shellHandler(makeCtx({ argv: ['gbrain-nonexistent-binary-xyz'], cwd: '/tmp' }));
    // spawn emits 'error' on ENOENT
    await expect(p).rejects.toThrow();
  });
  test('result shape includes all declared keys', async () => {
    const res = await shellHandler(makeCtx({ cmd: 'echo ok', cwd: '/tmp' })) as any;
    expect(Object.keys(res).sort()).toEqual(['duration_ms', 'exit_code', 'pid', 'stderr_tail', 'stdout_tail']);
  });
});

// ---- Shell handler: env allowlist -------------------------------------------

describe('shell handler: env allowlist', () => {
  test('process env leak prevention: a faux secret is NOT in child env', async () => {
    const saved = process.env.SHELL_TEST_SECRET;
    process.env.SHELL_TEST_SECRET = 'should-not-leak';
    try {
      const res = await shellHandler(makeCtx({
        cmd: 'echo "secret=${SHELL_TEST_SECRET:-EMPTY}"',
        cwd: '/tmp',
      })) as any;
      expect(res.stdout_tail).toBe('secret=EMPTY\n');
    } finally {
      if (saved === undefined) delete process.env.SHELL_TEST_SECRET;
      else process.env.SHELL_TEST_SECRET = saved;
    }
  });
  test('PATH is inherited from worker', async () => {
    const res = await shellHandler(makeCtx({
      cmd: 'echo "path=$PATH"',
      cwd: '/tmp',
    })) as any;
    expect(res.stdout_tail.startsWith('path=')).toBe(true);
    expect(res.stdout_tail.length).toBeGreaterThan('path=\n'.length);
  });
  test('caller-supplied env key is added', async () => {
    const res = await shellHandler(makeCtx({
      cmd: 'echo "val=$MY_CUSTOM"',
      cwd: '/tmp',
      env: { MY_CUSTOM: 'hello' },
    })) as any;
    expect(res.stdout_tail).toBe('val=hello\n');
  });
  test('caller-supplied env can override allowlisted key (PATH)', async () => {
    const res = await shellHandler(makeCtx({
      cmd: 'echo "path=$PATH"',
      cwd: '/tmp',
      env: { PATH: '/custom/bin' },
    })) as any;
    expect(res.stdout_tail).toBe('path=/custom/bin\n');
  });
});

// ---- Shell handler: abort --------------------------------------------------

describe('shell handler: abort', () => {
  test('ctx.signal.abort triggers SIGTERM and handler throws aborted', async () => {
    const ac = new AbortController();
    const promise = shellHandler(makeCtx(
      { cmd: 'sleep 30', cwd: '/tmp' },
      { signal: ac.signal },
    ));
    // Give spawn a beat to start
    setTimeout(() => ac.abort(new Error('cancel')), 50);
    await expect(promise).rejects.toThrow(/aborted/);
  });
  test('ctx.shutdownSignal.abort also triggers kill', async () => {
    const shutdownCtl = new AbortController();
    const promise = shellHandler(makeCtx(
      { cmd: 'sleep 30', cwd: '/tmp' },
      { shutdownSignal: shutdownCtl.signal },
    ));
    setTimeout(() => shutdownCtl.abort(new Error('shutdown')), 50);
    await expect(promise).rejects.toThrow(/aborted/);
  });
  test('pre-aborted signal → immediate kill', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancel'));
    const promise = shellHandler(makeCtx(
      { cmd: 'sleep 30', cwd: '/tmp' },
      { signal: ac.signal },
    ));
    await expect(promise).rejects.toThrow(/aborted/);
  });
});

// ---- shell-audit: ISO-week filename ----------------------------------------

describe('shell-audit: computeAuditFilename', () => {
  test('2027-01-01 is ISO week 53 of 2026', () => {
    expect(computeAuditFilename(new Date('2027-01-01T12:00:00Z'))).toBe('shell-jobs-2026-W53.jsonl');
  });
  test('2026-12-28 (Monday) is ISO week 53 of 2026', () => {
    expect(computeAuditFilename(new Date('2026-12-28T12:00:00Z'))).toBe('shell-jobs-2026-W53.jsonl');
  });
  test('2027-01-04 (Monday) is ISO week 1 of 2027', () => {
    expect(computeAuditFilename(new Date('2027-01-04T12:00:00Z'))).toBe('shell-jobs-2027-W01.jsonl');
  });
  test('2026-04-19 (mid-year reference)', () => {
    const f = computeAuditFilename(new Date('2026-04-19T00:00:00Z'));
    expect(f).toMatch(/^shell-jobs-2026-W\d{2}\.jsonl$/);
  });
});

// ---- shell-audit: write path -----------------------------------------------

describe('shell-audit: write', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-audit-test-'));
    process.env.GBRAIN_AUDIT_DIR = tmpDir;
  });
  afterAll(() => {
    delete process.env.GBRAIN_AUDIT_DIR;
  });

  test('GBRAIN_AUDIT_DIR env override resolves to the custom dir', () => {
    expect(resolveAuditDir()).toBe(tmpDir);
  });
  test('writes a JSONL line; creates dir if missing', () => {
    const inner = path.join(tmpDir, 'nested-not-yet-created');
    process.env.GBRAIN_AUDIT_DIR = inner;
    logShellSubmission({
      caller: 'cli', remote: false, job_id: 42, cwd: '/tmp', cmd_display: 'echo ok',
    });
    const files = fs.readdirSync(inner);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(inner, files[0]), 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.caller).toBe('cli');
    expect(parsed.job_id).toBe(42);
    expect(parsed.cmd_display).toBe('echo ok');
    expect(parsed.ts).toBeDefined();
  });
  test('argv_display stored as JSON array (Codex #11)', () => {
    logShellSubmission({
      caller: 'cli', remote: false, job_id: 1, cwd: '/tmp',
      argv_display: ['node', 'script.mjs', '--date', '2026-04-18'],
    });
    const files = fs.readdirSync(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed.argv_display)).toBe(true);
    expect(parsed.argv_display).toEqual(['node', 'script.mjs', '--date', '2026-04-18']);
  });
  test('does NOT log env values', () => {
    logShellSubmission({
      caller: 'cli', remote: false, job_id: 1, cwd: '/tmp', cmd_display: 'echo ok',
    });
    const files = fs.readdirSync(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    expect(content).not.toContain('env');
  });
  test('write failure (EACCES) is non-blocking', () => {
    // Point at a read-only target. /dev/null is not a directory.
    process.env.GBRAIN_AUDIT_DIR = '/dev/null/not-a-dir';
    // Should not throw — failures go to stderr.
    expect(() => logShellSubmission({
      caller: 'cli', remote: false, job_id: 1, cwd: '/tmp',
    })).not.toThrow();
  });
});

// ---- shell handler: UTF-8-safe output truncation ---------------------------

describe('shell handler: output truncation', () => {
  test('stdout > 64KB is truncated and marker is prepended', async () => {
    // Emit ~100KB of stdout to force truncation
    const res = await shellHandler(makeCtx({
      cmd: `yes ok | head -c 100000`,
      cwd: '/tmp',
    })) as any;
    expect(res.exit_code).toBe(0);
    expect(res.stdout_tail).toMatch(/^\[truncated \d+ bytes\]/);
    expect(res.stdout_tail.length).toBeGreaterThan(0);
    // Tail must contain characters we emitted
    expect(res.stdout_tail).toContain('ok');
  });
});

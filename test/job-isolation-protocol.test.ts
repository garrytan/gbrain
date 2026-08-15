/**
 * issue #5 — job-isolation protocol unit tests.
 *
 * Covers: outcome round-trip, missing/malformed/oversized decode paths
 * (oversize → UnrecoverableError: deterministic dead on attempt 1, never
 * silent truncation), instanceof reconstruction for the two error classes
 * executeJob branches on, child-CLI invocation resolution (env override /
 * binary / bun-dev fallback / fail-fast null), and killProcessGroup against
 * REAL detached processes — including the grandchild-death guarantee that
 * motivated group signaling (SIGKILL on a wrapper pid alone orphans the
 * handler; Bun rejects negative pids so the /bin/kill fallback is what
 * actually runs under `bun test`, making this a real-runtime regression
 * test for oven-sh/bun#15791).
 */

import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHILD_OUTCOME_MAX_BYTES,
  buildChildArgs,
  decodeChildOutcomeFile,
  encodeHandlerError,
  killProcessGroup,
  reconstructHandlerError,
  resolveChildCliInvocation,
  writeChildOutcomeFile,
  type ChildOutcome,
} from '../src/core/minions/job-isolation.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/handlers/subagent.ts';

function tmpFile(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-isolation-test-'));
  return { dir, path: join(dir, name) };
}

describe('outcome file round-trip', () => {
  test('success outcome survives write + decode; write is atomic (no .tmp left)', () => {
    const { dir, path } = tmpFile('outcome.json');
    try {
      writeChildOutcomeFile(path, { outcome: 'success', result: { pages: 3, ok: true } });
      expect(existsSync(`${path}.tmp`)).toBe(false);
      const decoded = decodeChildOutcomeFile(path);
      expect(decoded).toEqual({ outcome: 'success', result: { pages: 3, ok: true } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing file → generic Error naming the crash class', () => {
    const { dir, path } = tmpFile('never-written.json');
    try {
      expect(() => decodeChildOutcomeFile(path)).toThrow(/without writing its outcome file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed JSON → generic Error with byte count, NEVER file content', () => {
    const { dir, path } = tmpFile('garbage.json');
    try {
      writeFileSync(path, 'sk-secret-key-do-not-leak {{{', 'utf8');
      try {
        decodeChildOutcomeFile(path);
        throw new Error('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('not valid JSON');
        expect(msg).toContain('bytes');
        expect(msg).not.toContain('sk-secret');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('oversize file → UnrecoverableError naming the cap (dead on attempt 1)', () => {
    const { dir, path } = tmpFile('huge.json');
    try {
      writeFileSync(path, '{"outcome":"success","result":"xx"}', 'utf8');
      try {
        decodeChildOutcomeFile(path, 16); // tiny injected cap keeps the test fast
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UnrecoverableError);
        expect((e as Error).message).toContain('outcome cap');
      }
      // Default cap sanity.
      expect(CHILD_OUTCOME_MAX_BYTES).toBe(32 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unrecognized shape → generic Error (byte count only)', () => {
    const { dir, path } = tmpFile('weird.json');
    try {
      writeFileSync(path, '{"totally":"unrelated"}', 'utf8');
      expect(() => decodeChildOutcomeFile(path)).toThrow(/unrecognized shape/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handler-error encode → reconstruct (instanceof parity with inline mode)', () => {
  test('UnrecoverableError survives the boundary', () => {
    const enc = encodeHandlerError(new UnrecoverableError('bad config, never retry'));
    expect(enc.outcome).toBe('error');
    const rebuilt = reconstructHandlerError(enc as Extract<ChildOutcome, { outcome: 'error' }>);
    expect(rebuilt).toBeInstanceOf(UnrecoverableError);
    expect(rebuilt.message).toBe('bad config, never retry');
  });

  test('RateLeaseUnavailableError survives with lease fields', () => {
    const enc = encodeHandlerError(new RateLeaseUnavailableError('anthropic', 4, 4));
    const rebuilt = reconstructHandlerError(enc as Extract<ChildOutcome, { outcome: 'error' }>);
    expect(rebuilt).toBeInstanceOf(RateLeaseUnavailableError);
    const lease = rebuilt as RateLeaseUnavailableError;
    expect(lease.key).toBe('anthropic');
    expect(lease.active).toBe(4);
    expect(lease.max).toBe(4);
  });

  test('generic Error carries message + child stack; unknown kinds degrade to generic', () => {
    const boom = new Error('handler exploded');
    const enc = encodeHandlerError(boom) as Extract<ChildOutcome, { outcome: 'error' }>;
    const rebuilt = reconstructHandlerError(enc);
    expect(rebuilt).toBeInstanceOf(Error);
    expect(rebuilt).not.toBeInstanceOf(UnrecoverableError);
    expect(rebuilt.message).toBe('handler exploded');
    expect((rebuilt as Error & { childStack?: string }).childStack).toContain('handler exploded');

    const weird = reconstructHandlerError({
      outcome: 'error',
      errorKind: 'generic',
      message: 'from a hostile file',
    });
    expect(weird).toBeInstanceOf(Error);
    expect(weird).not.toBeInstanceOf(UnrecoverableError);
  });

  test('non-Error throws (strings) encode without crashing', () => {
    const enc = encodeHandlerError('plain string throw');
    expect(enc.outcome).toBe('error');
    if (enc.outcome === 'error') expect(enc.message).toBe('plain string throw');
  });
});

describe('child CLI invocation resolution', () => {
  test('env override wins', () => {
    const inv = resolveChildCliInvocation(
      { GBRAIN_JOB_CHILD_CLI: '/opt/custom/gbrain' },
      '/usr/bin/bun',
      '/repo/src/cli.ts',
      () => '/usr/local/bin/gbrain',
    );
    expect(inv).toEqual({ cmd: '/opt/custom/gbrain', argsPrefix: [] });
  });

  test('compiled binary next', () => {
    const inv = resolveChildCliInvocation({}, '/usr/bin/bun', '/repo/src/cli.ts', () => '/usr/local/bin/gbrain');
    expect(inv).toEqual({ cmd: '/usr/local/bin/gbrain', argsPrefix: [] });
  });

  test('bun-dev fallback when no binary resolves', () => {
    const inv = resolveChildCliInvocation({}, '/usr/bin/bun', '/repo/src/cli.ts', () => null);
    expect(inv).toEqual({ cmd: '/usr/bin/bun', argsPrefix: ['/repo/src/cli.ts'] });
  });

  test('nothing resolves → null (caller must fail fast at startup)', () => {
    const inv = resolveChildCliInvocation({}, '/usr/bin/bun', '/repo/dist/other.js', () => null);
    expect(inv).toBeNull();
  });

  test('throwing binary resolver falls through to the dev fallback', () => {
    const inv = resolveChildCliInvocation({}, '/usr/bin/bun', '/repo/src/cli.ts', () => {
      throw new Error('which failed');
    });
    expect(inv).toEqual({ cmd: '/usr/bin/bun', argsPrefix: ['/repo/src/cli.ts'] });
  });

  test('child argv shape', () => {
    expect(buildChildArgs(42)).toEqual(['jobs', 'run-child', '--job-id', '42']);
  });
});

describe('killProcessGroup (real detached processes; Bun negative-pid fallback)', () => {
  async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  test('group SIGKILL kills the child AND its grandchild', async () => {
    const { dir, path: pidFile } = tmpFile('grandchild.pid');
    try {
      // Child shell spawns a long-lived grandchild and records its pid.
      const child = spawn('/bin/sh', ['-c', `sleep 300 & echo $! > ${pidFile}; wait`], {
        detached: true,
        stdio: 'ignore',
      });
      expect(child.pid).toBeGreaterThan(0);
      const gotPid = await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 3_000);
      expect(gotPid).toBe(true);
      const grandchildPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      expect(alive(child.pid!)).toBe(true);
      expect(alive(grandchildPid)).toBe(true);

      killProcessGroup(child.pid!, 'SIGKILL');

      const bothDead = await waitFor(() => !alive(child.pid!) && !alive(grandchildPid), 3_000);
      expect(bothDead).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('SIGTERM delivery to a live group returns true; dead group returns false', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: 'ignore' });
    const delivered = killProcessGroup(child.pid!, 'SIGTERM');
    expect(delivered).toBe(true);
    await waitFor(() => {
      try {
        process.kill(child.pid!, 0);
        return false;
      } catch {
        return true;
      }
    }, 3_000);
    // Group is gone now — a second signal reports not-delivered.
    expect(killProcessGroup(child.pid!, 'SIGKILL')).toBe(false);
  }, 15_000);

  test('nonsense pids are refused without throwing', () => {
    expect(killProcessGroup(0, 'SIGTERM')).toBe(false);
    expect(killProcessGroup(1, 'SIGTERM')).toBe(false);
    expect(killProcessGroup(-5, 'SIGTERM')).toBe(false);
    expect(killProcessGroup(1.5 as unknown as number, 'SIGTERM')).toBe(false);
  });
});

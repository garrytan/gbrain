/**
 * #4418 — `jobs supervisor start --detach` must not inherit the invoker's
 * stderr.
 *
 * The detach path re-exec'd the supervisor with
 * stdio ['ignore','ignore','inherit']; the worker then inherited that same
 * descriptor via ChildWorkerSupervisor's stdio 'inherit'. When a short-lived
 * automation runner closed its capture pipe, the worker exited 141 (SIGPIPE)
 * on its next stderr write and the supervisor's crash/backoff logging could
 * kill it too — stale jobs + locks while producers kept enqueueing. Pins:
 *
 *   1. the sink prefers a durable append-mode log in the audit dir
 *      (GBRAIN_AUDIT_DIR honored) and the fd is actually writable;
 *   2. an unusable audit dir falls back to the null device — never 'inherit';
 *   3. the jobs.ts detach branch routes through spawnDetachedSupervisor and
 *      no longer passes stderr 'inherit' (source pin — the branch needs a
 *      live Postgres supervisor to exercise end-to-end).
 */
import { afterEach, describe, test, expect, mock, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  openDetachedStderrSink,
  closeDetachedStderrSink,
  spawnDetachedSupervisor,
} from '../src/core/minions/detached-stderr.ts';
import { surfaceSource } from './helpers/source-surface.ts';

describe('openDetachedStderrSink (#4418)', () => {
  test('opens a durable append-mode log in the audit dir (GBRAIN_AUDIT_DIR honored)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-detached-stderr-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        const sink = openDetachedStderrSink();
        expect(typeof sink.fd).toBe('number');
        expect(sink.path).toBe(join(dir, 'supervisor-stderr.log'));
        // The fd is genuinely writable — the property that keeps the
        // supervisor + worker alive after the invoker's pipe closes.
        writeSync(sink.fd as number, 'worker lifecycle line\n');
        closeDetachedStderrSink(sink);
        expect(readFileSync(sink.path!, 'utf-8')).toContain('worker lifecycle line');
        // Append mode: a second open must not truncate the first write.
        const sink2 = openDetachedStderrSink();
        closeDetachedStderrSink(sink2);
        expect(readFileSync(sink.path!, 'utf-8')).toContain('worker lifecycle line');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unusable audit dir falls back to the null device — never inherit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-detached-stderr-bad-'));
    try {
      // Point the audit dir UNDER a regular file so mkdir fails.
      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, 'not a dir', 'utf-8');
      await withEnv({ GBRAIN_AUDIT_DIR: join(blocker, 'nested') }, async () => {
        const sink = openDetachedStderrSink();
        expect(typeof sink.fd).toBe('number');
        expect(sink.path === '/dev/null' || sink.path === '\\\\.\\NUL').toBe(true);
        closeDetachedStderrSink(sink);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('closeDetachedStderrSink is idempotent and ignore-safe', () => {
    closeDetachedStderrSink({ fd: 'ignore', path: null });
    const sink = openDetachedStderrSink();
    closeDetachedStderrSink(sink);
    closeDetachedStderrSink(sink); // double-close swallowed
  });
});

describe('spawnDetachedSupervisor argv (#7532)', () => {
  afterEach(() => { mock.restore(); });

  async function spawnedArgs(execPath: string, cliScript: string): Promise<unknown[]> {
    const dir = mkdtempSync(join(tmpdir(), 'gb-detached-argv-'));
    const spawn = spyOn(childProcess, 'spawn').mockImplementation((() => ({ pid: 4242, unref: () => {} })) as never);
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
        expect(spawnDetachedSupervisor(execPath, cliScript, ['jobs', 'supervisor', 'start']).pid).toBe(4242);
      });
      expect(spawn.mock.calls.length).toBe(1);
      expect(spawn.mock.calls[0]?.[0]).toBe(execPath);
      return spawn.mock.calls[0]?.[1] as unknown[];
    } finally {
      mock.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a compiled binary gets only its CLI args, not its embedded /$bunfs entry', async () => {
    expect(await spawnedArgs('/opt/acme-example/bin/gbrain-linux-x64', '/$bunfs/root/gbrain-linux-x64'))
      .toEqual(['jobs', 'supervisor', 'start']);
  });

  test('a bun or node runtime keeps the CLI script as its first arg', async () => {
    expect(await spawnedArgs('/usr/local/bin/bun', '/opt/acme-example/gbrain/src/cli.ts'))
      .toEqual(['/opt/acme-example/gbrain/src/cli.ts', 'jobs', 'supervisor', 'start']);
    expect(await spawnedArgs('/usr/local/bin/node', '/opt/acme-example/gbrain/dist/cli.js'))
      .toEqual(['/opt/acme-example/gbrain/dist/cli.js', 'jobs', 'supervisor', 'start']);
  });
});

describe('jobs.ts detach branch (source pin, #4418)', () => {
  const jobsSource = surfaceSource('jobs');

  test('the detach spawn routes through spawnDetachedSupervisor', () => {
    expect(jobsSource).toContain('spawnDetachedSupervisor');
  });

  test("no spawn in jobs.ts hands the detached child an 'inherit' stderr", () => {
    expect(jobsSource).not.toContain("stdio: ['ignore', 'ignore', 'inherit']");
  });
});

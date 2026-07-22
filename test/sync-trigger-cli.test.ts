/**
 * Tests for `gbrain sync trigger` CLI (v0.40 D18).
 *
 * Validates the push-trigger entry point:
 *   - Help text renders
 *   - --source <id> required (exits 2)
 *   - --priority invalid (exits 2)
 *   - Non-existent source errors before submit (exits 1)
 *   - Successful submit prints job_id=N on stdout
 *   - Default priority is high (-10)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSyncTrigger } from '../src/commands/sync.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

/** Capture process.exit and stdout/stderr writes for one runSyncTrigger call. */
async function capture(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  const exitError = new Error('__exit__');
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw exitError;
  }) as never;
  console.log = (...a: unknown[]) => { stdout += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(' ') + '\n'; };
  try {
    await runSyncTrigger(engine, args);
  } catch (e) {
    if (e !== exitError) throw e;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout, stderr, exitCode };
}

describe('runSyncTrigger', () => {
  test('--help prints usage and returns', async () => {
    const { stdout, exitCode } = await capture(['--help']);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('gbrain sync trigger');
    expect(stdout).toContain('--source');
    expect(stdout).toContain('--priority');
  });

  test('missing --source exits 2 with hint', async () => {
    const { stderr, exitCode } = await capture([]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--source <id> is required');
  });

  test('invalid --priority exits 2', async () => {
    const { stderr, exitCode } = await capture(['--source', 'default', '--priority', 'urgent']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Invalid --priority value');
  });

  test('non-existent source exits 1', async () => {
    const { stderr, exitCode } = await capture(['--source', 'does-not-exist']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not found');
  });

  test('valid trigger submits sync job + prints job_id=N to stdout', async () => {
    const { stdout, exitCode } = await capture(['--source', 'default']);
    expect(exitCode).toBeNull();
    expect(stdout).toMatch(/^job_id=\d+$/m);

    // Verify a sync job exists with auto_embed_backfill + priority -10
    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'sync', limit: 5 });
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    expect(job.priority).toBe(-10);
    expect((job.data as { sourceId: string }).sourceId).toBe('default');
    expect((job.data as { auto_embed_backfill: boolean }).auto_embed_backfill).toBe(true);
  });

  test('--priority normal maps to 0', async () => {
    const { exitCode } = await capture(['--source', 'default', '--priority', 'normal']);
    expect(exitCode).toBeNull();
    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'sync', limit: 5 });
    expect(jobs[0].priority).toBe(0);
  });

  test('--priority low maps to 5', async () => {
    const { exitCode } = await capture(['--source', 'default', '--priority', 'low']);
    expect(exitCode).toBeNull();
    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'sync', limit: 5 });
    expect(jobs[0].priority).toBe(5);
  });
});

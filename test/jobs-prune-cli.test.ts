import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { parseJobsPruneArgs, runJobs } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function addOldCancelledJob(daysAgo = 60): Promise<number> {
  const job = await queue.add('sync', {});
  await queue.cancelJob(job.id);
  await engine.executeRaw(
    'UPDATE minion_jobs SET updated_at = $1 WHERE id = $2',
    [new Date(Date.now() - daysAgo * 86400000).toISOString(), job.id],
  );
  return job.id;
}

async function withCapturedStdout<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const value = await fn();
    return { value, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('gbrain jobs prune CLI safety flags', () => {
  test('--dry-run reports count without deleting terminal jobs', async () => {
    const id = await addOldCancelledJob();

    const { output } = await withCapturedStdout(() =>
      runJobs(engine, ['prune', '--older-than', '30d', '--dry-run']),
    );

    expect(output).toContain('[dry-run] would prune 1 jobs');
    expect(await queue.getJob(id)).not.toBeNull();
  });

  test('--help is side-effect-free', async () => {
    const id = await addOldCancelledJob();

    const { output } = await withCapturedStdout(() => runJobs(engine, ['prune', '--help']));

    expect(output).toContain('gbrain jobs prune');
    expect(await queue.getJob(id)).not.toBeNull();
  });

  test('unknown flags fail before the prune path can run', () => {
    expect(() => parseJobsPruneArgs(['--dryrun'])).toThrow('unknown jobs prune flag');
    expect(() => parseJobsPruneArgs(['--older-than', '30d', '--bogus'])).toThrow('unknown jobs prune flag');
  });
});

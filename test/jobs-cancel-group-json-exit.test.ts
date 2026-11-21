import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runJobsCancel } from '../src/commands/jobs/cancel.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function run(extra: string[]): Promise<number | undefined> {
  const queue = new MinionQueue(engine);
  let code: number | undefined;
  const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => { code = c ?? 0; throw new Error('exit'); }) as never);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runJobsCancel({ args: ['cancel', '--group', 'nonexistent-zz', ...extra], engine, engineOrNull: engine, queue });
  } catch { /* captured via exit spy */ } finally {
    exit.mockRestore(); log.mockRestore(); err.mockRestore();
  }
  return code;
}

test('unknown spend group exits 1 in human mode', async () => {
  expect(await run([])).toBe(1);
});

test('unknown spend group exits 1 with --json too', async () => {
  expect(await run(['--json'])).toBe(1);
});

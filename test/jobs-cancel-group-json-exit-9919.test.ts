/**
 * #9919: gbrain jobs cancel --group <unknown> exited 1, but with --json it printed jobs: 0 and exited 0, because
 * the JSON branch returned before the empty-group check.
 *
 * 1. Protects: an empty spend group exits 1 in both modes; --json prints a structured not_found error.
 * 2. Fails when: the --json branch returns before the empty-group check again.
 * 3. Real seams: runJobsCancel on a PGLite brain with a real MinionQueue.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runJobsCancel } from '../src/commands/jobs/cancel.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

async function run(extra: string[]): Promise<{ code: number | undefined; out: string }> {
  const lines: string[] = [];
  let code: number | undefined;
  _resetCliExitVerdictForTests();
  const exit = spyOn(process, 'exit').mockImplementation(((c?: number) => { code = c ?? 0; throw new Error('exit'); }) as never);
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runJobsCancel({ args: ['cancel', '--group', 'nonexistent-zz', ...extra], engine, engineOrNull: engine, queue: new MinionQueue(engine) } as never);
  } catch { /* process.exit is captured by the spy */ } finally {
    exit.mockRestore(); log.mockRestore(); err.mockRestore();
  }
  return { code: code ?? currentExitCode(), out: lines.join('\n') };
}

test('an unknown spend group exits 1 in human mode', async () => {
  expect((await run([])).code).toBe(1);
});

test('an unknown spend group exits 1 with --json and prints a structured error', async () => {
  const { code, out } = await run(['--json']);
  expect(code).toBe(1);
  expect(JSON.parse(out).code).toBe('not_found');
});

/**
 * Refusal-swallow sites in the minion worker path (triage rows 7-11: spend refusal record, terminal hook, worker
 * pause release, quiet-hours defer, worker stall check): a raw-SQL catch must not turn the Rust engine's
 * `engine_capability_missing` refusal into a quiet default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each site either reads and writes through a typed member (so an engine whose `executeRaw` refuses runs it
 *    exactly as PGLite does, and the Rust arm is compared with it), or lets the refusal surface.
 *  - Regression: the refusal was logged at most, so a Rust brain's terminal hook never ran, a spend refusal left no result
 *    row, a pause or quiet-hours release left the claim to expire, and the stall check never looked.
 *  - Why existing coverage misses it: the worker tests run PGLite, where every raw statement succeeds.
 *  - Seam: a PGLite engine wrapped so `executeRaw` throws the real refusal (test/helpers/refusing-engine.ts); the Rust
 *    cases need the addon and are skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { terminalHookNotifier } from '../../src/core/minions/terminal-hook.ts';
import { refusingEngine } from '../helpers/refusing-engine.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from '../engine-parity/rust-arm.ts';

let pg: PGLiteEngine;
beforeAll(async () => {
  pg = new PGLiteEngine();
  await pg.connect({ database_url: '' });
  await pg.initSchema();
}, 60_000);
afterAll(async () => { await pg.disconnect(); });

const rustRun = existsSync(rustArmAddonPath()) || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' ? test : test.skip;

function hookScript(): { dir: string; argv: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-refusal-hook-'));
  const script = join(dir, 'hook.sh');
  writeFileSync(script, '#!/bin/sh\nprintf "%s|%s" "$GBRAIN_JOB_ID" "$GBRAIN_JOB_STATUS" > "$1/$GBRAIN_JOB_ID.env"\n', { mode: 0o755 });
  return { dir, argv: ['/bin/sh', script, dir] };
}

/** Runs one `noop` job to completion on a worker whose engine is `engine`, with the terminal hook notifier attached. */
async function runHookedJob(engine: BrainEngine, workerEngine: BrainEngine, argv: string[]): Promise<number> {
  const queue = new MinionQueue(engine);
  const job = await queue.add('hook-ok', { n: 1 });
  const notifier = terminalHookNotifier(workerEngine, { argv, timeout_ms: 5_000 });
  const worker = new MinionWorker(workerEngine, { pollInterval: 50, healthCheckInterval: 0, onJobSettled: notifier.onJobSettled });
  worker.register('hook-ok', async () => ({ fine: true }));
  const running = worker.start();
  for (let i = 0; i < 200 && (await queue.getJob(job.id))?.status !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
  worker.stop();
  await running;
  await notifier.drain();
  return job.id;
}

describe('worker refusal-swallow sites', () => {
  test('S8 terminalHookNotifier: the settled job is read through the typed getJob, so the hook runs on an engine whose raw SQL refuses', async () => {
    const { dir, argv } = hookScript();
    const id = await runHookedJob(pg, refusingEngine(pg, { needle: 'FROM minion_jobs WHERE id = $1' }), argv);
    expect(readFileSync(join(dir, `${id}.env`), 'utf8')).toBe(`${id}|completed`);
    expect(readdirSync(dir).filter((f) => f.endsWith('.env'))).toHaveLength(1);
  });

  rustRun('S8 on a Rust brain: the terminal hook runs for a job the worker completed', async () => {
    const { engine, dir: brainDir } = await openRustBrain();
    try {
      const { dir, argv } = hookScript();
      const id = await runHookedJob(engine as unknown as BrainEngine, engine as unknown as BrainEngine, argv);
      expect(readFileSync(join(dir, `${id}.env`), 'utf8')).toBe(`${id}|completed`);
    } finally {
      await engine.disconnect();
      removeBrainDir(brainDir);
    }
  }, 30_000);
});

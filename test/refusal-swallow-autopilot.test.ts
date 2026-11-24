/**
 * Refusal-swallow sites in the autopilot daemon, dispatch and fan-out (triage rows 1-5): a catch around a raw-SQL read
 * must not turn the Rust engine's `engine_capability_missing` refusal into a quiet default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when the engine refuses the read with the real capability refusal (`capabilityMissing`), the site
 *    surfaces it; every other error still takes the path's old fallback (a SQL engine's blip is not a refusal).
 *  - Regression: the refusal was logged or dropped and the loop carried on (no-worker warning never fires, auto-drain not
 *    submitted, no cooldown data, idle answered false), so a Rust brain looked healthy while a stage was missing.
 *  - Why existing coverage misses it: the autopilot tests script `executeRaw` with generic errors only.
 *  - Seam: an engine stub whose `executeRaw` throws the real refusal object; the Rust engine itself is not driven here
 *    because the daemon never dispatches through the queue on a Rust brain (the gate test below proves it).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { submitAutoDrains } from '../src/commands/autopilot-dispatch.ts';
import { computeAutopilotIdle } from '../src/commands/autopilot.ts';
import { isSourceInCooldown, readRecentSourceFailures } from '../src/commands/autopilot-fanout.ts';
import { existsSync } from 'node:fs';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';
import { withEnv } from './helpers/with-env.ts';
import { refusingEngine } from './helpers/refusing-engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { autopilotUsesMinionsDispatch, probeNoWorkerPeer, type AutopilotDaemonState } from '../src/commands/autopilot-daemon.ts';

const REFUSAL = () => capabilityMissing('raw_sql', 'executeRaw');

function stubEngine(executeRaw: () => Promise<unknown>, extra: Record<string, unknown> = {}): BrainEngine {
  return { kind: 'rust', executeRaw, ...extra } as unknown as BrainEngine;
}

function daemonState(): AutopilotDaemonState {
  return { noWorkerConsecutiveIdle: 0 } as AutopilotDaemonState;
}

let pg: PGLiteEngine;
let home: string;
beforeAll(async () => {
  pg = new PGLiteEngine();
  await pg.connect({});
  await pg.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-refusal-swallow-'));
}, 120_000);
afterAll(async () => {
  await pg.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('autopilot refusal-swallow sites', () => {
  test('S1 probeNoWorkerPeer: a capability refusal surfaces; a transient error is logged and the loop carries on', async () => {
    const state = daemonState();
    await expect(probeNoWorkerPeer(stubEngine(async () => { throw REFUSAL(); }), state, 60))
      .rejects.toMatchObject({ code: 'engine_capability_missing' });
    expect(state.noWorkerConsecutiveIdle).toBe(0);
    await probeNoWorkerPeer(stubEngine(async () => { throw new Error('connection reset'); }), state, 60);
    expect(state.noWorkerConsecutiveIdle).toBe(0);
  });

  test('S1 gate: a Rust brain never reaches the no-worker probe, the fan-out cooldown read or the auto-drain submit', () => {
    expect(autopilotUsesMinionsDispatch('pain_triggered', 'rust', false)).toBe(false);
    expect(autopilotUsesMinionsDispatch('always', 'rust', false)).toBe(false);
    expect(autopilotUsesMinionsDispatch('pain_triggered', 'pglite', false)).toBe(false);
    expect(autopilotUsesMinionsDispatch('pain_triggered', 'postgres', false)).toBe(true);
    expect(autopilotUsesMinionsDispatch('off', 'postgres', false)).toBe(false);
    expect(autopilotUsesMinionsDispatch('pain_triggered', 'postgres', true)).toBe(false);
  });

  test('S2 submitAutoDrains: a capability refusal on the already-queued check surfaces; another error skips the source and carries on', async () => {
    const root = join(home, 'git-a');
    mkdirSync(root, { recursive: true });
    await pg.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['git-a', root]);
    await pg.putPage('notes/git-a-0', { type: 'note', title: 'a', compiled_truth: 'A durable decision, recorded in prose with context. '.repeat(12) } as never, { sourceId: 'git-a' });
    await pg.setConfig('autopilot.auto_drain.threshold', '1');
    const queue = new MinionQueue(pg);
    const drain = (engine: BrainEngine) => withEnv({ GBRAIN_HOME: home }, () => submitAutoDrains(engine, queue, { timeoutMs: 60_000, jsonMode: true }));
    await expect(drain(refusingEngine(pg, { needle: 'idempotency_key = $1' }))).rejects.toMatchObject({ code: 'engine_capability_missing' });
    await drain(refusingEngine(pg, { needle: 'idempotency_key = $1', error: () => new Error('connection reset') }));
    expect(await pg.executeRaw(`SELECT id FROM minion_jobs WHERE name = 'extract-atoms-drain'`)).toHaveLength(0);
  });

  test('S3 readRecentSourceFailures: a capability refusal from the typed read surfaces (no cooldown data is not an answer); another error still fails open', async () => {
    const engineWith = (error: () => Error) => ({ kind: 'rust', listRecentSourceCycleFailures: async () => { throw error(); } }) as unknown as BrainEngine;
    await expect(readRecentSourceFailures(engineWith(REFUSAL))).rejects.toMatchObject({ code: 'engine_capability_missing' });
    expect((await readRecentSourceFailures(engineWith(() => new Error('relation "minion_jobs" does not exist')))).size).toBe(0);
  });

  const rustRun = existsSync(rustArmAddonPath()) || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' ? test : test.skip;
  rustRun('S3 on a Rust brain: the claim-time cooldown guard answers from the typed reads (no failures recorded, so not in cooldown)', async () => {
    const { engine, dir } = await openRustBrain();
    try {
      expect(await isSourceInCooldown(engine as unknown as BrainEngine, 'default')).toBe(false);
      expect((await readRecentSourceFailures(engine as unknown as BrainEngine)).size).toBe(0);
    } finally {
      await engine.disconnect();
      removeBrainDir(dir);
    }
  });

  test('S3 typed: the recent cycle failures come from the typed listRecentSourceCycleFailures, so an engine whose raw SQL refuses reports them as PGLite does', async () => {
    const queue = new MinionQueue(pg);
    await pg.executeRaw('DELETE FROM minion_jobs');
    for (const source of ['s3a', 's3a', 's3b']) {
      const job = await queue.add('autopilot-cycle', { source_id: source }, { queue: 'default' });
      await pg.executeRaw(`UPDATE minion_jobs SET status = 'dead', finished_at = now() WHERE id = $1`, [job.id]);
    }
    const view = async (engine: BrainEngine) => [...(await readRecentSourceFailures(engine)).entries()].map(([id, f]) => [id, f.count]).sort();
    expect(await view(pg)).toEqual([['s3a', 2], ['s3b', 1]]);
    expect(await view(refusingEngine(pg))).toEqual([['s3a', 2], ['s3b', 1]]);
    await pg.executeRaw('DELETE FROM minion_jobs');
  });

  test('S4 isSourceInCooldown: the source row is read through the typed getSource, so an engine whose raw SQL refuses answers as PGLite does', async () => {
    const queue = new MinionQueue(pg);
    await pg.executeRaw('INSERT INTO sources(id,name,config) VALUES($1,$1,$2::jsonb)', ['s4', JSON.stringify({ last_source_cycle_at: new Date(Date.now() + 60_000).toISOString() })]);
    const job = await queue.add('autopilot-cycle', { source_id: 's4' }, { queue: 'default' });
    await pg.executeRaw(`UPDATE minion_jobs SET status = 'dead', finished_at = now() WHERE id = $1`, [job.id]);
    // The failure is recent, but a success after it ends the cooldown: PGLite answers false.
    expect(await isSourceInCooldown(pg, 's4')).toBe(false);
    // A brain whose raw SQL refuses the sources read must give the same answer, not "no success, so in cooldown".
    expect(await isSourceInCooldown(refusingEngine(pg, { needle: 'FROM sources' }), 's4')).toBe(false);
  });

  test('S5 computeAutopilotIdle: the queue is counted through the typed countJobsByStatus; a capability refusal surfaces, any other error still reads "not idle"', async () => {
    const idleEngine = (counts: Array<{ status: string; count: number }>) => ({
      kind: 'postgres',
      readCycleLocks: async () => [],
      countJobsByStatus: async () => counts,
    }) as unknown as BrainEngine;
    expect(await computeAutopilotIdle(idleEngine([]), 'postgres')).toBe(true);
    expect(await computeAutopilotIdle(idleEngine([{ status: 'active', count: 1 }]), 'postgres')).toBe(false);
    expect(await computeAutopilotIdle(idleEngine([{ status: 'waiting', count: 2 }]), 'postgres')).toBe(false);
    const refusing = { readCycleLocks: async () => { throw REFUSAL(); } } as unknown as BrainEngine;
    await expect(computeAutopilotIdle(refusing, 'rust')).rejects.toMatchObject({ code: 'engine_capability_missing' });
    const blip = { readCycleLocks: async () => { throw new Error('connection reset'); } } as unknown as BrainEngine;
    expect(await computeAutopilotIdle(blip, 'postgres')).toBe(false);
  });
});

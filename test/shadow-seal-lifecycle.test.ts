/**
 * The seal across a real serving-process lifecycle on PGLite: attach, the real supervisor and follower, an in-process
 * shadow child (test/helpers/shadow-stable-harness.ts), the engine's before-disconnect callbacks, then a restart on the
 * same brain dir. The database half of the seal (seal.ts) is a seam here (`sealChecks`): PGLite never seals on its own
 * (pglite_no_db_continuity), so without it every test below would pass for that reason alone.
 *
 * Protects: a write the follower never followed, or a lost write whose line could not be written, never lets the next
 * session take the seal over. Regressions it catches: a wrapped write in a later before-disconnect callback (after the
 * supervisor stopped) left no trace, so the restart carried the watermark on; a close sealed while a lost-write line was
 * still unrecorded.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { readFollowerFile } from '../src/shadow/follow-status.ts';
import { writeSeedRecord } from '../src/shadow/seed.ts';
import { SHADOW_STATE_VERSION, writeShadowState, type ShadowState } from '../src/shadow/state.ts';
import { SEED, startRig, until, type Rig } from './helpers/shadow-stable-harness.ts';

const STATE = { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'state-start-1', sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' } as ShadowState;
const sealChecks = { mark: async () => ({ token: 'mark-1' }), confirm: async () => ({ doubt: null }) };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function brain(): Promise<{ dir: string; dataDir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-seal-life-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-seal-life-db-'));
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });
  writeSeedRecord(dir, SEED);
  writeShadowState(dir, STATE);
  return { dir, dataDir };
}

// Each session opens its own engine on the brain's data dir, one after the other (a restart is a new engine). They are
// made up front and every one is disconnected after the file; disconnecting one a session already closed does nothing.
const ENGINES_NEEDED = 6;
const engines: PGLiteEngine[] = [];
let nextEngine = 0;
beforeAll(() => { for (let i = 0; i < ENGINES_NEEDED; i++) engines.push(new PGLiteEngine()); });
afterAll(async () => { for (const engine of engines) await engine.disconnect(); });

async function open(dataDir: string, init = false): Promise<PGLiteEngine> {
  const engine = engines[nextEngine++];
  if (!engine) throw new Error(`more than ${ENGINES_NEEDED} sessions in this file: raise ENGINES_NEEDED`);
  await engine.connect({ engine: 'pglite', database_path: dataDir } as never);
  if (init) await engine.initSchema();
  return engine;
}

/** One serving session on the brain: valid, then whatever `during` does, then a clean disconnect. */
async function serve(dir: string, dataDir: string, during: (rig: Rig, primary: PGLiteEngine) => Promise<void> = async () => {}, init = false): Promise<void> {
  const primary = await open(dataDir, init);
  const rig = await startRig({ primary, dir, state: STATE as never, attach: { sealChecks } });
  cleanups.push(() => { rig.attached.supervisor.stop(); rig.attached.reconciler?.stop(); });
  await rig.settled();
  await rig.engine.putPage('open/a', { type: 'note', title: 'A', compiled_truth: 'a', timeline: '' });
  await until(() => rig.attached.follower!.idle());
  await during(rig, primary);
  await primary.disconnect();
}

/** The next session on the brain: what its child decided about the seal, read before anything else runs. */
async function restart(dir: string, dataDir: string): Promise<Record<string, unknown> | undefined> {
  const primary = await open(dataDir);
  cleanups.push(() => primary.disconnect());
  const rig = await startRig({ primary, dir, state: STATE as never, attach: { sealChecks } });
  cleanups.push(() => { rig.attached.supervisor.stop(); rig.attached.reconciler?.stop(); });
  await rig.attached.supervisor.request('state');
  return readFollowerFile(dir)?.seal_outcome as Record<string, unknown> | undefined;
}

describe('the seal across a serving-process lifecycle (PGLite, seal checks stubbed)', () => {
  test('control: a quiet close seals and the restart takes the seal over', async () => {
    const { dir, dataDir } = await brain();
    await serve(dir, dataDir, undefined, true);
    expect(readFollowerFile(dir)!.seal).toMatchObject({ db_at: 'mark-1' });
    expect(await restart(dir, dataDir)).toMatchObject({ outcome: 'taken' });
  }, 60_000);

  test('a wrapped write in a later before-disconnect callback (after the supervisor stopped) makes the restart refuse the seal', async () => {
    const { dir, dataDir } = await brain();
    let wrote = false;
    await serve(dir, dataDir, async (rig, primary) => {
      primary.registerBeforeDisconnect(async () => {
        await rig.engine.putPage('open/late', { type: 'note', title: 'Late', compiled_truth: 'late', timeline: '' });
        wrote = true;
      });
    }, true);
    expect(wrote).toBe(true);
    const outcome = await restart(dir, dataDir);
    expect(outcome).toMatchObject({ outcome: 'refused', reason: 'invalidation_after_seal' });
  }, 60_000);

  test('a close while a lost-write line still cannot be written does not seal (lost_write_unrecorded)', async () => {
    const { dir, dataDir } = await brain();
    const foreign = join(dir, 'follower-invalidations.jsonl');
    try {
      await serve(dir, dataDir, async (rig) => {
        chmodSync(foreign, 0o400);
        rig.attached.follower!.close();
        await rig.engine.putPage('open/lost', { type: 'note', title: 'Lost', compiled_truth: 'lost', timeline: '' });
      }, true);
    } finally { chmodSync(foreign, 0o600); }
    expect(readFollowerFile(dir)!.seal).toBeUndefined();
    expect(readFollowerFile(dir)!.seal_outcome).toMatchObject({ outcome: 'not_sealed', reason: 'lost_write_unrecorded' });
  }, 60_000);
});

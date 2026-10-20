/**
 * #6712 PR 4b (design v3.1 §9, DX F14; §11 targets): doctor `managed_sync_not_moving` warns when a source's newest pass
 * found no change (`up_to_date`) but took longer than the §11 target for its kind: an idle tick 0.5 s, a full round 2 s
 * (sources up to 100,000 pages). The warning names the pass's `timings_ms`, its fix is the read-only
 * `gbrain sync status --detail`, and it is never a fail. A pass that changed something, or one inside its target, reads ok.
 * A real idle tick records its own `timings_ms` (`setup`, `kind`). PGLite.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { managedSyncMovementEntry } from '../src/commands/doctor/checks/managed-sync-movement.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/a.md'), '---\ntype: concept\ntitle: a\n---\n\nThe body of a.\n');
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
};

type Check = { status: string; message: string; details: { slow_passes?: Array<{ source_id: string; duration_ms: number; target_ms: number; kind: string }> }; fix?: { argv: string[] } };
const doctor = async (engine: BrainEngine) => (await managedSyncMovementEntry.run({ engine } as never) as unknown as Check[])[0]!;
const telemetry = async (engine: BrainEngine) => (await engine.executeRaw<{ t: Record<string, unknown> }>(
  "SELECT completed_keys->0->'telemetry' AS t FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'='default'", [MANAGED_SYNC_PASS_OP]))[0]!.t;
const setTelemetry = (engine: BrainEngine, patch: Record<string, unknown>) => engine.executeRaw(
  "UPDATE op_checkpoints SET completed_keys=jsonb_build_array(jsonb_set(completed_keys->0,'{telemetry}',(completed_keys->0->'telemetry')||$2::text::jsonb)) WHERE op=$1 AND completed_keys->0->>'source_id'='default'",
  [MANAGED_SYNC_PASS_OP, JSON.stringify(patch)]);

describe('#6712 PR 4b: doctor warns on a slow no-change pass', () => {
  test('an idle tick records its timings; over its 0.5 s target it warns naming them, with the read-only --detail fix; inside it, or after a change, it is ok', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    const idle = await telemetry(engine);
    expect(idle).toMatchObject({ kind: 'idle', outcome: 'up_to_date' });
    expect(Object.keys(idle.timings_ms as Record<string, number>).sort()).toEqual(['kind', 'setup']);

    await setTelemetry(engine, { duration_ms: 400 });
    { const ok = await doctor(engine); expect(ok.status).toBe('ok'); expect(ok.details.slow_passes).toBeUndefined(); }

    await setTelemetry(engine, { duration_ms: 900, timings_ms: { setup: 850, kind: 50 } });
    const slow = await doctor(engine);
    expect(slow.status).toBe('warn');
    expect(slow.details.slow_passes).toEqual([expect.objectContaining({ source_id: 'default', kind: 'idle', duration_ms: 900, target_ms: 500 })]);
    expect(slow.message).toContain('default (its newest idle pass found no change in 900 ms, over the 500 ms target');
    expect(slow.message).toMatch(/; timings_ms \{("setup":850,"kind":50|"kind":50,"setup":850)\}\)/);
    expect(slow.fix?.argv).toEqual(['gbrain', 'sync', 'status', '--source', 'default', '--json', '--detail']);

    // A full round that found no change has the 2 s target; a pass that changed something is not a no-change pass.
    await setTelemetry(engine, { kind: 'full', duration_ms: 1500 });
    expect((await doctor(engine)).status).toBe('ok');
    await setTelemetry(engine, { kind: 'full', duration_ms: 2500 });
    expect(await doctor(engine)).toMatchObject({ status: 'warn', details: { slow_passes: [expect.objectContaining({ kind: 'full', target_ms: 2000 })] } });
    await setTelemetry(engine, { outcome: 'synced', duration_ms: 60_000 });
    { const ok = await doctor(engine); expect(ok.status).toBe('ok'); expect(ok.details.slow_passes).toBeUndefined(); }
  }, { setup }), 120_000);

  test('it is never a fail, however slow the pass', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    await setTelemetry(engine, { duration_ms: 3_600_000 });
    expect((await doctor(engine)).status).toBe('warn');
  }, { setup }), 120_000);
});

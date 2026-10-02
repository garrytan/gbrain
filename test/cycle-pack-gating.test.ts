// v0.41 T9 R-GATE — orchestrator-level pack gate for lens-pack phases.
//
// Contracts, all asserted through runCycle on an in-memory PGLite brain:
//   1. ALL_PHASES orders extract_atoms after extract_facts and
//      synthesize_concepts after patterns; PHASE_SCOPE covers every phase.
//   2. Under a pack that does not declare them, extract_atoms and
//      synthesize_concepts report status 'skipped', reason
//      'not_in_active_pack', with an actionable summary (#2117).
//   3. Under a pack that declares them (gbrain-creator), the gate opens:
//      the phase is dispatched instead of pack-skipped.
//   3b. Phases are local to the declaring manifest (D4-B): a user pack
//      that extends gbrain-creator without re-declaring them stays gated.
//   4. Pack gating is additive: across a full cycle on the default pack,
//      ONLY those two phases are pack-skipped.
//   5. Both phases take the cycle lock (they write pages), so a live
//      holder turns the cycle into cycle_already_running.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ALL_PHASES, PHASE_SCOPE, runCycle, type CyclePhase } from '../src/core/cycle.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

const PACK_GATED: ReadonlyArray<CyclePhase> = ['extract_atoms', 'synthesize_concepts'];

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-pack-gate-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  gbrainHome = emptyHome();
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
});

function cycleUnderPack(pack: string | undefined, opts: Parameters<typeof runCycle>[1]) {
  return withEnv(
    { GBRAIN_HOME: gbrainHome, GBRAIN_SCHEMA_PACK: pack, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
    () => runCycle(engine, opts),
  );
}

describe('v0.41 T9 R-GATE: ALL_PHASES + PHASE_SCOPE contract', () => {
  test('extract_atoms runs after extract_facts; synthesize_concepts after patterns', () => {
    expect(ALL_PHASES.indexOf('extract_facts')).toBeGreaterThan(-1);
    expect(ALL_PHASES.indexOf('extract_atoms')).toBeGreaterThan(ALL_PHASES.indexOf('extract_facts'));
    expect(ALL_PHASES.indexOf('patterns')).toBeGreaterThan(-1);
    expect(ALL_PHASES.indexOf('synthesize_concepts')).toBeGreaterThan(ALL_PHASES.indexOf('patterns'));
  });

  test('PHASE_SCOPE: extract_atoms is source-scoped, synthesize_concepts global, every phase mapped', () => {
    expect(PHASE_SCOPE.extract_atoms).toBe('source');
    expect(PHASE_SCOPE.synthesize_concepts).toBe('global');
    for (const p of ALL_PHASES) expect(PHASE_SCOPE[p]).toBeDefined();
  });
});

describe('v0.41 T9 R-GATE: dispatch consults the active pack', () => {
  test('a pack without the phases skips both with an actionable not_in_active_pack summary', async () => {
    const report = await cycleUnderPack('gbrain-base', { brainDir, phases: [...PACK_GATED], dryRun: true });
    for (const phase of PACK_GATED) {
      const r = report.phases.find(p => p.phase === phase);
      expect(r?.status).toBe('skipped');
      expect(r?.details?.reason).toBe('not_in_active_pack');
      expect(r?.summary).toContain('phases:');
      expect(r?.summary).toContain('gbrain-creator');
    }
    const atoms = report.phases.find(p => p.phase === 'extract_atoms');
    expect(atoms?.summary).toContain('gbrain dream --phase extract_atoms --drain');
  }, 60_000);

  test('a pack that declares the phases (gbrain-creator) opens the gate', async () => {
    const report = await cycleUnderPack('gbrain-creator', { brainDir, phases: [...PACK_GATED], dryRun: true });
    for (const phase of PACK_GATED) {
      const r = report.phases.find(p => p.phase === phase);
      expect(r).toBeDefined();
      expect(r?.details?.reason).not.toBe('not_in_active_pack');
    }
  }, 60_000);

  test('phases are not inherited through extends (D4-B): a child of gbrain-creator stays gated', async () => {
    const packDir = join(gbrainHome, '.gbrain', 'schema-packs', 'creator-child-example');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'pack.yaml'), [
      'api_version: gbrain-schema-pack-v1',
      'name: creator-child-example',
      'version: 1.0.0',
      'description: test pack extending gbrain-creator without declaring phases',
      'gbrain_min_version: 0.41.0',
      'extends: gbrain-creator',
      'page_types: []',
      '',
    ].join('\n'));
    const report = await cycleUnderPack('creator-child-example', { brainDir, phases: ['extract_atoms'], dryRun: true });
    expect(report.phases.find(p => p.phase === 'extract_atoms')?.details?.reason).toBe('not_in_active_pack');
  }, 60_000);

  test('pack gating is additive: a full default-pack cycle pack-skips only the two lens phases', async () => {
    const report = await cycleUnderPack(undefined, { brainDir, dryRun: true });
    const packSkipped = report.phases
      .filter(p => p.details?.reason === 'not_in_active_pack')
      .map(p => p.phase)
      .sort();
    expect(packSkipped).toEqual([...PACK_GATED].sort());
  }, 120_000);
});

describe('cycle_already_running names the holder', () => {
  test('a busy cycle lock reports the holder and its age', async () => {
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ('gbrain-cycle', 99999, 'other-host', NOW() - INTERVAL '90 seconds', NOW() + INTERVAL '1 hour')`,
    );
    const report = await cycleUnderPack('gbrain-base', { brainDir, phases: ['extract_atoms'], dryRun: true });
    expect(report.reason).toBe('cycle_already_running');
    expect(report.lock_holder).toMatchObject({ id: 'gbrain-cycle', holder_pid: 99999, holder_host: 'other-host' });
    expect(report.lock_holder!.age_ms).toBeGreaterThanOrEqual(89_000);
  }, 60_000);
});

describe('v0.41 T9 R-GATE: lens phases take the cycle lock', () => {
  for (const phase of PACK_GATED) {
    test(`${phase} alone waits behind a live cycle-lock holder`, async () => {
      await engine.executeRaw(
        `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
         VALUES ('gbrain-cycle', 99999, 'other-host', NOW(), NOW() + INTERVAL '1 hour')`,
      );
      const report = await cycleUnderPack('gbrain-base', { brainDir, phases: [phase], dryRun: true });
      expect(report.status).toBe('skipped');
      expect(report.reason).toBe('cycle_already_running');
    }, 60_000);
  }
});

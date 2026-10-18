// #6393: the cycle's pack gate resolves through the same tiers
// `gbrain schema active` uses (DB config, per-source DB config), and a paid
// phase that only those tiers newly activate waits for explicit consent
// (`cycle.<phase>.enabled true`) instead of starting silently (T4).

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { packDeclaresPhase, resolvePackPhaseGate, runCycle } from '../src/core/cycle.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other-example','other-example') ON CONFLICT DO NOTHING");
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-pack-gate-db-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  gbrainHome = emptyHome();
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'schema_pack%' OR key LIKE 'cycle.%'");
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
});

const isolated = <T>(fn: () => Promise<T>) =>
  withEnv({ GBRAIN_HOME: gbrainHome, GBRAIN_SCHEMA_PACK: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, fn);

describe('packDeclaresPhase reads the DB-config tiers', () => {
  test('a brain-wide DB config pack that declares the phase → true', async () => {
    await engine.setConfig('schema_pack', 'gbrain-creator');
    await isolated(async () => {
      expect(await packDeclaresPhase(engine, 'extract_atoms')).toBe(true);
      expect(await packDeclaresPhase(engine, 'synthesize_concepts')).toBe(true);
    });
  });

  test('a per-source override on another source does not leak', async () => {
    await engine.setConfig('schema_pack.source.other-example', 'gbrain-creator');
    await isolated(async () => {
      expect(await packDeclaresPhase(engine, 'extract_atoms', 'default')).toBe(false);
      expect(await packDeclaresPhase(engine, 'extract_atoms', 'other-example')).toBe(true);
      expect((await resolvePackPhaseGate(engine, 'extract_atoms', 'other-example')).source_tier).toBe('per-source-db');
    });
  });

  test('the brain-wide base pack → false', async () => {
    await engine.setConfig('schema_pack', 'gbrain-base');
    await isolated(async () => {
      expect(await packDeclaresPhase(engine, 'extract_atoms')).toBe(false);
    });
  });
});

describe('newly activated paid phases wait for consent (T4)', () => {
  test('a DB-config pack the file plane did not declare skips with consent_required and names the opt-in', async () => {
    await engine.setConfig('schema_pack', 'gbrain-creator');
    const report = await isolated(() => runCycle(engine, { brainDir, phases: ['extract_atoms', 'synthesize_concepts'], dryRun: true }));
    for (const phase of ['extract_atoms', 'synthesize_concepts']) {
      const r = report.phases.find(p => p.phase === phase);
      expect(r?.status).toBe('skipped');
      expect(r?.details).toMatchObject({ reason: 'consent_required', resolved_pack: 'gbrain-creator', source_tier: 'db-config' });
      expect(r?.summary).toContain(`gbrain config set cycle.${phase}.enabled true`);
    }
  }, 60_000);

  test('cycle.<phase>.enabled true opens the gate', async () => {
    await engine.setConfig('schema_pack', 'gbrain-creator');
    await engine.setConfig('cycle.extract_atoms.enabled', 'true');
    const report = await isolated(() => runCycle(engine, { brainDir, phases: ['extract_atoms', 'synthesize_concepts'], dryRun: true }));
    const atoms = report.phases.find(p => p.phase === 'extract_atoms');
    expect(atoms?.details?.reason).not.toBe('consent_required');
    expect(atoms?.details?.reason).not.toBe('not_in_active_pack');
    expect(report.phases.find(p => p.phase === 'synthesize_concepts')?.details?.reason).toBe('consent_required');
  }, 60_000);

  test('a pack the file plane already declared needs no new consent', async () => {
    mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
    writeFileSync(join(gbrainHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', schema_pack: 'gbrain-creator' }));
    await engine.setConfig('schema_pack', 'gbrain-creator');
    const report = await isolated(() => runCycle(engine, { brainDir, phases: ['extract_atoms'], dryRun: true }));
    const atoms = report.phases.find(p => p.phase === 'extract_atoms');
    expect(atoms?.details?.reason).not.toBe('consent_required');
    expect(atoms?.details?.reason).not.toBe('not_in_active_pack');
  }, 60_000);
});

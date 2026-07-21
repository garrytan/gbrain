/**
 * dream.home_source gate — unit layer.
 *
 * The per-source cycle fan-out runs the corpus-global dream phases
 * (synthesize, patterns) in whatever source's cycle wins the cooldown
 * race, scattering their output across lottery-chosen sources. The gate
 * pins both phases to one configured home source. These tests pin the
 * decision table of `resolveDreamHomeGate` and the patterns-phase
 * integration (gate fires before any config/reflection work).
 */
import { describe, test, expect } from 'bun:test';
import { resolveDreamHomeGate, runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function engineWith(config: Record<string, string | null>, opts: { throwOnGet?: boolean } = {}): BrainEngine {
  return {
    getConfig: async (key: string) => {
      if (opts.throwOnGet) throw new Error('db down');
      return config[key] ?? null;
    },
    setConfig: async (key: string, value: string) => { config[key] = value; },
  } as unknown as BrainEngine;
}

describe('resolveDreamHomeGate', () => {
  test('unset home_source → no gate (legacy behavior)', async () => {
    const gate = await resolveDreamHomeGate(engineWith({}), 'agent-src');
    expect(gate.skip).toBe(false);
  });

  test('empty/whitespace home_source → no gate', async () => {
    const gate = await resolveDreamHomeGate(engineWith({ 'dream.home_source': '  ' }), 'agent-src');
    expect(gate.skip).toBe(false);
  });

  test('cycle source matches home → proceed', async () => {
    const gate = await resolveDreamHomeGate(engineWith({ 'dream.home_source': 'wiki' }), 'wiki');
    expect(gate.skip).toBe(false);
  });

  test('cycle source differs from home → skip with loud reason', async () => {
    const gate = await resolveDreamHomeGate(engineWith({ 'dream.home_source': 'wiki' }), 'iso-src');
    expect(gate.skip).toBe(true);
    if (gate.skip) {
      expect(gate.reason).toBe('not_home_source');
      expect(gate.summary).toContain("dream.home_source='wiki'");
      expect(gate.summary).toContain("'iso-src'");
    }
  });

  test('undefined cycle source is treated as default', async () => {
    const skip = await resolveDreamHomeGate(engineWith({ 'dream.home_source': 'wiki' }), undefined);
    expect(skip.skip).toBe(true);
    const pass = await resolveDreamHomeGate(engineWith({ 'dream.home_source': 'default' }), undefined);
    expect(pass.skip).toBe(false);
  });

  test("typo'd home source fails CLOSED (every cycle skips, value named)", async () => {
    const gate = await resolveDreamHomeGate(engineWith({ 'dream.home_source': 'wiky' }), 'wiki');
    expect(gate.skip).toBe(true);
    if (gate.skip) expect(gate.summary).toContain("'wiky'");
  });

  test('config read failure fails CLOSED (skip with home_source_unknown — never a misrouted run)', async () => {
    const gate = await resolveDreamHomeGate(engineWith({}, { throwOnGet: true }), 'agent-src');
    expect(gate.skip).toBe(true);
    if (gate.skip) expect(gate.reason).toBe('home_source_unknown');
  });

  test('home_source value is trimmed before compare', async () => {
    const gate = await resolveDreamHomeGate(engineWith({ 'dream.home_source': ' wiki ' }), 'wiki');
    expect(gate.skip).toBe(false);
  });
});

describe('runPhasePatterns — home-source gate integration', () => {
  test('non-home cycle skips before touching patterns config', async () => {
    // Engine only implements getConfig; if the gate did NOT fire first, the
    // phase would call further engine methods and throw on the stub.
    const engine = engineWith({ 'dream.home_source': 'wiki' });
    const result = await runPhasePatterns(engine, {
      brainDir: '/tmp/nonexistent-brain-dir',
      dryRun: false,
      sourceId: 'ingest',
    });
    expect(result.status).toBe('skipped');
    expect((result.details as { reason?: string }).reason).toBe('not_home_source');
  });
});

describe('runPhasePatterns — cooldown', () => {
  test('active cooldown skips with cooldown_active before any reflection work', async () => {
    const engine = engineWith({
      'dream.patterns.last_completion_ts': new Date(Date.now() - 60_000).toISOString(),
    });
    const result = await runPhasePatterns(engine, { brainDir: '/tmp/nonexistent-brain-dir', dryRun: false, sourceId: 'default' });
    expect(result.status).toBe('skipped');
    expect((result.details as { reason?: string }).reason).toBe('cooldown_active');
  });

  test('expired cooldown proceeds (skips later for a different reason on the stub engine)', async () => {
    const engine = engineWith({
      'dream.patterns.last_completion_ts': new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
    });
    const result = await runPhasePatterns(engine, { brainDir: '/tmp/nonexistent-brain-dir', dryRun: false, sourceId: 'default' });
    expect((result.details as { reason?: string }).reason).not.toBe('cooldown_active');
  });

  test('cooldown_hours=0 disables the cooldown', async () => {
    const engine = engineWith({
      'dream.patterns.cooldown_hours': '0',
      'dream.patterns.last_completion_ts': new Date().toISOString(),
    });
    const result = await runPhasePatterns(engine, { brainDir: '/tmp/nonexistent-brain-dir', dryRun: false, sourceId: 'default' });
    expect((result.details as { reason?: string }).reason).not.toBe('cooldown_active');
  });
});

describe('runPhaseSynthesize — home-source gate integration', () => {
  test('non-home cycle skips with not_home_source before any corpus work', async () => {
    const engine = engineWith({ 'dream.home_source': 'wiki' });
    const result = await runPhaseSynthesize(engine, {
      brainDir: '/tmp/nonexistent-brain-dir',
      dryRun: false,
      sourceId: 'ingest',
    });
    expect(result.status).toBe('skipped');
    expect((result.details as { reason?: string }).reason).toBe('not_home_source');
  });

  test('explicit --date target BYPASSES the gate (skips later for a different reason)', async () => {
    // Gate bypass proof by differential skip reason: with the gate active the
    // phase would return not_home_source; bypassed, it proceeds to config
    // loading and skips as not_configured (stub engine has no corpus dir).
    const engine = engineWith({ 'dream.home_source': 'wiki' });
    const result = await runPhaseSynthesize(engine, {
      brainDir: '/tmp/nonexistent-brain-dir',
      dryRun: false,
      sourceId: 'ingest',
      date: '2026-01-01',
    });
    expect(result.status).toBe('skipped');
    expect((result.details as { reason?: string }).reason).toBe('not_configured');
  });

  test('explicit --input target BYPASSES the gate too (same explicitTarget predicate as the cooldown)', async () => {
    const engine = engineWith({ 'dream.home_source': 'wiki' });
    const result = await runPhaseSynthesize(engine, {
      brainDir: '/tmp/nonexistent-brain-dir',
      dryRun: false,
      sourceId: 'ingest',
      inputFile: '/tmp/nonexistent-transcript.txt',
    });
    // Bypassed the gate; whatever happens next, it must NOT be the gate skip.
    expect((result.details as { reason?: string }).reason).not.toBe('not_home_source');
  });
});

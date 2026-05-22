/**
 * Scenario loader tests — proves scenario.json parsing + validation work.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listScenarios, loadScenario, readBrief } from '../src/core/claw-test/scenarios.ts';

const ORIG_ROOT = process.env.GBRAIN_CLAW_SCENARIOS_DIR;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scenarios-'));
  process.env.GBRAIN_CLAW_SCENARIOS_DIR = root;
});

afterEach(() => {
  if (ORIG_ROOT !== undefined) process.env.GBRAIN_CLAW_SCENARIOS_DIR = ORIG_ROOT;
  else delete process.env.GBRAIN_CLAW_SCENARIOS_DIR;
  rmSync(root, { recursive: true, force: true });
});

function scaffoldScenario(name: string, scenarioJson: string, briefContent = '# Brief'): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scenario.json'), scenarioJson);
  writeFileSync(join(dir, 'BRIEF.md'), briefContent);
}

describe('listScenarios', () => {
  test('returns empty when no scenarios exist', () => {
    expect(listScenarios()).toEqual([]);
  });

  test('returns directories that contain scenario.json, sorted', () => {
    scaffoldScenario('beta', '{"kind":"fresh-install","expected_phases":[]}');
    scaffoldScenario('alpha', '{"kind":"fresh-install","expected_phases":[]}');
    mkdirSync(join(root, 'incomplete'), { recursive: true }); // no scenario.json
    expect(listScenarios()).toEqual(['alpha', 'beta']);
  });
});

describe('loadScenario', () => {
  test('parses a valid fresh-install scenario', () => {
    scaffoldScenario('demo', JSON.stringify({
      kind: 'fresh-install',
      expected_phases: ['import.files', 'doctor.db_checks'],
      description: 'demo',
      brain: 'brain',
    }));
    const cfg = loadScenario('demo');
    expect(cfg.name).toBe('demo');
    expect(cfg.kind).toBe('fresh-install');
    expect(cfg.expectedPhases).toEqual(['import.files', 'doctor.db_checks']);
    expect(cfg.description).toBe('demo');
    expect(cfg.brainRelative).toBe('brain');
  });

  test('parses an upgrade scenario with from_version + seed', () => {
    scaffoldScenario('upgrade-x', JSON.stringify({
      kind: 'upgrade',
      from_version: '0.18.0',
      expected_phases: ['doctor.db_checks'],
      seed: 'seed',
    }));
    mkdirSync(join(root, 'upgrade-x', 'seed'), { recursive: true });
    const cfg = loadScenario('upgrade-x');
    expect(cfg.kind).toBe('upgrade');
    expect(cfg.fromVersion).toBe('0.18.0');
    expect(cfg.seedRelative).toBe('seed');
  });

  test('throws on missing scenario directory', () => {
    expect(() => loadScenario('does-not-exist')).toThrow(/not found/);
  });

  test('throws on malformed JSON', () => {
    scaffoldScenario('bad', 'not json {');
    expect(() => loadScenario('bad')).toThrow(/malformed/);
  });

  test('throws on unknown kind', () => {
    scaffoldScenario('weird', JSON.stringify({ kind: 'mystery', expected_phases: [] }));
    expect(() => loadScenario('weird')).toThrow(/unknown kind/);
  });

  test('throws on non-array expected_phases', () => {
    scaffoldScenario('bad-phases', JSON.stringify({ kind: 'fresh-install', expected_phases: 'oops' }));
    expect(() => loadScenario('bad-phases')).toThrow(/expected_phases/);
  });

  test('throws when BRIEF.md missing', () => {
    const dir = join(root, 'no-brief');
    mkdirSync(dir);
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ kind: 'fresh-install', expected_phases: [] }));
    expect(() => loadScenario('no-brief')).toThrow(/BRIEF\.md missing/);
  });
});

describe('readBrief', () => {
  test('returns BRIEF.md content', () => {
    scaffoldScenario('reads-brief', '{"kind":"fresh-install","expected_phases":[]}', '# Hello world');
    const cfg = loadScenario('reads-brief');
    expect(readBrief(cfg)).toBe('# Hello world');
  });
});

describe('shipped scenarios load cleanly', () => {
  test('fresh-install loads from default fixtures root', () => {
    delete process.env.GBRAIN_CLAW_SCENARIOS_DIR;
    try {
      const cfg = loadScenario('fresh-install');
      expect(cfg.kind).toBe('fresh-install');
      expect(cfg.expectedPhases.length).toBeGreaterThan(0);
    } finally {
      process.env.GBRAIN_CLAW_SCENARIOS_DIR = root;
    }
  });

  test('upgrade-from-v0.18 loads from default fixtures root', () => {
    delete process.env.GBRAIN_CLAW_SCENARIOS_DIR;
    try {
      const cfg = loadScenario('upgrade-from-v0.18');
      expect(cfg.kind).toBe('upgrade');
      expect(cfg.fromVersion).toBe('0.18.0');
    } finally {
      process.env.GBRAIN_CLAW_SCENARIOS_DIR = root;
    }
  });
});

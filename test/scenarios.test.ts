/**
 * Scenario loader tests — proves scenario.json parsing + validation work.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, statSync, writeFileSync } from 'fs';
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

describe('loadScenario — oracle validation', () => {
  const base = (oracle: string) =>
    `{"kind":"fresh-install","expected_phases":[],"oracle":${oracle}}`;

  test('happy path: query defaults minResults to 1; min_results overrides; files_exist parsed', () => {
    scaffoldScenario('o-happy', base('{"query":"alice"}'));
    expect(loadScenario('o-happy').oracle).toEqual({ query: 'alice', minResults: 1 });

    scaffoldScenario('o-min', base('{"query":"alice","min_results":0,"files_exist":["skills/query/SKILL.md"]}'));
    const cfg = loadScenario('o-min');
    expect(cfg.oracle?.minResults).toBe(0);
    expect(cfg.oracle?.filesExist).toEqual(['skills/query/SKILL.md']);
  });

  test('oracle must be a JSON object', () => {
    scaffoldScenario('o-arr', base('["x"]'));
    expect(() => loadScenario('o-arr')).toThrow(/oracle must be a JSON object/);
    scaffoldScenario('o-str', base('"x"'));
    expect(() => loadScenario('o-str')).toThrow(/oracle must be a JSON object/);
  });

  test('oracle.query must be a non-empty string and must not start with a dash', () => {
    scaffoldScenario('o-empty', base('{"query":"  "}'));
    expect(() => loadScenario('o-empty')).toThrow(/oracle\.query must be a non-empty string/);
    scaffoldScenario('o-num', base('{"query":7}'));
    expect(() => loadScenario('o-num')).toThrow(/oracle\.query must be a non-empty string/);
    // The query lands in gbrain argv — a dash-leading value would parse as a flag.
    scaffoldScenario('o-dash', base('{"query":"--json"}'));
    expect(() => loadScenario('o-dash')).toThrow(/must not start with a dash/);
  });

  test('oracle.min_results requires query and must be a finite number >= 0', () => {
    scaffoldScenario('o-orphan', base('{"min_results":1}'));
    expect(() => loadScenario('o-orphan')).toThrow(/min_results requires oracle\.query/);
    scaffoldScenario('o-neg', base('{"query":"alice","min_results":-1}'));
    expect(() => loadScenario('o-neg')).toThrow(/min_results must be a number >= 0/);
    scaffoldScenario('o-nan', base('{"query":"alice","min_results":"5"}'));
    expect(() => loadScenario('o-nan')).toThrow(/min_results must be a number >= 0/);
  });

  test('oracle.files_exist must be workspace-relative strings', () => {
    scaffoldScenario('o-files-str', base('{"files_exist":"skills"}'));
    expect(() => loadScenario('o-files-str')).toThrow(/files_exist must be a string\[\]/);
    scaffoldScenario('o-files-abs', base('{"files_exist":["/etc/passwd"]}'));
    expect(() => loadScenario('o-files-abs')).toThrow(/workspace-relative/);
    scaffoldScenario('o-files-dots', base('{"files_exist":["../outside.md"]}'));
    expect(() => loadScenario('o-files-dots')).toThrow(/workspace-relative/);
  });
});

describe('loadScenario — containment (adversarial-gate pins)', () => {
  // Scenario packs load from arbitrary dirs via the scenarios-dir env
  // override, and their content flows to an external agent — traversal in the
  // name or the declared paths would expose arbitrary operator files.
  test('traversal-shaped scenario names are rejected', () => {
    expect(() => loadScenario('../outside')).toThrow(/not found/);
    expect(() => loadScenario('a/b')).toThrow(/not found/);
    expect(() => loadScenario('..')).toThrow(/not found/);
  });

  test('brief, brain, and seed paths escaping the scenario dir are rejected', () => {
    scaffoldScenario('esc-brief', '{"kind":"fresh-install","expected_phases":[],"brief":"../outside.md"}');
    expect(() => loadScenario('esc-brief')).toThrow(/inside the scenario dir/);
    scaffoldScenario('esc-brain', '{"kind":"fresh-install","expected_phases":[],"brain":"../../brains"}');
    expect(() => loadScenario('esc-brain')).toThrow(/inside the scenario dir/);
    scaffoldScenario('esc-seed', '{"kind":"upgrade","expected_phases":[],"seed":"/etc"}');
    expect(() => loadScenario('esc-seed')).toThrow(/inside the scenario dir/);
  });
});

describe('readBrief', () => {
  test('returns BRIEF.md content', () => {
    scaffoldScenario('reads-brief', '{"kind":"fresh-install","expected_phases":[]}', '# Hello world');
    const cfg = loadScenario('reads-brief');
    expect(readBrief(cfg)).toBe('# Hello world');
  });
});

describe('every shipped fixture loads (exhaustive guard)', () => {
  // The shipped fixtures root, addressed directly — NOT through the
  // GBRAIN_CLAW_SCENARIOS_DIR override this file's beforeEach installs.
  const SHIPPED_ROOT = join(import.meta.dir, 'fixtures', 'claw-test-scenarios');

  // Ratchet: fixtures whose scenario.json declares a kind the loader does not
  // accept YET. Each entry is asserted to (a) still be well-formed JSON with
  // its declared kind (fixture-rot guard) and (b) FAIL loadScenario with the
  // unknown-kind error. The moment the kind is wired (TODOS.md:5529-5545,
  // "Wire the orphaned voice-agent-install ScenarioKind"), assertion (b)
  // flips and forces the entry OUT of this map, promoting the fixture to the
  // full every-fixture-loads assertion below. Adding a NEW orphaned fixture
  // requires a reviewer-visible entry here.
  const KNOWN_ORPHANS: Record<string, { declaredKind: string }> = {
    'voice-agent-install': { declaredKind: 'voice-agent-install' },
  };

  function shippedDirs(): string[] {
    return readdirSync(SHIPPED_ROOT)
      .filter(name => statSync(join(SHIPPED_ROOT, name)).isDirectory())
      .sort();
  }

  test('fixtures root exists and carries the known scenario floor', () => {
    expect(existsSync(SHIPPED_ROOT)).toBe(true);
    const dirs = shippedDirs();
    // Floor, not ceiling: new scenarios are welcome, but the three that exist
    // today can never silently vanish out from under the guard.
    for (const required of ['fresh-install', 'upgrade-from-v0.18', 'voice-agent-install']) {
      expect(dirs).toContain(required);
    }
  });

  test('no invisible dead fixtures: every scenario dir has scenario.json + BRIEF.md and is listed', () => {
    const dirs = shippedDirs();
    for (const name of dirs) {
      // listScenarios silently filters dirs without scenario.json — a
      // half-committed fixture would otherwise sit dead and unlisted forever.
      expect(existsSync(join(SHIPPED_ROOT, name, 'scenario.json'))).toBe(true);
      expect(existsSync(join(SHIPPED_ROOT, name, 'BRIEF.md'))).toBe(true);
    }
    expect(listScenarios(SHIPPED_ROOT)).toEqual(dirs);
  });

  test('every non-orphaned fixture loads via loadScenario with coherent config', () => {
    const names = listScenarios(SHIPPED_ROOT).filter(n => !(n in KNOWN_ORPHANS));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const cfg = loadScenario(name, SHIPPED_ROOT);
      const declared = JSON.parse(readFileSync(join(SHIPPED_ROOT, name, 'scenario.json'), 'utf-8'));
      expect(cfg.name).toBe(name);
      expect(cfg.kind).toBe(declared.kind);
      expect(cfg.expectedPhases.length).toBeGreaterThan(0);
      expect(readBrief(cfg).trim().length).toBeGreaterThan(0);
    }
  });

  test('known orphans are pinned: well-formed fixture, loader still rejects the kind', () => {
    for (const [name, { declaredKind }] of Object.entries(KNOWN_ORPHANS)) {
      // (a) The fixture itself must not rot while it waits for wiring.
      const raw = JSON.parse(readFileSync(join(SHIPPED_ROOT, name, 'scenario.json'), 'utf-8'));
      expect(raw.kind).toBe(declaredKind);
      expect(Array.isArray(raw.expected_phases)).toBe(true);
      expect(raw.expected_phases.length).toBeGreaterThan(0);
      // (b) The ratchet: once ScenarioKind accepts this kind, this assertion
      // fails and the entry must move to the full-load sweep above. Do NOT
      // loosen this to a skip — a test that cannot fail is not coverage.
      expect(() => loadScenario(name, SHIPPED_ROOT)).toThrow(/unknown kind/);
    }
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

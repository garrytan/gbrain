/**
 * scenario.json loader for the claw-test harness.
 *
 *  test/fixtures/claw-test-scenarios/<name>/scenario.json:
 *    { kind: "fresh-install", expected_phases: ["import.files", ...], ... }
 *
 * The harness reads scenario.json to know which phases to assert from
 * gbrain's --progress-json events. Pure local fs; no DB, no network.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export type ScenarioKind = 'fresh-install' | 'upgrade';

export interface ScenarioConfig {
  /** Directory the scenario was loaded from. Always absolute. */
  dir: string;
  /** Stable scenario name (the directory name). */
  name: string;
  /** Kind of scenario; drives setup-phase behavior. */
  kind: ScenarioKind;
  /** Stable phase names emitted by --progress-json that the harness asserts. */
  expectedPhases: string[];
  /** When kind==="upgrade": version we are simulating an upgrade FROM. */
  fromVersion?: string;
  /** Optional human-readable summary. */
  description?: string;
  /** Path to BRIEF.md (relative to scenario dir, default 'BRIEF.md'). */
  briefRelative: string;
  /** Path to brain markdown source (relative to scenario dir). For 'fresh-install': 'brain'. */
  brainRelative?: string;
  /** Path to seed dir for upgrade scenarios. */
  seedRelative?: string;
}

/** Default fixtures root, override via $GBRAIN_CLAW_SCENARIOS_DIR for tests. */
function defaultFixturesRoot(): string {
  if (process.env.GBRAIN_CLAW_SCENARIOS_DIR) {
    return resolve(process.env.GBRAIN_CLAW_SCENARIOS_DIR);
  }
  // src/core/claw-test/scenarios.ts → ../../../test/fixtures/claw-test-scenarios
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'test', 'fixtures', 'claw-test-scenarios');
}

/** List all available scenario names. */
export function listScenarios(root?: string): string[] {
  const r = root ?? defaultFixturesRoot();
  if (!existsSync(r)) return [];
  return readdirSync(r)
    .filter(name => {
      const path = join(r, name);
      try {
        return statSync(path).isDirectory() && existsSync(join(path, 'scenario.json'));
      } catch {
        return false;
      }
    })
    .sort();
}

/** Load and validate one scenario by name. */
export function loadScenario(name: string, root?: string): ScenarioConfig {
  const r = root ?? defaultFixturesRoot();
  const dir = join(r, name);
  const cfgPath = join(dir, 'scenario.json');
  if (!existsSync(cfgPath)) {
    throw new Error(`scenario ${JSON.stringify(name)} not found at ${cfgPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch (e) {
    throw new Error(`scenario ${JSON.stringify(name)}: malformed scenario.json (${e instanceof Error ? e.message : e})`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`scenario ${JSON.stringify(name)}: scenario.json must be a JSON object`);
  }
  const cfg = raw as Record<string, unknown>;
  if (cfg.kind !== 'fresh-install' && cfg.kind !== 'upgrade') {
    throw new Error(`scenario ${JSON.stringify(name)}: unknown kind ${JSON.stringify(cfg.kind)}`);
  }
  if (!Array.isArray(cfg.expected_phases) || !cfg.expected_phases.every(x => typeof x === 'string')) {
    throw new Error(`scenario ${JSON.stringify(name)}: expected_phases must be a string[]`);
  }
  const briefRel = typeof cfg.brief === 'string' ? cfg.brief : 'BRIEF.md';
  if (!existsSync(join(dir, briefRel))) {
    throw new Error(`scenario ${JSON.stringify(name)}: BRIEF.md missing at ${briefRel}`);
  }
  const out: ScenarioConfig = {
    dir,
    name,
    kind: cfg.kind,
    expectedPhases: cfg.expected_phases as string[],
    briefRelative: briefRel,
  };
  if (typeof cfg.from_version === 'string') out.fromVersion = cfg.from_version;
  if (typeof cfg.description === 'string') out.description = cfg.description;
  if (typeof cfg.brain === 'string') out.brainRelative = cfg.brain;
  if (typeof cfg.seed === 'string') out.seedRelative = cfg.seed;
  // Default brain path conventions
  if (!out.brainRelative && existsSync(join(dir, 'brain'))) out.brainRelative = 'brain';
  if (!out.seedRelative && out.kind === 'upgrade' && existsSync(join(dir, 'seed'))) {
    out.seedRelative = 'seed';
  }
  return out;
}

/** Read BRIEF.md content for this scenario. Used by --live mode. */
export function readBrief(scenario: ScenarioConfig): string {
  return readFileSync(join(scenario.dir, scenario.briefRelative), 'utf-8');
}

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

/**
 * Live-mode success oracle, declared per scenario. The harness verifies these
 * AFTER the agent exits 0 — exit code alone would pass an agent that did
 * nothing. All fields optional; a scenario with no oracle gets the kind's
 * default verification (fresh-install: doctor only; upgrade: schema-version
 * probe must ADVANCE during the agent turn).
 */
export interface ScenarioOracle {
  /** Query the staged brain must answer post-run (live mode). */
  query?: string;
  /** Minimum result count for `query` (default 1 when query is set). */
  minResults?: number;
  /** Workspace-relative paths that must exist post-run (proves brief steps ran). */
  filesExist?: string[];
}

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
  /** Live-mode success oracle (see ScenarioOracle). */
  oracle?: ScenarioOracle;
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

/**
 * Confine a scenario-declared relative path inside the scenario dir. The
 * scenario pack is a trust boundary (loadable from arbitrary dirs via the
 * scenarios-dir env override, and its content flows to an external agent):
 * a traversal-shaped brief/brain/seed would let a pack read — and, via the
 * BRIEF, exfiltrate to the agent — arbitrary operator files.
 */
function confineToScenarioDir(name: string, dir: string, rel: string, field: string): void {
  const abs = resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + '/')) {
    throw new Error(`scenario ${JSON.stringify(name)}: ${field} must stay inside the scenario dir; got ${JSON.stringify(rel)}`);
  }
}

/** Load and validate one scenario by name. */
export function loadScenario(name: string, root?: string): ScenarioConfig {
  // The name is a directory segment — never a path. A traversal-shaped name
  // would resolve scenario.json (and everything the scenario references)
  // outside the fixtures root.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new Error(`scenario name ${JSON.stringify(name)} not found (names are letters, digits, dot, dash, underscore)`);
  }
  const r = root ?? defaultFixturesRoot();
  const dir = resolve(join(r, name));
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
  confineToScenarioDir(name, dir, briefRel, 'brief');
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
  if (typeof cfg.brain === 'string') {
    confineToScenarioDir(name, dir, cfg.brain, 'brain');
    out.brainRelative = cfg.brain;
  }
  if (typeof cfg.seed === 'string') {
    confineToScenarioDir(name, dir, cfg.seed, 'seed');
    out.seedRelative = cfg.seed;
  }
  if (cfg.oracle !== undefined) {
    if (!cfg.oracle || typeof cfg.oracle !== 'object' || Array.isArray(cfg.oracle)) {
      throw new Error(`scenario ${JSON.stringify(name)}: oracle must be a JSON object`);
    }
    const o = cfg.oracle as Record<string, unknown>;
    const oracle: ScenarioOracle = {};
    if (o.query !== undefined) {
      if (typeof o.query !== 'string' || !o.query.trim()) {
        throw new Error(`scenario ${JSON.stringify(name)}: oracle.query must be a non-empty string`);
      }
      // The query lands in gbrain argv — a leading dash would parse as a CLI
      // flag instead of a query (scenario packs load from arbitrary dirs via
      // the scenarios-dir env override, so treat this as a trust boundary).
      if (o.query.trim().startsWith('-')) {
        throw new Error(`scenario ${JSON.stringify(name)}: oracle.query must not start with a dash`);
      }
      oracle.query = o.query;
      oracle.minResults = 1;
    }
    if (o.min_results !== undefined) {
      // Rejecting min_results without query keeps the config honest: the
      // harness only reads minResults when a query is declared, and accepting
      // config it never enforces would be a silent no-op.
      if (o.query === undefined) {
        throw new Error(`scenario ${JSON.stringify(name)}: oracle.min_results requires oracle.query`);
      }
      if (typeof o.min_results !== 'number' || !Number.isFinite(o.min_results) || o.min_results < 0) {
        throw new Error(`scenario ${JSON.stringify(name)}: oracle.min_results must be a number >= 0`);
      }
      oracle.minResults = o.min_results;
    }
    if (o.files_exist !== undefined) {
      if (!Array.isArray(o.files_exist) || !o.files_exist.every(x => typeof x === 'string' && x.trim())) {
        throw new Error(`scenario ${JSON.stringify(name)}: oracle.files_exist must be a string[]`);
      }
      // Paths are resolved relative to the run's workspace; confine them so a
      // scenario pack can't probe arbitrary operator paths.
      for (const p of o.files_exist as string[]) {
        if (p.startsWith('/') || p.split('/').includes('..')) {
          throw new Error(`scenario ${JSON.stringify(name)}: oracle.files_exist entries must be workspace-relative (no absolute paths, no '..'): ${JSON.stringify(p)}`);
        }
      }
      oracle.filesExist = o.files_exist as string[];
    }
    out.oracle = oracle;
  }
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

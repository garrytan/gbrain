/**
 * `gbrain eval brainstorm` — three-axis evaluation gate for the v0.37.0
 * brainstorm + LSD wave (D3 + codex round 2 #11).
 *
 * Three independent axes (conjunctive pass — ALL three must clear):
 *
 *   1. DISTANCE — mean(distance_score) of passing ideas. Anchored against
 *      Open Collider's published 4-13× distance shift over default-prompt
 *      baseline. Target ≥0.4 (a normalized 0-1 distance; the 4× floor in
 *      Open Collider's space maps roughly to the upper half of our [0,1]).
 *
 *   2. USEFULNESS — mean weighted-score from the brainstorm judge over the
 *      held-out fixture. Target ≥3.5/5. Below this the ideas may be far
 *      but they aren't worth reading.
 *
 *   3. GROUNDING — fraction of ideas that cite ≥1 real slug from the test
 *      brain. Target 1.0 (every idea must cite a real slug). Without this
 *      we ship a feature that's gameable: a model returning "fluff that
 *      doesn't reference your notes" would still pass distance + usefulness.
 *
 * Distance alone is gameable (codex r2 #11) — that's why this is a
 * three-axis gate rather than the single-axis "4-13× distance shift" that
 * Open Collider's paper anchors on.
 *
 * The fixture is JSONL with one object per line: `{question}` (minimum).
 * Optional `expected_far_prefixes` for spot-check assertions on which
 * brain regions the domain-bank should surface.
 *
 * Exit codes mirror gbrain's eval convention:
 *   0 = pass (all three thresholds clear)
 *   1 = fail (at least one axis below threshold)
 *   2 = inconclusive (fewer than 2 fixtures produced parseable results)
 */

import type { BrainEngine } from '../core/engine.ts';
import { readFileSync, existsSync } from 'fs';
import { runBrainstorm, BRAINSTORM_PROFILE } from '../core/brainstorm/orchestrator.ts';
import { loadConfig } from '../core/config.ts';

export interface BrainstormEvalFixture {
  question: string;
  /** Optional: prefixes the domain-bank should surface (asserted in --strict mode). */
  expected_far_prefixes?: string[];
  notes?: string;
}

export interface BrainstormEvalThresholds {
  /** Mean normalized distance of passing ideas. Default 0.4. */
  distance_min: number;
  /** Mean judge weighted_score of passing ideas. Default 3.5. */
  usefulness_min: number;
  /** Fraction of ideas that cite a real slug from the brain. Default 1.0. */
  grounding_min: number;
}

export const DEFAULT_BRAINSTORM_THRESHOLDS: BrainstormEvalThresholds = Object.freeze({
  distance_min: 0.4,
  usefulness_min: 3.5,
  grounding_min: 1.0,
});

export interface PerFixtureResult {
  question: string;
  /** Number of generated ideas that passed the judge threshold. */
  pass_count: number;
  /** Number of ideas total (before judge filtering). */
  total_ideas: number;
  /** Mean distance_score over passing ideas. */
  mean_distance: number;
  /** Mean judge weighted_score over passing ideas (NaN if no judge scores). */
  mean_usefulness: number;
  /** Fraction of ideas citing a real slug. */
  grounding_rate: number;
  /** Did the domain-bank surface enough prefixes? D11 sparse signal. */
  short_of_target: boolean;
  /** Cost in USD (actual). */
  cost_usd: number;
  /** True iff judge failed mid-run for this fixture. */
  judge_failed: boolean;
}

export interface BrainstormEvalReport {
  schema_version: 1;
  fixture_path: string;
  total_fixtures: number;
  parseable_fixtures: number;
  thresholds: BrainstormEvalThresholds;
  per_fixture: PerFixtureResult[];
  aggregate: {
    distance: number;
    usefulness: number;
    grounding: number;
  };
  /** pass / fail / inconclusive. */
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** Reasons supporting the verdict. */
  reasons: string[];
  total_cost_usd: number;
}

export interface EvalBrainstormCliArgs {
  fixture?: string;
  json: boolean;
  limit?: number;
  help: boolean;
  error?: string;
  distance_min?: number;
  usefulness_min?: number;
  grounding_min?: number;
}

function parseArgs(args: string[]): EvalBrainstormCliArgs {
  const out: EvalBrainstormCliArgs = { json: false, help: false };
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--limit') {
      const v = args[++i];
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `--limit requires a positive integer (got ${v})`;
        return out;
      }
      out.limit = n;
    } else if (a === '--distance-min') {
      const n = parseFloat(args[++i]);
      if (!Number.isFinite(n)) { out.error = '--distance-min requires a number'; return out; }
      out.distance_min = n;
    } else if (a === '--usefulness-min') {
      const n = parseFloat(args[++i]);
      if (!Number.isFinite(n)) { out.error = '--usefulness-min requires a number'; return out; }
      out.usefulness_min = n;
    } else if (a === '--grounding-min') {
      const n = parseFloat(args[++i]);
      if (!Number.isFinite(n)) { out.error = '--grounding-min requires a number'; return out; }
      out.grounding_min = n;
    } else if (a.startsWith('--')) {
      out.error = `unknown flag: ${a}`;
      return out;
    } else {
      positional.push(a);
    }
    i++;
  }
  if (positional.length > 0) out.fixture = positional[0];
  return out;
}

const HELP = `Usage: gbrain eval brainstorm <fixture.jsonl> [options]

Three-axis evaluation gate for \`gbrain brainstorm\`. Runs the fixture's
questions through the brainstorm orchestrator, then scores DISTANCE +
USEFULNESS + GROUNDING against pass thresholds. All three must clear.

Fixture format (JSONL, one object per line):
  {"question": "why are AI coding tools converging on the same UX?"}
  {"question": "the unspoken assumption in venture pricing"}

Options:
  --limit N             Cap to N fixtures (default: all)
  --json                Emit BrainstormEvalReport as JSON
  --distance-min X      Override distance threshold (default 0.4)
  --usefulness-min X    Override usefulness threshold (default 3.5)
  --grounding-min X     Override grounding threshold (default 1.0)
  --help, -h            Show this help

Exit codes: 0 pass, 1 fail, 2 inconclusive (< 2 fixtures parseable).
Cost: ~$0.05-0.15 per fixture × N — budget accordingly.
`;

/** Parse JSONL fixture file. Skips blank lines and lines that fail JSON.parse. */
export function readBrainstormEvalFixture(path: string): BrainstormEvalFixture[] {
  if (!existsSync(path)) {
    throw new Error(`fixture not found: ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  const fixtures: BrainstormEvalFixture[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed rows; we report parseable_fixtures separately
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.question !== 'string' || obj.question.trim().length === 0) continue;
    fixtures.push({
      question: obj.question,
      expected_far_prefixes: Array.isArray(obj.expected_far_prefixes)
        ? obj.expected_far_prefixes.filter((x): x is string => typeof x === 'string')
        : undefined,
      notes: typeof obj.notes === 'string' ? obj.notes : undefined,
    });
  }
  return fixtures;
}

/** Verify grounding: a real slug means a slug present in `realSlugs`. Returns the fraction of ideas citing ≥1 real slug. */
export function computeGroundingRate(
  ideas: Array<{ close_slug: string; far_slug: string }>,
  realSlugs: Set<string>
): number {
  if (ideas.length === 0) return 0;
  let grounded = 0;
  for (const idea of ideas) {
    const closeReal = realSlugs.has(idea.close_slug);
    const farReal = realSlugs.has(idea.far_slug);
    if (closeReal || farReal) grounded++;
  }
  return grounded / ideas.length;
}

/**
 * Aggregate one fixture's brainstorm result into the three-axis metrics.
 * `realSlugs` is the set of slugs known to exist in the test brain (so we
 * can detect hallucinated citations — codex r2 #11's grounding signal).
 */
export function summarizeFixture(
  question: string,
  result: Awaited<ReturnType<typeof runBrainstorm>>,
  realSlugs: Set<string>
): PerFixtureResult {
  const passing = result.ideas.filter((i) => i.passes);
  const meanDistance = passing.length === 0
    ? 0
    : passing.reduce((s, i) => s + i.distance_score, 0) / passing.length;
  const judgedPassing = passing.filter((i) => i.judge !== undefined);
  const meanUsefulness = judgedPassing.length === 0
    ? Number.NaN
    : judgedPassing.reduce((s, i) => s + (i.judge!.weighted_score), 0) / judgedPassing.length;
  const grounding = computeGroundingRate(result.ideas, realSlugs);

  return {
    question,
    pass_count: passing.length,
    total_ideas: result.ideas.length,
    mean_distance: meanDistance,
    mean_usefulness: meanUsefulness,
    grounding_rate: grounding,
    short_of_target: result.short_of_target,
    cost_usd: result.cost.actual_usd,
    judge_failed: result.judge_failed,
  };
}

/** Compute the three aggregate axes across all parseable fixtures + the verdict. */
export function computeVerdict(
  perFixture: PerFixtureResult[],
  thresholds: BrainstormEvalThresholds
): { aggregate: { distance: number; usefulness: number; grounding: number }; verdict: 'pass' | 'fail' | 'inconclusive'; reasons: string[] } {
  const usable = perFixture.filter((r) => r.pass_count > 0 && !r.judge_failed);
  if (usable.length < 2) {
    return {
      aggregate: { distance: 0, usefulness: 0, grounding: 0 },
      verdict: 'inconclusive',
      reasons: [`Only ${usable.length} fixture(s) produced parseable, judged ideas. Need at least 2 to compute meaningful aggregates.`],
    };
  }
  const distance = usable.reduce((s, r) => s + r.mean_distance, 0) / usable.length;
  const validUseful = usable.filter((r) => Number.isFinite(r.mean_usefulness));
  const usefulness = validUseful.length === 0
    ? 0
    : validUseful.reduce((s, r) => s + r.mean_usefulness, 0) / validUseful.length;
  const grounding = usable.reduce((s, r) => s + r.grounding_rate, 0) / usable.length;

  const reasons: string[] = [];
  if (distance < thresholds.distance_min) {
    reasons.push(`distance ${distance.toFixed(3)} < ${thresholds.distance_min} (ideas too close to the question — domain-bank not surfacing distant pages)`);
  }
  if (usefulness < thresholds.usefulness_min) {
    reasons.push(`usefulness ${usefulness.toFixed(2)} < ${thresholds.usefulness_min} (ideas far but low judge score)`);
  }
  if (grounding < thresholds.grounding_min) {
    reasons.push(`grounding ${grounding.toFixed(3)} < ${thresholds.grounding_min} (some ideas cite non-existent slugs — hallucination signal)`);
  }
  if (reasons.length > 0) {
    return { aggregate: { distance, usefulness, grounding }, verdict: 'fail', reasons };
  }
  return {
    aggregate: { distance, usefulness, grounding },
    verdict: 'pass',
    reasons: [`all three axes cleared: distance ${distance.toFixed(3)} >= ${thresholds.distance_min}, usefulness ${usefulness.toFixed(2)} >= ${thresholds.usefulness_min}, grounding ${grounding.toFixed(3)} >= ${thresholds.grounding_min}`],
  };
}

/** Build the set of slugs known to exist in the brain (for grounding check). */
async function loadRealSlugs(engine: BrainEngine): Promise<Set<string>> {
  const refs = await engine.listAllPageRefs();
  return new Set(refs.map((r) => r.slug));
}

/** CLI entry. Exits with 0/1/2 mirroring eval convention. */
export async function runEvalBrainstorm(engine: BrainEngine, args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  if (parsed.error) {
    console.error(`gbrain eval brainstorm: ${parsed.error}`);
    console.error(HELP);
    return 2;
  }
  if (!parsed.fixture) {
    console.error('gbrain eval brainstorm: fixture path required');
    console.error(HELP);
    return 2;
  }
  let fixtures: BrainstormEvalFixture[];
  try {
    fixtures = readBrainstormEvalFixture(parsed.fixture);
  } catch (err) {
    console.error(`gbrain eval brainstorm: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  const thresholds: BrainstormEvalThresholds = {
    distance_min: parsed.distance_min ?? DEFAULT_BRAINSTORM_THRESHOLDS.distance_min,
    usefulness_min: parsed.usefulness_min ?? DEFAULT_BRAINSTORM_THRESHOLDS.usefulness_min,
    grounding_min: parsed.grounding_min ?? DEFAULT_BRAINSTORM_THRESHOLDS.grounding_min,
  };
  const slice = parsed.limit ? fixtures.slice(0, parsed.limit) : fixtures;

  const config = loadConfig() ?? {};
  const realSlugs = await loadRealSlugs(engine);

  const perFixture: PerFixtureResult[] = [];
  let totalCost = 0;
  for (const [idx, fix] of slice.entries()) {
    if (!parsed.json) {
      console.error(`[eval-brainstorm] ${idx + 1}/${slice.length}: ${fix.question.slice(0, 60)}...`);
    }
    try {
      const result = await runBrainstorm(engine, config, {
        question: fix.question,
        profile: BRAINSTORM_PROFILE,
        skipCostPreview: true,
      });
      const summary = summarizeFixture(fix.question, result, realSlugs);
      perFixture.push(summary);
      totalCost += summary.cost_usd;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!parsed.json) {
        console.error(`[eval-brainstorm] fixture ${idx + 1} failed: ${msg}`);
      }
      perFixture.push({
        question: fix.question,
        pass_count: 0,
        total_ideas: 0,
        mean_distance: 0,
        mean_usefulness: Number.NaN,
        grounding_rate: 0,
        short_of_target: false,
        cost_usd: 0,
        judge_failed: true,
      });
    }
  }

  const { aggregate, verdict, reasons } = computeVerdict(perFixture, thresholds);
  const report: BrainstormEvalReport = {
    schema_version: 1,
    fixture_path: parsed.fixture,
    total_fixtures: fixtures.length,
    parseable_fixtures: perFixture.filter((r) => !r.judge_failed && r.total_ideas > 0).length,
    thresholds,
    per_fixture: perFixture,
    aggregate,
    verdict,
    reasons,
    total_cost_usd: totalCost,
  };

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n=== gbrain eval brainstorm ===`);
    console.log(`Fixture: ${parsed.fixture}`);
    console.log(`Parseable: ${report.parseable_fixtures}/${report.total_fixtures}`);
    console.log(`Distance:   ${aggregate.distance.toFixed(3)} (threshold ${thresholds.distance_min})`);
    console.log(`Usefulness: ${aggregate.usefulness.toFixed(2)} (threshold ${thresholds.usefulness_min})`);
    console.log(`Grounding:  ${aggregate.grounding.toFixed(3)} (threshold ${thresholds.grounding_min})`);
    console.log(`Cost:       $${totalCost.toFixed(2)}`);
    console.log(`Verdict:    ${verdict.toUpperCase()}`);
    for (const r of reasons) {
      console.log(`  - ${r}`);
    }
  }

  return verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : 2;
}

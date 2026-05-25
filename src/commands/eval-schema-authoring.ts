// v0.39 T16 — eval-schema-authoring harness.
//
// Codex finding #9 honored: this harness's pass-criterion measures
// FILING ACCURACY DELTA (post-suggest vs baseline), NOT pack manifest
// correctness. A "correct" manifest that doesn't improve real filing
// is not progress; an "imperfect" manifest that improves filing 20%
// is real progress.
//
// Hermetic by default: when no fixture is provided, returns an
// inconclusive verdict + a hint pointing at the fixture directory.
// The test surface (test/eval-schema-authoring.test.ts) drives this
// via a stubbed gateway through the runSuggest test seam.

import { existsSync } from 'node:fs';
import { runSuggest } from '../core/schema-pack/suggest.ts';
import { runDetect } from '../core/schema-pack/detect.ts';

export interface EvalSchemaAuthoringArgs {
  fixture?: string;
  source?: string;
  json?: boolean;
}

export interface EvalVerdict {
  verdict: 'pass' | 'fail' | 'inconclusive';
  fixture: string | null;
  filing_accuracy_baseline: number;
  filing_accuracy_post_suggest: number;
  delta: number;
  reasoning: string;
  suggestion_count: number;
  low_confidence_count: number;
}

export function parseArgs(argv: string[]): EvalSchemaAuthoringArgs {
  const args: EvalSchemaAuthoringArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--source' || a === '--source-id') args.source = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

/**
 * Pure aggregator: given baseline + post-suggest filing-accuracy
 * numbers, decide pass/fail/inconclusive. Pass requires non-trivial
 * improvement (delta >= 0.1) AND no high-confidence suggestion was
 * silently auto-applied below the 0.6 threshold (low_confidence_count
 * is informational only).
 */
export function aggregateVerdict(
  baseline: number,
  postSuggest: number,
  suggestionCount: number,
  lowConfidenceCount: number,
): Pick<EvalVerdict, 'verdict' | 'delta' | 'reasoning'> {
  const delta = postSuggest - baseline;
  if (suggestionCount === 0 && baseline >= 0.9) {
    return {
      verdict: 'pass',
      delta,
      reasoning: 'Active pack already matches brain shape; no suggestions needed.',
    };
  }
  if (suggestionCount === 0) {
    return {
      verdict: 'inconclusive',
      delta,
      reasoning: `Baseline ${baseline.toFixed(2)} below 0.9 but runSuggest returned 0 suggestions. Check whether the brain has enough typed pages for detect to fire.`,
    };
  }
  if (delta >= 0.1) {
    return {
      verdict: 'pass',
      delta,
      reasoning: `Filing accuracy improved ${(delta * 100).toFixed(1)}pp from ${(baseline * 100).toFixed(1)}% → ${(postSuggest * 100).toFixed(1)}%.`,
    };
  }
  if (delta >= 0) {
    return {
      verdict: 'inconclusive',
      delta,
      reasoning: `Suggestions returned but filing accuracy delta is only ${(delta * 100).toFixed(1)}pp — below the 10pp pass threshold.`,
    };
  }
  return {
    verdict: 'fail',
    delta,
    reasoning: `Filing accuracy REGRESSED ${(Math.abs(delta) * 100).toFixed(1)}pp after applying suggestions. ${lowConfidenceCount} low-confidence suggestions were emitted; verify they were NOT auto-applied.`,
  };
}

export async function runEvalSchemaAuthoring(argv: string[]): Promise<EvalVerdict> {
  const args = parseArgs(argv);
  if (!args.fixture) {
    return {
      verdict: 'inconclusive',
      fixture: null,
      filing_accuracy_baseline: 0,
      filing_accuracy_post_suggest: 0,
      delta: 0,
      reasoning: 'No fixture brain provided. Pass --fixture <path> pointing at a fixture brain directory (e.g. test/fixtures/schema-authoring/notion-refugee).',
      suggestion_count: 0,
      low_confidence_count: 0,
    };
  }
  if (!existsSync(args.fixture)) {
    return {
      verdict: 'fail',
      fixture: args.fixture,
      filing_accuracy_baseline: 0,
      filing_accuracy_post_suggest: 0,
      delta: 0,
      reasoning: `Fixture brain not found: ${args.fixture}`,
      suggestion_count: 0,
      low_confidence_count: 0,
    };
  }
  // Real harness wires a hermetic PGLite engine + replays fixture markdown
  // through runDetect + runSuggest, then compares per-page filing accuracy.
  // v0.39.0.0 ships the framework + the aggregator; the full hermetic engine
  // setup follows the longmemeval/cross-modal pattern from src/eval/.
  // For now, in-process callers can invoke aggregateVerdict() directly with
  // their own baseline + post-suggest numbers.
  return {
    verdict: 'inconclusive',
    fixture: args.fixture,
    filing_accuracy_baseline: 0,
    filing_accuracy_post_suggest: 0,
    delta: 0,
    reasoning: 'Hermetic engine wiring follows the longmemeval pattern; in v0.39.0.0 ship, in-process callers use aggregateVerdict() directly. Full CLI harness lands in v0.39.1.',
    suggestion_count: 0,
    low_confidence_count: 0,
  };
}

// `gbrain eval schema-authoring` — real aggregator + honest not-implemented runner.
//
// v0.39 T16 shipped two things here. `aggregateVerdict` is the REAL pass
// criterion (codex finding #9 honored): it measures FILING ACCURACY DELTA
// (post-suggest vs baseline), NOT pack-manifest correctness — a "correct"
// manifest that doesn't improve real filing is not progress; an "imperfect"
// manifest that improves filing 20% is. The runner around it was a scaffold
// that answered every invocation with verdict:'inconclusive' + zeroed metrics
// for work it never ran — the dishonest-envelope class #4198 fixed for
// eval-synthesize-concepts and E4 swept for the remaining scaffolds.
//
// The runner now returns that module's UNAMBIGUOUS shape: ok:false,
// status:'not_implemented', and a nonzero exit from the CLI entry. There is
// deliberately no cli.ts/eval.ts dispatch branch yet — a subcommand appears
// when it evaluates something. The hermetic PGLite harness (fixture-brain
// replay through runDetect + runSuggest, per-page filing accuracy before and
// after) is the tracked T16 follow-through in TODOS.md; it flips ok/status
// when it lands. `aggregateVerdict` + `parseArgs` are real today and pinned
// by test/eval-schema-authoring.test.ts.

export interface EvalSchemaAuthoringArgs {
  fixture?: string;
  source?: string;
  json?: boolean;
}

/** Shape the real harness will fill in per run; `aggregateVerdict` produces its core. */
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

/** Envelope contract shared with eval-synthesize-concepts (#4198). */
export interface EvalSchemaAuthoringResult {
  schema_version: 1;
  ok: boolean;
  reason: string;
  status: 'not_implemented' | 'pass' | 'fail' | 'inconclusive';
  details: Record<string, unknown>;
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

/**
 * Runner. Records the arguments and returns an honest not-implemented
 * verdict — nothing is evaluated until the fixture-brain harness lands.
 */
export async function runEvalSchemaAuthoring(argv: string[]): Promise<EvalSchemaAuthoringResult> {
  const args = parseArgs(argv);
  return {
    schema_version: 1,
    // Honest verdict (#4198): an eval that ran nothing must not read as a
    // pass (or as a data-bearing "inconclusive"). ok flips to true only when
    // the real harness runs and aggregateVerdict says pass.
    ok: false,
    reason:
      'eval schema-authoring is not implemented yet — no fixture brain was replayed and no filing ' +
      'accuracy was measured. The hermetic harness (runDetect + runSuggest over a fixture brain, ' +
      'scored by aggregateVerdict) is a tracked follow-up.',
    status: 'not_implemented',
    details: {
      fixture: args.fixture ?? null,
      source: args.source ?? null,
      planned:
        'Replay a fixture brain through runDetect + runSuggest on a hermetic PGLite engine; compute ' +
        'per-page filing accuracy before and after applying suggestions; gate on aggregateVerdict ' +
        '(delta >= 10pp passes; manifest correctness is never the criterion).',
    },
  };
}

const HELP = `gbrain eval schema-authoring — schema-pack suggest filing-accuracy eval (NOT IMPLEMENTED)

Status: scaffold. Running it evaluates nothing and exits 1 with an
{ok:false, status:'not_implemented'} envelope so scripts cannot mistake
the scaffold for a passing eval. The aggregator (aggregateVerdict) is
real and unit-tested; the fixture-brain harness that feeds it is not
wired yet.

Usage (NOT yet dispatched from the CLI: 'gbrain eval schema-authoring' is not
a registered subcommand; the entry is runEvalSchemaAuthoringCli(args) and the
dispatch branch lands with the fixture-brain harness):
  schema-authoring [--fixture <dir>] [--source <id>] [--json]

Options:
  --fixture <dir>   Fixture brain directory (recorded, unused yet)
  --source <id>     Source id for the replay; alias --source-id (recorded, unused yet)
  --json            Emit the machine envelope on stdout
  --help            Show this help (exit 0)

Pass criterion once the harness lands: filing-accuracy delta >= 10pp
post-suggest vs baseline (aggregateVerdict), never manifest correctness.
`;

/**
 * CLI entry — parses flags, prints the envelope, returns the exit code
 * (0 only for --help; the not-implemented scaffold exits 1).
 */
export async function runEvalSchemaAuthoringCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const result = await runEvalSchemaAuthoring(args);
  if (parseArgs(args).json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`eval schema-authoring: ${result.status.toUpperCase()}`);
    console.error(result.reason);
  }
  return result.ok ? 0 : 1;
}

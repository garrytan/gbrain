// `gbrain eval synthesize-concepts` — honest not-implemented scaffold (#4198).
//
// v0.41 T11 shipped the command surface but never wired a dispatch branch:
// the subcommand fell through to the generic qrels eval ("Error: --qrels
// <path|json> is required") and the scaffold envelope claimed ok:true, so a
// scripted caller read "pass" from a command that evaluated nothing. The
// dedicated cli.ts branch + this module now return an UNAMBIGUOUS
// not-implemented verdict: ok:false, status:'not_implemented', nonzero exit.
// The full parity-baseline evaluator (tier agreement + cluster stability
// against a downstream agent's concepts/ tree) remains a tracked follow-up.

export interface EvalSynthesizeConceptsOpts {
  parityBaseline?: string;
  sample?: number;
  json?: boolean;
}

export interface EvalSynthesizeConceptsResult {
  schema_version: 1;
  ok: boolean;
  reason: string;
  status: 'not_implemented' | 'pass' | 'fail';
  details: Record<string, unknown>;
}

export async function runEvalSynthesizeConcepts(
  opts: EvalSynthesizeConceptsOpts = {},
): Promise<EvalSynthesizeConceptsResult> {
  return {
    schema_version: 1,
    // Honest verdict (#4198): an eval that ran nothing must not read as a
    // pass. ok flips to true only when the real evaluator lands.
    ok: false,
    reason:
      'eval synthesize-concepts is not implemented yet — no concepts were evaluated. ' +
      'The parity-baseline evaluator (tier agreement + cluster stability) is a tracked follow-up.',
    status: 'not_implemented',
    details: {
      parity_baseline_path: opts.parityBaseline ?? null,
      sample_size: opts.sample ?? null,
      planned:
        'Compare synthesize_concepts output against a downstream agent concepts/ tree on a ' +
        'sample subset; compute tier agreement (T1/T2/T3) + cluster stability via set Jaccard.',
    },
  };
}

const HELP = `gbrain eval synthesize-concepts — concept-synthesis parity eval (NOT IMPLEMENTED)

Status: scaffold. Running it evaluates nothing and exits 1 with an
{ok:false, status:'not_implemented'} envelope so scripts cannot mistake
the scaffold for a passing eval.

Usage:
  gbrain eval synthesize-concepts [--parity-baseline <dir>] [--sample <n>] [--json]

Options:
  --parity-baseline <dir>  Concepts tree to compare against (recorded, unused yet)
  --sample <n>             Sample size (recorded, unused yet)
  --json                   Emit the machine envelope on stdout
  --help                   Show this help (exit 0)

Planned evaluator: tier agreement (T1/T2/T3) + cluster stability (set
Jaccard) between synthesize_concepts output and the baseline tree.
`;

/**
 * CLI entry — parses flags, prints the envelope, returns the exit code
 * (0 only for --help; the not-implemented scaffold exits 1).
 */
export async function runEvalSynthesizeConceptsCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const opts: EvalSynthesizeConceptsOpts = { json: args.includes('--json') };
  const pbIdx = args.indexOf('--parity-baseline');
  if (pbIdx !== -1 && args[pbIdx + 1]) opts.parityBaseline = args[pbIdx + 1];
  const sampleIdx = args.indexOf('--sample');
  if (sampleIdx !== -1 && args[sampleIdx + 1]) {
    const n = Number(args[sampleIdx + 1]);
    if (Number.isFinite(n) && n > 0) opts.sample = Math.floor(n);
  }

  const result = await runEvalSynthesizeConcepts(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`eval synthesize-concepts: ${result.status.toUpperCase()}`);
    console.error(result.reason);
  }
  return result.ok ? 0 : 1;
}

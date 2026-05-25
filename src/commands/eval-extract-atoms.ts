// v0.41 T11 — `gbrain eval extract-atoms` command (minimal scaffold).
//
// v0.41 ships the COMMAND SURFACE. Full parity baseline against
// your OpenClaw's existing 13K atoms on a 500-page subset (the codex T4
// requirement) lands in v0.41.1. The scaffold here surfaces the command
// so users can discover it and the v0.41.1 work has a clear extension
// point.

export interface EvalExtractAtomsOpts {
  parityBaseline?: string;
  sample?: number;
  json?: boolean;
}

export interface EvalExtractAtomsResult {
  schema_version: 1;
  ok: boolean;
  reason: string;
  status: 'not_yet_implemented' | 'pass' | 'fail';
  details: Record<string, unknown>;
}

export async function runEvalExtractAtoms(
  opts: EvalExtractAtomsOpts = {},
): Promise<EvalExtractAtomsResult> {
  return {
    schema_version: 1,
    ok: true,
    reason: 'v0.41 ships the command surface; full parity-baseline eval lands v0.41.1',
    status: 'not_yet_implemented',
    details: {
      parity_baseline_path: opts.parityBaseline ?? null,
      sample_size: opts.sample ?? null,
      v0_41_1_followup:
        'Compare extract_atoms output against your OpenClaw atoms/ on a sample subset; ' +
        'compute precision/recall over atom_type classifications + virality_score correlation.',
    },
  };
}

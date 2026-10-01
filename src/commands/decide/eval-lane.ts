/**
 * Eval-only `gbrain decide` subcommands (judge harness). Loaded by
 * `loadDecideLanes()`; the module behind the subcommand loads lazily so help
 * stays cheap.
 */
import { registerDecideSubcommand } from '../decide.ts';

export const JUDGE_AGREEMENT_USAGE = 'judge-agreement --suite <longmemeval|grounding> --input <file> [--limit N] [--provider <id>] [--threshold 0.5] [--dry-run] [--json] [--out FILE]';

registerDecideSubcommand('judge-agreement', async (_engine, args) => (await import('./judge-agreement.ts')).runJudgeAgreement(args),
  `${JUDGE_AGREEMENT_USAGE}   Eval-only: Jev beside an LLM judge (Cohen's kappa)`);

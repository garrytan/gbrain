/**
 * v0.41.16.0 — `gbrain eval conversation-parser <fixture.jsonl>` CLI verb.
 *
 * Per Layer 4a: fixture-corpus CI gate. Deterministic; runs in PR CI
 * with `--no-llm` so built-in regex regressions block PRs WITHOUT
 * spending API tokens.
 *
 * Exit codes (match eval-gate convention):
 *   0 — PASS (all fixtures passed)
 *   1 — FAIL (any fixture failed)
 *   2 — USAGE (bad args, missing fixture, malformed JSONL)
 *
 * Stable JSON envelope under `--json`:
 *   {
 *     schema_version: 1,
 *     ...EvalReport
 *   }
 */

import { readFileSync, existsSync } from 'node:fs';
import {
  parseFixtureJsonl,
  scoreFixture,
  aggregateScores,
  type ConversationFixture,
  type EvalReport,
} from '../core/conversation-parser/eval.ts';

interface CliArgs {
  fixtures?: string;
  minRecall: number;
  noLlm: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const out: CliArgs = {
    minRecall: 0.9,
    noLlm: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--fixtures') {
      out.fixtures = args[++i];
    } else if (a.startsWith('--fixtures=')) {
      out.fixtures = a.slice('--fixtures='.length);
    } else if (a === '--min-recall') {
      out.minRecall = Number(args[++i]);
    } else if (a.startsWith('--min-recall=')) {
      out.minRecall = Number(a.slice('--min-recall='.length));
    } else if (a === '--no-llm') {
      out.noLlm = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (!out.fixtures && !a.startsWith('--')) {
      // Positional fixture path (e.g. `gbrain eval conversation-parser path.jsonl`).
      out.fixtures = a;
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`Usage: gbrain eval conversation-parser [options] <fixture.jsonl>

Run the v0.41.16.0 conversation parser against a JSONL fixture
corpus and report per-fixture quality + an aggregate verdict.

Options:
  --fixtures <path>     Path to JSONL fixture file. Also positional.
  --min-recall <float>  Recall floor for positive fixtures. Default 0.9.
  --no-llm              Disable LLM polish + fallback (built-in regex only).
                        Use for CI gating to keep the run deterministic.
  --json                Emit stable JSON envelope on stdout.
  --help, -h            Print this help.

Exit codes:
  0  PASS — every fixture met its criteria.
  1  FAIL — one or more fixtures failed; failure list printed.
  2  USAGE — bad args, missing fixture, malformed JSONL.

Fixture line shape (one JSON object per line):
  {
    "fixture_id": "string",
    "pattern": "string | null (null = adversarial)",
    "frontmatter": { "date": "YYYY-MM-DD", ... },
    "body": "string",
    "expected_messages": number,
    "expected_participants": ["string", ...]
  }
`);
}

/**
 * Returns the exit code. CLI dispatcher process.exit's on the return.
 */
export async function runEvalConversationParser(
  args: string[],
): Promise<number> {
  const cli = parseArgs(args);
  if (cli.help) {
    printHelp();
    return 0;
  }
  if (!cli.fixtures) {
    process.stderr.write(
      '[eval conversation-parser] USAGE: missing fixture path. See --help.\n',
    );
    return 2;
  }
  if (!existsSync(cli.fixtures)) {
    process.stderr.write(
      `[eval conversation-parser] USAGE: fixture file not found: ${cli.fixtures}\n`,
    );
    return 2;
  }

  let fixtures: ConversationFixture[];
  try {
    const content = readFileSync(cli.fixtures, 'utf8');
    fixtures = parseFixtureJsonl(content);
  } catch (err) {
    process.stderr.write(
      `[eval conversation-parser] USAGE: ${(err as Error).message}\n`,
    );
    return 2;
  }

  if (fixtures.length === 0) {
    process.stderr.write(
      '[eval conversation-parser] USAGE: fixture file has zero parseable lines.\n',
    );
    return 2;
  }

  const scores = fixtures.map((f) =>
    scoreFixture(f, { minRecall: cli.minRecall, noLlm: cli.noLlm }),
  );
  const report: EvalReport = aggregateScores(scores);

  if (cli.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else {
    formatHumanReport(report);
  }

  return report.failed > 0 ? 1 : 0;
}

function formatHumanReport(report: EvalReport): void {
  process.stdout.write(
    `[eval conversation-parser] ${report.passed}/${report.total_fixtures} fixtures passed\n`,
  );
  process.stdout.write(
    `[eval conversation-parser] recall_mean=${report.recall_mean.toFixed(3)} ` +
      `participants_recall_mean=${report.participants_recall_mean.toFixed(3)}\n`,
  );
  process.stdout.write(
    `[eval conversation-parser] pattern_coverage: ${Object.entries(report.pattern_coverage)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}\n`,
  );
  if (report.failed > 0) {
    process.stdout.write('\nFAILED FIXTURES:\n');
    for (const s of report.fixtures) {
      if (s.passed) continue;
      process.stdout.write(
        `  - ${s.fixture_id} (expected=${s.expected_pattern}, got=${s.matched_pattern_id ?? 'no_match'})\n`,
      );
      for (const r of s.reasons) {
        process.stdout.write(`      • ${r}\n`);
      }
    }
  }
}

/**
 * gbrain routing-eval — Standalone CLI verb for Check 5 (W2, v0.17).
 *
 * Runs the structural routing eval against every `routing-eval.jsonl`
 * fixture in the skills tree. Exits:
 *   0   all fixtures pass (top1 accuracy = 1.0, no ambiguity, no
 *       false positives, no lint issues)
 *   1   any failure
 *   2   fixtures directory not found / resolver missing (setup error)
 *
 * Layer B (LLM tie-break) via `--llm` is reserved: the flag parses and
 * surfaces in the envelope, but the harness does not yet call any model.
 * The plan ships structural layer only in v0.17. The LLM layer has
 * explicit sequencing in v0.18 once the structural baseline is stable.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve as resolvePath, isAbsolute } from 'path';

import {
  indexResolverTriggers,
  lintRoutingFixtures,
  loadRoutingFixtures,
  runRoutingEval,
  type RoutingReport,
  type FixtureLintIssue,
} from '../core/routing-eval.ts';
import { findResolverFile, RESOLVER_FILENAMES_LABEL } from '../core/resolver-filenames.ts';
import { autoDetectSkillsDir } from '../core/repo-root.ts';
import { join } from 'path';

interface Flags {
  help: boolean;
  json: boolean;
  llm: boolean;
  skillsDir: string | null;
}

export interface RoutingEvalEnvelope {
  ok: boolean;
  skillsDir: string | null;
  resolverFile: string | null;
  report: RoutingReport | null;
  lintIssues: FixtureLintIssue[];
  malformedFixtures: { file: string; line: number; error: string }[];
  error: 'no_skills_dir' | 'no_resolver' | null;
  message: string | null;
}

const HELP = `gbrain routing-eval [options]

Run the structural routing eval (Check 5) against every skills/<name>/
routing-eval.jsonl fixture. Reports top-1 accuracy, ambiguity, and
false-positive counts. Lints fixtures for verbatim trigger copies.

Options:
  --json             Machine-readable JSON envelope
  --llm              (reserved for v0.18) Run Layer B LLM tie-break
  --skills-dir PATH  Override the auto-detected skills/ directory
  --help             Show this message

Exit codes:
  0  all fixtures passed, no lint issues
  1  one or more failures (miss / ambiguous / false positive / lint)
  2  setup error (no skills dir, no resolver file)
`;

function parseFlags(argv: string[]): Flags {
  const f: Flags = { help: false, json: false, llm: false, skillsDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') f.help = true;
    else if (a === '--json') f.json = true;
    else if (a === '--llm') f.llm = true;
    else if (a === '--skills-dir') {
      f.skillsDir = argv[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--skills-dir=')) {
      f.skillsDir = a.slice('--skills-dir='.length) || null;
    }
  }
  return f;
}

function resolveSkillsDir(
  flags: Flags,
): { dir: string | null; source: string | null; error: RoutingEvalEnvelope['error']; message: string | null } {
  if (flags.skillsDir) {
    const dir = isAbsolute(flags.skillsDir)
      ? flags.skillsDir
      : resolvePath(process.cwd(), flags.skillsDir);
    return { dir, source: 'explicit', error: null, message: null };
  }
  const detected = autoDetectSkillsDir();
  if (!detected.dir) {
    return {
      dir: null,
      source: null,
      error: 'no_skills_dir',
      message:
        'Could not auto-detect skills/ with a resolver file. Set $OPENCLAW_WORKSPACE or pass --skills-dir.',
    };
  }
  return { dir: detected.dir, source: detected.source, error: null, message: null };
}

export async function runRoutingEvalCli(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if (flags.help) {
    console.log(HELP);
    process.exit(0);
  }

  const { dir, error, message } = resolveSkillsDir(flags);
  if (error === 'no_skills_dir') {
    const env: RoutingEvalEnvelope = {
      ok: false,
      skillsDir: null,
      resolverFile: null,
      report: null,
      lintIssues: [],
      malformedFixtures: [],
      error,
      message,
    };
    if (flags.json) console.log(JSON.stringify(env, null, 2));
    else console.error(message);
    process.exit(2);
  }

  const skillsDir = dir!;
  const resolverFile =
    findResolverFile(skillsDir) ?? findResolverFile(join(skillsDir, '..'));
  if (!resolverFile) {
    const env: RoutingEvalEnvelope = {
      ok: false,
      skillsDir,
      resolverFile: null,
      report: null,
      lintIssues: [],
      malformedFixtures: [],
      error: 'no_resolver',
      message: `${RESOLVER_FILENAMES_LABEL} not found in ${skillsDir} or its parent.`,
    };
    if (flags.json) console.log(JSON.stringify(env, null, 2));
    else console.error(env.message);
    process.exit(2);
  }

  const resolverContent = readFileSync(resolverFile, 'utf-8');
  const index = indexResolverTriggers(resolverContent);

  const loaded = loadRoutingFixtures(skillsDir);
  const lintIssues = lintRoutingFixtures(loaded.fixtures, index);
  const report = runRoutingEval(resolverContent, loaded.fixtures, { llm: flags.llm });

  const cleanFixtures = lintIssues.length === 0;
  const cleanResults =
    report.missed === 0 && report.ambiguous === 0 && report.falsePositives === 0;
  const cleanLoader = loaded.malformed.length === 0;
  const ok = cleanFixtures && cleanResults && cleanLoader;

  const env: RoutingEvalEnvelope = {
    ok,
    skillsDir,
    resolverFile,
    report,
    lintIssues,
    malformedFixtures: loaded.malformed.map(m => ({
      file: m.file,
      line: m.line,
      error: m.error,
    })),
    error: null,
    message: null,
  };

  if (flags.json) {
    console.log(JSON.stringify(env, null, 2));
  } else {
    const pct = Math.round(report.top1Accuracy * 100);
    const header = ok ? 'routing-eval: OK' : 'routing-eval: ISSUES';
    console.log(
      `${header} — ${report.totalCases} case(s), ${pct}% top-1 accuracy`,
    );
    if (report.missed > 0) console.log(`  • ${report.missed} missed`);
    if (report.ambiguous > 0) console.log(`  • ${report.ambiguous} ambiguous`);
    if (report.falsePositives > 0)
      console.log(`  • ${report.falsePositives} false positives (negative cases that matched)`);
    for (const d of report.details.filter(x => x.outcome !== 'pass')) {
      console.log(
        `  [${d.outcome}] "${d.fixture.intent}" (expected=${d.fixture.expected_skill ?? 'none'})${d.note ? ' — ' + d.note : ''}`,
      );
    }
    for (const lint of lintIssues) {
      console.log(
        `  [lint:${lint.reason}] "${lint.fixture.intent}" — ${lint.detail}`,
      );
    }
    for (const m of loaded.malformed) {
      console.log(`  [malformed] ${m.file}:${m.line} — ${m.error}`);
    }
    if (flags.llm) {
      console.log('\nNote: --llm (Layer B LLM tie-break) is reserved for v0.18. No model calls made.');
    }
  }

  process.exit(ok ? 0 : 1);
}

/**
 * gbrain check-resolvable — Standalone CLI gate for skill-tree integrity.
 *
 * Thin wrapper over `src/core/check-resolvable.ts`. Exit contract (D-CX-3,
 * post-codex-review):
 *   default:  exit 0 unless there are error-severity issues
 *   --strict: exit 0 unless there are errors OR warnings
 * This lets advisory checks (filing audit, future routing gaps) emit
 * warnings without breaking CI for workspaces that haven't migrated yet.
 * CI pipelines that want the old behavior pass --strict.
 *
 * Currently covers 4 of 6 checks from the original design: reachability,
 * MECE overlap, MECE gap, DRY violations. Checks 5 (trigger routing eval)
 * and 6 (brain filing) are tracked as separate GitHub issues and surfaced
 * via the `deferred` field in --json output.
 */

import { resolve as resolvePath, isAbsolute } from 'path';
import {
  checkResolvable,
  autoFixDryViolations,
  type ResolvableReport,
  type ResolvableIssue,
  type AutoFixReport,
} from '../core/check-resolvable.ts';
import { autoDetectSkillsDir, AUTO_DETECT_HINT, type SkillsDirSource } from '../core/repo-root.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeferredCheck {
  check: number;
  name: string;
  issue: string;
}

export interface Envelope {
  ok: boolean;
  skillsDir: string | null;
  report: ResolvableReport | null;
  autoFix: AutoFixReport | null;
  deferred: DeferredCheck[];
  error: 'no_skills_dir' | null;
  message: string | null;
}

type SkillsDirResolutionSource = 'explicit' | SkillsDirSource | null;

export interface Flags {
  help: boolean;
  json: boolean;
  fix: boolean;
  dryRun: boolean;
  verbose: boolean;
  strict: boolean;
  skillsDir: string | null;
}

// Check 5 (trigger_routing_eval) and Check 6 (brain_filing) both
// shipped as real implementations in v0.19 (W2 + W3). Array is now
// empty; the export stays as a stable public field of the --json
// envelope so downstream consumers that check `.deferred[]` keep
// working. Future deferred checks get appended here.
export const DEFERRED: DeferredCheck[] = [];

const HELP_TEXT = `gbrain check-resolvable [options]

Validate the skill tree: reachability, MECE overlap, DRY violations, and
gap detection. Exits non-zero on errors. Warnings are advisory by default;
pass --strict to fail CI on warnings too.

Options:
  --json             Machine-readable JSON (stable envelope)
  --fix              Apply DRY auto-fixes before checking
  --dry-run          With --fix, preview only; no writes
  --verbose          Show passing checks and the deferred-check note
  --strict           Treat warnings as errors (promotes warnings to exit 1)
  --skills-dir PATH  Override the auto-detected skills/ directory
  --help             Show this message

Exit codes:
  0   clean (no errors; no warnings unless --strict)
  1   errors present, OR (with --strict) warnings present

Check 5 (trigger routing eval) runs via W2: any
skills/<name>/routing-eval.jsonl fixtures are evaluated and routing
gaps surface as warnings.

Check 6 (brain filing) runs via W3: skills with writes_pages: true
are audited against skills/_brain-filing-rules.json. No checks are
currently deferred.
`;

// ---------------------------------------------------------------------------
// Flag parsing — permissive on unknown flags, matching lint/orphans/publish.
// ---------------------------------------------------------------------------

export function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    help: false,
    json: false,
    fix: false,
    dryRun: false,
    verbose: false,
    strict: false,
    skillsDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--fix') flags.fix = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--strict') flags.strict = true;
    else if (a === '--skills-dir') {
      flags.skillsDir = argv[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--skills-dir=')) {
      flags.skillsDir = a.slice('--skills-dir='.length) || null;
    }
    // unknown flags silently ignored
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Skills-dir resolution
// ---------------------------------------------------------------------------

export function resolveSkillsDir(flags: Flags): {
  dir: string | null;
  error: Envelope['error'];
  message: string | null;
  source: SkillsDirResolutionSource;
} {
  if (flags.skillsDir) {
    const dir = isAbsolute(flags.skillsDir)
      ? flags.skillsDir
      : resolvePath(process.cwd(), flags.skillsDir);
    return { dir, error: null, message: null, source: 'explicit' };
  }

  const detected = autoDetectSkillsDir();
  if (!detected.dir) {
    return {
      dir: null,
      error: 'no_skills_dir',
      message:
        'Could not auto-detect skills/ with a RESOLVER.md or AGENTS.md.\n' +
        'Priority order:\n' +
        AUTO_DETECT_HINT +
        '\nFix: export OPENCLAW_WORKSPACE=<path> or pass --skills-dir <path>.',
      source: null,
    };
  }

  const sourceLabel = {
    repo_root: 'repo root skills/',
    openclaw_workspace_env: '$OPENCLAW_WORKSPACE/skills',
    openclaw_workspace_env_root: '$OPENCLAW_WORKSPACE (AGENTS.md at workspace root)',
    openclaw_workspace_home: '~/.openclaw/workspace/skills',
    openclaw_workspace_home_root: '~/.openclaw/workspace (AGENTS.md at workspace root)',
    cwd_skills: './skills',
  }[detected.source!]!;

  return {
    dir: detected.dir,
    error: null,
    message: `Auto-detected skills directory from ${sourceLabel}: ${detected.dir}`,
    source: detected.source,
  };
}

// ---------------------------------------------------------------------------
// Human output (mirrors doctor's resolver_health formatting)
// ---------------------------------------------------------------------------

function renderHuman(env: Envelope, flags: Flags): void {
  if (env.error === 'no_skills_dir') {
    console.error(env.message);
    return;
  }
  const report = env.report!;

  if (flags.fix && env.autoFix) {
    printAutoFixHuman(env.autoFix, flags.dryRun);
  }

  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.log(`resolver_health: OK — ${report.summary.total_skills} skills, all reachable`);
  } else {
    const status =
      report.errors.length > 0
        ? 'FAIL'
        : flags.strict
          ? 'FAIL (strict: warnings promoted)'
          : 'WARN';
    const total = report.errors.length + report.warnings.length;
    console.log(
      `resolver_health: ${status} — ${total} issue(s): ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
    );
    for (const iss of [...report.errors, ...report.warnings]) {
      console.log(formatIssueLine(iss));
    }
    if (report.errors.length === 0 && report.warnings.length > 0 && !flags.strict) {
      console.log('\n(warnings are advisory; run with --strict to fail CI on warnings.)');
    }
  }

  if (flags.verbose) {
    const urls = DEFERRED.map(d => `${d.name} (${d.issue})`).join(', ');
    console.log(`Deferred: ${urls}`);
  }
}

function formatIssueLine(iss: ResolvableIssue): string {
  const type = iss.type.padEnd(18);
  const skill = iss.skill.padEnd(24);
  return `  • ${type} ${skill} ${iss.action}`;
}

function printAutoFixHuman(autoFix: AutoFixReport, dryRun: boolean): void {
  const verb = dryRun ? 'PROPOSED' : 'APPLIED';
  for (const outcome of autoFix.fixed) {
    console.log(`[${verb}] ${outcome.skillPath} (${outcome.patternLabel})`);
  }
  const n = autoFix.fixed.length;
  const s = autoFix.skipped.length;
  if (n === 0 && s === 0) {
    console.log('check-resolvable --fix: no DRY violations to repair.');
    return;
  }
  const label = dryRun ? 'fixes proposed' : 'fixes applied';
  console.log(`${n} ${label}${s > 0 ? `, ${s} skipped:` : '.'}`);
  for (const sk of autoFix.skipped) {
    const hint = sk.reason === 'working_tree_dirty' ? ' (run `git stash` first)' : '';
    console.log(`  - ${sk.skillPath}: ${sk.reason}${hint}`);
  }
  if (dryRun && n > 0) console.log('Run without --dry-run to apply.\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runCheckResolvable(args: string[]): Promise<void> {
  const flags = parseFlags(args);

  if (flags.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const { dir, error, message, source } = resolveSkillsDir(flags);

  if (error === 'no_skills_dir') {
    const env: Envelope = {
      ok: false,
      skillsDir: null,
      report: null,
      autoFix: null,
      deferred: DEFERRED,
      error,
      message,
    };
    if (flags.json) {
      console.log(JSON.stringify(env, null, 2));
    } else {
      renderHuman(env, flags);
    }
    process.exit(1);
  }

  const skillsDir = dir!;
  if (!flags.json && source !== 'explicit' && message) {
    console.log(message);
  }

  let autoFix: AutoFixReport | null = null;
  if (flags.fix) {
    autoFix = autoFixDryViolations(skillsDir, { dryRun: flags.dryRun });
  }

  const report = checkResolvable(skillsDir);

  // Exit semantics (D-CX-3):
  //   default mode: fail iff any errors
  //   --strict:     fail if any errors OR any warnings
  // Warnings alone never flip the exit code in default mode. This lets
  // advisory checks (filing audit, future routing gaps) emit without
  // breaking CI for workspaces that haven't migrated yet.
  const envOk = flags.strict
    ? report.errors.length === 0 && report.warnings.length === 0
    : report.errors.length === 0;

  const env: Envelope = {
    ok: envOk,
    skillsDir,
    report,
    autoFix,
    deferred: DEFERRED,
    error: null,
    message: null,
  };

  if (flags.json) {
    console.log(JSON.stringify(env, null, 2));
  } else {
    renderHuman(env, flags);
  }

  process.exit(env.ok ? 0 : 1);
}

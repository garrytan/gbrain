/**
 * gbrain check-resolvable — Standalone CLI gate for skill-tree integrity.
 *
 * Thin wrapper over `src/core/check-resolvable.ts`. Exit-code rule is stricter
 * than `gbrain doctor`'s resolver_health: this command exits 1 on ANY issue
 * (errors OR warnings) so CI can gate on a single command. Honors the README
 * contract: "Exits non-zero if anything is off."
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
import { findRepoRoot } from '../core/repo-root.ts';

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

export interface Flags {
  help: boolean;
  json: boolean;
  fix: boolean;
  dryRun: boolean;
  verbose: boolean;
  skillsDir: string | null;
}

// TBD: fill these issue URLs after filing the GitHub issues pre-PR.
// grep for 'TBD-check-5' / 'TBD-check-6' before shipping.
export const DEFERRED: DeferredCheck[] = [
  {
    check: 5,
    name: 'trigger_routing_eval',
    issue: 'https://github.com/garrytan/gbrain/issues?q=TBD-check-5',
  },
  {
    check: 6,
    name: 'brain_filing',
    issue: 'https://github.com/garrytan/gbrain/issues?q=TBD-check-6',
  },
];

const HELP_TEXT = `gbrain check-resolvable [options]

Validate the skill tree: reachability, MECE overlap, DRY violations, and
gap detection. Exits non-zero if any issues are found (errors OR warnings).

Options:
  --json             Machine-readable JSON (stable envelope)
  --fix              Apply DRY auto-fixes before checking
  --dry-run          With --fix, preview only; no writes
  --verbose          Show passing checks and the deferred-check note
  --skills-dir PATH  Override the auto-detected skills/ directory
  --help             Show this message

Deferred to separate issues (see --json .deferred[]):
  - Check 5: trigger routing eval
  - Check 6: brain filing
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
    skillsDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--fix') flags.fix = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--verbose') flags.verbose = true;
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

export function resolveSkillsDir(flags: Flags): { dir: string | null; error: Envelope['error']; message: string | null } {
  if (flags.skillsDir) {
    const dir = isAbsolute(flags.skillsDir)
      ? flags.skillsDir
      : resolvePath(process.cwd(), flags.skillsDir);
    return { dir, error: null, message: null };
  }
  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    return {
      dir: null,
      error: 'no_skills_dir',
      message:
        'Could not locate skills/RESOLVER.md from cwd. Pass --skills-dir <path> or run from inside a gbrain repo.',
    };
  }
  return { dir: resolvePath(repoRoot, 'skills'), error: null, message: null };
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

  if (report.ok && report.issues.length === 0) {
    console.log(`resolver_health: OK — ${report.summary.total_skills} skills, all reachable`);
  } else {
    const errors = report.issues.filter(i => i.severity === 'error');
    const warnings = report.issues.filter(i => i.severity === 'warning');
    const status = errors.length > 0 ? 'FAIL' : 'WARN';
    console.log(
      `resolver_health: ${status} — ${report.issues.length} issue(s): ${errors.length} error(s), ${warnings.length} warning(s)`,
    );
    for (const iss of report.issues) {
      console.log(formatIssueLine(iss));
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

  const { dir, error, message } = resolveSkillsDir(flags);

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

  let autoFix: AutoFixReport | null = null;
  if (flags.fix) {
    autoFix = autoFixDryViolations(skillsDir, { dryRun: flags.dryRun });
  }

  const report = checkResolvable(skillsDir);

  const env: Envelope = {
    ok: report.issues.length === 0,
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

/**
 * `gbrain skillpack health [<skill>] [--skills-dir PATH] [--json] [--strict]`:
 * read-only skill health (size, growth since the last diet, description,
 * triggers, drift against this gbrain) for the active skills folder: the
 * harness or workspace skills dir, else the bundled skills. Also the loader the
 * `skill_health` doctor check and `gbrain maintain` use.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { autoDetectSkillsDirReadOnly } from '../../core/repo-root.ts';
import { bundledSkillSlugs, findGbrainRoot, loadBundleManifest } from '../../core/skillpack/bundle.ts';
import { computeSkillHealth, parseSkillBudgets, registeredSkillSurface, skillHealthSummary, type SkillHealthReport } from '../../core/skill-health.ts';
import { resolveAbs } from './shared.ts';

const HELP = `gbrain skillpack health [<skill>] [--skills-dir PATH] [--json] [--strict]

Read-only skill health for the active skills folder (the harness or workspace
skills dir, else gbrain's bundled skills): bytes against the skill's budget,
growth past 10% over its last diet, description size, frontmatter triggers,
and every gbrain command, flag or tool the skill shows that this gbrain does
not have. Each finding names the edit or command that fixes it and a verify
command. A folder without a skills manifest or skills.lock.json is checked
only for copies of gbrain's bundled skills.

Exit 0 (findings included), 1 with --strict when there are findings, 2 when
no skills folder is found.`;

/** Health for one skills folder, with the bundle's budgets and slugs when a bundle is found. */
export function skillHealthFor(skillsDir: string, only?: string): SkillHealthReport {
  const gbrainRoot = findGbrainRoot();
  const budgetsPath = gbrainRoot ? join(gbrainRoot, 'skills', 'skill-budgets.tsv') : null;
  const budgets = budgetsPath && existsSync(budgetsPath) ? parseSkillBudgets(readFileSync(budgetsPath, 'utf8')).rows : new Map();
  let bundled = new Set<string>();
  try {
    if (gbrainRoot) bundled = new Set(bundledSkillSlugs(loadBundleManifest(gbrainRoot)));
  } catch {
    // A broken bundle manifest leaves only managed folders checkable.
  }
  return computeSkillHealth({ skillsDir, surface: registeredSkillSurface(), budgets, bundled, only });
}

export async function cmdHealth(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  let skillsDir: string | null = null;
  let only: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--skills-dir') skillsDir = args[++i] ?? null;
    else if (!a.startsWith('-')) only = a;
  }
  const dir = skillsDir ? resolveAbs(skillsDir) : autoDetectSkillsDirReadOnly().dir;
  if (!dir || !existsSync(dir)) {
    console.error('skillpack health: no skills folder found. Pass --skills-dir <path> or set $GBRAIN_SKILLS_DIR.');
    process.exit(2);
  }
  const report = skillHealthFor(dir, only);
  if (only && report.skills.length === 0) {
    console.error(`skillpack health: no gbrain skill named '${only}' in ${dir}.`);
    process.exit(2);
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`skill health (${dir}, ${report.scope}): ${skillHealthSummary(report)}`);
    for (const s of report.skills) {
      console.log(`  ${s.skill.padEnd(32)} ${String(s.bytes).padStart(6)} / ${s.ceiling} bytes  ${s.invocations} invocation(s)${s.findings ? `  ${s.findings} finding(s)` : ''}`);
    }
    for (const f of report.findings) {
      console.log(`\n${f.code} ${f.file}${f.line ? `:${f.line}` : ''}\n  observed: ${f.observed}\n  expected: ${f.expected}\n  fix: ${f.fix}\n  verify: ${f.verify}`);
    }
  }
  process.exit(strict && report.findings.length ? 1 : 0);
}

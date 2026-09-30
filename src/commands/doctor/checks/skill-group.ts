/**
 * SKILL check group: resolver health (with `--fix` auto-repair before the scan), retrieval reflex, volunteer channels, memory verbs, and skill conformance / brain-first / manifest / currency / preconditions.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { checkResolvable } from '../../../core/check-resolvable.ts';
import { autoFixDryViolations, type AutoFixReport } from '../../../core/dry-fix.ts';
import {
  skillConformanceCheck,
  skillBrainFirstCheck,
  skillsManifestIntegrityCheck,
  skillCurrencyCheck,
  skillPreconditionsCheck,
} from '../skill-checks.ts';
import { checkVolunteerChannels } from './core-health.ts';
import { buildRetrievalReflexCheck, buildMemoryVerbsCheck } from './verbs-reflex.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

async function runResolverHealth(ctx: DoctorContext): Promise<Check[]> {
  const { skillsDirResolution: detected, doFix, dryRun, jsonOutput, scope } = ctx;
  const skillsDir = detected.dir;
  const checks: Check[] = [];

  if (scope === 'all' && skillsDir) {

    // --fix: run auto-repair BEFORE checkResolvable so the post-fix scan
    // reflects the new state. Auto-fix only targets DRY violations today;
    // other resolver issues are left to human repair.
    //
    // SAFETY GATE (v0.31.7 follow-up to D5): refuse --fix when the skills
    // dir came from the install-path fallback. autoFixDryViolations writes
    // to SKILL.md files; a user running `cd ~ && gbrain doctor --fix`
    // without an explicit signal would have install_path resolve to the
    // bundled gbrain repo and silently rewrite the install-tree skills.
    // Codex caught this leak in the v0.31.7 ship review (D6 lock).
    if (doFix) {
      if (detected.source === 'install_path') {
        process.stderr.write(
          'gbrain doctor --fix refused: skills dir resolved via install-path fallback (read-only).\n' +
          'The --fix flag writes to SKILL.md files; running it against the bundled install\n' +
          'tree would silently mutate gbrain itself. Set $GBRAIN_SKILLS_DIR, $OPENCLAW_WORKSPACE,\n' +
          'or pass --skills-dir <path> to point at the workspace you actually want to fix.\n',
        );
      } else {
        ctx.autoFixReport = autoFixDryViolations(skillsDir, { dryRun });
        printAutoFixReport(ctx.autoFixReport, dryRun, jsonOutput);
      }
    }

    const report = checkResolvable(skillsDir, { skillsDirSource: detected.source === 'explicit' ? null : detected.source });
    if (report.errors.length === 0 && report.warnings.length === 0) {
      checks.push({
        name: 'resolver_health',
        status: 'ok',
        message: `${report.summary.total_skills} skills, all reachable`,
      });
    } else {
      const status = report.errors.length > 0 ? 'fail' as const : 'warn' as const;
      const total = report.errors.length + report.warnings.length;
      const check: Check = {
        name: 'resolver_health',
        status,
        message: `${total} issue(s): ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
        issues: [...report.errors, ...report.warnings].map(i => ({
          type: i.type,
          skill: i.skill,
          action: i.action,
          fix: i.fix,
        })),
      };
      checks.push(check);
    }
  } else if (scope === 'all') {
    checks.push({ name: 'resolver_health', status: 'warn', message: 'Could not find skills directory' });
  }
  return checks;
}

export const resolverHealthEntry: DoctorEntry = {
  name: 'resolver_health',
  emits: ['resolver_health'],
  run: runResolverHealth,
};

async function runRetrievalReflex(ctx: DoctorContext): Promise<Check[]> {
  const { engine, fastMode, scope, skillsDir } = ctx;
  const checks: Check[] = [];

  // 1b. Retrieval Reflex health (#1981, SKILL group — gated). Truthful runtime
  // status: the deterministic pointer layer is on by default; the heartbeat file
  // (written by the context engine when it actually injects) is the authority for
  // "is it firing". The doctor cannot see the OpenClaw host capability directly,
  // so it never claims "enabled via host"; it reports observed activity instead.
  if (scope === 'all') {
    checks.push(buildRetrievalReflexCheck(skillsDir));
  }

  // 1b-2. Per-channel push-context visibility (the hook lane's feedback
  // loop). Engine-aware sibling of the reflex heartbeat check above — the
  // LOCAL `gbrain doctor` is the primary operator surface for this, so it
  // runs here as well as on the remote report path. Skipped in fs-only mode.
  if (scope === 'all' && engine && !fastMode) {
    checks.push(await checkVolunteerChannels(engine));
  }

  // 1c. MEMORY_VERBS v1 usage sidecar health (Cathedral 1, E4). Read-only,
  // fail-open: reports whether the local JSONL sidecar is present + parseable
  // and when a verb last fired. Local file only — never uploaded.
  if (scope === 'all') {
    checks.push(await buildMemoryVerbsCheck());
  }
  return checks;
}

export const retrievalReflexEntry: DoctorEntry = {
  name: 'retrieval_reflex_health',
  emits: ['retrieval_reflex_health', 'volunteer_channels', 'memory_verbs_usage'],
  run: runRetrievalReflex,
};

async function runSkillConformance(ctx: DoctorContext): Promise<Check[]> {
  const { engine, scope, skillsDir } = ctx;
  const checks: Check[] = [];

  // 2. Skill conformance (SKILL group — gated)
  if (scope === 'all' && skillsDir) {
    const conformanceResult = skillConformanceCheck(skillsDir);
    checks.push(conformanceResult);
  }

  // 2b. Skill brain-first compliance (v0.36.x, supersedes PR #1206).
  // Scans every SKILL.md for external-lookup tools (web_search, exa,
  // perplexity, etc.) and warns when the skill doesn't declare
  // `brain_first: exempt` AND doesn't carry a canonical Convention
  // callout / Phase 1 brain heading / position-relative brain-first
  // reference. Motivated by the 2026-05-19 tweet-shield incident.
  //
  // Audit trail: snapshot+diff at ~/.gbrain/audit/skill-brain-first-
  // snapshot.json. Writes one detected/resolved JSONL line per state
  // transition + one fixed line per applied --fix. Stable brain → zero
  // audit writes per doctor run.
  //
  // SKILL group — gated.
  if (scope === 'all' && skillsDir) {
    checks.push(skillBrainFirstCheck(skillsDir));
  }

  // 2c. Skills manifest integrity (#159): tamper-evidence, not signatures.
  // Compares the skills tree against its committed skills.lock.json and
  // WARNS on drift — never fails, never blocks. No manifest (e.g. a user
  // workspace skills dir, or a compiled binary far from the repo) → ok/skip.
  // SKILL group — gated.
  if (scope === 'all' && skillsDir) {
    checks.push(skillsManifestIntegrityCheck(skillsDir));
  }

  // 2c-bis. Skill currency (new built-in skills available downstream) +
  // live precondition verification for installed skills that declare
  // `requires:`. Currency is filesystem-only; preconditions need the engine
  // and skip cleanly without one.
  if (scope === 'all' && skillsDir) {
    checks.push(skillCurrencyCheck(skillsDir));
    checks.push(await skillPreconditionsCheck(skillsDir, engine));
  }
  return checks;
}

export const skillConformanceEntry: DoctorEntry = {
  name: 'skill_conformance',
  emits: [
    'skill_conformance',
    'skill_brain_first',
    'skills_manifest_integrity',
    'skill_currency',
    'skill_preconditions',
  ],
  run: runSkillConformance,
};

/** Print the auto-fix report in human-readable form. JSON output goes through
 *  outputResults alongside the check list; this is the pretty-print path. */
function printAutoFixReport(report: AutoFixReport, dryRun: boolean, jsonOutput: boolean): void {
  if (jsonOutput) return; // JSON consumers read autoFixReport via the check issues / caller
  const verb = dryRun ? 'PROPOSED' : 'APPLIED';
  for (const outcome of report.fixed) {
    console.log(`[${verb}] ${outcome.skillPath} (${outcome.patternLabel})`);
    if (outcome.before) {
      console.log('--- before');
      console.log(outcome.before);
      console.log('--- after');
      console.log(outcome.after ?? '');
      console.log('');
    }
  }
  const n = report.fixed.length;
  const s = report.skipped.length;
  if (n === 0 && s === 0) {
    console.log('Doctor --fix: no DRY violations to repair.');
    return;
  }
  const label = dryRun ? 'fixes proposed' : 'fixes applied';
  console.log(`${n} ${label}${s > 0 ? `, ${s} skipped:` : '.'}`);
  for (const sk of report.skipped) {
    const hint = sk.reason === 'working_tree_dirty' ? ' (run `git stash` first)' : '';
    console.log(`  - ${sk.skillPath}: ${sk.reason}${hint}`);
  }
  if (dryRun && n > 0) console.log('\nRun without --dry-run to apply.');
}

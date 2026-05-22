#!/usr/bin/env bun
/**
 * scripts/live-brain-first-check.ts — opt-in dev script for the v0.36.x
 * skill_brain_first wave (T10 from /plan-eng-review).
 *
 * Runs the doctor brain-first check against the LIVE OpenClaw deployment
 * (or whatever `$OPENCLAW_WORKSPACE` points at) and produces a human-
 * readable + machine-readable report. NOT part of `bun run verify` — the
 * deployment isn't this repo's content, so coupling CI to it would
 * produce drift the moment OpenClaw evolves independently.
 *
 * Use this manually during dev / QA / after `gbrain doctor --fix` runs
 * to validate the wave against the real deployment.
 *
 * Usage:
 *   $OPENCLAW_WORKSPACE=~/.openclaw/workspace bun run scripts/live-brain-first-check.ts
 *   $OPENCLAW_WORKSPACE=~/.openclaw/workspace bun run scripts/live-brain-first-check.ts --json
 *   $OPENCLAW_WORKSPACE=~/.openclaw/workspace bun run scripts/live-brain-first-check.ts --fix-preview
 *
 * Exit codes:
 *   0 — workspace clean (no violators) OR workspace not configured
 *   1 — workspace configured + has violators (informational; no CI gate)
 *   2 — usage error (couldn't resolve workspace, doctor crash, etc.)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { autoDetectSkillsDirReadOnly } from '../src/core/repo-root.ts';
import { skillBrainFirstCheck } from '../src/commands/doctor.ts';
import { autoFixDryViolations } from '../src/core/dry-fix.ts';
import { parseSkillFrontmatter } from '../src/core/skill-frontmatter.ts';
import {
  analyzeSkillBrainFirst,
  buildBrainFirstSummaryLine,
  FORMERLY_HARDCODED_EXEMPT,
} from '../src/core/skill-brain-first.ts';
import { loadOrDeriveManifest } from '../src/core/skill-manifest.ts';

function main(): number {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const fixPreview = args.includes('--fix-preview');

  if (!process.env.OPENCLAW_WORKSPACE && !process.env.GBRAIN_SKILLS_DIR) {
    process.stderr.write(
      '[live-brain-first] No skills dir source set. Set OPENCLAW_WORKSPACE or GBRAIN_SKILLS_DIR.\n' +
      '  $OPENCLAW_WORKSPACE=~/.openclaw/workspace bun run scripts/live-brain-first-check.ts\n',
    );
    return 0; // not configured = not a failure
  }

  const detected = autoDetectSkillsDirReadOnly();
  if (!detected || !detected.dir || !existsSync(detected.dir)) {
    process.stderr.write(
      `[live-brain-first] Could not resolve skills dir from OPENCLAW_WORKSPACE / GBRAIN_SKILLS_DIR / cwd walk-up.\n`,
    );
    return 2;
  }

  process.stderr.write(`[live-brain-first] Scanning ${detected.dir} (source: ${detected.source})\n\n`);

  const check = skillBrainFirstCheck(detected.dir);
  const violators = check.issues ?? [];

  // Shape assertions for human eyeballs (per T1 from /plan-eng-review):
  // structurally-compliant skills MUST NOT appear in the violator list.
  // We surface these as informational warnings if any shape invariant
  // breaks; the script never fails on shape breach (that's the unit-test
  // suite's job).
  const shapeWarnings: string[] = [];

  // Walk manifest once to collect classification info for the report.
  const manifest = loadOrDeriveManifest(detected.dir);
  const compliantViaCallout: string[] = [];
  const exemptByFrontmatter: string[] = [];
  const exemptByNoExternal: string[] = [];
  const flaggedFormerly: string[] = [];
  const flaggedNew: string[] = [];

  for (const entry of manifest.skills) {
    const skillPath = join(detected.dir, entry.path);
    if (!existsSync(skillPath)) continue;
    let content: string;
    try {
      content = readFileSync(skillPath, 'utf-8');
    } catch {
      continue;
    }
    const fm = parseSkillFrontmatter(content);
    const a = analyzeSkillBrainFirst(content, entry.name, fm);
    if (a.status === 'ok') {
      if (a.reason === 'compliant_callout' || a.reason === 'compliant_phase' || a.reason === 'compliant_position') {
        compliantViaCallout.push(a.skill);
      } else if (a.reason === 'exempt_explicit') {
        exemptByFrontmatter.push(a.skill);
      } else if (a.reason === 'exempt_no_external') {
        exemptByNoExternal.push(a.skill);
      }
    } else {
      if (a.formerly_hardcoded_exempt) flaggedFormerly.push(a.skill);
      else flaggedNew.push(a.skill);
    }
  }

  if (jsonMode) {
    const report = {
      schema_version: 1,
      workspace: detected.dir,
      source: detected.source,
      status: check.status,
      total_skills: manifest.skills.length,
      compliant_via_callout: compliantViaCallout.sort(),
      exempt_by_frontmatter: exemptByFrontmatter.sort(),
      exempt_by_no_external: exemptByNoExternal.sort(),
      flagged_formerly_exempt: flaggedFormerly.sort(),
      flagged_new: flaggedNew.sort(),
      total_violators: violators.length,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Workspace: ${detected.dir}`);
    console.log(`Source: ${detected.source}`);
    console.log(`Total skills scanned: ${manifest.skills.length}`);
    console.log('');
    console.log(`Compliant via callout/phase/position: ${compliantViaCallout.length}`);
    console.log(`Exempt by frontmatter (brain_first: exempt): ${exemptByFrontmatter.length}`);
    console.log(`Exempt by no-external-pattern: ${exemptByNoExternal.length}`);
    console.log('');
    console.log(`Flagged (formerly hardcoded-exempt in PR #1206): ${flaggedFormerly.length}`);
    if (flaggedFormerly.length > 0) {
      for (const s of flaggedFormerly.sort()) console.log(`  - ${s}`);
    }
    console.log('');
    console.log(`Flagged (genuinely new violators): ${flaggedNew.length}`);
    if (flaggedNew.length > 0) {
      for (const s of flaggedNew.sort()) console.log(`  - ${s}`);
    }
    console.log('');

    if (violators.length === 0) {
      console.log('STATUS: ok — no brain-first violators in the live deployment');
    } else {
      console.log('STATUS: warn — fix with:');
      console.log('  gbrain doctor --fix       # auto-add canonical Convention callout (writes files)');
      console.log('  gbrain doctor --fix --dry-run   # preview without writing');
      console.log('  or add `brain_first: exempt` to each flagged skill\'s frontmatter');
    }
  }

  // --fix-preview: also run autoFixDryViolations against the live workspace
  // in dry-run mode to show what callouts the auto-fix would insert.
  if (fixPreview) {
    process.stderr.write('\n[live-brain-first] Running auto-fix dry-run preview...\n');
    const report = autoFixDryViolations(detected.dir, { dryRun: true });
    const brainFirstProposed = report.fixed.filter(
      f => f.status === 'proposed' && f.patternLabel === 'brain-first compliance',
    );
    if (brainFirstProposed.length === 0) {
      console.log('No brain-first auto-fix proposals.');
    } else {
      console.log(`\nWould insert canonical Convention callout into ${brainFirstProposed.length} skill(s):`);
      for (const p of brainFirstProposed.slice(0, 10)) {
        console.log(`  - ${p.skill}`);
      }
      if (brainFirstProposed.length > 10) {
        console.log(`  ... and ${brainFirstProposed.length - 10} more`);
      }
    }
  }

  return violators.length > 0 ? 1 : 0;
}

process.exit(main());

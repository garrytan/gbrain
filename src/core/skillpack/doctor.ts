/**
 * skillpack/doctor.ts — `gbrain skillpack doctor` runner.
 *
 * Two modes (codex T1 decision: layered doctor, agent picks):
 *   --quick  — structural-only sweep (~5s); walks the rubric, no sandbox
 *              / no LLM / no DB. Designed for tight iteration loops.
 *   --full   — quick + runs the publish-gate's test + LLM-judge + routing-
 *              eval suites. Currently delegates the heavy lifting to the
 *              publish-gate's sandbox path (W5 / W3 in the original spec);
 *              this v1 doctor only ships --quick. --full prints a hint
 *              pointing at the publish-gate command once that lands.
 *
 * --fix  — auto-scaffold missing pieces for dimensions flagged
 *          `auto_fixable: true`. Generates routing-eval.jsonl stubs,
 *          CHANGELOG entries, bootstrap.md stubs, license file. Refuses
 *          to overwrite files whose mtime is newer than skillpack.json's
 *          (heuristic for "hand-edited since last manifest update").
 *
 * Returns a structured DoctorResult the CLI formats as either human
 * output or stable JSON for agent consumption.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

import { loadSkillpackManifest } from './manifest-v1.ts';
import { walkRubric, type RubricScore } from './rubric.ts';
import { logSkillpackEvent } from './audit.ts';

export type DoctorMode = 'quick' | 'full';

export interface DoctorOptions {
  packRoot: string;
  mode: DoctorMode;
  fix?: boolean;
  /** Auto-confirm destructive fixes (CI / unattended use). */
  yes?: boolean;
}

export interface DoctorResult {
  schema_version: 'skillpack-doctor-v1';
  pack_name: string;
  pack_version: string;
  pack_root: string;
  mode: DoctorMode;
  score: number;
  max_score: number;
  tier_eligibility: 'endorsed' | 'community' | 'experimental' | 'blocked';
  promotion_blockers: string[];
  dimensions: Array<{
    id: number;
    name: string;
    category: 'core' | 'badge';
    description: string;
    score: number;
    passed: boolean;
    detail: string;
    fix_hint: string | null;
    auto_fixable: boolean;
  }>;
  fixes_applied: string[];
  full_mode_hint: string | null;
}

/** Run the doctor. Pure-ish — only reads + (optionally) writes the pack tree. */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  // Load manifest first; the rubric depends on it. On failure we surface
  // dimension 1's error directly without trying to walk the rest.
  let manifest;
  try {
    manifest = loadSkillpackManifest(opts.packRoot);
  } catch (err) {
    return {
      schema_version: 'skillpack-doctor-v1',
      pack_name: 'unknown',
      pack_version: 'unknown',
      pack_root: opts.packRoot,
      mode: opts.mode,
      score: 0,
      max_score: 10,
      tier_eligibility: 'blocked',
      promotion_blockers: ['manifest_valid'],
      dimensions: [
        {
          id: 1,
          name: 'manifest_valid',
          category: 'core',
          description: 'skillpack.json passes the v1 schema validator',
          score: 0,
          passed: false,
          detail: (err as Error).message,
          fix_hint:
            'Run `gbrain skillpack init <name>` to regenerate a valid stub manifest, or fix the field listed above.',
          auto_fixable: false,
        },
      ],
      fixes_applied: [],
      full_mode_hint: null,
    };
  }

  const score = await walkRubric({ packRoot: opts.packRoot, manifest });

  let fixesApplied: string[] = [];
  if (opts.fix) {
    fixesApplied = await applyAutoFixes(opts.packRoot, manifest, score, opts.yes ?? false);
    // Re-walk after fixes to update the score.
    const newScore = await walkRubric({ packRoot: opts.packRoot, manifest });
    return buildResult(opts, manifest, newScore, fixesApplied);
  }

  // Log the run for the gbrain doctor activity surface.
  logSkillpackEvent({
    event: 'doctor_run',
    pack: manifest.name,
    version: manifest.version,
    outcome: score.tier_eligibility === 'blocked' ? 'error' : 'ok',
    meta: { mode: opts.mode, score: score.total, tier: score.tier_eligibility },
  });

  return buildResult(opts, manifest, score, fixesApplied);
}

function buildResult(
  opts: DoctorOptions,
  manifest: ReturnType<typeof loadSkillpackManifest>,
  score: RubricScore,
  fixesApplied: string[],
): DoctorResult {
  return {
    schema_version: 'skillpack-doctor-v1',
    pack_name: manifest.name,
    pack_version: manifest.version,
    pack_root: opts.packRoot,
    mode: opts.mode,
    score: score.total,
    max_score: 10,
    tier_eligibility: score.tier_eligibility,
    promotion_blockers: score.promotion_blockers,
    dimensions: score.dimensions.map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category,
      description: d.description,
      score: d.passed ? 1 : 0,
      passed: d.passed,
      detail: d.detail,
      fix_hint: d.fix_hint,
      auto_fixable: d.auto_fixable,
    })),
    fixes_applied: fixesApplied,
    full_mode_hint:
      opts.mode === 'full'
        ? '--full mode runs the publish-gate test + LLM-judge + routing-eval suites in a sandbox. Implementation lands in a follow-up wave; for now use `gbrain skillpack test <pack-dir>` once W4 ships.'
        : null,
  };
}

/**
 * Apply auto-fixes for any dimension flagged `auto_fixable: true` whose
 * `passed` is false. Refuses to overwrite files whose mtime is newer than
 * skillpack.json's (the "user hand-edited" heuristic).
 */
async function applyAutoFixes(
  packRoot: string,
  manifest: ReturnType<typeof loadSkillpackManifest>,
  score: RubricScore,
  autoYes: boolean,
): Promise<string[]> {
  const fixes: string[] = [];
  const manifestPath = join(packRoot, 'skillpack.json');
  const manifestMtime = existsSync(manifestPath) ? statSync(manifestPath).mtimeMs : Date.now();

  // Plan first; ask for confirm before any write.
  const plan: Array<{ name: string; path: string; content: string }> = [];

  for (const dim of score.dimensions) {
    if (dim.passed) continue;
    if (!dim.auto_fixable) continue;

    switch (dim.name) {
      case 'routing_evals_present': {
        for (const skillPath of manifest.skills) {
          const evalFile = join(packRoot, skillPath, 'routing-eval.jsonl');
          if (existsSync(evalFile)) continue;
          // Build a 5-intent stub the publisher edits.
          const slug = skillPath.replace(/^skills\//, '');
          const stub = Array.from({ length: 5 }).map((_, i) => ({
            intent: `example intent ${i + 1} for ${slug}`,
            expected_skill: slug,
          }));
          plan.push({
            name: dim.name,
            path: evalFile,
            content: stub.map((s) => JSON.stringify(s)).join('\n') + '\n',
          });
        }
        break;
      }
      case 'changelog_present_and_current': {
        const path = join(packRoot, manifest.changelog ?? 'CHANGELOG.md');
        const date = new Date().toISOString().slice(0, 10);
        let content = '';
        if (existsSync(path)) {
          content = readFileSync(path, 'utf-8');
          const stat = statSync(path);
          if (stat.mtimeMs > manifestMtime) {
            // Hand-edited; skip.
            continue;
          }
        } else {
          content = '# Changelog\n\nAll notable changes documented here.\n\n';
        }
        const newEntry = `## [${manifest.version}] - ${date}\n\n- (describe changes)\n\n`;
        plan.push({ name: dim.name, path, content: newEntry + content });
        break;
      }
      case 'unit_tests_present': {
        const target = join(packRoot, 'test/example.test.ts');
        if (!existsSync(target)) {
          const stub = [
            "import { describe, test, expect } from 'bun:test';",
            "",
            "describe('example', () => {",
            "  test('placeholder — replace with real assertions', () => {",
            "    expect(1 + 1).toBe(2);",
            "  });",
            "});",
            "",
          ].join('\n');
          plan.push({ name: dim.name, path: target, content: stub });
        }
        break;
      }
      case 'e2e_tests_present': {
        const target = join(packRoot, 'e2e/example.e2e.test.ts');
        if (!existsSync(target)) {
          const stub = [
            "import { describe, test, expect } from 'bun:test';",
            "",
            "describe.skipIf(!process.env.DATABASE_URL)('example E2E', () => {",
            "  test('placeholder — replace with a real integration scenario', () => {",
            "    expect(process.env.DATABASE_URL).toBeDefined();",
            "  });",
            "});",
            "",
          ].join('\n');
          plan.push({ name: dim.name, path: target, content: stub });
        }
        break;
      }
      case 'llm_eval_present': {
        const target = join(packRoot, 'evals/example.judge.json');
        if (!existsSync(target)) {
          const stub = {
            task: 'Describe what good output for this skill looks like.',
            output:
              "{{output-from-skill}}  -- the doctor stub. Replace with real example output your skill produces.",
            cases: [
              { name: 'happy path', criteria: 'output satisfies the task' },
              { name: 'edge case', criteria: 'output handles a corner input gracefully' },
              { name: 'failure mode', criteria: 'output refuses gracefully when input is ambiguous' },
            ],
          };
          plan.push({ name: dim.name, path: target, content: JSON.stringify(stub, null, 2) + '\n' });
        }
        break;
      }
      case 'bootstrap_runbook_present': {
        const path = join(packRoot, manifest.runbooks?.bootstrap ?? 'runbooks/bootstrap.md');
        if (!existsSync(path)) {
          const stub = [
            '# Bootstrap',
            '',
            '1. show user: "<pack-name> is installed. Try one of the trigger phrases listed in skills/."',
            '2. (edit me) agent: gbrain put_page wiki/_bootstrap-stub --frontmatter type=stub',
            '',
            '<!-- v0.36 contract: gbrain displays this post-scaffold but DOES NOT auto-execute. -->',
            '',
          ].join('\n');
          plan.push({ name: dim.name, path, content: stub });
        }
        break;
      }
      case 'license_present': {
        const target = join(packRoot, 'LICENSE');
        if (!existsSync(target)) {
          const stub = `${manifest.license} License — replace with full license text matching the SPDX id declared in skillpack.json.\n`;
          plan.push({ name: dim.name, path: target, content: stub });
        }
        break;
      }
    }
  }

  if (plan.length === 0) return [];

  if (!autoYes) {
    process.stderr.write(`\n[skillpack doctor --fix] About to create the following files:\n`);
    for (const p of plan) {
      process.stderr.write(`  ${p.path}  (${p.name})\n`);
    }
    process.stderr.write(`\nNo TTY confirm available in this build; pass --yes to apply.\n`);
    return [];
  }

  for (const p of plan) {
    mkdirSync(dirname(p.path), { recursive: true });
    writeFileSync(p.path, p.content);
    fixes.push(`${p.name}: created ${p.path}`);
  }
  return fixes;
}

/** Render the doctor result as human-readable text. */
export function formatDoctorResult(result: DoctorResult): string {
  const tierBadge =
    result.tier_eligibility === 'endorsed'
      ? '★'
      : result.tier_eligibility === 'community'
        ? '·'
        : result.tier_eligibility === 'experimental'
          ? '?'
          : '✗';
  const lines: string[] = [];
  lines.push(
    `${tierBadge} ${result.pack_name}@${result.pack_version}  ${result.score}/${result.max_score}  [${result.tier_eligibility}]`,
  );
  lines.push(`Pack root: ${result.pack_root}`);
  lines.push(`Mode:      ${result.mode}`);
  lines.push('');
  lines.push('Core (must all pass to publish):');
  for (const d of result.dimensions.filter((dd) => dd.category === 'core')) {
    lines.push(
      `  ${d.passed ? '✓' : '✗'} ${d.id}. ${d.name}` + (d.passed ? '' : `  — ${d.detail}`),
    );
    if (!d.passed && d.fix_hint) lines.push(`    fix: ${d.fix_hint}`);
  }
  lines.push('');
  lines.push('Quality badges (earn for tier eligibility):');
  for (const d of result.dimensions.filter((dd) => dd.category === 'badge')) {
    lines.push(
      `  ${d.passed ? '✓' : '✗'} ${d.id}. ${d.name}` +
        (d.passed ? '' : `  — ${d.detail}`) +
        (d.auto_fixable && !d.passed ? '  [auto-fixable]' : ''),
    );
    if (!d.passed && d.fix_hint) lines.push(`    fix: ${d.fix_hint}`);
  }
  if (result.promotion_blockers.length > 0) {
    lines.push('');
    lines.push(`To reach the next tier, address: ${result.promotion_blockers.join(', ')}`);
  }
  if (result.fixes_applied.length > 0) {
    lines.push('');
    lines.push(`Auto-fixes applied (${result.fixes_applied.length}):`);
    for (const f of result.fixes_applied) lines.push(`  + ${f}`);
  }
  if (result.full_mode_hint) {
    lines.push('');
    lines.push(`Note: ${result.full_mode_hint}`);
  }
  return lines.join('\n');
}

#!/usr/bin/env bun
/**
 * Skill health guard: drift and size.
 *
 * Drift: every `gbrain ...` invocation a skill shows (shell fences and inline
 * code) must pass the dispatcher's own subcommand and unknown-flag checks, and
 * every operation-shaped frontmatter `tools:` entry must be a real operation
 * (src/core/skill-drift.ts against src/cli/skill-surface.ts). A PR that renames
 * a command or flag fails here until it updates the skills that teach it.
 * Accepted exceptions live in scripts/skill-drift-baseline.txt, a shrink-only
 * list; a line can also carry `<!-- skill-drift-ok: <reason> -->` (or the
 * line before it) when it shows a wrong invocation on purpose.
 *
 * Size: a SKILL.md over 16384 bytes needs a row in skills/skill-budgets.tsv
 * and must stay under its ceiling; every description stays under 1024 bytes. Ceilings only go down without a
 * reviewer-visible edit (CONTRIBUTING.md, "Changing a skill").
 *
 * GBRAIN_GUARD_ROOT points the scan at a fixture tree (guard self-test).
 * `--sizes <file>...` prints `Skill-size:` lines (HEAD vs working tree) for a
 * commit message and checks nothing.
 * Exit 0 clean, 1 on any violation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyzeSkillDrift, descriptionBytes } from '../src/core/skill-drift.ts';
import { cliSurface } from '../src/cli/skill-surface.ts';

const NEW_SKILL_CAP = 16_384;
const DESCRIPTION_CAP = 1_024;
const ROOT = process.env.GBRAIN_GUARD_ROOT ? resolve(process.env.GBRAIN_GUARD_ROOT) : resolve(import.meta.dir, '..');
const SKILLS = join(ROOT, 'skills');
const BASELINE = join(ROOT, 'scripts', 'skill-drift-baseline.txt');
const BUDGETS = join(SKILLS, 'skill-budgets.tsv');

const args = process.argv.slice(2);
if (args[0] === '--sizes') {
  for (const file of args.slice(1).filter(f => f.endsWith('SKILL.md'))) {
    let before = 0;
    try { before = Number(execFileSync('git', ['cat-file', '-s', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8' }).trim()); } catch {}
    const after = existsSync(join(ROOT, file)) ? statSync(join(ROOT, file)).size : 0;
    if (before !== after) console.log(`Skill-size: ${file.replace(/^skills\//, '').replace(/\/SKILL\.md$/, '')} ${before}→${after}`);
  }
  process.exit(0);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' ? [] : walk(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

const failures: string[] = [];
const rel = (p: string) => relative(ROOT, p);

// Drift
const surface = cliSurface();
const baseline = new Set(existsSync(BASELINE) ? readFileSync(BASELINE, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')) : []);
const seen = new Set<string>();
let invocations = 0;
let unverified = 0;
const files = walk(SKILLS);
for (const file of files) {
  const report = analyzeSkillDrift(rel(file), readFileSync(file, 'utf8'), surface);
  invocations += report.invocations;
  unverified += report.subcommandUnverified;
  for (const f of report.findings) {
    const key = `${f.file}\t${f.code}\t${f.token}`;
    if (baseline.has(key)) { seen.add(key); continue; }
    failures.push(`${f.code} ${f.file}:${f.line} '${f.snippet}'${f.suggestion ? ` (did you mean '${f.suggestion}'?)` : ''}\n    fix: ${f.remedy}`);
  }
}
for (const key of baseline) {
  if (!seen.has(key)) failures.push(`SKILL_DRIFT_BASELINE_STALE ${key.replaceAll('\t', ' ')}\n    fix: the finding is gone; delete this line from scripts/skill-drift-baseline.txt (the list only shrinks)`);
}

// Size
const rows = new Map<string, { max: number; lastDiet: number | null }>();
if (existsSync(BUDGETS)) {
  for (const line of readFileSync(BUDGETS, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [skill, max, lastDiet] = line.split('\t');
    if (!skill || !/^\d+$/.test(max ?? '')) { failures.push(`SKILL_BUDGET_ROW_INVALID skills/skill-budgets.tsv '${line}'\n    fix: write <skill>\t<max bytes>\t<last diet bytes or ->\t<note>`); continue; }
    if (rows.has(skill)) failures.push(`SKILL_BUDGET_ROW_DUPLICATE skills/skill-budgets.tsv '${skill}'\n    fix: keep one row per skill`);
    rows.set(skill, { max: Number(max), lastDiet: lastDiet && /^\d+$/.test(lastDiet) ? Number(lastDiet) : null });
  }
}
const skillFiles = files.filter(f => f.endsWith('/SKILL.md'));
const present = new Set<string>();
for (const file of skillFiles) {
  const skill = relative(SKILLS, file).replace(/\/SKILL\.md$/, '');
  present.add(skill);
  const content = readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(content);
  const desc = descriptionBytes(content);
  if (desc > DESCRIPTION_CAP) failures.push(`SKILL_BUDGET_DESCRIPTION ${rel(file)} description is ${desc} bytes (cap ${DESCRIPTION_CAP})\n    fix: the description loads in every session; keep one trigger per case and move the rest into the body`);
  const row = rows.get(skill);
  if (!row) {
    if (bytes > NEW_SKILL_CAP) failures.push(`SKILL_BUDGET_NEW_SKILL_OVER_CAP ${rel(file)} is ${bytes} bytes (cap ${NEW_SKILL_CAP} without a skills/skill-budgets.tsv row)\n    fix: move detail only some tasks need into references/ behind a link that says when to read it (CONTRIBUTING.md, "Changing a skill")`);
    continue;
  }
  if (bytes > row.max) {
    const overDiet = row.lastDiet ? `; it is ${Math.round((bytes / row.lastDiet - 1) * 100)}% over its last diet (${row.lastDiet} bytes)` : '';
    failures.push(`SKILL_BUDGET_OVER_CEILING ${rel(file)} is ${bytes} bytes (ceiling ${row.max})${overDiet}\n    fix: offset the growth with a cut (edit the line that already covers the idea, move rare detail to references/); raising the ceiling is a reviewer-visible edit to skills/skill-budgets.tsv`);
  } else if (row.lastDiet === null && bytes <= NEW_SKILL_CAP) {
    failures.push(`SKILL_BUDGET_ROW_STALE skills/skill-budgets.tsv '${skill}' is ${bytes} bytes, under the ${NEW_SKILL_CAP}-byte cap\n    fix: delete the row; the default cap now covers it`);
  }
}
for (const skill of rows.keys()) if (!present.has(skill)) failures.push(`SKILL_BUDGET_ROW_STALE skills/skill-budgets.tsv '${skill}' names no skill\n    fix: delete the row`);

const coverage = `${invocations} gbrain invocations in ${files.length} files; subcommands verified for ${invocations - unverified}, not declared for ${unverified} (flags checked for all)`;
if (failures.length) {
  console.error(`FAIL: ${failures.length} skill health violation(s) (${coverage}):`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('Why: a skill is what the agent follows; a command it shows must run as written, and every byte of it loads on every task that uses it.');
  process.exit(1);
}
console.log(`OK: skill health (${coverage}; ${skillFiles.length} skills within budget)`);

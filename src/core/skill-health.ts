/**
 * Runtime skill health for one skills folder: size against its budget, growth
 * since the last diet, description size, frontmatter triggers, and drift
 * against the running CLI (src/core/skill-drift.ts). Read-only, with no git,
 * database or model calls, so it behaves the same on repo-less brains.
 * Shared by `gbrain skillpack health`, the `skill_health` doctor check and
 * `gbrain maintain`; scripts/check-skill-health.ts enforces the same limits
 * on the bundled skills in CI.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analyzeSkillDrift, descriptionBytes, type CliSurface, type DriftCode } from './skill-drift.ts';
import { SKILLS_MANIFEST_FILENAME } from './skills-integrity.ts';

export const NEW_SKILL_CAP = 16_384;
export const DESCRIPTION_CAP = 1_024;
export const DIET_GROWTH_LIMIT = 1.1;
const REDIET = 'CONTRIBUTING.md#changing-a-skill';

let surfaceProvider: (() => CliSurface) | null = null;

/**
 * The CLI dispatcher registers its surface here (src/cli/main.ts), so doctor,
 * which the operations graph also loads, checks drift without importing the
 * command table. Without a provider drift is reported as not checked.
 */
export function setSkillSurfaceProvider(provider: (() => CliSurface) | null): void {
  surfaceProvider = provider;
}

export function registeredSkillSurface(): CliSurface | null {
  return surfaceProvider ? surfaceProvider() : null;
}

export type SkillHealthCode =
  | 'SKILL_HEALTH_OVER_BUDGET'
  | 'SKILL_HEALTH_DIET_GROWTH'
  | 'SKILL_HEALTH_DESCRIPTION'
  | 'SKILL_HEALTH_MISSING_TRIGGERS'
  | DriftCode;

export interface SkillBudget { max: number; lastDiet: number | null }

export interface SkillHealthFinding {
  code: SkillHealthCode;
  skill: string;
  /** Relative to the skills folder. */
  file: string;
  line?: number;
  observed: string;
  expected: string;
  fix: string;
  verify: string;
}

export interface SkillHealthEntry {
  skill: string;
  bytes: number;
  description_bytes: number;
  ceiling: number;
  last_diet: number | null;
  invocations: number;
  /** Invocations of commands that dispatch subcommands by hand: only their flags were checked. */
  subcommands_unverified: number;
  findings: number;
}

export interface SkillHealthReport {
  skills_dir: string;
  /** managed: a skills manifest or skills.lock.json is present, every skill is checked; bundled_copies: only copies of gbrain's bundled skills are checked; not_gbrain: nothing is checked. */
  scope: 'managed' | 'bundled_copies' | 'not_gbrain';
  skills: SkillHealthEntry[];
  findings: SkillHealthFinding[];
  /** False when no CLI surface was available, so commands, flags and tools were not checked. */
  drift_checked: boolean;
  totals: { skills: number; bytes: number; invocations: number; subcommands_unverified: number; drift: number; size: number };
}

export interface SkillBudgetRows {
  rows: Map<string, SkillBudget>;
  invalid: string[];
  duplicates: string[];
}

/** Parse skills/skill-budgets.tsv (tab-separated: skill, max bytes, last diet bytes or `-`, note). */
export function parseSkillBudgets(text: string): SkillBudgetRows {
  const out: SkillBudgetRows = { rows: new Map(), invalid: [], duplicates: [] };
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [skill, max, lastDiet] = line.split('\t');
    if (!skill || !/^\d+$/.test(max ?? '')) { out.invalid.push(line); continue; }
    if (out.rows.has(skill)) out.duplicates.push(skill);
    out.rows.set(skill, { max: Number(max), lastDiet: lastDiet && /^\d+$/.test(lastDiet) ? Number(lastDiet) : null });
  }
  return out;
}

/** A folder gbrain manages: it holds a real skills manifest or skills lock (never a derived one). */
export function isManagedSkillsDir(dir: string): boolean {
  return existsSync(join(dir, 'manifest.json')) || existsSync(join(dir, SKILLS_MANIFEST_FILENAME));
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'migrations' ? [] : markdownFiles(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

function hasTriggers(markdown: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  if (!fm) return false;
  const m = /^triggers:[ \t]*(.*)$/m.exec(fm);
  if (!m) return false;
  if (m[1].trim() && m[1].trim() !== '[]') return true;
  return /^[ \t]+-[ \t]*\S/m.test(fm.slice(m.index + m[0].length).split(/\n(?=\S)/)[0] ?? '');
}

export interface SkillHealthOptions {
  skillsDir: string;
  /** null skips the drift check (no CLI surface registered). */
  surface: CliSurface | null;
  /** Rows of the bundle's skills/skill-budgets.tsv, applied to skills of the same name. */
  budgets: ReadonlyMap<string, SkillBudget>;
  /** Slugs gbrain bundles; copies of them are checked even in a folder gbrain does not manage. */
  bundled: ReadonlySet<string>;
  /** Check one skill only. */
  only?: string;
  /** Overrides the managed-folder test (tests, and later the shared predicate). */
  isManaged?: (dir: string) => boolean;
}

export function computeSkillHealth(opts: SkillHealthOptions): SkillHealthReport {
  const { skillsDir, surface, budgets, bundled, only } = opts;
  const scope: SkillHealthReport['scope'] = (opts.isManaged ?? isManagedSkillsDir)(skillsDir)
    ? 'managed'
    : [...bundled].some(s => existsSync(join(skillsDir, s, 'SKILL.md'))) ? 'bundled_copies' : 'not_gbrain';
  const report: SkillHealthReport = {
    skills_dir: skillsDir, scope, skills: [], findings: [], drift_checked: surface !== null,
    totals: { skills: 0, bytes: 0, invocations: 0, subcommands_unverified: 0, drift: 0, size: 0 },
  };
  if (scope === 'not_gbrain' || !existsSync(skillsDir)) return report;

  const slugs = readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')))
    .map(e => e.name)
    .filter(s => (scope === 'managed' || bundled.has(s)) && (!only || s === only))
    .sort();

  for (const skill of slugs) {
    const dir = join(skillsDir, skill);
    const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const bytes = Buffer.byteLength(skillMd);
    const desc = descriptionBytes(skillMd);
    const budget = budgets.get(skill);
    const ceiling = budget?.max ?? NEW_SKILL_CAP;
    const verify = `gbrain skillpack health ${skill}`;
    const findings: SkillHealthFinding[] = [];
    const file = `${skill}/SKILL.md`;
    const upstream = bundled.has(skill)
      ? `if this copy is unedited, read gbrain's current version with \`gbrain skillpack reference ${skill}\`; otherwise `
      : '';

    if (bytes > ceiling) {
      findings.push({ code: 'SKILL_HEALTH_OVER_BUDGET', skill, file, observed: `${bytes} bytes`, expected: `at most ${ceiling} bytes`,
        fix: `${upstream}move detail only some tasks need into references/ behind a link that says when to read it (${REDIET})`, verify });
    }
    if (budget?.lastDiet && bytes > budget.lastDiet * DIET_GROWTH_LIMIT) {
      findings.push({ code: 'SKILL_HEALTH_DIET_GROWTH', skill, file,
        observed: `${bytes} bytes, ${Math.round((bytes / budget.lastDiet - 1) * 100)}% over its last diet`,
        expected: `at most ${Math.floor(budget.lastDiet * DIET_GROWTH_LIMIT)} bytes (last diet ${budget.lastDiet} + 10%)`,
        fix: `${upstream}re-diet the skill (${REDIET})`, verify });
    }
    if (desc > DESCRIPTION_CAP) {
      findings.push({ code: 'SKILL_HEALTH_DESCRIPTION', skill, file, observed: `description ${desc} bytes`, expected: `at most ${DESCRIPTION_CAP} bytes`,
        fix: 'the description loads in every session; keep one trigger per case and move the rest into the body', verify });
    }
    if (!hasTriggers(skillMd)) {
      findings.push({ code: 'SKILL_HEALTH_MISSING_TRIGGERS', skill, file, observed: 'no frontmatter triggers', expected: 'a triggers: list naming when to load the skill',
        fix: `add a triggers: list to the frontmatter of ${file}; without it the resolver cannot route to the skill`, verify });
    }

    let invocations = 0;
    let unverified = 0;
    let drift = 0;
    if (surface) {
      for (const path of markdownFiles(dir)) {
        const rel = relative(skillsDir, path);
        const d = analyzeSkillDrift(rel, rel === file ? skillMd : readFileSync(path, 'utf8'), surface);
        invocations += d.invocations;
        unverified += d.subcommandUnverified;
        for (const f of d.findings) {
          drift++;
          findings.push({ code: f.code, skill, file: f.file, line: f.line, observed: f.snippet,
            expected: f.suggestion ? `'${f.suggestion}'` : 'a command, flag or tool this gbrain has', fix: f.remedy, verify });
        }
      }
    }

    report.skills.push({ skill, bytes, description_bytes: desc, ceiling, last_diet: budget?.lastDiet ?? null,
      invocations, subcommands_unverified: unverified, findings: findings.length });
    report.findings.push(...findings);
    report.totals.skills++;
    report.totals.bytes += bytes;
    report.totals.invocations += invocations;
    report.totals.subcommands_unverified += unverified;
    report.totals.drift += drift;
    report.totals.size += findings.length - drift;
  }
  return report;
}

/** One line for doctor, maintain and skillpack-check. */
export function skillHealthSummary(r: SkillHealthReport): string {
  if (r.scope === 'not_gbrain') return 'no gbrain skills in this folder';
  const t = r.totals;
  const kb = (t.bytes / 1024).toFixed(0);
  const head = r.drift_checked
    ? `${t.skills} skill(s), ${kb} KB, ${t.invocations} gbrain invocation(s) (${t.subcommands_unverified} with undeclared subcommands, flags checked)`
    : `${t.skills} skill(s), ${kb} KB (commands and flags not checked outside the CLI)`;
  if (!r.findings.length) return `${head}; no findings`;
  const parts = [t.drift ? `${t.drift} drift` : '', t.size ? `${t.size} size/frontmatter` : ''].filter(Boolean).join(', ');
  const skills = [...new Set(r.findings.map(f => f.skill))];
  return `${head}; ${parts} finding(s) in ${skills.slice(0, 5).join(', ')}${skills.length > 5 ? `, … +${skills.length - 5} more` : ''}`;
}

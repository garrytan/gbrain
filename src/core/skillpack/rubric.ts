/**
 * skillpack/rubric.ts — declarative quality rubric for third-party skillpacks.
 *
 * Codex outside-voice T4: rubric splits into REQUIRED CORE (5 dimensions
 * that gate publish entirely) and QUALITY BADGES (5 dimensions that
 * gate tier eligibility). A pack with 0 badges can still publish as
 * experimental; community needs >= 3 badges; endorsed needs all 5.
 *
 * Each dimension is a pure-ish check function over the pack directory.
 * The doctor walks them in order; the anatomy doc is auto-generated
 * from this single source of truth.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { parseMarkdown } from '../markdown.ts';
import { loadSkillpackManifest, SkillpackManifestError, type SkillpackManifest } from './manifest-v1.ts';

/** Dimension category. */
export type RubricCategory = 'core' | 'badge';

/** Result of a single dimension check. */
export interface RubricDimensionResult {
  /** 1-10 dimension id (stable across versions). */
  id: number;
  /** snake_case name (stable; consumed by tier rules + anatomy doc). */
  name: string;
  /** Required core vs optional badge. */
  category: RubricCategory;
  /** Did the check pass? */
  passed: boolean;
  /** Human-readable description of what was checked. */
  description: string;
  /** Detail string surfaced in --json output (e.g. specific files that failed). */
  detail: string;
  /** Paste-ready fix command / hint when passed=false. */
  fix_hint: string | null;
  /** Whether `doctor --fix` can auto-resolve this dimension. */
  auto_fixable: boolean;
}

/** Rubric input — a parsed pack ready for scoring. */
export interface RubricInput {
  /** Absolute path to the pack root. */
  packRoot: string;
  /** Parsed manifest. */
  manifest: SkillpackManifest;
}

/** Score envelope produced by walkRubric. */
export interface RubricScore {
  /** All 10 dimension results. */
  dimensions: RubricDimensionResult[];
  /** Sum of passed dimensions (max 10). */
  total: number;
  /** Pass counts per category. */
  core_passed: number;
  badges_passed: number;
  /** Tier eligibility based on which dimensions passed. */
  tier_eligibility: 'endorsed' | 'community' | 'experimental' | 'blocked';
  /** When tier_eligibility is anything below endorsed, the dimensions blocking promotion. */
  promotion_blockers: string[];
}

const DIMENSIONS: Array<
  Omit<RubricDimensionResult, 'passed' | 'detail' | 'fix_hint'> & {
    check: (input: RubricInput) => Promise<{ passed: boolean; detail: string; fix_hint: string | null }>;
  }
> = [
  // ============================================================
  // CORE (5 dimensions — must all pass to publish at any tier)
  // ============================================================
  {
    id: 1,
    name: 'manifest_valid',
    category: 'core',
    description: 'skillpack.json passes the v1 schema validator',
    auto_fixable: false,
    check: async (input) => {
      try {
        loadSkillpackManifest(input.packRoot);
        return { passed: true, detail: 'manifest validates', fix_hint: null };
      } catch (err) {
        const msg = err instanceof SkillpackManifestError ? err.message : (err as Error).message;
        return {
          passed: false,
          detail: msg,
          fix_hint:
            'Run `gbrain skillpack init <name>` to regenerate a valid stub manifest, or fix the field listed above.',
        };
      }
    },
  },
  {
    id: 2,
    name: 'skills_have_skill_md',
    category: 'core',
    description: 'every listed skill has SKILL.md with valid frontmatter (name, description, triggers)',
    auto_fixable: false,
    check: async (input) => {
      const failures: string[] = [];
      for (const skillPath of input.manifest.skills) {
        const skillMd = join(input.packRoot, skillPath, 'SKILL.md');
        if (!existsSync(skillMd)) {
          failures.push(`${skillPath}/SKILL.md missing`);
          continue;
        }
        try {
          const parsed = parseMarkdown(readFileSync(skillMd, 'utf-8'));
          const fm = parsed.frontmatter as Record<string, unknown>;
          const missingFields = ['name', 'description', 'triggers'].filter((f) => !(f in fm));
          if (missingFields.length > 0) {
            failures.push(`${skillPath}/SKILL.md missing frontmatter fields: ${missingFields.join(', ')}`);
          }
          if (
            Array.isArray(fm.triggers)
              ? fm.triggers.length === 0
              : typeof fm.triggers === 'string'
                ? fm.triggers.trim().length === 0
                : true
          ) {
            if (!failures.some((f) => f.startsWith(skillPath))) {
              failures.push(`${skillPath}/SKILL.md frontmatter.triggers is empty`);
            }
          }
        } catch (err) {
          failures.push(`${skillPath}/SKILL.md failed to parse: ${(err as Error).message}`);
        }
      }
      return failures.length === 0
        ? { passed: true, detail: `all ${input.manifest.skills.length} skills have valid SKILL.md`, fix_hint: null }
        : {
            passed: false,
            detail: failures.join('; '),
            fix_hint:
              'For each missing SKILL.md, run `gbrain skillpack init` (regenerates the stub) or hand-write the frontmatter with name + description + triggers (array of >=1 strings).',
          };
    },
  },
  {
    id: 3,
    name: 'routing_evals_present',
    category: 'core',
    description: 'every skill has routing-eval.jsonl with >= 5 intents',
    auto_fixable: true,
    check: async (input) => {
      const failures: string[] = [];
      for (const skillPath of input.manifest.skills) {
        const evalFile = join(input.packRoot, skillPath, 'routing-eval.jsonl');
        if (!existsSync(evalFile)) {
          failures.push(`${skillPath}/routing-eval.jsonl missing`);
          continue;
        }
        const lines = readFileSync(evalFile, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
        if (lines.length < 5) {
          failures.push(`${skillPath}/routing-eval.jsonl has ${lines.length} intents (need >= 5)`);
        }
      }
      return failures.length === 0
        ? { passed: true, detail: `all skills have >= 5 routing intents`, fix_hint: null }
        : {
            passed: false,
            detail: failures.join('; '),
            fix_hint:
              'Add intents to skills/<slug>/routing-eval.jsonl — one JSON object per line with {intent, expected_skill, ambiguous_with?}. `gbrain skillpack doctor --fix` will scaffold stubs.',
          };
    },
  },
  {
    id: 4,
    name: 'skills_have_unique_triggers',
    category: 'core',
    description: 'no two skills in this pack share an exact trigger phrase (MECE)',
    auto_fixable: false,
    check: async (input) => {
      const triggerMap: Record<string, string[]> = {};
      for (const skillPath of input.manifest.skills) {
        const skillMd = join(input.packRoot, skillPath, 'SKILL.md');
        if (!existsSync(skillMd)) continue;
        try {
          const fm = parseMarkdown(readFileSync(skillMd, 'utf-8')).frontmatter as Record<string, unknown>;
          const triggers = Array.isArray(fm.triggers) ? (fm.triggers as unknown[]) : [];
          for (const t of triggers) {
            if (typeof t === 'string' && t.trim()) {
              const norm = t.trim().toLowerCase();
              if (!triggerMap[norm]) triggerMap[norm] = [];
              triggerMap[norm].push(skillPath);
            }
          }
        } catch {
          // Already surfaced by dimension 2.
        }
      }
      const conflicts = Object.entries(triggerMap).filter(([, skills]) => skills.length > 1);
      return conflicts.length === 0
        ? { passed: true, detail: 'all triggers unique', fix_hint: null }
        : {
            passed: false,
            detail: conflicts.map(([t, skills]) => `"${t}" claimed by: ${skills.join(', ')}`).join('; '),
            fix_hint:
              'Rephrase the conflicting trigger in one of the skills so each skill claims unique routing phrases. The MECE property is what makes agent routing deterministic.',
          };
    },
  },
  {
    id: 5,
    name: 'changelog_present_and_current',
    category: 'core',
    description: 'CHANGELOG.md present and contains an entry for the current version',
    auto_fixable: true,
    check: async (input) => {
      const path = join(input.packRoot, input.manifest.changelog ?? 'CHANGELOG.md');
      if (!existsSync(path)) {
        return {
          passed: false,
          detail: `CHANGELOG.md missing at ${relative(input.packRoot, path)}`,
          fix_hint:
            'Create CHANGELOG.md with at least a `## [<version>] - <YYYY-MM-DD>` entry for the current version. `gbrain skillpack doctor --fix` will scaffold a stub.',
        };
      }
      const content = readFileSync(path, 'utf-8');
      const versionEntryRe = new RegExp(`##\\s+\\[?${input.manifest.version.replace(/\./g, '\\.')}\\]?`);
      if (!versionEntryRe.test(content)) {
        return {
          passed: false,
          detail: `CHANGELOG.md has no entry matching ## [${input.manifest.version}]`,
          fix_hint: `Add a top-level entry: \`## [${input.manifest.version}] - ${new Date().toISOString().slice(0, 10)}\` followed by bullet-list notes.`,
        };
      }
      return { passed: true, detail: `CHANGELOG.md references ${input.manifest.version}`, fix_hint: null };
    },
  },

  // ============================================================
  // QUALITY BADGES (5 dimensions — earn for tier eligibility)
  // ============================================================
  {
    id: 6,
    name: 'unit_tests_present',
    category: 'badge',
    description: 'pack declares unit_tests[] with at least one matching test file',
    auto_fixable: true,
    check: async (input) => {
      if (!input.manifest.unit_tests || input.manifest.unit_tests.length === 0) {
        return {
          passed: false,
          detail: 'manifest.unit_tests not declared',
          fix_hint: 'Add `"unit_tests": ["test/**/*.test.ts"]` to skillpack.json and a passing test in test/.',
        };
      }
      const found = countGlobMatches(input.packRoot, input.manifest.unit_tests);
      return found > 0
        ? { passed: true, detail: `${found} unit test file(s) found`, fix_hint: null }
        : {
            passed: false,
            detail: 'unit_tests globs match zero files on disk',
            fix_hint: 'Create a test/<name>.test.ts (or matching glob) with at least one bun:test case.',
          };
    },
  },
  {
    id: 7,
    name: 'e2e_tests_present',
    category: 'badge',
    description: 'pack declares e2e_tests[] with at least one matching test file',
    auto_fixable: true,
    check: async (input) => {
      if (!input.manifest.e2e_tests || input.manifest.e2e_tests.length === 0) {
        return {
          passed: false,
          detail: 'manifest.e2e_tests not declared',
          fix_hint: 'Add `"e2e_tests": ["e2e/**/*.test.ts"]` and at least one integration test that exercises a full user journey.',
        };
      }
      const found = countGlobMatches(input.packRoot, input.manifest.e2e_tests);
      return found > 0
        ? { passed: true, detail: `${found} e2e test file(s) found`, fix_hint: null }
        : {
            passed: false,
            detail: 'e2e_tests globs match zero files on disk',
            fix_hint: 'Create an e2e/<name>.test.ts (or matching glob).',
          };
    },
  },
  {
    id: 8,
    name: 'llm_eval_present',
    category: 'badge',
    description: 'pack declares llm_evals[] with >= 1 file containing >= 3 cases',
    auto_fixable: true,
    check: async (input) => {
      if (!input.manifest.llm_evals || input.manifest.llm_evals.length === 0) {
        return {
          passed: false,
          detail: 'manifest.llm_evals not declared',
          fix_hint: 'Add `"llm_evals": ["evals/*.judge.json"]` and at least one *.judge.json with >= 3 cases.',
        };
      }
      const evalFiles = listGlobMatches(input.packRoot, input.manifest.llm_evals);
      if (evalFiles.length === 0) {
        return {
          passed: false,
          detail: 'llm_evals globs match zero files on disk',
          fix_hint: 'Create evals/<name>.judge.json with {task, output, cases:[...]} shape (cross-modal-eval format).',
        };
      }
      // Each eval must have >= 3 cases. Read and validate.
      for (const file of evalFiles) {
        try {
          const data = JSON.parse(readFileSync(file, 'utf-8'));
          const cases = (data as Record<string, unknown>).cases;
          if (Array.isArray(cases) && cases.length >= 3) {
            return {
              passed: true,
              detail: `${relative(input.packRoot, file)} has ${cases.length} cases`,
              fix_hint: null,
            };
          }
        } catch {
          // Try the next file.
        }
      }
      return {
        passed: false,
        detail: 'no llm_evals file has >= 3 cases',
        fix_hint: 'Each *.judge.json must have a "cases" array with >= 3 items. Stubs are flagged as theater.',
      };
    },
  },
  {
    id: 9,
    name: 'bootstrap_runbook_present',
    category: 'badge',
    description: 'pack declares runbooks.bootstrap and the file is non-empty',
    auto_fixable: true,
    check: async (input) => {
      const path = input.manifest.runbooks?.bootstrap;
      if (!path) {
        return {
          passed: false,
          detail: 'manifest.runbooks.bootstrap not declared',
          fix_hint: 'Add `"runbooks": {"bootstrap": "runbooks/bootstrap.md"}` and write the file with post-scaffold steps.',
        };
      }
      const abs = join(input.packRoot, path);
      if (!existsSync(abs)) {
        return {
          passed: false,
          detail: `${path} declared but file does not exist`,
          fix_hint: `Create ${path} with at least one bootstrap step. \`gbrain skillpack doctor --fix\` will scaffold a stub.`,
        };
      }
      const content = readFileSync(abs, 'utf-8').trim();
      if (content.length === 0) {
        return {
          passed: false,
          detail: `${path} is empty`,
          fix_hint: `Add at least one bootstrap step to ${path}. Three step kinds supported: "agent:" / "show user:" / "ask user:".`,
        };
      }
      return { passed: true, detail: `${path} has ${content.split('\n').length} lines`, fix_hint: null };
    },
  },
  {
    id: 10,
    name: 'license_present',
    category: 'badge',
    description: 'LICENSE file exists at the pack root (informational badge)',
    auto_fixable: true,
    check: async (input) => {
      const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];
      for (const c of candidates) {
        const path = join(input.packRoot, c);
        if (existsSync(path) && statSync(path).size > 0) {
          return { passed: true, detail: `${c} present`, fix_hint: null };
        }
      }
      return {
        passed: false,
        detail: 'no LICENSE / LICENSE.md / LICENSE.txt at pack root',
        fix_hint: `Create a LICENSE file matching the SPDX id you declared in skillpack.json (${input.manifest.license}).`,
      };
    },
  },
];

/** Minimal glob counter — supports double-star/file.ext and one-level patterns. */
function listGlobMatches(packRoot: string, globs: string[]): string[] {
  const matches = new Set<string>();
  for (const g of globs) {
    matches.forEach.bind(matches); // (silence unused warning for empty loop body)
    for (const found of walkGlob(packRoot, g)) {
      matches.add(found);
    }
  }
  return [...matches];
}

function countGlobMatches(packRoot: string, globs: string[]): number {
  return listGlobMatches(packRoot, globs).length;
}

function walkGlob(packRoot: string, glob: string): string[] {
  // Split into prefix (literal directory path) and pattern.
  const starIdx = glob.indexOf('*');
  const literalPart = starIdx === -1 ? glob : glob.slice(0, starIdx);
  const lastSlash = literalPart.lastIndexOf('/');
  const baseRel = lastSlash === -1 ? '' : literalPart.slice(0, lastSlash);
  const baseAbs = baseRel ? join(packRoot, baseRel) : packRoot;
  if (!existsSync(baseAbs)) return [];

  // Convert glob to regex.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '__DOUBLESTAR_SLASH__')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR_SLASH__/g, '(?:.+/)?')
    .replace(/__DOUBLESTAR__/g, '.+');
  const regex = new RegExp('^' + escaped + '$');

  const matches: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e.startsWith('.git')) continue;
      const full = join(dir, e);
      const rel = relative(packRoot, full);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && regex.test(rel)) matches.push(full);
    }
  };
  walk(baseAbs);
  return matches;
}

/** Walk every dimension in order, returning the full RubricScore. */
export async function walkRubric(input: RubricInput): Promise<RubricScore> {
  const dimensions: RubricDimensionResult[] = [];
  for (const def of DIMENSIONS) {
    const r = await def.check(input);
    dimensions.push({
      id: def.id,
      name: def.name,
      category: def.category,
      description: def.description,
      auto_fixable: def.auto_fixable,
      passed: r.passed,
      detail: r.detail,
      fix_hint: r.fix_hint,
    });
  }
  const core = dimensions.filter((d) => d.category === 'core');
  const badges = dimensions.filter((d) => d.category === 'badge');
  const corePassed = core.filter((d) => d.passed).length;
  const badgesPassed = badges.filter((d) => d.passed).length;
  const total = corePassed + badgesPassed;

  const allCorePassed = corePassed === core.length;
  let tier_eligibility: RubricScore['tier_eligibility'];
  if (!allCorePassed) tier_eligibility = 'blocked';
  else if (badgesPassed === badges.length) tier_eligibility = 'endorsed';
  else if (badgesPassed >= 3) tier_eligibility = 'community';
  else tier_eligibility = 'experimental';

  // Blockers = dimensions that need to pass to reach the next tier.
  const promotionBlockers: string[] = [];
  if (tier_eligibility === 'blocked') {
    promotionBlockers.push(...core.filter((d) => !d.passed).map((d) => d.name));
  } else if (tier_eligibility !== 'endorsed') {
    promotionBlockers.push(...badges.filter((d) => !d.passed).map((d) => d.name));
  }

  return {
    dimensions,
    total,
    core_passed: corePassed,
    badges_passed: badgesPassed,
    tier_eligibility,
    promotion_blockers: promotionBlockers,
  };
}

/** Pure-data export of the rubric for the anatomy doc generator. */
export function describeRubric(): Array<{
  id: number;
  name: string;
  category: RubricCategory;
  description: string;
  auto_fixable: boolean;
}> {
  return DIMENSIONS.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    description: d.description,
    auto_fixable: d.auto_fixable,
  }));
}

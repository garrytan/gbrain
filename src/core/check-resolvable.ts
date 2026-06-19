/**
 * check-resolvable.ts — Shared core function for resolver validation.
 *
 * Three call sites:
 * 1. `bun test` — unit tests import and assert on checkResolvable()
 * 2. `gbrain doctor` — runtime health check with actionable agent guidance
 * 3. skill-creator skill — mandatory post-creation validation gate
 *
 * @param skillsDir — the `skills/` directory (NOT repo root). Parser joins
 *   this path with manifest paths like `query/SKILL.md`.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { findResolverFile, findAllResolverFiles, RESOLVER_FILENAMES_LABEL } from './resolver-filenames.ts';
import { loadOrDeriveManifest } from './skill-manifest.ts';
import {
  indexResolverTriggers,
  lintRoutingFixtures,
  loadRoutingFixtures,
  runRoutingEval,
} from './routing-eval.ts';
import { runFilingAudit } from './filing-audit.ts';
import {
  entriesToResolverContent,
  findPrimaryResolverPath,
  loadSkillTriggerIndex,
} from './skill-trigger-index.ts';
import { parseSkillFrontmatter } from './skill-frontmatter.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvableFix {
  type: 'add_trigger' | 'remove_trigger' | 'add_frontmatter' | 'create_stub';
  file: string;
  section?: string;
  skill_path?: string;
}

export interface ResolvableIssue {
  type:
    | 'unreachable'
    | 'mece_overlap'
    | 'mece_gap'
    | 'dry_violation'
    | 'missing_file'
    | 'orphan_trigger'
    // Check 5 (W2): routing eval results surfaced as advisories.
    | 'routing_miss'
    | 'routing_ambiguous'
    | 'routing_false_positive'
    | 'routing_fixture_lint'
    // Check 6 (W3): brain-filing audit findings.
    | 'filing_missing_writes_to'
    | 'filing_unknown_directory'
    // D-CX-9: scaffolded skill still carries SKILLIFY_STUB sentinel.
    | 'skillify_stub_unreplaced';
  severity: 'error' | 'warning';
  skill: string;
  message: string;
  action: string;
  fix?: ResolvableFix;
}

export interface ResolvableReport {
  /**
   * True when there are no error-severity issues. Warnings do NOT flip `ok`.
   * Callers that want strict-mode (warnings fail CI too) should gate on
   * `errors.length === 0 && warnings.length === 0`.
   */
  ok: boolean;
  /**
   * Error-severity issues only. Determines `ok` and default exit codes.
   * A subset of `issues[]`.
   */
  errors: ResolvableIssue[];
  /**
   * Warning-severity issues. Informational by default; `--strict` promotes.
   * A subset of `issues[]`.
   */
  warnings: ResolvableIssue[];
  /**
   * @deprecated Use `errors` and `warnings` separately. Kept for one-release
   * backwards compatibility; will be removed in v0.18. Equivalent to
   * `[...errors, ...warnings]`.
   */
  issues: ResolvableIssue[];
  summary: {
    total_skills: number;
    reachable: number;
    unreachable: number;
    overlaps: number;
    gaps: number;
  };
}

export interface FixResult {
  issue: ResolvableIssue;
  applied: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Skills that intentionally overlap with many others (always-on, routers). */
const OVERLAP_WHITELIST = new Set([
  'ingest',           // router that delegates to idea-ingest, media-ingest, meeting-ingestion
  'signal-detector',  // always-on, fires on every message
  'brain-ops',        // always-on, every brain read/write
]);

export interface ResolverEntry {
  trigger: string;
  skillPath: string;       // e.g., 'skills/query/SKILL.md'
  isGStack: boolean;       // GStack: X entries (external, skip file check)
  section: string;         // e.g., 'Brain operations'
}

/**
 * Parse RESOLVER.md / AGENTS.md into structured entries. Supports two formats
 * that can mix in one file:
 *
 *   Format 1 (table) — original gbrain shape:
 *     | trigger phrase | `skills/<name>/SKILL.md` |
 *
 *   Format 2 (compact list, v0.41.7.0) — OpenClaw-native shape:
 *     - **skill-name**: trigger1 | trigger2 | trigger3
 *     - skill-name: trigger1 | trigger2
 *
 * List-format constraints (v0.41.7.0):
 *   - Skill name MUST be kebab-lowercase (`[a-z][a-z0-9-]+`). Bold names
 *     like `**Note**`, `**Convention**`, `**TODO**` are deliberately
 *     skipped so prose bullets in real-world AGENTS.md files don't get
 *     mis-parsed as skill rows.
 *   - `skillPath` is ALWAYS derived as `skills/<name>/SKILL.md`. An
 *     optional `→ \`skills/path\`` (or ASCII `->`) suffix is stripped from
 *     the trigger string but NOT honored as the path: downstream consumers
 *     (`routing-eval.ts:skillSlugFromPath`, the manifest lookup at this
 *     file's :367) both assume the convention. For non-conventional paths,
 *     use the table format.
 *   - Multiple triggers fan out to one entry per trigger, all sharing the
 *     same `skillPath`. `checkResolvable` dedupes by `skillPath` downstream,
 *     so the integration reachability count counts each skill once.
 */
export function parseResolverEntries(resolverContent: string): ResolverEntry[] {
  const entries: ResolverEntry[] = [];
  let currentSection = '';

  for (const line of resolverContent.split('\n')) {
    // Track section headings
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      continue;
    }

    // ── Format 1: Markdown table rows ──
    if (line.startsWith('|') && !line.includes('---')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 2) continue;

      const trigger = cols[0];
      const skillCol = cols[1];

      // Skip header rows
      if (trigger.toLowerCase() === 'trigger' || trigger.toLowerCase() === 'skill') continue;

      // GStack / external references (Check `ACCESS_POLICY.md`, Read X, GStack: Y)
      if (skillCol.startsWith('GStack:') || skillCol.startsWith('Check ') || skillCol.startsWith('Read ')) {
        entries.push({ trigger, skillPath: skillCol, isGStack: true, section: currentSection });
        continue;
      }

      // Backtick-wrapped skill path
      const pathMatch = skillCol.match(/`(skills\/[^`]+\/SKILL\.md)`/);
      if (pathMatch) {
        entries.push({ trigger, skillPath: pathMatch[1], isGStack: false, section: currentSection });
      }
      continue;
    }

    // ── Format 2: Compact list rows (v0.41.7.0) ──
    // Bold form preferred: `- **skill-name**: trigger1 | trigger2`
    // Plain fallback:     `- skill-name: trigger1 | trigger2`
    // Name regex is kebab-lowercase only so prose bullets like `- **Note**: …`
    // don't false-match as skill rows (codex F2 / D4).
    const listBold = line.match(/^-\s+\*\*([a-z][a-z0-9-]+)\*\*\s*:\s*(.+)$/);
    const listPlain = listBold ? null : line.match(/^-\s+([a-z][a-z0-9-]+)\s*:\s*(.+)$/);
    const listMatch = listBold ?? listPlain;
    if (listMatch) {
      const skillName = listMatch[1];
      const triggersRaw = listMatch[2].trim();
      // Strip optional explicit path suffix (D3: stripped, NOT captured).
      // Both Unicode → and ASCII -> accepted; skillPath is always derived.
      const cleaned = triggersRaw.replace(/\s*(?:→|->)\s*`skills\/[^`]+`\s*$/, '');
      // Split on |, drop empty pieces and the literal `...` placeholder.
      const triggers = cleaned
        .split('|')
        .map(t => t.trim())
        .filter(t => t.length > 0 && t !== '...');
      const skillPath = `skills/${skillName}/SKILL.md`;
      // Multiple entries share skillPath; checkResolvable dedupes downstream.
      for (const trigger of triggers) {
        entries.push({ trigger, skillPath, isGStack: false, section: currentSection });
      }
    }
  }

  return entries;
}

// Manifest loading is now delegated to src/core/skill-manifest.ts
// (loadOrDeriveManifest). That module auto-derives from walking
// `skillsDir/*/SKILL.md` when manifest.json is missing — the scenario
// needed for AGENTS.md-only OpenClaw deployments. See D-CX-12 / F-ENG-1.

/** Simple YAML frontmatter parser — extracts triggers array if present. */
function extractTriggers(skillContent: string): string[] {
  return parseSkillFrontmatter(skillContent)?.triggers ?? [];
}

/**
 * Scan for inlined cross-cutting rules that should reference convention
 * files. Each pattern can list multiple valid delegation targets — e.g.,
 * notability rules live in both `conventions/quality.md` and
 * `_brain-filing-rules.md`, and referencing either counts as delegation.
 */
export interface CrossCuttingPattern {
  pattern: RegExp;
  conventions: string[];
  label: string;
}

export const CROSS_CUTTING_PATTERNS: CrossCuttingPattern[] = [
  { pattern: /iron\s*law.*back-?link/i,
    conventions: ['conventions/quality.md'],
    label: 'Iron Law back-linking' },
  { pattern: /citation.*format.*\[Source:/i,
    conventions: ['conventions/quality.md'],
    label: 'citation format rules' },
  { pattern: /notability.*gate/i,
    conventions: ['conventions/quality.md', '_brain-filing-rules.md'],
    label: 'notability gate' },
];

/** Proximity window (lines) within which a delegation reference suppresses
 *  a DRY match. Typical skill section is 20-30 lines; 40 covers header +
 *  section without leaking across document-length files. */
export const DRY_PROXIMITY_LINES = 40;

export interface DelegationRef {
  convention: string; // normalized relative path, e.g., 'conventions/quality.md'
  line: number;       // 1-indexed line number of the reference
}

/**
 * Extract delegation references from skill content. Recognizes three shapes:
 *   1. `> **Convention:** ... \`skills/<path>\` ...`
 *   2. `> **Filing rule:** ... \`skills/<path>\` ...`
 *   3. Inline backtick `\`skills/conventions/*.md\`` or
 *      `\`skills/_brain-filing-rules.md\``
 *
 * Paths are normalized by stripping the leading `skills/` so they match the
 * `conventions` field of CROSS_CUTTING_PATTERNS.
 */
export function extractDelegationTargets(content: string): DelegationRef[] {
  const refs: DelegationRef[] = [];
  const lines = content.split('\n');
  // Match backtick-wrapped skills/ paths that point at a known delegation
  // target. Scoped to conventions/ subtree and _brain-filing-rules.md.
  const pathRe = /`skills\/((?:conventions\/[^`]+\.md)|(?:_brain-filing-rules\.md))`/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    pathRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pathRe.exec(line)) !== null) {
      refs.push({ convention: m[1], line: i + 1 });
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Validate that all skills are reachable from RESOLVER.md, detect MECE
 * violations, and check for DRY issues.
 *
 * @param skillsDir — path to the `skills/` directory
 */
export function checkResolvable(skillsDir: string): ResolvableReport {
  const issues: ResolvableIssue[] = [];

  // Load inputs via the v0.41.11 shared primitive. UNION semantics
  // across two surfaces:
  //   1. Per-skill SKILL.md frontmatter `triggers:` (canonical) — every
  //      skill ships its own triggers; new skills don't need a
  //      RESOLVER.md row to be reachable.
  //   2. Curated RESOLVER.md / AGENTS.md rows from skillsDir AND parent
  //      directory (D-CX-14 OpenClaw workspace-root layout preserved).
  //
  // Frontmatter is the source of truth (closes the #1451 drift class);
  // RESOLVER.md rows still contribute additively so the human-readable
  // dispatcher map stays load-bearing. See src/core/skill-trigger-index.ts.
  const triggerEntries = loadSkillTriggerIndex(skillsDir);

  // Primary RESOLVER.md path is still needed for error messages and
  // --fix targets that have to point at a concrete file. When neither
  // RESOLVER.md nor AGENTS.md exists but frontmatter triggers DO
  // populate the index, fall back to a suggested path so `fix:` blocks
  // still have a concrete target (auto-fix paths that touch RESOLVER.md
  // will create it on first write).
  const resolverPathOrNull = findPrimaryResolverPath(skillsDir);
  const resolverPath = resolverPathOrNull ?? join(skillsDir, 'RESOLVER.md');
  if (!resolverPathOrNull && triggerEntries.length === 0) {
    // No RESOLVER.md / AGENTS.md anywhere AND no skill ships frontmatter
    // triggers — the resolver tree is fully empty. Preserve the
    // original 'missing_file' error semantics so doctor's UX doesn't
    // regress for genuinely-uninitialized skills directories.
    const suggested = join(skillsDir, 'RESOLVER.md');
    const missingIssue: ResolvableIssue = {
      type: 'missing_file',
      severity: 'error',
      skill: RESOLVER_FILENAMES_LABEL,
      message: `${RESOLVER_FILENAMES_LABEL} not found in ${skillsDir} or its parent (and no SKILL.md frontmatter declares triggers:)`,
      action: `Create ${suggested} with skill routing tables, or add 'triggers:' to each SKILL.md frontmatter`,
      fix: { type: 'create_stub', file: suggested },
    };
    return {
      ok: false,
      errors: [missingIssue],
      warnings: [],
      issues: [missingIssue],
      summary: { total_skills: 0, reachable: 0, unreachable: 0, overlaps: 0, gaps: 0 },
    };
  }

  // Project to ResolverEntry[] shape that downstream code already
  // consumes (source field is only needed for action-text routing).
  const entries: ResolverEntry[] = triggerEntries;

  // Build a synthesized resolver-content string for the routing-eval
  // and lint stages that still take string content. Re-emits both
  // frontmatter-derived AND RESOLVER.md-derived entries as one table.
  const resolverContent = entriesToResolverContent(triggerEntries);
  const { skills: manifest } = loadOrDeriveManifest(skillsDir);

  // Build lookup sets
  const resolverSkillPaths = new Set(
    entries.filter(e => !e.isGStack).map(e => e.skillPath)
  );

  // 1. Check every manifest skill is reachable from RESOLVER.md
  let reachable = 0;
  let unreachable = 0;

  for (const skill of manifest) {
    const expectedPath = `skills/${skill.path}`;
    if (resolverSkillPaths.has(expectedPath)) {
      reachable++;
    } else {
      // Also check if the skill name appears in any resolver entry
      const nameInResolver = entries.some(
        e => e.skillPath.includes(skill.name) || e.trigger.includes(skill.name)
      );
      if (nameInResolver) {
        reachable++;
      } else {
        unreachable++;
        // Find the best section for this skill based on its description
        const section = 'Brain operations'; // default suggestion
        issues.push({
          type: 'unreachable',
          severity: 'error',
          skill: skill.name,
          message: `Skill '${skill.name}' is in manifest but has no trigger row in ${RESOLVER_FILENAMES_LABEL}`,
          action: `Add a trigger row for 'skills/${skill.path}' in RESOLVER.md under ${section}`,
          fix: {
            type: 'add_trigger',
            file: resolverPath,
            section,
            skill_path: `skills/${skill.path}`,
          },
        });
      }
    }
  }

  // 2. Check every resolver entry points to a file that exists
  for (const entry of entries) {
    if (entry.isGStack) continue;

    // Resolver uses 'skills/query/SKILL.md', manifest uses 'query/SKILL.md'
    // The file on disk is at skillsDir + 'query/SKILL.md'
    const relPath = entry.skillPath.replace(/^skills\//, '');
    const fullPath = join(skillsDir, relPath);

    if (!existsSync(fullPath)) {
      issues.push({
        type: 'missing_file',
        severity: 'error',
        skill: entry.skillPath,
        message: `RESOLVER.md references '${entry.skillPath}' but the file doesn't exist`,
        action: `Create the skill at '${fullPath}' or remove the resolver entry`,
        fix: { type: 'create_stub', file: fullPath },
      });
    }

    // Check if in manifest
    const skillName = relPath.replace(/\/SKILL\.md$/, '');
    const inManifest = manifest.some(s => s.name === skillName);
    if (!inManifest && existsSync(fullPath)) {
      issues.push({
        type: 'orphan_trigger',
        severity: 'warning',
        skill: skillName,
        message: `RESOLVER.md has a trigger for '${skillName}' which is not in manifest.json`,
        action: `Register '${skillName}' in skills/manifest.json or remove from RESOLVER.md`,
        fix: { type: 'remove_trigger', file: resolverPath, skill_path: entry.skillPath },
      });
    }
  }

  // 3. MECE overlap detection
  let overlaps = 0;
  // Build trigger→skill map from SKILL.md frontmatter triggers
  const triggerMap = new Map<string, string[]>();
  for (const skill of manifest) {
    const skillPath = join(skillsDir, skill.path);
    if (!existsSync(skillPath)) continue;
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const triggers = extractTriggers(content);
      for (const t of triggers) {
        const normalized = t.toLowerCase().trim();
        if (!triggerMap.has(normalized)) triggerMap.set(normalized, []);
        triggerMap.get(normalized)!.push(skill.name);
      }
    } catch {
      // Skip unreadable files
    }
  }

  for (const [trigger, skills] of triggerMap) {
    if (skills.length <= 1) continue;
    // Filter out whitelisted skills
    const nonWhitelisted = skills.filter(s => !OVERLAP_WHITELIST.has(s));
    if (nonWhitelisted.length <= 1) continue;
    overlaps++;
    issues.push({
      type: 'mece_overlap',
      severity: 'warning',
      skill: nonWhitelisted.join(', '),
      message: `Trigger '${trigger}' matches multiple skills: ${nonWhitelisted.join(', ')}`,
      action: `Add disambiguation rule in RESOLVER.md or narrow triggers in one skill's frontmatter`,
    });
  }

  // 4. Gap detection — skills with no triggers in frontmatter
  let gaps = 0;
  for (const skill of manifest) {
    if (OVERLAP_WHITELIST.has(skill.name)) continue; // always-on don't need triggers
    const skillPath = join(skillsDir, skill.path);
    if (!existsSync(skillPath)) continue;
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const triggers = extractTriggers(content);
      if (triggers.length === 0) {
        gaps++;
        issues.push({
          type: 'mece_gap',
          severity: 'warning',
          skill: skill.name,
          message: `Skill '${skill.name}' has no triggers: field in its SKILL.md frontmatter`,
          action: `Add a triggers: array to the frontmatter of skills/${skill.path}`,
          fix: {
            type: 'add_frontmatter',
            file: skillPath,
            skill_path: `skills/${skill.path}`,
          },
        });
      }
    } catch {
      // Skip unreadable
    }
  }

  // 5. DRY detection — inlined cross-cutting rules.
  // A match is suppressed when the skill references one of the pattern's
  // accepted convention files within DRY_PROXIMITY_LINES lines of the match.
  // This catches the common case where a skill delegates at a section
  // header but still contains prose mentioning the rule by name.
  for (const skill of manifest) {
    const skillPath = join(skillsDir, skill.path);
    if (!existsSync(skillPath)) continue;
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const delegations = extractDelegationTargets(content);
      for (const { pattern, conventions, label } of CROSS_CUTTING_PATTERNS) {
        const globalRe = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
        const matches = [...content.matchAll(globalRe)];
        for (const m of matches) {
          const matchLine = content.slice(0, m.index ?? 0).split('\n').length;
          const suppressed = delegations.some(
            d => conventions.includes(d.convention) && Math.abs(d.line - matchLine) <= DRY_PROXIMITY_LINES
          );
          if (suppressed) continue;
          issues.push({
            type: 'dry_violation',
            severity: 'warning',
            skill: skill.name,
            message: `Skill '${skill.name}' inlines ${label} instead of delegating to a convention file`,
            action: `Replace inlined rules with a reference to one of: ${conventions.join(', ')}`,
          });
          break; // one issue per pattern per skill
        }
      }
    } catch {
      // Skip unreadable
    }
  }

  // Check 5 (W2, v0.17): structural routing eval. Surfaces as warnings
  // only — routing issues are advisory. Agents running under --strict
  // will fail on them; default runs see them as informational.
  const loaded = loadRoutingFixtures(skillsDir);
  if (loaded.fixtures.length > 0) {
    const triggerIndex = indexResolverTriggers(resolverContent);
    const lintIssues = lintRoutingFixtures(loaded.fixtures, triggerIndex);
    for (const lint of lintIssues) {
      issues.push({
        type: 'routing_fixture_lint',
        severity: 'warning',
        skill: lint.fixture.expected_skill ?? 'unknown',
        message: `Routing fixture lint (${lint.reason}): "${lint.fixture.intent}"`,
        action: `Edit skills/<skill>/routing-eval.jsonl to fix: ${lint.detail}`,
      });
    }
    const routingReport = runRoutingEval(resolverContent, loaded.fixtures);
    for (const d of routingReport.details) {
      if (d.outcome === 'pass') continue;
      const kind =
        d.outcome === 'missed'
          ? 'routing_miss'
          : d.outcome === 'ambiguous'
            ? 'routing_ambiguous'
            : 'routing_false_positive';
      const skillName = d.fixture.expected_skill ?? 'negative-case';
      // v0.41.11: triggers live in SKILL.md frontmatter (canonical) AND
      // RESOLVER.md rows. Point the agent at the canonical surface
      // first; the dispatcher map is the secondary edit point.
      const editTarget = d.fixture.expected_skill
        ? `skills/${d.fixture.expected_skill}/SKILL.md frontmatter triggers: (canonical) or skills/RESOLVER.md row (dispatcher map)`
        : `the relevant skill's SKILL.md frontmatter triggers:`;
      issues.push({
        type: kind,
        severity: 'warning',
        skill: skillName,
        message: `Routing ${d.outcome} for intent "${d.fixture.intent}"`,
        action: `Update routing-eval.jsonl fixture or broaden ${editTarget} (${d.note ?? 'no additional detail'})`,
      });
    }
  }
  for (const m of loaded.malformed) {
    issues.push({
      type: 'routing_fixture_lint',
      severity: 'warning',
      skill: 'routing-eval',
      message: `Malformed routing fixture ${m.file}:${m.line}`,
      action: `Fix the JSONL in routing-eval.jsonl at line ${m.line}: ${m.error}`,
    });
  }

  // D-CX-9 SKILLIFY_STUB sentinel check: scan every SKILL.md + script
  // file under skillsDir for the sentinel marker emitted by
  // `gbrain skillify scaffold`. Presence means a scaffolded skill
  // shipped without a real implementation — warning-severity in
  // default mode, error-promoted under --strict via D-CX-3.
  for (const skill of manifest) {
    const skillDir = join(skillsDir, skill.path.replace(/\/SKILL\.md$/, ''));
    const scriptDir = join(skillDir, 'scripts');
    const candidates: string[] = [join(skillsDir, skill.path)];
    if (existsSync(scriptDir)) {
      try {
        for (const f of readdirSync(scriptDir)) {
          if (f.match(/\.(ts|mjs|js|py)$/)) candidates.push(join(scriptDir, f));
        }
      } catch {
        // Skip unreadable script dir.
      }
    }
    for (const candidate of candidates) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        if (content.includes('SKILLIFY_STUB: replace before running check-resolvable --strict')) {
          issues.push({
            type: 'skillify_stub_unreplaced',
            severity: 'warning',
            skill: skill.name,
            message: `Skill '${skill.name}' still contains the SKILLIFY_STUB sentinel in ${relative(skillsDir, candidate)}`,
            action: `Replace the SKILLIFY_STUB sentinel in ${candidate} with a real implementation or remove the file. D-CX-9 gate.`,
          });
          break; // one issue per skill
        }
      } catch {
        // Skip unreadable file.
      }
    }
  }

  // Check 6 (W3, v0.17): brain-filing audit. Warning-only per
  // D-CX-3 + D-CX-5 — does not break CI for workspaces that haven't
  // adopted writes_pages:/writes_to: yet. Any errors in the rules
  // doc itself surface as a single fatal-ish entry.
  try {
    const filingReport = runFilingAudit(skillsDir);
    for (const issue of filingReport.issues) {
      issues.push(issue);
    }
  } catch (err) {
    issues.push({
      type: 'filing_unknown_directory',
      severity: 'warning',
      skill: 'brain-filing-rules',
      message: `_brain-filing-rules.json failed to load`,
      action: `Fix skills/_brain-filing-rules.json: ${(err as Error).message}`,
    });
  }

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    issues,
    summary: {
      total_skills: manifest.length,
      reachable,
      unreachable,
      overlaps,
      gaps,
    },
  };
}

// Re-export auto-fix so callers have one canonical entry point.
export { autoFixDryViolations } from './dry-fix.ts';
export type { AutoFixOptions, AutoFixReport, FixOutcome } from './dry-fix.ts';

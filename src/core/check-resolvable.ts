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
  type: 'unreachable' | 'mece_overlap' | 'mece_gap' | 'dry_violation' | 'missing_file' | 'orphan_trigger';
  severity: 'error' | 'warning';
  skill: string;
  message: string;
  action: string;
  fix?: ResolvableFix;
}

export interface ResolvableReport {
  ok: boolean;
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

interface ResolverEntry {
  trigger: string;
  skillPath: string;       // e.g., 'skills/query/SKILL.md'
  isGStack: boolean;       // GStack: X entries (external, skip file check)
  section: string;         // e.g., 'Brain operations'
}

/** Parse RESOLVER.md markdown tables into structured entries. */
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

    // Skip non-table rows
    if (!line.startsWith('|') || line.includes('---')) continue;

    // Split table columns
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;

    const trigger = cols[0];
    const skillCol = cols[1];

    // Skip header rows
    if (trigger.toLowerCase() === 'trigger' || trigger.toLowerCase() === 'skill') continue;

    // Check for GStack entries
    if (skillCol.startsWith('GStack:') || skillCol.startsWith('Check ') || skillCol.startsWith('Read ')) {
      entries.push({ trigger, skillPath: skillCol, isGStack: true, section: currentSection });
      continue;
    }

    // Extract skill path from backtick-wrapped references
    const pathMatch = skillCol.match(/`(skills\/[^`]+\/SKILL\.md)`/);
    if (pathMatch) {
      entries.push({ trigger, skillPath: pathMatch[1], isGStack: false, section: currentSection });
    }
  }

  return entries;
}

/** Extract skill names from manifest.json */
function loadManifest(skillsDir: string): Array<{ name: string; path: string }> {
  const manifestPath = join(skillsDir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  try {
    const content = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return content.skills || [];
  } catch {
    return [];
  }
}

/** Simple YAML frontmatter parser — extracts triggers array if present. */
function extractTriggers(skillContent: string): string[] {
  const fmMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const triggersMatch = fm.match(/^triggers:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (!triggersMatch) return [];
  return triggersMatch[1]
    .split('\n')
    .map(l => l.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
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

  // Load inputs
  const resolverPath = join(skillsDir, 'RESOLVER.md');
  if (!existsSync(resolverPath)) {
    return {
      ok: false,
      issues: [{
        type: 'missing_file',
        severity: 'error',
        skill: 'RESOLVER.md',
        message: 'RESOLVER.md not found',
        action: `Create ${resolverPath} with skill routing tables`,
        fix: { type: 'create_stub', file: resolverPath },
      }],
      summary: { total_skills: 0, reachable: 0, unreachable: 0, overlaps: 0, gaps: 0 },
    };
  }

  const resolverContent = readFileSync(resolverPath, 'utf-8');
  const entries = parseResolverEntries(resolverContent);
  const manifest = loadManifest(skillsDir);

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
          message: `Skill '${skill.name}' is in manifest but has no trigger row in RESOLVER.md`,
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

  return {
    ok: issues.filter(i => i.severity === 'error').length === 0,
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

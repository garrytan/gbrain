/**
 * filing-audit.ts — Check 6 of the skillify checklist (W3).
 *
 * For every skill that writes brain pages (`writes_pages: true`),
 * verify that:
 *   1. The skill declares a non-empty `writes_to: [dir, ...]` frontmatter.
 *   2. Each directory in `writes_to:` is a valid filing target per
 *      `skills/_brain-filing-rules.json`. `sources/` is explicitly
 *      allowed (bulk data capture is a legitimate filing target).
 *
 * Important distinction: `writes_pages: true` is distinct from the
 * pre-existing `mutating: true` field. `mutating:true` means "has
 * side effects" (any side effect — cron, config, report write).
 * `writes_pages:true` means "writes brain pages to a semantic
 * directory." Cron/config/report-writer skills set `mutating:true`
 * but NOT `writes_pages:true`, and so are correctly exempted from
 * filing-audit noise.
 *
 * Current scope: declaration-level audit only (cheap, deterministic).
 * A future release may add `filing-audit --pages` to walk brain pages
 * and infer primary subject via LLM (catches real misfilings vs
 * declarations); that is tracked as follow-up work, not in this scope.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseSkillFrontmatter } from './skill-frontmatter.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilingRule {
  kind: string;
  directory: string;
  examples?: string[];
  description?: string;
}

export interface FilingRulesDoc {
  version: string;
  companion?: string;
  description?: string;
  rules: FilingRule[];
  sources_dir?: {
    directory: string;
    purpose: string;
    not_for?: string[];
  };
  notes?: string[];
}

export interface FilingIssue {
  type: 'filing_missing_writes_to' | 'filing_unknown_directory';
  severity: 'warning';
  skill: string;
  directory?: string;
  message: string;
  action: string;
}

export interface FilingReport {
  totalScanned: number;
  writesPagesSkills: number;
  issues: FilingIssue[];
}

// ---------------------------------------------------------------------------
// Rules loader
// ---------------------------------------------------------------------------

/**
 * Load canonical filing rules from `skillsDir/_brain-filing-rules.json`.
 * Returns null if the file is missing — filing-audit is a no-op until
 * the rules doc is in place. Throws on malformed JSON so the caller
 * surfaces a loud "rules doc is broken" signal instead of silently
 * degrading.
 */
export function loadFilingRules(skillsDir: string): FilingRulesDoc | null {
  const path = join(skillsDir, '_brain-filing-rules.json');
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('_brain-filing-rules.json: top-level must be an object');
  }
  if (!Array.isArray(parsed.rules)) {
    throw new Error('_brain-filing-rules.json: "rules" must be an array');
  }
  return parsed as FilingRulesDoc;
}

/**
 * Return the canonical set of directories a skill is allowed to list in
 * `writes_to:`. Includes every rule's directory plus the special
 * `sources_dir` entry.
 */
export function allowedDirectories(rules: FilingRulesDoc): Set<string> {
  const set = new Set<string>();
  for (const r of rules.rules) set.add(normalizeDir(r.directory));
  if (rules.sources_dir?.directory) set.add(normalizeDir(rules.sources_dir.directory));
  return set;
}

function normalizeDir(dir: string): string {
  // Accept `people`, `people/`, `/people`, `/people/` — normalize to
  // `people/` so comparisons are consistent.
  const trimmed = dir.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? `${trimmed}/` : '';
}

// ---------------------------------------------------------------------------
// Skill frontmatter parsing (minimal, tolerant)
// ---------------------------------------------------------------------------

/**
 * Public surface preserved for back-compat: SkillFrontmatter remains a
 * narrow alias here, but the underlying parser now lives in
 * `skill-frontmatter.ts` (`parseSkillFrontmatter`). The wider
 * `ParsedFrontmatter` type from that module is structurally compatible
 * with this narrower one — every field on SkillFrontmatter is optional
 * and present on ParsedFrontmatter.
 *
 * If you're writing new code, import `parseSkillFrontmatter` and
 * `ParsedFrontmatter` from `./skill-frontmatter.ts` directly. This
 * thin wrapper exists so existing filing-audit callers don't need to
 * be touched.
 */
export interface SkillFrontmatter {
  name?: string;
  writes_pages?: boolean;
  writes_to?: string[];
  mutating?: boolean;
  raw: string;
}

function parseFrontmatter(skillMdPath: string): SkillFrontmatter | null {
  let content: string;
  try {
    content = readFileSync(skillMdPath, 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseSkillFrontmatter(content);
  if (!parsed) return null;
  // Project the wider ParsedFrontmatter onto the narrower SkillFrontmatter
  // shape filing-audit callers expect. Field order matches the original
  // shape so tests that compare object keys via JSON.stringify stay stable.
  return {
    raw: parsed.raw,
    name: parsed.name,
    writes_pages: parsed.writes_pages,
    writes_to: parsed.writes_to,
    mutating: parsed.mutating,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Scan every skill under `skillsDir`. For skills with
 * `writes_pages: true`:
 *   - Missing `writes_to:` → warning.
 *   - Any dir in `writes_to:` not in allowedDirectories → warning.
 *
 * Skills without `writes_pages:` (or with `writes_pages: false`) are
 * skipped — regardless of `mutating:` value. This is deliberate
 * (D-CX-7): filing-audit targets brain-page writers, not arbitrary
 * side effects.
 */
export function runFilingAudit(skillsDir: string): FilingReport {
  const issues: FilingIssue[] = [];
  const rules = loadFilingRules(skillsDir);
  if (!rules) {
    return { totalScanned: 0, writesPagesSkills: 0, issues };
  }
  const allowed = allowedDirectories(rules);

  let totalScanned = 0;
  let writesPagesSkills = 0;

  if (!existsSync(skillsDir)) {
    return { totalScanned, writesPagesSkills, issues };
  }
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return { totalScanned, writesPagesSkills, issues };
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue;
    const dir = join(skillsDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    totalScanned++;

    const fm = parseFrontmatter(skillMd);
    if (!fm) continue;
    if (fm.writes_pages !== true) continue;
    writesPagesSkills++;

    const skillName = fm.name ?? entry;

    if (!fm.writes_to || fm.writes_to.length === 0) {
      issues.push({
        type: 'filing_missing_writes_to',
        severity: 'warning',
        skill: skillName,
        message: `Skill '${skillName}' has writes_pages: true but no writes_to: list`,
        action: `Add a writes_to: [dir, ...] list to skills/${entry}/SKILL.md frontmatter (see skills/_brain-filing-rules.json for valid directories)`,
      });
      continue;
    }

    for (const rawDir of fm.writes_to) {
      const normalized = normalizeDir(rawDir);
      if (!allowed.has(normalized)) {
        issues.push({
          type: 'filing_unknown_directory',
          severity: 'warning',
          skill: skillName,
          directory: rawDir,
          message: `Skill '${skillName}' declares writes_to: '${rawDir}' which is not listed in _brain-filing-rules.json`,
          action: `Fix the writes_to: entry in skills/${entry}/SKILL.md or add '${normalized}' to skills/_brain-filing-rules.json rules[]`,
        });
      }
    }
  }

  return { totalScanned, writesPagesSkills, issues };
}

/**
 * filing-audit.ts — Check 6 of the skillify checklist (W3, v0.17).
 *
 * For every skill that writes brain pages (`writes_pages: true`),
 * verify that:
 *   1. The skill declares a non-empty `writes_to: [dir, ...]` frontmatter.
 *   2. Each directory in `writes_to:` is a valid filing target per
 *      `skills/_brain-filing-rules.json`. `sources/` is explicitly
 *      allowed (bulk data capture is a legitimate filing target).
 *
 * Important distinction (D-CX-7): `writes_pages: true` is distinct
 * from the pre-existing `mutating: true` field. `mutating:true` means
 * "has side effects" (any side effect — cron, config, report write).
 * `writes_pages:true` means "writes brain pages to a semantic
 * directory." Cron/config/report-writer skills set `mutating:true`
 * but NOT `writes_pages:true`, and so are correctly exempted from
 * filing-audit noise.
 *
 * v0.17 scope: declaration-level audit only (cheap, deterministic).
 * v0.18 plan: `filing-audit --pages` walks brain pages and infers
 * primary subject via LLM to catch real misfilings vs declarations
 * (D-CX-13).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const raw = fmMatch[1];
  const out: SkillFrontmatter = { raw };

  const nameMatch = raw.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  if (nameMatch) out.name = nameMatch[1].trim();

  const wpMatch = raw.match(/^writes_pages:\s*(true|false)\s*$/m);
  if (wpMatch) out.writes_pages = wpMatch[1] === 'true';

  const mutMatch = raw.match(/^mutating:\s*(true|false)\s*$/m);
  if (mutMatch) out.mutating = mutMatch[1] === 'true';

  // writes_to: supports inline `[a, b, c]` OR multi-line block list
  //   writes_to:
  //     - people/
  //     - companies/
  // AND inline `writes_to: [people/, companies/]`
  const inlineWtMatch = raw.match(/^writes_to:\s*\[([^\]]*)\]\s*$/m);
  if (inlineWtMatch) {
    out.writes_to = inlineWtMatch[1]
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  } else {
    const blockMatch = raw.match(/^writes_to:\s*\n((?:\s+-\s+[^\n]+\n?)+)/m);
    if (blockMatch) {
      out.writes_to = blockMatch[1]
        .split('\n')
        .map(l => l.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
    }
  }
  return out;
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

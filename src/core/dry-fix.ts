/**
 * dry-fix.ts — Auto-repair DRY violations surfaced by checkResolvable().
 *
 * Called by `gbrain doctor --fix`. Scans every skill in the manifest, locates
 * matches of CROSS_CUTTING_PATTERNS, expands each match to its block
 * boundary, and replaces the block with a `> **Convention:** ...` reference
 * line. Writes are guarded:
 *   - working-tree-dirty  → skip (preserves git-as-backup contract)
 *   - inside code fence   → skip (don't mangle example prose)
 *   - already delegated   → skip (idempotent re-runs)
 *   - multi-match         → skip (ambiguous; manual edit required)
 *
 * Dry-run mode returns proposed edits without writing to disk.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  CROSS_CUTTING_PATTERNS,
  DRY_PROXIMITY_LINES,
  extractDelegationTargets,
  type CrossCuttingPattern,
} from './check-resolvable.ts';
import { loadOrDeriveManifest } from './skill-manifest.ts';
import {
  getWorkingTreeStatus as _getWorkingTreeStatus,
  isInsideCodeFence as _isInsideCodeFence,
  isWorkingTreeDirty as _isWorkingTreeDirty,
  type WorkingTreeStatus as _WorkingTreeStatus,
} from './skill-fix-gates.ts';
import { parseSkillFrontmatter } from './skill-frontmatter.ts';
import {
  analyzeSkillBrainFirst,
  CONVENTION_CALLOUT_RE,
} from './skill-brain-first.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutoFixOptions {
  dryRun?: boolean;
}

export type FixStatus = 'applied' | 'proposed' | 'skipped' | 'error';

export type SkipReason =
  | 'working_tree_dirty'
  | 'no_git_backup'
  | 'inside_code_fence'
  | 'already_delegated'
  | 'ambiguous_multiple_matches'
  | 'block_is_callout'
  | 'file_missing'
  | 'read_error'
  | 'write_error';

export interface FixOutcome {
  skill: string;
  skillPath: string;   // absolute
  patternLabel: string;
  status: FixStatus;
  reason?: SkipReason | string;
  before?: string;     // snippet (the expanded block)
  after?: string;      // replacement line
}

export interface AutoFixReport {
  fixed: FixOutcome[];     // applied writes (or proposals in dryRun)
  skipped: FixOutcome[];   // skips and errors
}

// ---------------------------------------------------------------------------
// MISSING_RULE pattern type — v0.36.x INSERT-new-callout flow (T2 + T4)
// ---------------------------------------------------------------------------

/**
 * INSERT-missing-rule pattern type. Sibling of `CrossCuttingPattern` but
 * with INSERT semantics instead of REPLACE:
 *   - `detect`        decides whether THIS skill is missing the rule.
 *   - `callout`       is the literal Convention-callout line to insert.
 *   - `idempotentCheck` decides whether the rule is ALREADY present
 *                     (so we don't double-insert on re-runs).
 *
 * Insertion site: `findInsertionLine(content)` (after frontmatter close
 * `---`, after first H1 paragraph if present, before first H2). The
 * shared safety gates (working-tree, code-fence, install-path) apply
 * exactly the same way as for REPLACE patterns.
 */
export interface MissingRulePattern {
  /** Stable label for reporting (e.g. 'brain-first compliance'). */
  label: string;
  /** Return true when the rule is MISSING for this skill (needs insert). */
  detect: (content: string, skillName: string) => boolean;
  /** Return true when this skill already declares the rule (skip insert). */
  idempotentCheck: (content: string) => boolean;
  /** The literal callout line to insert. */
  callout: string;
}

/**
 * v0.36.x missing-rule patterns. Currently one entry — the brain-first
 * Convention callout, motivated by the 2026-05-19 tweet-shield incident
 * (no model knew Garry built Palantir's Finance UI; brain did).
 *
 * The detector calls `analyzeSkillBrainFirst()` (the pure helper) so the
 * detector here, the doctor check, and the skillify-check gate all share
 * the same compliance ladder. One source of truth.
 *
 * The callout shape matches the existing compliant skills (brain-ops,
 * perplexity-research, academic-verify) — `> **Convention:** see
 * conventions/brain-first.md ...` with a brief explanation of the lookup
 * chain so a reader landing on it knows what to do next.
 */
export const MISSING_RULE_PATTERNS: MissingRulePattern[] = [
  {
    label: 'brain-first compliance',
    detect: (content, skillName) => {
      const fm = parseSkillFrontmatter(content);
      return analyzeSkillBrainFirst(content, skillName, fm).status === 'warn';
    },
    idempotentCheck: (content) => CONVENTION_CALLOUT_RE.test(content),
    callout: '> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) for the lookup chain (search → query → get_page → external).',
  },
];

// ---------------------------------------------------------------------------
// Block-expansion strategy map
// ---------------------------------------------------------------------------

export type BlockShape = 'bullet' | 'blockquote' | 'paragraph';

export interface Block {
  startLine: number;   // 0-indexed inclusive
  endLine: number;     // 0-indexed inclusive
}

/** Detect which block shape the line at `lineIdx` belongs to. */
export function detectBlockShape(lines: string[], lineIdx: number): BlockShape {
  const line = lines[lineIdx] ?? '';
  if (/^(\s*)(?:[-*]\s|\d+\.\s)/.test(line)) return 'bullet';
  if (/^>\s/.test(line)) return 'blockquote';
  return 'paragraph';
}

/** Expand a bullet item: start at the bullet line, end at the next sibling
 *  or shallower bullet (sub-bullets included). */
export function expandBullet(lines: string[], lineIdx: number): Block | null {
  const line = lines[lineIdx] ?? '';
  const indentMatch = line.match(/^(\s*)(?:[-*]\s|\d+\.\s)/);
  if (!indentMatch) return null;
  const baseIndent = indentMatch[1].length;

  // Walk up to find the start of THIS bullet (in case match is on a
  // continuation line of a multi-line bullet).
  let start = lineIdx;
  while (start > 0) {
    const prev = lines[start - 1];
    const prevIsBullet = /^(\s*)(?:[-*]\s|\d+\.\s)/.test(prev);
    const prevIndent = prev.match(/^(\s*)/)?.[1].length ?? 0;
    if (prevIsBullet && prevIndent <= baseIndent) break;
    if (prev.trim() === '') break;
    start--;
  }

  // Walk down: continue until a bullet at <= baseIndent (sibling or
  // shallower), a blank line, or end of file.
  let end = lineIdx;
  for (let i = lineIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') break;
    const isBullet = /^(\s*)(?:[-*]\s|\d+\.\s)/.test(l);
    const indent = l.match(/^(\s*)/)?.[1].length ?? 0;
    if (isBullet && indent <= baseIndent) break;
    end = i;
  }
  return { startLine: start, endLine: end };
}

/** Expand a blockquote: contiguous `>` lines. Returns null if the block is
 *  itself a `> **Convention:**` or `> **Filing rule:**` callout (don't
 *  rewrite a reference into a reference). */
export function expandBlockquote(lines: string[], lineIdx: number): Block | null {
  if (!/^>\s/.test(lines[lineIdx] ?? '')) return null;
  let start = lineIdx;
  while (start > 0 && /^>\s/.test(lines[start - 1])) start--;
  let end = lineIdx;
  while (end + 1 < lines.length && /^>\s/.test(lines[end + 1])) end++;

  const firstLine = lines[start] ?? '';
  if (/\*\*(?:Convention|Filing rule):\*\*/.test(firstLine)) {
    return null; // this IS a delegation callout already
  }
  return { startLine: start, endLine: end };
}

/** Expand a paragraph: previous blank line → next blank line. */
export function expandParagraph(lines: string[], lineIdx: number): Block | null {
  let start = lineIdx;
  while (start > 0 && lines[start - 1].trim() !== '') start--;
  let end = lineIdx;
  while (end + 1 < lines.length && lines[end + 1].trim() !== '') end++;
  return { startLine: start, endLine: end };
}

export const expanders: Record<BlockShape, (lines: string[], lineIdx: number) => Block | null> = {
  bullet: expandBullet,
  blockquote: expandBlockquote,
  paragraph: expandParagraph,
};

// ---------------------------------------------------------------------------
// Guards (re-exported from src/core/skill-fix-gates.ts for back-compat)
// ---------------------------------------------------------------------------

/**
 * v0.36.x extracted the working-tree + code-fence safety primitives to
 * `src/core/skill-fix-gates.ts` so both REPLACE (CROSS_CUTTING_PATTERNS)
 * and INSERT (MISSING_RULE_PATTERNS) auto-fix flows can share them. The
 * re-exports below preserve the public symbol names for tests + external
 * callers that imported these from `dry-fix.ts` directly.
 */
export const isInsideCodeFence = _isInsideCodeFence;
export const getWorkingTreeStatus = _getWorkingTreeStatus;
export const isWorkingTreeDirty = _isWorkingTreeDirty;
export type WorkingTreeStatus = _WorkingTreeStatus;

// ---------------------------------------------------------------------------
// Manifest loading delegated to src/core/skill-manifest.ts. Using the
// shared loader means auto-fix works in AGENTS.md-only workspaces where
// manifest.json is absent — the derive-from-walk path kicks in and
// auto-fix has the same skill set check-resolvable sees. D-CX-12.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Auto-repair DRY violations across every skill in the manifest.
 *
 * @param skillsDir — path to the `skills/` directory
 * @param opts.dryRun — if true, do not write; return proposed edits
 */
export function autoFixDryViolations(
  skillsDir: string,
  opts: AutoFixOptions = {}
): AutoFixReport {
  const fixed: FixOutcome[] = [];
  const skipped: FixOutcome[] = [];
  const { skills: manifest } = loadOrDeriveManifest(skillsDir);

  for (const skill of manifest) {
    const skillPath = join(skillsDir, skill.path);
    if (!existsSync(skillPath)) {
      // Manifest-present but file-missing is already reported by
      // checkResolvable as 'missing_file'; don't double-report here.
      continue;
    }

    let content: string;
    try {
      content = readFileSync(skillPath, 'utf-8');
    } catch (e: any) {
      skipped.push({
        skill: skill.name,
        skillPath,
        patternLabel: '(all)',
        status: 'error',
        reason: 'read_error',
      });
      continue;
    }

    // Compute delegations fresh per pattern — a prior applied fix inserts
    // a new Convention callout that should inform later patterns'
    // idempotency checks.
    let delegations = extractDelegationTargets(content);

    for (const cut of CROSS_CUTTING_PATTERNS) {
      const outcome = attemptFix(skill.name, skillPath, content, delegations, cut, opts);
      if (!outcome) continue;
      if (outcome.status === 'applied' || outcome.status === 'proposed') {
        fixed.push(outcome);
        if (outcome.status === 'applied') {
          try {
            content = readFileSync(skillPath, 'utf-8');
            delegations = extractDelegationTargets(content);
          } catch {
            break;
          }
        }
      } else {
        skipped.push(outcome);
      }
    }

    // v0.36.x INSERT-missing-rule patterns. Run AFTER REPLACE so a
    // freshly-inserted Convention callout from REPLACE doesn't get a
    // second INSERT layered on top by the brain-first detector.
    // (Belt + suspenders: brain-first's detect() reads the current file
    // content and calls analyzeSkillBrainFirst, which already short-
    // circuits on CONVENTION_CALLOUT_RE match.)
    for (const mrp of MISSING_RULE_PATTERNS) {
      const outcome = attemptInsertFix(skill.name, skillPath, content, mrp, opts);
      if (!outcome) continue;
      if (outcome.status === 'applied' || outcome.status === 'proposed') {
        fixed.push(outcome);
        if (outcome.status === 'applied') {
          try {
            content = readFileSync(skillPath, 'utf-8');
          } catch {
            break;
          }
        }
      } else {
        skipped.push(outcome);
      }
    }
  }

  return { fixed, skipped };
}

// ---------------------------------------------------------------------------
// INSERT expander — v0.36.x missing-rule auto-fix
// ---------------------------------------------------------------------------

/**
 * Find the line index at which to insert a new Convention callout.
 *
 * Insertion strategy `after-h1-paragraph`:
 *   1. After frontmatter closing `---`
 *   2. After the first `# Title` H1 if present
 *   3. After the leading paragraph following the H1 if present
 *   4. Before the first `## H2` heading
 *   5. Fallback: append at body end if no H2 exists
 *
 * Returns a 0-indexed line number where the new callout should be
 * inserted. Callers splice `[callout, ''] + ` at this position.
 *
 * Exported for unit tests.
 */
export function findInsertionLine(content: string): number {
  const lines = content.split('\n');
  let cursor = 0;

  // Step 1: Skip leading frontmatter fence if present.
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        cursor = i + 1;
        break;
      }
    }
  }

  // Step 2: Skip blank lines after frontmatter.
  while (cursor < lines.length && lines[cursor].trim() === '') cursor++;

  // Step 3: If there's a leading H1, advance past it.
  if (cursor < lines.length && /^#\s+/.test(lines[cursor])) {
    cursor++;
    // Step 4: Skip blank lines + the leading paragraph following the H1.
    while (cursor < lines.length && lines[cursor].trim() === '') cursor++;
    // Paragraph: contiguous non-blank, non-heading, non-fence lines.
    while (
      cursor < lines.length &&
      lines[cursor].trim() !== '' &&
      !/^##+\s+/.test(lines[cursor]) &&
      !/^---\s*$/.test(lines[cursor])
    ) {
      cursor++;
    }
    // Skip the trailing blank lines after the leading paragraph.
    while (cursor < lines.length && lines[cursor].trim() === '') cursor++;
  }

  // Step 5: Cursor is now at first H2 OR end of file. Either way, insert here.
  return cursor;
}

/**
 * Attempt an INSERT-missing-rule fix for one skill+pattern.
 *
 * Mirrors `attemptFix()` (the REPLACE-in-place path) for safety gates but
 * applies INSERT semantics: refuses when the rule is already present,
 * inserts at `findInsertionLine(content)` otherwise.
 *
 * Returns:
 *   - null            when the detector decides this skill doesn't need
 *                     the rule (skip silently — not every skill needs every
 *                     missing-rule pattern).
 *   - 'skipped' outcome with reason when a safety gate blocks the write.
 *   - 'proposed' outcome (dryRun) with before/after preview.
 *   - 'applied' outcome on successful write.
 *   - 'error' outcome on write failure.
 */
function attemptInsertFix(
  skillName: string,
  skillPath: string,
  content: string,
  mrp: MissingRulePattern,
  opts: AutoFixOptions
): FixOutcome | null {
  const base = {
    skill: skillName,
    skillPath,
    patternLabel: mrp.label,
  };

  // Detector gate: does this skill NEED the rule inserted?
  if (!mrp.detect(content, skillName)) return null;

  // Idempotency: is the rule already declared somehow? Belt+suspenders;
  // detect() should already short-circuit, but double-check at the
  // insertion gate so a future detector that misses callout cases doesn't
  // produce double-inserts.
  if (mrp.idempotentCheck(content)) {
    return { ...base, status: 'skipped', reason: 'already_delegated' };
  }

  // Safety gates (shared with REPLACE path).
  const treeStatus = getWorkingTreeStatus(skillPath);
  if (treeStatus === 'dirty') {
    return { ...base, status: 'skipped', reason: 'working_tree_dirty' };
  }
  if (treeStatus === 'not_a_repo') {
    return { ...base, status: 'skipped', reason: 'no_git_backup' };
  }

  // Compute insertion site.
  const insertAt = findInsertionLine(content);
  const lines = content.split('\n');

  // Build the new file content: splice [callout, ''] at insertAt.
  // The blank line after the callout keeps the surrounding block
  // structure readable.
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const inserted = [...before, mrp.callout, '', ...after];
  let next = inserted.join('\n');
  if (content.endsWith('\n') && !next.endsWith('\n')) {
    next += '\n';
  }

  if (opts.dryRun) {
    return {
      ...base,
      status: 'proposed',
      before: '(no prior block — inserting new callout)',
      after: mrp.callout,
    };
  }

  try {
    writeFileSync(skillPath, next, 'utf-8');
  } catch {
    return { ...base, status: 'error', reason: 'write_error' };
  }

  return {
    ...base,
    status: 'applied',
    before: '(no prior block — inserted new callout)',
    after: mrp.callout,
  };
}

function attemptFix(
  skillName: string,
  skillPath: string,
  content: string,
  delegations: ReturnType<typeof extractDelegationTargets>,
  cut: CrossCuttingPattern,
  opts: AutoFixOptions
): FixOutcome | null {
  const base = {
    skill: skillName,
    skillPath,
    patternLabel: cut.label,
  };

  // Find ALL matches first (for multi-match detection).
  const globalRe = new RegExp(
    cut.pattern.source,
    cut.pattern.flags.includes('g') ? cut.pattern.flags : cut.pattern.flags + 'g'
  );
  const matches = [...content.matchAll(globalRe)];
  if (matches.length === 0) return null;

  if (matches.length > 1) {
    return { ...base, status: 'skipped', reason: 'ambiguous_multiple_matches' };
  }

  const m = matches[0];
  const offset = m.index ?? 0;

  if (isInsideCodeFence(content, offset)) {
    return { ...base, status: 'skipped', reason: 'inside_code_fence' };
  }

  // Compute match line (1-indexed) to evaluate idempotency.
  // Use the same proximity window as the detector (DRY_PROXIMITY_LINES)
  // so the fixer can't re-fire on blocks the detector already suppresses.
  const matchLine = content.slice(0, offset).split('\n').length;
  const alreadyDelegated = delegations.some(
    d => cut.conventions.includes(d.convention) && Math.abs(d.line - matchLine) <= DRY_PROXIMITY_LINES
  );
  if (alreadyDelegated) {
    return { ...base, status: 'skipped', reason: 'already_delegated' };
  }

  const treeStatus = getWorkingTreeStatus(skillPath);
  if (treeStatus === 'dirty') {
    return { ...base, status: 'skipped', reason: 'working_tree_dirty' };
  }
  if (treeStatus === 'not_a_repo') {
    // File isn't tracked by git — writing would destroy the user's only
    // copy with no rollback path. Refuse.
    return { ...base, status: 'skipped', reason: 'no_git_backup' };
  }

  // Expand to block boundary.
  const lines = content.split('\n');
  const lineIdx = matchLine - 1; // 0-indexed
  const shape = detectBlockShape(lines, lineIdx);
  const expander = expanders[shape];
  const block = expander(lines, lineIdx);
  if (!block) {
    return { ...base, status: 'skipped', reason: 'block_is_callout' };
  }

  // Build replacement line.
  const canonical = cut.conventions[0];
  const replacement = `> **Convention:** See \`skills/${canonical}\` for ${cut.label}.`;

  // Splice: replace lines[startLine..endLine] with [replacement].
  const before = lines.slice(0, block.startLine).join('\n');
  const originalBlock = lines.slice(block.startLine, block.endLine + 1).join('\n');
  const after = lines.slice(block.endLine + 1).join('\n');

  // Preserve structure: one newline between sections, preserve the file's
  // trailing newline if the original had one (POSIX convention).
  const parts: string[] = [];
  if (before.length > 0) parts.push(before);
  parts.push(replacement);
  if (after.length > 0) parts.push(after);
  let next = parts.join('\n');
  if (content.endsWith('\n') && !next.endsWith('\n')) {
    next += '\n';
  }

  if (opts.dryRun) {
    return {
      ...base,
      status: 'proposed',
      before: originalBlock,
      after: replacement,
    };
  }

  try {
    writeFileSync(skillPath, next, 'utf-8');
  } catch {
    return { ...base, status: 'error', reason: 'write_error' };
  }

  return {
    ...base,
    status: 'applied',
    before: originalBlock,
    after: replacement,
  };
}

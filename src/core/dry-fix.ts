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
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import {
  CROSS_CUTTING_PATTERNS,
  DRY_PROXIMITY_LINES,
  extractDelegationTargets,
  type CrossCuttingPattern,
} from './check-resolvable.ts';

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
// Guards
// ---------------------------------------------------------------------------

/** True when the match offset sits inside a fenced code block (``` ... ```).
 *  Counts triple-backtick fences at line starts. Odd count = inside. */
export function isInsideCodeFence(content: string, offset: number): boolean {
  const before = content.slice(0, offset);
  const fenceRe = /^```/gm;
  const fenceCount = (before.match(fenceRe) || []).length;
  return fenceCount % 2 === 1;
}

export type WorkingTreeStatus = 'clean' | 'dirty' | 'not_a_repo';

/** Check the git state of a skill file. Three distinct outcomes — callers
 *  must NOT conflate "not a repo" with "clean", because the auto-fix
 *  contract is "git is the backup" and writing to a file outside any repo
 *  destroys user data with no recovery path.
 *
 *  `execFileSync` with array args bypasses the shell entirely, so paths
 *  with odd characters from a manifest can't inject commands. */
export function getWorkingTreeStatus(skillPath: string): WorkingTreeStatus {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', skillPath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: dirname(skillPath),
    });
    return out.trim().length > 0 ? 'dirty' : 'clean';
  } catch {
    // git exits 128 when not inside a repo; treat any non-zero the same.
    return 'not_a_repo';
  }
}

/** Legacy wrapper. Callers that need to distinguish not_a_repo from clean
 *  should use getWorkingTreeStatus() directly. */
export function isWorkingTreeDirty(skillPath: string): boolean {
  return getWorkingTreeStatus(skillPath) === 'dirty';
}

// ---------------------------------------------------------------------------
// Manifest loading (duplicated from check-resolvable.ts to avoid exporting
// that internal helper — kept in sync via tests)
// ---------------------------------------------------------------------------

interface ManifestEntry {
  name: string;
  path: string;
}

function loadManifest(skillsDir: string): ManifestEntry[] {
  const manifestPath = join(skillsDir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  try {
    const content = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return content.skills || [];
  } catch {
    return [];
  }
}

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
  const manifest = loadManifest(skillsDir);

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
  }

  return { fixed, skipped };
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

/**
 * skillpack/apply-hunks.ts — pure-JS unified-diff parser + clean-hunk
 * applier (D15, TODO-3 folded).
 *
 * Used by `gbrain skillpack reference --apply-clean-hunks`. For each
 * hunk in a diff between gbrain's bundle and the user's local file,
 * apply ONLY when the hunk's pre-change context lines (everything
 * prefixed with ' ' or '-') appear as a contiguous block in the user's
 * file. If the block is missing or appears more than once, the hunk
 * conflicts — skip it and report.
 *
 * Two-way diff against gbrain's CURRENT bundle (no scaffold-time base
 * tracking). Conflicting hunks are skipped, not merged — the agent
 * picks them up via the conflict report and merges by hand. This is
 * the explicit "agent is the merge driver" contract.
 *
 * No system `patch(1)` dependency — portable to every gbrain target.
 */

export interface Hunk {
  /** Old-file start line (1-indexed). Informational. */
  oldStart: number;
  /** Old-file line count. */
  oldCount: number;
  /** New-file start line (1-indexed). Informational. */
  newStart: number;
  /** New-file line count. */
  newCount: number;
  /** Hunk body lines, prefix-preserved (' ', '-', '+'). */
  lines: string[];
  /** Whether this hunk's pre-change text lacked a final newline. */
  oldNoNewlineAtEnd: boolean;
  /** Whether this hunk's post-change text lacks a final newline. */
  newNoNewlineAtEnd: boolean;
}

export interface ParsedDiff {
  hunks: Hunk[];
}

export class ApplyHunksError extends Error {
  constructor(message: string, public code: 'parse_error') {
    super(message);
    this.name = 'ApplyHunksError';
  }
}

/**
 * Parse a unified-diff string into hunks. Tolerates leading file
 * headers (`--- a/...` / `+++ b/...`) but doesn't require them. Throws
 * `ApplyHunksError(parse_error)` on malformed hunk headers.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: Hunk[] = [];
  if (text.length === 0) return { hunks };
  const lines = text.split('\n');
  // Strip a trailing empty entry that arises when text ends with '\n'.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip file headers and any inter-hunk junk until we hit a hunk header.
    if (!line.startsWith('@@')) {
      i += 1;
      continue;
    }

    // Hunk header: @@ -aStart,aCount +bStart,bCount @@
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) {
      throw new ApplyHunksError(`Malformed hunk header: ${line}`, 'parse_error');
    }
    const oldStart = parseInt(m[1], 10);
    const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    const newStart = parseInt(m[3], 10);
    const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;

    i += 1;
    const body: string[] = [];
    let oldNoNewlineAtEnd = false;
    let newNoNewlineAtEnd = false;

    // Collect body lines until we hit the next hunk header, file header,
    // or end of input. Track `\ No newline at end of file` markers and
    // attribute them to the line they follow. Don't break early on
    // line-counts being met — a `\` marker can legitimately follow the
    // last body line.
    let aSeen = 0;
    let bSeen = 0;
    while (i < lines.length) {
      const ln = lines[i];
      if (ln.startsWith('@@') || ln.startsWith('---') || ln.startsWith('+++')) break;
      if (ln === '\\ No newline at end of file') {
        // Attribute to the previous body line — was it from a or b?
        if (body.length > 0) {
          const prev = body[body.length - 1].charAt(0);
          if (prev === '-' || prev === ' ') oldNoNewlineAtEnd = true;
          if (prev === '+' || prev === ' ') newNoNewlineAtEnd = true;
        }
        i += 1;
        continue;
      }
      const c = ln.charAt(0);
      if (c === ' ') {
        aSeen += 1;
        bSeen += 1;
      } else if (c === '-') aSeen += 1;
      else if (c === '+') bSeen += 1;
      else {
        // Unknown prefix; tolerate as context (gnu diff sometimes emits
        // empty-prefix blank lines for an empty context line).
        body.push(' ' + ln);
        aSeen += 1;
        bSeen += 1;
        i += 1;
        continue;
      }
      body.push(ln);
      i += 1;
      // Once counts are met, peek ahead: if the next line is a `\`
      // marker, keep going to consume it. Otherwise we're done with
      // this hunk.
      if (aSeen >= oldCount && bSeen >= newCount) {
        if (i >= lines.length || lines[i] !== '\\ No newline at end of file') {
          break;
        }
        // else loop continues and consumes the marker
      }
    }

    hunks.push({
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: body,
      oldNoNewlineAtEnd,
      newNoNewlineAtEnd,
    });
  }

  return { hunks };
}

export interface ApplyHunksResult {
  /** Final text after applying clean hunks (and leaving conflicts in place). */
  text: string;
  /** Number of hunks applied. */
  applied: number;
  /** Number of hunks skipped due to conflict. */
  conflicted: number;
  /** Per-hunk applied/skipped flag (in hunk order). */
  outcomes: Array<{
    hunk: number;
    status: 'applied' | 'conflict_missing' | 'conflict_ambiguous';
  }>;
}

/**
 * Apply a parsed diff to a target file's text. For each hunk:
 *   - Extract the pre-change block (the ' ' and '-' lines, in order).
 *   - Search the target text for that block as a contiguous run.
 *   - Found exactly once → replace with the post-change block (' ' and '+').
 *   - Not found → conflict_missing (skip).
 *   - Found 2+ times → conflict_ambiguous (skip; refuse to guess).
 *
 * Multiple-hunk diffs are applied in order. Each successful apply
 * mutates the in-memory text so subsequent hunks see the updated
 * state. Conflicts don't poison subsequent hunks — they get a clean
 * shot at the post-apply text.
 */
export function applyHunks(targetText: string, diff: ParsedDiff): ApplyHunksResult {
  let currentText = targetText;
  let applied = 0;
  let conflicted = 0;
  const outcomes: ApplyHunksResult['outcomes'] = [];

  for (let i = 0; i < diff.hunks.length; i++) {
    const hunk = diff.hunks[i];
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (const ln of hunk.lines) {
      const c = ln.charAt(0);
      const body = ln.slice(1);
      if (c === ' ') {
        beforeLines.push(body);
        afterLines.push(body);
      } else if (c === '-') {
        beforeLines.push(body);
      } else if (c === '+') {
        afterLines.push(body);
      }
    }

    // Empty pre-change (pure addition at start of file or end of file)
    // — apply at line oldStart-1 (0-indexed). Unambiguous since there's
    // nothing to match.
    if (beforeLines.length === 0) {
      currentText = applyPureAddition(currentText, afterLines, hunk);
      applied += 1;
      outcomes.push({ hunk: i, status: 'applied' });
      continue;
    }

    const split = splitTextPreserveTrailing(currentText);
    const matches = findAllMatches(split.lines, beforeLines);
    if (matches.length === 0) {
      conflicted += 1;
      outcomes.push({ hunk: i, status: 'conflict_missing' });
      continue;
    }
    if (matches.length > 1) {
      conflicted += 1;
      outcomes.push({ hunk: i, status: 'conflict_ambiguous' });
      continue;
    }

    // Found exactly once — splice in the after-lines.
    const at = matches[0];
    const newLines = [
      ...split.lines.slice(0, at),
      ...afterLines,
      ...split.lines.slice(at + beforeLines.length),
    ];
    // Trailing-newline behavior: if hunk says newNoNewlineAtEnd AND the
    // hunk's range covers the end of the file, the result loses its
    // trailing newline. Otherwise preserve whatever the file had.
    const coversEnd = at + beforeLines.length === split.lines.length;
    const trailingNewline = coversEnd
      ? !hunk.newNoNewlineAtEnd
      : split.trailingNewline;
    currentText = joinLines(newLines, trailingNewline);
    applied += 1;
    outcomes.push({ hunk: i, status: 'applied' });
  }

  return { text: currentText, applied, conflicted, outcomes };
}

function applyPureAddition(text: string, additions: string[], hunk: Hunk): string {
  const split = splitTextPreserveTrailing(text);
  // Pure addition at oldStart (1-indexed, before any content). If
  // oldStart is 0 or 1 with oldCount 0, insert at the file start.
  const insertAt = Math.max(0, hunk.oldStart - 1);
  const newLines = [...split.lines.slice(0, insertAt), ...additions, ...split.lines.slice(insertAt)];
  const trailingNewline =
    insertAt === split.lines.length ? !hunk.newNoNewlineAtEnd : split.trailingNewline;
  return joinLines(newLines, trailingNewline);
}

interface SplitText {
  lines: string[];
  trailingNewline: boolean;
}

function splitTextPreserveTrailing(text: string): SplitText {
  if (text.length === 0) return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? '' : '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

/**
 * Return every starting index in `haystack` at which `needle` matches
 * as a contiguous block. Naive O(n*m) scan — fine for skill files.
 */
function findAllMatches(haystack: string[], needle: string[]): number[] {
  if (needle.length === 0) return [];
  if (needle.length > haystack.length) return [];
  const matches: number[] = [];
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    matches.push(i);
  }
  return matches;
}

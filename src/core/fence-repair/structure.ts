/**
 * Structural Tier 1 rules for one section (#6188): `marker_form` (takes
 * two-dash markers) and `close_fence` (a missing end marker).
 *
 * `close_fence` inserts the end marker after the last table row only when
 * every row of the before-region is one contiguous block and nothing but
 * blank lines follows it to the end of the section: the privacy boundary
 * hides everything after an unpaired begin marker, so closing the fence
 * early would publish whatever trails it (gate (g)). Every structural edit
 * is also checked against `exposedLines` before it is kept.
 */
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { exposedLines } from './page-checks.ts';
import { extractRawRows, MARKERS, parseRowSpans, primaryFence, type RawFence, type RawSection } from './raw-rows.ts';
import type { FenceFix, FenceIssue, FenceReason, FenceSection, FixClass } from './types.ts';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface PassResult {
  text: string;
  fixes: FenceFix[];
  residual: FenceIssue[];
}

interface Step {
  edits: Edit[];
  fixes: FenceFix[];
  residual: FenceIssue[];
}

/** Apply non-overlapping edits (any order) to `text`. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** Run the structural rules until they settle (a converted marker may then need closing). */
export function structuralPass(text: string, section: FenceSection): PassResult {
  let current = text;
  const fixes: FenceFix[] = [];
  for (let round = 0; round < 3; round++) {
    const step = structuralStep(current, section);
    if (!step.edits.length) return { text: current, fixes, residual: step.residual };
    current = applyEdits(current, step.edits);
    fixes.push(...step.fixes);
  }
  throw new Error('fence structure rules did not settle');
}

/** A fence whose markers need a person: repeated, or an end marker with no begin before it. */
export function fenceBlocked(raw: RawSection, fence: RawFence): boolean {
  return fence.issues.some(i => i.reason === 'repeated_marker')
    || raw.issues.some(i => i.fence === fence.kind && i.reason === 'missing_begin');
}

function structuralStep(text: string, section: FenceSection): Step {
  const raw = extractRawRows(text, section);
  const step: Step = { edits: [], fixes: [], residual: [] };
  for (const kind of ['facts', 'takes'] as const) {
    const fence = primaryFence(raw, kind);
    if (!fence || fenceBlocked(raw, fence)) continue;
    const edits = markerEdits(text, fence);
    if (edits === null) {
      step.residual.push(fenceIssue(fence, 'marker_near_miss', fence.begin.line));
      continue;
    }
    if (edits.length) keep(step, text, fence, edits, 'marker_form', 'marker_near_miss');
    else if (!fence.end) planClose(step, text, fence);
  }
  return step;
}

function fenceIssue(fence: RawFence, reason: FenceReason, line: number | null): FenceIssue {
  return { fence: fence.kind, section: fence.section, row: null, column: null, line, reason };
}

/** Keep a fence's edits unless they would show text the privacy boundary hid. */
function keep(step: Step, text: string, fence: RawFence, edits: Edit[], cls: FixClass, otherwise: FenceReason): void {
  if (exposedLines(text, applyEdits(text, edits)).length) {
    step.residual.push(fenceIssue(fence, otherwise, fence.begin.line));
    return;
  }
  step.edits.push(...edits);
  step.fixes.push({ fence: fence.kind, section: fence.section, row: null, column: null, line: fence.begin.line, class: cls });
}

/** `marker_form` edits for two-dash takes markers; null when a near-miss begin has no table after it. */
function markerEdits(text: string, fence: RawFence): Edit[] | null {
  const edits: Edit[] = [];
  if (fence.begin.nearMiss) {
    if (!tableFollows(text, fence.begin.end)) return null;
    edits.push({ start: fence.begin.start, end: fence.begin.end, text: TAKES_FENCE_BEGIN });
  }
  if (fence.end?.nearMiss) edits.push({ start: fence.end.start, end: fence.end.end, text: TAKES_FENCE_END });
  return edits;
}

/** The first non-blank line after `from` is a pipe-table row. */
function tableFollows(text: string, from: number): boolean {
  let at = text.indexOf('\n', from);
  while (at !== -1) {
    const next = text.indexOf('\n', at + 1);
    const end = next === -1 ? text.length : next;
    if (text.slice(at + 1, end).trim()) return parseRowSpans(text, at + 1, end, 0) !== null;
    at = next;
  }
  return false;
}

function planClose(step: Step, text: string, fence: RawFence): void {
  const lines = [fence.header, ...fence.separators, ...fence.rows].filter(r => r !== null).sort((a, b) => a.line - b.line);
  const last = lines[lines.length - 1];
  if (lines.some((row, i) => i > 0 && row.line !== lines[i - 1]!.line + 1)) {
    step.residual.push(fenceIssue(fence, 'split_rows', fence.begin.line));
    return;
  }
  const after = last ? last.end : fence.begin.end;
  if (text.slice(after, fence.regionEnd).trim()) {
    step.residual.push(fenceIssue(fence, 'unclosed_trailing_content', fence.begin.line));
    return;
  }
  keep(step, text, fence, [closeEdit(text, after, MARKERS[fence.kind].end)], 'close_fence', 'unclosed_trailing_content');
}

/** Insert `marker` on its own line after the line that ends at or after `at`, keeping that line's ending. */
function closeEdit(text: string, at: number, marker: string): Edit {
  const nl = text.indexOf('\n', at);
  if (nl === -1) return { start: text.length, end: text.length, text: `\n${marker}` };
  const crlf = nl > 0 && text[nl - 1] === '\r';
  const pos = crlf ? nl - 1 : nl;
  return { start: pos, end: pos, text: `${crlf ? '\r\n' : '\n'}${marker}` };
}

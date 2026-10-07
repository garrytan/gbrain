/**
 * #5616 edit_page: ordered exact-string replacements applied server-side to
 * the caller's authorized view of a page (the `content` get_page returns to
 * that caller with include_content:true), mapped back onto the canonical body
 * without moving or exposing protected takes/facts fences.
 *
 * The canonical serialization is split into editable text and protected
 * segments. A protected segment renders as itself for trusted local callers;
 * for remote callers a takes fence renders as nothing and a facts fence as
 * its world-visible rows, exactly as get_page sanitizes them. An edit must
 * match exactly once inside editable text; a match that touches or crosses a
 * protected segment is refused, so canonical bytes outside the edited spans
 * are preserved byte for byte.
 */
import type { Page } from '../types.ts';
import { OperationError } from '../ops/contract.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { sanitizeText } from '../batch-rows.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { unifiedDiff } from '../skillpack/diff-text.ts';
import { redactRetrievalOutput } from '../search/output-redaction.ts';
import { scanCanonicalFences, targetFenceRefusal } from '../fence-repair/refusal.ts';

export const EDIT_PAGE_MAX_EDITS = 50;
export const EDIT_PAGE_DIFF_MAX_BYTES = 8 * 1024;
export const EDIT_PAGE_DOCS = 'docs/protocol/MEMORY_VERBS_v1.md#partial-page-edits-edit_page';

export interface PageEdit { old_text: string; new_text: string; }
interface Segment { canonical: string; view: string; editable: boolean; }

const MARKERS = [FACTS_FENCE_BEGIN, FACTS_FENCE_END, TAKES_FENCE_BEGIN, TAKES_FENCE_END];
const MARKER_PATTERN = new RegExp(MARKERS.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
const REMOTE_VIEW = { includeWithdrawn: true, keepMaterializedMarkers: true } as const;

function editError(code: string, message: string, suggestion: string, detail?: string): OperationError {
  const error = new OperationError(code, message, suggestion, EDIT_PAGE_DOCS);
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** Validates the wire shape: 1-50 `{ old_text, new_text }` objects, `old_text` non-empty. */
export function parsePageEdits(value: unknown): PageEdit[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > EDIT_PAGE_MAX_EDITS) {
    throw editError('edit_invalid', `edits must be an array of 1 to ${EDIT_PAGE_MAX_EDITS} replacements.`,
      'Pass edits: [{ "old_text": "…", "new_text": "…" }] in the order to apply them.');
  }
  return value.map((edit, index) => {
    const record = edit as Record<string, unknown> | null;
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(k => k !== 'old_text' && k !== 'new_text')
      || typeof record.old_text !== 'string' || typeof record.new_text !== 'string') {
      throw editError('edit_invalid', `Edit ${index} must be an object with string old_text and new_text.`,
        'Each edit is exactly { "old_text": "…", "new_text": "…" }.', `edit_index=${index}`);
    }
    if (record.old_text.length === 0) {
      throw editError('edit_invalid', `Edit ${index} has an empty old_text.`,
        'Quote enough existing text to match exactly once; use put_page to write a new page.', `edit_index=${index}`);
    }
    if (MARKERS.some(marker => (record.new_text as string).includes(marker))) {
      throw editError('edit_protected_span', `Edit ${index} would write a protected fence marker.`,
        'Use the takes_* operations or remember/forget for takes and facts.', `edit_index=${index}`);
    }
    return { old_text: record.old_text, new_text: record.new_text };
  });
}

function bodySegments(body: string, remote: boolean): Segment[] {
  if (remote && sanitizeText(body) !== body) {
    throw editError('edit_invalid', 'This page contains bytes the remote view cannot reproduce.',
      'Edit it from the brain host with put_page or the local CLI.');
  }
  const segments: Segment[] = [];
  let cursor = 0;
  let open: { start: number; end: string } | undefined;
  for (const token of body.matchAll(MARKER_PATTERN)) {
    const marker = token[0];
    if (!open) {
      if (marker !== FACTS_FENCE_BEGIN && marker !== TAKES_FENCE_BEGIN) continue;
      if (token.index > cursor) segments.push(text(body.slice(cursor, token.index)));
      open = { start: token.index, end: marker === FACTS_FENCE_BEGIN ? FACTS_FENCE_END : TAKES_FENCE_END };
      continue;
    }
    if (marker !== open.end) throw unrepairedFence();
    cursor = token.index + marker.length;
    const fence = body.slice(open.start, cursor);
    segments.push({ canonical: fence, view: remote ? sanitizeRemoteBody(fence, REMOTE_VIEW) : fence, editable: false });
    open = undefined;
  }
  if (open) throw unrepairedFence();
  if (cursor < body.length) segments.push(text(body.slice(cursor)));
  return segments;
}

function text(value: string): Segment { return { canonical: value, view: value, editable: true }; }
function unrepairedFence(): OperationError {
  return editError('edit_invalid', 'A takes or facts fence on this page is malformed.',
    'Read the page, then fix the fence (or write the whole page with put_page, which normalizes what it can) before editing it.');
}

/**
 * Mirrors serializeMarkdown's layout so the view is byte-equal to get_page's
 * `content`; adjacent editable pieces coalesce so a match may span the
 * frontmatter, body and timeline sentinel like any ordinary text.
 */
function pageSegments(page: Page, tags: string[], remote: boolean): Segment[] {
  const head = serializePageToMarkdown({ ...page, compiled_truth: '', timeline: '' }, tags).slice(0, -1);
  const timeline = bodySegments(page.timeline ?? '', remote);
  const sentinel = '\n\n<!-- timeline -->\n\n';
  // A remote view whose whole timeline is protected has no sentinel either.
  const sentinelSegment = timeline.some(segment => segment.view.length > 0) ? text(sentinel) : { canonical: sentinel, view: '', editable: false };
  const pieces = [text(head), ...bodySegments(page.compiled_truth ?? '', remote),
    ...(page.timeline ? [sentinelSegment, ...timeline] : []), text('\n')];
  return pieces.reduce<Segment[]>((out, piece) => {
    const last = out[out.length - 1];
    if (last?.editable && piece.editable) out[out.length - 1] = text(last.canonical + piece.canonical);
    else out.push(piece);
    return out;
  }, []);
}

const join = (segments: Segment[], key: 'canonical' | 'view') => segments.map(segment => segment[key]).join('');

/** The text a caller matches against: get_page `content` for that caller. */
export function editableView(page: Page, tags: string[], remote: boolean): string {
  return join(pageSegments(page, tags, remote), 'view');
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/**
 * Applies the edits in order, each to the text produced by the previous one,
 * all or nothing. Returns the canonical content to publish and the caller's
 * view before and after (the only text a diff or receipt may show).
 */
export function applyPageEdits(page: Page, tags: string[], remote: boolean, edits: PageEdit[]): { content: string; before: string; after: string } {
  // #6188 (D19): edit_page never rewrites a fence; a stored fence that does not compile refuses typed, location only.
  const [defect] = scanCanonicalFences(page).defects;
  if (defect) throw targetFenceRefusal(defect, page.slug, page.source_id);
  let segments = pageSegments(page, tags, remote);
  const before = join(segments, 'view');
  edits.forEach((edit, index) => {
    const view = join(segments, 'view');
    const ranges: Array<{ start: number; end: number; index: number }> = [];
    let offset = 0;
    segments.forEach((segment, i) => { ranges.push({ start: offset, end: offset + segment.view.length, index: i }); offset += segment.view.length; });
    const inside = (at: number) => ranges.find(r => segments[r.index].editable && at >= r.start && at + edit.old_text.length <= r.end);
    const all = occurrences(view, edit.old_text);
    const allowed = all.filter(at => inside(at));
    if (allowed.length === 0 && all.length > 0) {
      throw editError('edit_protected_span', `Edit ${index}'s old_text touches a protected takes or facts section.`,
        'Use the takes_* operations or remember/forget for takes and facts, and quote only ordinary page text.', `edit_index=${index}`);
    }
    if (allowed.length === 0) {
      throw editError('edit_no_match', `Edit ${index}'s old_text was not found in the page.`,
        'Read get_page with include_content:true and copy old_text exactly, including whitespace; earlier edits in the same call have already been applied to the text it matches.',
        `edit_index=${index} match_count=0`);
    }
    if (allowed.length > 1) {
      throw editError('edit_ambiguous_match', `Edit ${index}'s old_text matches ${allowed.length} places.`,
        'Include surrounding text in old_text so it matches exactly once.', `edit_index=${index} match_count=${allowed.length}`);
    }
    const at = allowed[0];
    const range = inside(at)!;
    const segment = segments[range.index];
    const local = at - range.start;
    const replaced = segment.canonical.slice(0, local) + edit.new_text + segment.canonical.slice(local + edit.old_text.length);
    segments = segments.map((s, i) => i === range.index ? text(replaced) : s);
  });
  return { content: join(segments, 'canonical'), before, after: join(segments, 'view') };
}

const encodedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));

/**
 * The caller-view unified diff, secret-redacted like retrieval output (it is
 * retained in the receipt), cut on a line boundary so its JSON encoding fits
 * 8 KB: the receipt reserves exactly that much (EDIT_PAGE_RECEIPT_RESERVE).
 */
export function editDiff(slug: string, before: string, after: string): { diff: string; diff_truncated?: true } {
  const [{ diff: full }] = redactRetrievalOutput([{ diff: unifiedDiff(before, after, { oldPath: `a/${slug}.md`, newPath: `b/${slug}.md` }) }], {}).results;
  if (encodedBytes(full) <= EDIT_PAGE_DIFF_MAX_BYTES) return { diff: full };
  const lines = full.split('\n');
  let kept = '';
  for (const line of lines) {
    if (encodedBytes(`${kept}${line}\n`) > EDIT_PAGE_DIFF_MAX_BYTES) break;
    kept += `${line}\n`;
  }
  return { diff: kept, diff_truncated: true };
}

/** Extra terminal-receipt bytes an edit_page admission reserves for its diff. */
export const EDIT_PAGE_RECEIPT_RESERVE = EDIT_PAGE_DIFF_MAX_BYTES + 512;

/** Submission preflight and publication share one check of the stated revision. */
export function assertEditRevision(current: string | null, expected: unknown): void {
  if (current !== null && expected === current) return;
  throw editError('revision_conflict', current === null ? 'The page does not exist.' : 'The page changed since expected_revision was read.',
    'Read get_page with include_content:true again, rebuild the edits against that content, and resend with its revision.',
    current === null ? undefined : `current_revision=${current}`);
}

/**
 * #5969 (D3): a put_page / put_pages body that leaves out the page's Timeline
 * section. The section's presence is read from the content as the caller sent
 * it, before any normalization: `splitBody` returns an empty timeline both for
 * an omission and for a present-but-empty section, and the bare-heading
 * recognizer needs a dated bullet, so the two are indistinguishable later.
 *
 *   - `omitted`: no timeline sentinel and no `## Timeline` / `## History`
 *     heading outside code. A remote caller is refused when stored rows it saw
 *     would be deleted, unless it passes `drop_timeline: true`; a local
 *     preserving writer (no expected_revision) keeps them.
 *   - `emptied`: the section is there with no entries: a deliberate delete for
 *     every writer class, reported.
 *   - `present`: a normal diff, reported.
 *
 * Admission records the section on the intent (`timeline_section`), so
 * failed-writes replay and put_pages batch children carry it unchanged.
 * Maintenance, reconcile and file-import writers record none and keep the
 * shared projection policy.
 */
import type { BrainEngine } from '../engine.ts';
import { findTimelineSplitIndex, frontmatterBodyOffset, parseMarkdown } from '../markdown.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { bodyHasTimelineEntries, timelineRowsToRemove, type ProjectionWriter, type TimelineRowsRemoved, type TimelineWritePolicy } from './canonical-projections.ts';

export const TIMELINE_SECTIONS = ['present', 'emptied', 'omitted'] as const;
export type TimelineSection = typeof TIMELINE_SECTIONS[number];
export const TIMELINE_OMISSION_CODE = 'timeline_rows_would_be_removed';
const DOCS = 'docs/guides/write-refusals.md#timeline_rows_would_be_removed';
const TIMELINE_HEADING = /^##\s+(timeline|history)\b/i;

function hasTimelineHeading(lines: string[]): boolean {
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && TIMELINE_HEADING.test(line.trim())) return true;
  }
  return false;
}

/** What the caller's raw content says about its Timeline section. */
export function timelineSectionOf(content: string, slug: string): TimelineSection {
  const lines = content.slice(frontmatterBodyOffset(content)).split('\n');
  if (findTimelineSplitIndex(lines) === -1 && !hasTimelineHeading(lines)) return 'omitted';
  return bodyHasTimelineEntries(parseMarkdown(content, slug), slug) ? 'present' : 'emptied';
}

export function isTimelineSection(value: unknown): value is TimelineSection {
  return (TIMELINE_SECTIONS as readonly unknown[]).includes(value);
}

/** The policy an ordinary put_page intent carries; none for every other writer. */
export function timelineWritePolicy(intent: Record<string, unknown>, remote: boolean, writer: ProjectionWriter): TimelineWritePolicy | undefined {
  if (!isTimelineSection(intent.timeline_section)) return undefined;
  return { section: intent.timeline_section, drop: intent.drop_timeline === true, preserveOmitted: !remote && writer === 'preserving' };
}

export function timelineOmissionRefusal(slug: string, sourceId: string, removed: TimelineRowsRemoved): OperationError {
  const rows = `${removed.count} timeline row(s) dated ${removed.earliest}${removed.latest !== removed.earliest ? ` to ${removed.latest}` : ''}`;
  const retry: Action = { mcp: { tool: 'put_page', arguments: { slug, source_id: sourceId, drop_timeline: true } }, consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Only if removing every one of those dated entries is intended: the same complete content with drop_timeline: true and a new request_id deletes them and reports them in timeline_rows_removed.',
    inputs: [{ name: 'content', how: 'the same complete page content' }, { name: 'request_id', how: 'a new UUID' }] };
  return opError(TIMELINE_OMISSION_CODE, `This put_page has no Timeline section, so it would delete ${rows} from ${slug}; nothing was written.`,
    `Read the page with get_page include_content:true, keep its Timeline section in your content and resubmit with a new request_id. To remove every dated entry on purpose, resubmit the same content with drop_timeline: true; to remove only some, send the section without those bullets.`,
    { why: 'put_page content replaces the whole page, and a body without a Timeline section would delete dated entries other writers added (add_timeline_entry, imports); a remote write must say so explicitly.',
      docs: DOCS,
      fix: { mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, include_content: true } }, consent: [], actor: 'agent', requires_exclusive: false,
        why: `Returns ${slug} with its current Timeline section, so the resubmitted content keeps those entries.`,
        verify: { mcp: { tool: 'get_timeline', arguments: { slug } } }, then: retry } });
}

/**
 * Refuse a remote omission that would delete rows. Runs before admission (the
 * caller gets the full fix) and again during preparation against the pinned
 * prior, so a row added in between is not deleted silently.
 */
export async function assertTimelineNotOmitted(engine: BrainEngine, input: { intent: Record<string, unknown>; remote: boolean; writer: ProjectionWriter;
  slug: string; sourceId: string; content: string; prior: PageSnapshot | null }): Promise<void> {
  const policy = timelineWritePolicy(input.intent, input.remote, input.writer);
  if (!input.remote || policy?.section !== 'omitted' || policy.drop || !input.prior || input.prior.page.deleted_at) return;
  const removed = await timelineRowsToRemove(engine, parseMarkdown(input.content, input.slug), input.prior, input.slug, input.writer, policy);
  if (removed) throw timelineOmissionRefusal(input.slug, input.sourceId, removed);
}

/**
 * GBRA-215 L3: the ingest report namespace. A page of type ingest-report is written only by the attempt that owns it
 * (an internal report intent through the page door); every generic page mutation (put, capture, edit, append, delete,
 * restore, revert, batch, upload) is refused on one, and none may declare the type. That keeps a report's ownership
 * evidence, which undo trusts, out of any caller's reach. A brain's own files re-imported from Git are not refused.
 *
 * Report slugs (ingest/<attempt_id>) are always reserved. ingest.reserve_namespace (default off) also refuses every
 * generic mutation of any other slug under ingest/: before ingest existed those were ordinary pages, so reserving them
 * all is the owner's choice and no existing page changes behaviour by default.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { BrainEngine } from '../engine.ts';
import { coerceFrontmatterString, parseMarkdownHead, serializePageToMarkdown } from '../markdown.ts';
import { withoutBody } from '../page-body/page-shape.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { Page } from '../types.ts';
import { INGEST_REPORT_PREFIX, INGEST_REPORT_TYPE } from './report.ts';

export const RESERVE_NAMESPACE_KEY = 'ingest.reserve_namespace';
const REPORT_SLUG = /^ingest\/a[0-9a-f]{16}$/;
const LEADING_FRONTMATTER = /^---[^\n]*\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/;

/** Whether a document's leading frontmatter declares the report type; the body never does. */
function declaresReportType(text: string): boolean {
  return coerceFrontmatterString(parseMarkdownHead(text).frontmatter.type) === INGEST_REPORT_TYPE;
}

/**
 * The existing page's frontmatter head after the edits that reach it. An edit matched only after the head's closing
 * fence changes the body, which cannot change the frontmatter; one that straddles the closing fence is applied to the
 * head as far as it reaches. No page body is read.
 */
function editedHead(existing: Pick<PageSnapshot, 'page' | 'tags'>, edits: unknown[]): string {
  let head = serializePageToMarkdown({ ...withoutBody(existing.page), compiled_truth: '', timeline: '' } as Page, existing.tags).slice(0, -1);
  for (const edit of edits) {
    const { old_text: oldText, new_text: newText } = (edit ?? {}) as { old_text?: unknown; new_text?: unknown };
    if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') continue;
    const close = LEADING_FRONTMATTER.exec(head)?.[0].length ?? head.length;
    const at = head.indexOf(oldText);
    if (at !== -1 && at < close) {
      head = head.slice(0, at) + newText + head.slice(at + oldText.length);
      continue;
    }
    for (let from = Math.max(0, head.length - oldText.length + 1); from < close - 1; from++) {
      if (oldText.startsWith(head.slice(from))) { head = head.slice(0, from) + newText; break; }
    }
  }
  return head;
}

function refused(slug: string, why: string): OperationError {
  const attempt = slug.slice(INGEST_REPORT_PREFIX.length);
  return opError('ingest_namespace_reserved', 'Page ' + slug + ' is reserved for ingest reports; generic page writes cannot change it.',
    'Nothing was written. ' + why + ' Undo an ingest with ingest_undo (gbrain ingest-undo <attempt_id>); read a report with ingest-show.',
    { docs: 'docs/guides/ingest.md#reserved-namespace', ...(REPORT_SLUG.test(slug) ? { fix: readFix('Shows the ingest attempt this report belongs to, read-only.', { argv: ['gbrain', 'ingest-show', attempt], mcp: { tool: 'ingest', arguments: { attempt_id: attempt } } }) } : {}) });
}

/** The reserved-type and reserved-namespace check every generic page mutation passes at admission. */
export async function assertIngestNamespaceWritable(engine: BrainEngine, input: { operation: string; slug: string; existing: Pick<PageSnapshot, 'page' | 'tags'> | null | undefined; params: Record<string, unknown> }): Promise<void> {
  const existing = input.existing && !input.existing.page.deleted_at ? input.existing : null;
  if (input.existing?.page.type === INGEST_REPORT_TYPE) throw refused(input.slug, 'Ingest reports are written only by the ingest attempt that owns them.');
  const { content, edits } = input.params;
  if (input.params.type === INGEST_REPORT_TYPE || (typeof content === 'string' && declaresReportType(content))
    || (Array.isArray(edits) && existing && declaresReportType(editedHead(existing, edits)))) {
    throw refused(input.slug, 'The ingest-report page type is reserved for ingest.');
  }
  if (!input.slug.startsWith(INGEST_REPORT_PREFIX)) return;
  if (REPORT_SLUG.test(input.slug)) throw refused(input.slug, 'Slugs of the form ingest/<attempt_id> are written only by the ingest attempt that owns them.');
  const reserve = await engine.getConfig(RESERVE_NAMESPACE_KEY);
  if (reserve != null && /^(true|1|on|yes)$/i.test(reserve.trim())) throw refused(input.slug, 'This brain reserves every slug under ingest/ for ingest reports (ingest.reserve_namespace).');
}

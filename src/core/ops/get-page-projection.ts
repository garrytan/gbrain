import type { Page } from '../types.ts';
import { serializePageToMarkdown } from '../markdown.ts';

export interface GetPageProjectionOpts {
  revision: string;
  tags: string[];
  /** include_content: add the canonical serialized `content` field. */
  includeContent: boolean;
  /** content_only: only meaningful with includeContent; ignored without it. */
  contentOnly: boolean;
  resolved_slug?: string;
  content_flag?: { reason: string; detail: string } | null;
  /** include_timeline_entries (#5709): the page's timeline rows, read by the caller; present in both shapes. */
  timeline_entries?: unknown;
  /** A held source file (sync could not import it); present in both shapes so an editor sees it. */
  file_held?: unknown;
}

/**
 * Shape the get_page response from the reader-visible page body.
 *
 * #2225: `content` is the canonical serialized markdown (frontmatter +
 * compiled_truth + `<!-- timeline -->` sentinel + timeline), built from the
 * visible body so the privacy-fence strip applies to untrusted readers too.
 * content_only returns just what a get→edit→put_page round trip needs (source_id
 * and revision included, so the write goes back to the page that was read), without
 * the duplicate compiled_truth / timeline / frontmatter the full shape carries
 * next to `content` (a 30 KB page otherwise comes back as ~62 KB).
 */
export function projectGetPage(visibleBody: Page, o: GetPageProjectionOpts) {
  const { revision, tags, resolved_slug, content_flag } = o;
  const extras = {
    ...(o.timeline_entries !== undefined ? { timeline_entries: o.timeline_entries } : {}),
    ...(o.file_held !== undefined ? { file_held: o.file_held } : {}),
    ...(resolved_slug ? { resolved_slug } : {}), ...(content_flag ? { content_flag } : {}),
  };
  if (o.includeContent && o.contentOnly) {
    const deletedAt = visibleBody.deleted_at;
    return {
      slug: visibleBody.slug,
      source_id: visibleBody.source_id,
      type: visibleBody.type,
      title: visibleBody.title,
      revision,
      tags,
      content: serializePageToMarkdown(visibleBody, tags),
      ...(deletedAt ? { deleted_at: deletedAt } : {}),
      ...extras,
    };
  }
  return {
    ...visibleBody,
    revision,
    tags,
    ...(o.includeContent ? { content: serializePageToMarkdown(visibleBody, tags) } : {}),
    ...extras,
  };
}

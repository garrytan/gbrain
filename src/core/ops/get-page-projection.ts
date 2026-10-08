import type { Page } from '../types.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isQuarantined, pageQuarantinedNotice, QUARANTINE_KEY } from '../quarantine.ts';
import { hasScope } from '../scope.ts';
import type { OperationContext } from './contract.ts';

/** #6259: how a get_page reader sees a page the content-quality gate hid as junk. */
export interface QuarantinedView { reason: string; detail: string; assessed_at: string | null; body_omitted: boolean }

/**
 * Trusted local reads keep the body (with a notice); untrusted reads get no
 * body unless an `admin`-scoped caller asks with `include_quarantined: true`.
 */
export function quarantinedView(page: Pick<Page, 'frontmatter'>, reader: { remote: boolean; admin: boolean; includeQuarantined: boolean }): QuarantinedView | null {
  const frontmatter = page.frontmatter as Record<string, unknown> | null;
  if (!isQuarantined(frontmatter)) return null;
  const marker = (frontmatter![QUARANTINE_KEY] ?? {}) as Record<string, unknown>;
  return { reason: typeof marker.reason === 'string' ? marker.reason : 'unknown', detail: typeof marker.detail === 'string' ? marker.detail : '',
    assessed_at: typeof marker.assessed_at === 'string' ? marker.assessed_at : null,
    body_omitted: reader.remote && !(reader.admin && reader.includeQuarantined) };
}


/** get_page's read of a quarantined page: its view for this caller (null when not quarantined), with the safety notice emitted. */
export function readQuarantined(ctx: Pick<OperationContext, 'remote' | 'auth' | 'emitNotice'>, page: Pick<Page, 'slug' | 'frontmatter'>, includeQuarantined: boolean): QuarantinedView | null {
  const view = quarantinedView(page, { remote: ctx.remote !== false, admin: hasScope(ctx.auth?.scopes ?? [], 'admin'), includeQuarantined });
  if (view) ctx.emitNotice?.(pageQuarantinedNotice(page.slug, view, 'read'));
  return view;
}

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
  /** #6259: the page is quarantined; `body_omitted` drops compiled_truth, timeline and `content`. */
  quarantined?: QuarantinedView | null;
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
export function projectGetPage(page: Page, o: GetPageProjectionOpts) {
  const { revision, tags, resolved_slug, content_flag, quarantined } = o;
  const omitted = quarantined?.body_omitted === true;
  const visibleBody = omitted ? { ...page, compiled_truth: '', timeline: '' } : page;
  const extras = {
    ...(quarantined ? { quarantined } : {}),
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
      ...(omitted ? {} : { content: serializePageToMarkdown(visibleBody, tags) }),
      ...(deletedAt ? { deleted_at: deletedAt } : {}),
      ...extras,
    };
  }
  return {
    ...visibleBody,
    revision,
    tags,
    ...(o.includeContent && !omitted ? { content: serializePageToMarkdown(visibleBody, tags) } : {}),
    ...extras,
  };
}

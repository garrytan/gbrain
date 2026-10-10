import type { Page } from '../types.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isQuarantined, pageQuarantinedNotice, QUARANTINE_KEY } from '../quarantine.ts';
import { hasScope } from '../scope.ts';
import type { OperationContext } from './contract.ts';
import { createAuditWriter } from '../audit/audit-writer.ts';
import { MEMORY_CONFIRM_SCOPE } from '../trust/confirm.ts';
import { renderTrustedText, type TrustFields } from '../eligibility/labels.ts';
import { loadPageTrust } from '../eligibility/stamp.ts';
import { resolveReadEligibility, type ReadEligibility } from '../eligibility/policy.ts';
import { admitsTrust } from '../trust/tier.ts';

/**
 * #6259: how a get_page reader sees a page the content-quality gate hid as junk.
 * `body_enveloped` (#5575 ENG-15): an untrusted reader authorized for
 * quarantined content gets the body wrapped as external data.
 */
export interface QuarantinedView { reason: string; detail: string; assessed_at: string | null; body_omitted: boolean; body_enveloped?: true }

/**
 * Trusted local reads keep the body (with a notice); untrusted reads get no
 * body unless a caller holding `admin` or `memory_confirm` (`reader.admin`)
 * asks with `include_quarantined: true`, and then only inside the data envelope.
 */
export function quarantinedView(page: Pick<Page, 'frontmatter'>, reader: { remote: boolean; admin: boolean; includeQuarantined: boolean }): QuarantinedView | null {
  const frontmatter = page.frontmatter as Record<string, unknown> | null;
  if (!isQuarantined(frontmatter)) return null;
  const marker = (frontmatter![QUARANTINE_KEY] ?? {}) as Record<string, unknown>;
  return { reason: typeof marker.reason === 'string' ? marker.reason : 'unknown', detail: typeof marker.detail === 'string' ? marker.detail : '',
    assessed_at: typeof marker.assessed_at === 'string' ? marker.assessed_at : null,
    body_omitted: reader.remote && !(reader.admin && reader.includeQuarantined),
    ...(reader.remote && reader.admin && reader.includeQuarantined ? { body_enveloped: true as const } : {}) };
}

const quarantinedReads = createAuditWriter<{ ts: string; slug: string; source_id: string; client_id: string; reason: string }>({ featureName: 'quarantined-reads' });


/** get_page's read of a quarantined page: its view for this caller (null when not quarantined), with the safety notice emitted. */
export function readQuarantined(ctx: Pick<OperationContext, 'remote' | 'auth' | 'emitNotice'>, page: Pick<Page, 'slug' | 'frontmatter' | 'source_id'>, includeQuarantined: boolean): QuarantinedView | null {
  const scopes = ctx.auth?.scopes ?? [];
  const authorized = hasScope(scopes, 'admin') || hasScope(scopes, MEMORY_CONFIRM_SCOPE);
  const view = quarantinedView(page, { remote: ctx.remote !== false, admin: authorized, includeQuarantined });
  if (view) ctx.emitNotice?.(pageQuarantinedNotice(page.slug, view, 'read'));
  if (view?.body_enveloped) quarantinedReads.log({ slug: page.slug, source_id: page.source_id, client_id: ctx.auth?.clientId ?? '', reason: view.reason });
  return view;
}

/** Wraps quarantined text for an untrusted reader as external data (eligibility/labels.ts). */
function enveloped(text: string, fields: TrustFields | undefined): string {
  return text ? renderTrustedText(text, { trust_tier: 'external_untrusted', origin: fields?.origin ?? 'quarantined' }) : text;
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
  /** #5575 A6: the page's trust tier and short write origin. */
  trust?: TrustFields;
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
  const wrap = quarantined?.body_enveloped === true;
  const visibleBody = omitted ? { ...page, compiled_truth: '', timeline: '' }
    : wrap ? { ...page, compiled_truth: enveloped(page.compiled_truth, o.trust), timeline: enveloped(page.timeline, o.trust) } : page;
  const content = () => wrap ? enveloped(serializePageToMarkdown(page, tags), o.trust) : serializePageToMarkdown(visibleBody, tags);
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
      ...(omitted ? {} : { content: content() }),
      ...(deletedAt ? { deleted_at: deletedAt } : {}),
      ...extras,
    };
  }
  return {
    ...visibleBody,
    revision,
    tags,
    ...(o.includeContent && !omitted ? { content: content() } : {}),
    // #5575 A6: the reading shape carries the page's trust; the content_only round-trip shape stays minimal.
    ...(o.trust ?? {}),
    ...extras,
  };
}

/**
 * #5575 (A6, CEO-18, ENG-14): get_page and fetch read one page's trust once.
 * Returns its label fields and the read eligibility (for the page's timeline
 * rows), or null when the page sits below the effective read floor, which the
 * caller answers exactly like a missing page (no existence oracle).
 */
export async function pageTrustForRead(ctx: Pick<OperationContext, 'engine' | 'auth'>, page: Pick<Page, 'id'>, minTrust: unknown):
  Promise<{ trust: TrustFields; eligibility: ReadEligibility } | null> {
  const eligibility = await resolveReadEligibility(ctx, { minTrust });
  const trust = (await loadPageTrust(ctx.engine, [{ page_id: page.id, slug: '' }]).catch(() => null))?.byId.get(page.id)
    ?? { trust_tier: 'unknown' as const, origin: 'unrecorded' };
  if (eligibility.floor && !admitsTrust(trust.trust_tier, eligibility.floor)) return null;
  return { trust, eligibility };
}

/** fetch's `text`: withheld for an unauthorized untrusted reader, enveloped for an authorized one (#6259, ENG-15). */
export function projectFetchText(visibleBody: Page, tags: string[], quarantined: QuarantinedView | null, trust?: TrustFields): string {
  if (quarantined?.body_omitted) return '';
  const text = serializePageToMarkdown(visibleBody, tags);
  return quarantined?.body_enveloped ? enveloped(text, trust) : text;
}

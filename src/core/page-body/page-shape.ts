/**
 * Segmented page storage (Wave B): how a page object says where its body
 * lives. A segmented page (`body_storage = 'segmented'`) keeps its body in
 * `page_body_manifest` + `page_segment_texts`; its `compiled_truth` and
 * `timeline` columns are NULL. Every reader that turns a page row into a
 * `Page` (`rowToPage`, the snapshot readers) gives such a page enumerable
 * getters for the body fields that throw `page_body_segmented`, so a path
 * that needs the whole body as one string fails before it reads or writes
 * anything, and so do `{...page}`, `JSON.stringify(page)` and `structuredClone`.
 *
 * `Page` itself stays one shape (making it a union broke over a thousand
 * sites): the runtime getters and `scripts/check-page-body-readers.ts` are the
 * enforcement, not the type checker.
 */
import { opError } from '../ops/contract.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import type { Page } from '../types.ts';
import type { BodyStorage } from './types.ts';

/** A segmented page as metadata: no body strings, only its size. */
export type SegmentedPage = Omit<Page, 'compiled_truth' | 'timeline'> & { body_storage: 'segmented'; body_bytes: number };

type BodyShape = { body_storage?: BodyStorage | null; body_bytes?: number | null };

/** The body fields a page-like object exposes; `content` where the object carries a rendered page. */
export type SegmentedBodyField = 'compiled_truth' | 'timeline' | 'content';

/** True when the page's body lives in segments (its body fields throw). */
export function isSegmentedPage(page: BodyShape): boolean {
  return page.body_storage === 'segmented';
}

/**
 * True when the page's body fields are still the throwing getters: a segmented
 * page that was not read back as strings (`materializedPage` leaves a body over
 * the single-string ceiling unread). Such a body was written by the streamed
 * import, which holds files with facts or takes fences.
 */
export function bodyUnread(page: object): boolean {
  return Object.getOwnPropertyDescriptor(page, 'compiled_truth')?.get !== undefined;
}

/** The page's fields without its body, for a copy whose body comes from elsewhere (a page with an unread body cannot be spread). */
export function withoutBody<T extends object>(page: T): Omit<T, SegmentedBodyField> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(page)) if (key !== 'compiled_truth' && key !== 'timeline' && key !== 'content') copy[key] = (page as Record<string, unknown>)[key];
  return copy as Omit<T, SegmentedBodyField>;
}

/** The stored body a fence merge reads: an unread body holds no facts or takes fences, so it reads as empty. */
export function fenceBody(page: { compiled_truth: string; timeline?: string | null }): { compiled_truth: string; timeline: string } {
  return bodyUnread(page) ? { compiled_truth: '', timeline: '' } : { compiled_truth: page.compiled_truth, timeline: page.timeline ?? '' };
}

/** The refusal every whole-body path gives a segmented page; `site` names the path in the message. */
export function pageBodySegmentedError(page: { slug?: string; source_id?: string }, site: string) {
  const slug = page.slug ?? '<unknown>';
  const sourceId = page.source_id ?? 'default';
  return opError('page_body_segmented',
    `${site}: page ${slug} (source ${sourceId}) stores its body in segments, and this path reads or writes the whole body as one string. Nothing was read or changed.`,
    "This path cannot process a page stored in segments yet; retrying refuses the same way. Read the page in pieces: get_page body: 'auto' returns its outline and first window, and body: 'window' reads any lines or bytes.",
    { fix: { argv: ['gbrain', 'get', '--source', sourceId, '--body', 'auto', '--', slug],
      mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, body: 'auto' } },
      consent: [], actor: 'agent', requires_exclusive: false, why: "Returns the page's outline and its first window, with next_cursor to read on." } });
}

/**
 * The refusal of a write that reads the body whole (a fence or timeline edit through the put path) on a segmented page
 * over PAGE_MAX_BYTES (24 MiB): up to it the page is read back as strings and written as a normal put.
 */
export function pageBodyOverCeilingError(page: { slug?: string; source_id?: string; body_bytes?: number | null }, site: string) {
  const slug = page.slug ?? '<unknown>';
  const sourceId = page.source_id ?? 'default';
  return opError('page_body_segmented',
    `${site}: page ${slug} (source ${sourceId}) stores its ${Number(page.body_bytes ?? 0)}-byte body in segments, over the 24 MiB (${PAGE_MAX_BYTES}-byte) limit up to which this write reads the body whole. Nothing was read or changed.`,
    "This write edits a page stored in segments by reading its body whole, which works up to 24 MiB; this page is larger, so retrying refuses the same way. Read the page in pieces: get_page body: 'auto' returns its outline and first window, and body: 'window' reads any lines or bytes.",
    { fix: { argv: ['gbrain', 'get', '--source', sourceId, '--body', 'auto', '--', slug],
      mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, body: 'auto' } },
      consent: [], actor: 'agent', requires_exclusive: false, why: "Returns the page's outline and its first window, with next_cursor to read on." } });
}

/** Throws `page_body_segmented` for a segmented page; `site` names the caller. Inline pages pass. */
export function assertInlineBody(page: BodyShape & { slug?: string; source_id?: string }, site: string): void {
  if (isSegmentedPage(page)) throw pageBodySegmentedError(page, site);
}

/**
 * UTF-8 bytes of the page body: `body_bytes` for a segmented page (its body is
 * never loaded), else the bytes of `compiled_truth` + `timeline`.
 */
export function pageBodyBytes(page: BodyShape & { compiled_truth?: string | null; timeline?: string | null }): number {
  if (isSegmentedPage(page)) return Number(page.body_bytes ?? 0);
  return Buffer.byteLength(page.compiled_truth ?? '', 'utf8') + Buffer.byteLength(page.timeline ?? '', 'utf8');
}

/**
 * Replace the body fields of a segmented page object with enumerable getters
 * and setters that throw `page_body_segmented`. Enumerable on purpose: spread,
 * `JSON.stringify` and `Object.assign` read them and throw instead of copying
 * an empty body.
 */
export function guardSegmentedBody<T extends object>(page: T, site: string,
  fields: readonly SegmentedBodyField[] = ['compiled_truth', 'timeline']): T {
  const ref = page as { slug?: string; source_id?: string };
  for (const field of fields) {
    const refuse = (): never => { throw pageBodySegmentedError(ref, `${site}.${field}`); };
    Object.defineProperty(page, field, { enumerable: true, configurable: false, get: refuse, set: refuse });
  }
  return page;
}

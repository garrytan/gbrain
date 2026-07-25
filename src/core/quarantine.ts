/**
 * Content-quality markers stored in page frontmatter.
 *
 * `quarantine` hides high-confidence junk from search while preserving the
 * page for review. `content_flag` keeps a suspicious page searchable and
 * exposes a warning to retrieval callers. No schema migration is required.
 */

export const QUARANTINE_KEY = 'quarantine';

export function quarantineFilterFragment(pageAlias: string): string {
  return `NOT (COALESCE(${pageAlias}.frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}')`;
}

export const QUARANTINE_FILTER_FRAGMENT = quarantineFilterFragment('p');

export interface QuarantineMarker {
  reason: 'junk_pattern' | 'literal_substring';
  detail: string;
  assessed_at: string;
  bytes?: number;
}

export function buildQuarantineMarker(
  reason: QuarantineMarker['reason'],
  detail: string,
  extra: { bytes?: number; now?: Date } = {},
): QuarantineMarker {
  return {
    reason,
    detail,
    assessed_at: (extra.now ?? new Date()).toISOString(),
    ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
  };
}

export function isQuarantined(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  if (!frontmatter) return false;
  const value = frontmatter[QUARANTINE_KEY];
  return value !== undefined && value !== null;
}

export function filterOutQuarantined<
  T extends { frontmatter?: Record<string, unknown> | null },
>(pages: ReadonlyArray<T>): T[] {
  return pages.filter((page) => !isQuarantined(page.frontmatter ?? null));
}

export const CONTENT_FLAG_KEY = 'content_flag';

export interface ContentFlagMarker {
  reason: 'markup_heavy' | 'oversized';
  detail: string;
  assessed_at: string;
  markup_ratio?: number;
  bytes?: number;
}

export function buildContentFlagMarker(
  reason: ContentFlagMarker['reason'],
  detail: string,
  extra: { markup_ratio?: number; bytes?: number; now?: Date } = {},
): ContentFlagMarker {
  return {
    reason,
    detail,
    assessed_at: (extra.now ?? new Date()).toISOString(),
    ...(extra.markup_ratio !== undefined ? { markup_ratio: extra.markup_ratio } : {}),
    ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
  };
}

export function getContentFlag(
  frontmatter: Record<string, unknown> | null | undefined,
): { reason: string; detail: string } | null {
  if (!frontmatter) return null;
  const value = frontmatter[CONTENT_FLAG_KEY];
  if (!value || typeof value !== 'object') return null;
  const marker = value as Record<string, unknown>;
  if (typeof marker.reason !== 'string' || marker.reason.length === 0) return null;
  return {
    reason: marker.reason,
    detail: typeof marker.detail === 'string' ? marker.detail : '',
  };
}

export function hasContentFlag(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  return getContentFlag(frontmatter) !== null;
}

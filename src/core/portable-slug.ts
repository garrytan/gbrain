/**
 * Page slugs whose file names every supported platform can store (GBRA-130
 * B-5, B-12). A page lives at `<slug>.md` (its raw sidecar at
 * `.raw/<leaf>.json`), so each slug segment becomes a file or directory name:
 * Windows refuses its reserved device names (`con`, `aux`, `nul.x`, `com1`,
 * ...) and file systems cap a name at 255 bytes, which a 255-character
 * segment in a multi-byte script passes in UTF-16 units but not in bytes.
 *
 * `slugPortabilityProblem` is the rule new page identities are admitted under
 * (put_page, put_pages; persistence/suffixed-slug.ts), entity stubs mint
 * around (enrichment-service.ts slugifyEntity), and export escapes for pages
 * an older gbrain admitted (export-stage.ts exportPagePath). Existing pages
 * keep accepting updates; the colon namespace (`ns:foo`) is slug grammar and
 * is not a portability problem here (export escapes it).
 */

/** Longest file name, in UTF-8 bytes, a page's files may use: the export and write-through budget. */
export const FILE_NAME_MAX_BYTES = 240;
/** The longest extension a slug's leaf segment gets on disk (`.raw/<leaf>.json`; the page itself is `<leaf>.md`). */
const LEAF_EXTENSION_BYTES = '.json'.length;
/** A Windows reserved device name, alone or before an extension (`aux`, `nul.x`). */
export const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?=\.|$)/i;

export interface SlugPortabilityProblem {
  reason: 'reserved_name' | 'segment_too_long';
  /** The first offending segment. */
  segment: string;
  /** The slug with every offending segment made portable: the slug to write instead. */
  suggestion: string;
}

/** The byte budget of one segment's name: a leaf also carries its extension. */
export function segmentByteBudget(leaf: boolean): number {
  return FILE_NAME_MAX_BYTES - (leaf ? LEAF_EXTENSION_BYTES : 0);
}

/** The longest prefix of `text` within `bytes` UTF-8 bytes, cut at a code point boundary. */
export function truncateUtf8(text: string, bytes: number): string {
  let used = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    used += size;
    out += char;
  }
  return out;
}

/** One segment made portable: a reserved device name gets `-<suffix>`, an over-long name is cut to its budget. */
export function portableSegment(segment: string, leaf: boolean, suffix = 'page'): string {
  const renamed = segment.replace(RESERVED_DEVICE_NAME, name => `${name}-${suffix}`);
  const budget = segmentByteBudget(leaf);
  return Buffer.byteLength(renamed) <= budget ? renamed : truncateUtf8(renamed, budget).replace(/[-._:]+$/, '');
}

/** Null when every segment of `slug` is a portable file name; otherwise the first problem and the portable slug to use. */
export function slugPortabilityProblem(slug: string, suffix = 'page'): SlugPortabilityProblem | null {
  const segments = slug.split('/');
  let first: Omit<SlugPortabilityProblem, 'suggestion'> | null = null;
  const fixed = segments.map((segment, i) => {
    const leaf = i === segments.length - 1;
    const reserved = RESERVED_DEVICE_NAME.test(segment);
    if (!reserved && Buffer.byteLength(segment) <= segmentByteBudget(leaf)) return segment;
    first ??= { reason: reserved ? 'reserved_name' : 'segment_too_long', segment };
    return portableSegment(segment, leaf, suffix);
  });
  return first === null ? null : { ...(first as Omit<SlugPortabilityProblem, 'suggestion'>), suggestion: fixed.join('/') };
}

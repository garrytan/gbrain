import { normalizeAlias, normalizeAliasList } from './search/alias-normalize.ts';
import { buildBasenameIndex, queryBasenameIndex, normalizeBasename, FRONTMATTER_LINK_MAP, type LinkExtractionPack } from './link-extraction.ts';
import { slugifyPath, slugifySegment } from './sync.ts';
import { opError } from './ops/contract.ts';
import { DEFAULT_REFERENCE_LIMITS, type SourceLocalReferenceLimits } from './source-local-reference-limits.ts';

export interface SourceLocalReferencePage {
  slug: string;
  title: string;
  aliases?: unknown;
}

export function buildSourceLocalReferenceIndex(pages: readonly SourceLocalReferencePage[], limits: SourceLocalReferenceLimits = DEFAULT_REFERENCE_LIMITS) {
  if (pages.length > limits.maxPages) throw opError('request_too_large', `Reference metadata exceeds ${limits.maxPages.toLocaleString('en-US')} pages; partition the source or raise links.reference_index_max_pages.`,
    `The source has ${pages.length} pages. Raise links.reference_index_max_pages with gbrain config set on the host if memory permits, or split the source; for a company import, inspect again with narrower --include and --exclude globs.`);
  const slugs = new Map<string, string[]>();
  const names = new Map<string, Set<string>>();
  let bytes = 0;
  const keys = (name: string) => new Set([normalizeAlias(name), normalizeBasename(name), slugifySegment(name)].filter(Boolean));
  for (const page of pages) {
    const aliases = normalizeAliasList(page.aliases);
    bytes += Buffer.byteLength(JSON.stringify([page.slug, page.title, aliases]));
    if (bytes > limits.maxBytes) throw opError('request_too_large', `Reference metadata exceeds ${limits.maxBytes / 1024 ** 2} MiB; narrow the source or raise links.reference_index_max_bytes.`,
      `The slugs, titles and aliases exceed ${limits.maxBytes} bytes. Raise links.reference_index_max_bytes with gbrain config set on the host if memory permits, or split the source or trim long aliases; for a company import, inspect again with narrower --include and --exclude globs.`);
    const sameSlug = slugs.get(page.slug) ?? [];
    sameSlug.push(page.slug);
    slugs.set(page.slug, sameSlug);
    for (const name of [page.title, page.slug.split('/').at(-1)!, ...aliases]) {
      for (const key of keys(name)) {
        const matches = names.get(key) ?? new Set<string>();
        matches.add(page.slug);
        names.set(key, matches);
      }
    }
  }
  const basenames = buildBasenameIndex(slugs.keys());
  const exactMatches = (name: string) => slugs.get(name) ?? [];
  const namedMatches = (name: string, dirHint?: string | string[]) => {
    const hints = Array.isArray(dirHint) ? dirHint : dirHint ? [dirHint] : [];
    const matches = new Set<string>();
    for (const key of keys(name)) for (const slug of names.get(key) ?? []) {
      if (!hints.length || hints.some(hint => slug.startsWith(`${hint}/`))) matches.add(slug);
    }
    return [...matches].sort();
  };
  return {
    exactMatches,
    namedMatches,
    resolveMatches(name: string, dirHint?: string | string[]): string[] {
      const value = name.trim();
      if (!value || value.includes(':') || /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => part === '..' || part === '.')) return [];
      const direct = exactMatches(value);
      if (direct.length) return direct;
      if (value.includes('/')) return exactMatches(slugifyPath(value));
      const rootMatches = [...new Set([slugifyPath(value), normalizeBasename(value)])].flatMap(exactMatches);
      return rootMatches.length ? rootMatches : namedMatches(value, dirHint);
    },
    basenameMatches(name: string): string[] {
      return name.includes(':') ? [] : queryBasenameIndex(basenames, name);
    },
  };
}

export function frontmatterReferenceHints(pack: LinkExtractionPack, pageType: string, field: string): string | string[] {
  const mapping = pack.frontmatter_links.find(item => item.page_type === pageType && item.fields.includes(field));
  const expectedType = pack.link_types.find(item => item.name === mapping?.link_type)?.inference?.target_type;
  const prefixes = pack.page_types?.find(item => item.name === expectedType)?.path_prefixes.map(prefix => prefix.replace(/^\/+|\/+$/g, ''));
  const legacy = FRONTMATTER_LINK_MAP.find(item => item.fields.includes(field) && (!item.pageType || item.pageType === pageType));
  return prefixes?.length ? prefixes : legacy?.dirHint ?? '';
}

/**
 * Memory group audience policy — server-side enforcement for page access.
 *
 * Pages declare `audience: [coding, project:gbrain]` in YAML frontmatter
 * (stored in pages.frontmatter JSONB). Groups declare which audiences they
 * may read/write. Unassigned OAuth clients are denied reads (fail closed).
 */

export interface MemoryGroupPolicy {
  id: string;
  name: string;
  readAudiences: string[];
  writeAudiences: string[];
  readSlugPrefixes: string[];
  writeSlugPrefixes: string[];
  deniedAudiences: string[];
  bypassPolicy: boolean;
}

/** Default when frontmatter has no audience field. */
export const DEFAULT_PAGE_AUDIENCES = ['public'] as const;

export function normalizePageAudiences(frontmatter: Record<string, unknown> | undefined | null): string[] {
  if (!frontmatter || typeof frontmatter !== 'object') {
    return [...DEFAULT_PAGE_AUDIENCES];
  }
  const raw = frontmatter.audience;
  if (raw == null) return [...DEFAULT_PAGE_AUDIENCES];
  if (Array.isArray(raw)) {
    const list = raw.map((v) => String(v).trim()).filter(Boolean);
    return list.length ? list : [...DEFAULT_PAGE_AUDIENCES];
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [...DEFAULT_PAGE_AUDIENCES];
}

/** Match policy pattern against a single page audience tag (supports `*` and `project:*`). */
export function audiencePatternMatches(pattern: string, pageAudience: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return pageAudience === prefix || pageAudience.startsWith(`${prefix}:`);
  }
  return pattern === pageAudience;
}

export function audiencesAllowed(policyAudiences: string[], pageAudiences: string[]): boolean {
  if (policyAudiences.some((p) => p === '*')) return true;
  for (const pattern of policyAudiences) {
    for (const pageAud of pageAudiences) {
      if (audiencePatternMatches(pattern, pageAud)) return true;
    }
  }
  return false;
}

export function slugMatchesPrefixes(slug: string, prefixes: string[]): boolean {
  if (!prefixes.length) return true;
  return prefixes.some((p) => slug === p || slug.startsWith(p.endsWith('/') ? p : `${p}/`) || slug.startsWith(p));
}

export function canReadPage(
  group: MemoryGroupPolicy | null | undefined,
  pageAudiences: string[],
  slug: string,
): boolean {
  if (!group) return false;
  if (group.bypassPolicy) return true;
  if (group.deniedAudiences.length && audiencesAllowed(group.deniedAudiences, pageAudiences)) {
    return false;
  }
  if (!audiencesAllowed(group.readAudiences, pageAudiences)) return false;
  return slugMatchesPrefixes(slug, group.readSlugPrefixes);
}

export function canWritePage(
  group: MemoryGroupPolicy | null | undefined,
  pageAudiences: string[],
  slug: string,
): boolean {
  if (!group) return false;
  if (group.bypassPolicy) return true;
  if (group.deniedAudiences.length && audiencesAllowed(group.deniedAudiences, pageAudiences)) {
    return false;
  }
  if (!audiencesAllowed(group.writeAudiences, pageAudiences)) return false;
  return slugMatchesPrefixes(slug, group.writeSlugPrefixes);
}

export function parseAudiencesFromMarkdown(content: string): string[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [...DEFAULT_PAGE_AUDIENCES];
  const block = match[1];
  const line = block.split(/\r?\n/).find((l) => /^audience:\s*\[/.test(l));
  if (!line) return [...DEFAULT_PAGE_AUDIENCES];
  const inner = line.replace(/^audience:\s*\[|\]\s*$/g, '');
  const tags = inner
    .split(',')
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return tags.length ? tags : [...DEFAULT_PAGE_AUDIENCES];
}

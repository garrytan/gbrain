import type { BrainEngine } from '../../../core/engine.ts';
import { retiredPageSql } from '../../../core/entities/resolve.ts';
import { normalizeAlias, normalizeAliasList } from '../../../core/search/alias-normalize.ts';
import type { TitleDuplicatePair } from './entity-duplicates.ts';

const ENTITY_TYPES = new Set(['person', 'company', 'organization', 'fund', 'project', 'entity']);
const ORGANIZATIONS = new Set(['company', 'organization', 'fund']);
// Provider labels rather than corporate identity: these domains cannot identify an organization.
const PUBLIC_PROVIDERS = new Set(['gmail', 'googlemail', 'yahoo', 'hotmail', 'outlook', 'live', 'icloud', 'me', 'aol', 'proton', 'protonmail', 'pm', 'msn', 'mail', 'gmx', 'fastmail']);

function domainKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`);
    const domain = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return PUBLIC_PROVIDERS.has(domain.split('.')[0]!) ? '' : domain;
  } catch { return ''; }
}

/** Whole-source inverted indexes avoid an all-pages quadratic comparison.
 * The existing (source_id, stub, canonical) tuple is the stable pair identity;
 * ordering denotes a review pair, never a recommended merge direction.
 */
export async function entityCollisionPairs(engine: BrainEngine, sourceId: string): Promise<TitleDuplicatePair[]> {
  const pages = await engine.executeRaw<{ slug: string; title: string; type: string; frontmatter: Record<string, unknown> }>(
    `SELECT slug, title, type, frontmatter FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND NOT ${retiredPageSql('pages')}
      ORDER BY slug`, [sourceId]);
  const groups = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  const add = (index: Map<string, Set<string>>, key: string, slug: string) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key)!.add(slug);
  };
  for (const page of pages) {
    if (!ENTITY_TYPES.has(page.type)) continue;
    const fm = page.frontmatter ?? {};
    if (page.type === 'person') {
      for (const value of [fm.email, fm.emails].flat()) {
        if (typeof value === 'string' && value.includes('@')) add(groups, `email:${value.trim().toLowerCase()}`, page.slug);
      }
    }
    if (ORGANIZATIONS.has(page.type)) {
      for (const value of [fm.domain, fm.domains, fm.website, fm.url].flat()) {
        const domain = domainKey(value);
        if (domain) add(groups, `domain:${domain}`, page.slug);
      }
    }
    for (const name of [page.title, page.slug, page.slug.split('/').pop()!.replace(/-/g, ' ')]) {
      add(names, normalizeAlias(name), page.slug);
    }
    for (const alias of normalizeAliasList(fm.aliases)) {
      add(aliases, alias, page.slug);
      add(names, alias, page.slug);
    }
  }
  const pairs = new Map<string, TitleDuplicatePair>();
  const pair = (a: string, b: string) => {
    if (a === b) return;
    const [stub, canonical] = [a, b].sort();
    pairs.set(JSON.stringify([stub, canonical]), { source_id: sourceId, stub: stub!, canonical: canonical!, stub_links: 0, canonical_links: 0 });
  };
  for (const group of groups.values()) {
    const slugs = [...group].sort();
    for (let i = 0; i < slugs.length; i++) for (let j = i + 1; j < slugs.length; j++) pair(slugs[i]!, slugs[j]!);
  }
  for (const [alias, owners] of aliases) {
    for (const owner of owners) for (const target of names.get(alias) ?? []) pair(owner, target);
  }
  return [...pairs.values()].sort((a, b) => a.stub.localeCompare(b.stub) || a.canonical.localeCompare(b.canonical));
}

/**
 * `entity` with `names`: resolve a list of names, codes and aliases in one
 * call, the way a reader resolves the account codes and nicknames a batch of
 * handoff mails names. Each name resolves exactly as `entity name:` does
 * (buildEntityCard's alias, slug, title and fuzzy arms, private pages hidden
 * from remote callers) and returns a compact row: the page, its names, the
 * opening lines of its body (`lead`) and its identity siblings with theirs.
 * No references, facts or open threads: a full card per name is `entity name:`.
 *
 * Bounded: at most ENTITY_NAMES_MAX names, ENTITY_LEAD_CHARS per lead,
 * duplicates resolved once.
 */
import type { BrainEngine } from '../engine.ts';
import { buildEntityCard } from './entity-card.ts';
import { readCardIdentity } from './entity-card-identity.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { redactFindings } from '../secret-scan.ts';

export const ENTITY_NAMES_MAX = 50;
export const ENTITY_LEAD_CHARS = 200;
const CONCURRENCY = 8;

export interface EntityNamePage { slug: string; title: string; type: string | null; aka: string[]; lead: string }
export type EntityNameRow =
  | ({ name: string; found: true } & EntityNamePage & { siblings?: EntityNamePage[] })
  | { name: string; found: false; suggestions?: Array<{ slug: string; title: string }> };

/** The opening prose of a page body: fences and secrets removed, headings, markers and table rows dropped, up to `max` characters. */
export function pageLead(body: string | null, max = ENTITY_LEAD_CHARS): string {
  const text = redactFindings(sanitizeRemoteBody(body ?? ''), { highEntropy: true }).text
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('<!--') && !l.startsWith('|'))
    .join(' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export async function lookupEntityNames(engine: BrainEngine, sourceId: string, names: string[],
  opts: { remote: boolean; surfaceCeiling?: 'verbs' | 'starter' | 'full' }): Promise<{ results: EntityNameRow[]; found: number; missing: number }> {
  const unique = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  const rows = new Map<string, EntityNameRow>();
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    await Promise.all(unique.slice(i, i + CONCURRENCY).map(async name => rows.set(name, await lookupOne(engine, sourceId, name, opts))));
  }
  const results = unique.map(n => rows.get(n)!);
  const found = results.filter(r => r.found).length;
  return { results, found, missing: results.length - found };
}

async function lookupOne(engine: BrainEngine, sourceId: string, name: string,
  opts: { remote: boolean; surfaceCeiling?: 'verbs' | 'starter' | 'full' }): Promise<EntityNameRow> {
  const result = await buildEntityCard(engine, sourceId, name, { remote: opts.remote, includeReferences: false });
  if (!result.found || !result.card) {
    const suggestions = (result.suggestions ?? []).slice(0, 3).map(s => ({ slug: s.slug, title: s.title }));
    return { name, found: false, ...(suggestions.length ? { suggestions } : {}) };
  }
  const { entity, aka } = result.card;
  const [row] = await engine.executeRaw<{ slug: string; title: string | null; compiled_truth: string | null }>(
    'SELECT slug, title, compiled_truth FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, entity.slug]);
  const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
  const excludePrivate = await resolveExcludePrivatePages(engine, opts.remote ? undefined : false);
  const identity = row ? await readCardIdentity(engine, sourceId, row, { excludePrivate, surfaceCeiling: opts.surfaceCeiling, aka }).catch(() => null) : null;
  const siblingPages = identity?.identity_siblings?.pages ?? [];
  const bodies = new Map<string, string | null>([[entity.slug, row?.compiled_truth ?? null]]);
  if (siblingPages.length) {
    const sib = await engine.executeRaw<{ slug: string; compiled_truth: string | null }>(
      'SELECT slug, compiled_truth FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL',
      [sourceId, siblingPages.map(p => p.slug)]).catch(() => []);
    for (const s of sib) bodies.set(s.slug, s.compiled_truth);
  }
  return {
    name, found: true, slug: entity.slug, title: entity.title, type: entity.type, aka, lead: pageLead(bodies.get(entity.slug) ?? null),
    ...(siblingPages.length ? { siblings: siblingPages.map(p => ({ slug: p.slug, title: p.title, type: p.type, aka: p.aka, lead: pageLead(bodies.get(p.slug) ?? null) })) } : {}),
  };
}

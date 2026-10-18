/**
 * `entity` with `names`: resolve a list of names, codes and aliases in one
 * call, the way a reader resolves the account codes and nicknames a batch of
 * handoff mails names. Each name resolves exactly as `entity name:` does
 * (the card's candidate selection, `selectEntityCandidates`: alias, slug,
 * title and suffix arms; private and quarantined pages, siblings included,
 * hidden from remote callers) and returns a compact row: the page, its names,
 * the opening lines of its body (`lead`, from the candidate row) and its
 * identity siblings with theirs. No card is assembled (no facts or open
 * threads: a full card per name is `entity name:`), and the private-page
 * setting, mention policy and source pack are read once per batch. Each found
 * page and sibling also carries `referenced_by_count` and a `next` to its full
 * card (`entity.names_references`, default on), and `records` when record
 * types are enrolled (`entity.record_types`), from one batched read for the
 * whole call (verbs/entity-references.ts).
 *
 * Bounded: at most ENTITY_NAMES_MAX names, ENTITY_LEAD_CHARS per lead,
 * duplicates resolved once; records RECORD_ROWS_PER_TARGET per page and
 * RECORD_ROWS_PER_CALL per call, allotted in input order.
 */
import type { BrainEngine } from '../engine.ts';
import { readAka, selectAcrossSources, type EntityLookupScope } from './entity-card.ts';
import { readSiblingIdentity } from './entity-card-identity.ts';
import { boundedProjectedPrefix } from '../page-window/document.ts';
import { boundedBodyPrefixSql, overlaidBoundedRows } from '../page-window/bounded-lead.ts';
import { redactFindings } from '../secret-scan.ts';
import type { Notice } from '../agent-output.ts';
import { readRowReferences, type RowReferences } from './entity-references.ts';
import { mentionCoverageNotice, readMentionCoverage } from '../mentions/coverage.ts';

export const ENTITY_NAMES_MAX = 50;
export const ENTITY_LEAD_CHARS = 200;
const CONCURRENCY = 8;

export interface EntityNamePage extends RowReferences { slug: string; title: string; type: string | null; aka: string[]; lead: string }
export type EntityNameRow =
  | ({ name: string; found: true; source_id: string } & EntityNamePage & { siblings?: EntityNamePage[] })
  | { name: string; found: false; suggestions?: Array<{ slug: string; title: string }> };

/** The opening prose of a page body: fences and secrets removed, headings, markers and table rows dropped, up to `max` characters. */
export function pageLead(body: string | null, max = ENTITY_LEAD_CHARS): string {
  const text = redactFindings(boundedProjectedPrefix(body), { highEntropy: true }).text
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('<!--') && !l.startsWith('|'))
    .join(' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export async function lookupEntityNames(engine: BrainEngine, sourceId: string, names: string[],
  opts: { remote: boolean; sources?: readonly string[]; surfaceCeiling?: 'verbs' | 'starter' | 'full'; emitNotice?: (n: Notice) => void }): Promise<{ results: EntityNameRow[]; found: number; missing: number }> {
  const unique = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  // #6723: each name resolves in the first source (home first) with a hit; a source's lookup scope is read once per batch.
  const sources = opts.sources?.length ? opts.sources : [sourceId];
  const scopes = new Map<string, Promise<EntityLookupScope>>();
  const excludePrivate = new Map<string, boolean>();
  const rows = new Map<string, EntityNameRow>();
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    await Promise.all(unique.slice(i, i + CONCURRENCY).map(async name => {
      const { sourceId: hitSource, scope, selected } = await selectAcrossSources(engine, sources, name, opts.remote, { omitQuarantined: opts.remote, scopes });
      excludePrivate.set(hitSource, scope.excludePrivate);
      rows.set(name, await lookupOne(engine, hitSource, name, scope, selected, opts));
    }));
  }
  const results = unique.map(n => rows.get(n)!);
  for (const [src, exclude] of excludePrivate) {
    await attachReferences(engine, src, results.filter(r => r.found && r.source_id === src), exclude, { ...opts, home: sources[0]! });
  }
  const found = results.filter(r => r.found).length;
  return { results, found, missing: results.length - found };
}

/** One batched reference read per source for every found page and sibling, in input order (page first, then its siblings). */
async function attachReferences(engine: BrainEngine, sourceId: string, results: EntityNameRow[], excludePrivate: boolean,
  opts: { remote: boolean; home: string; surfaceCeiling?: 'verbs' | 'starter' | 'full'; emitNotice?: (n: Notice) => void }): Promise<void> {
  const pages: EntityNamePage[] = [];
  for (const r of results) if (r.found) pages.push(r, ...(r.siblings ?? []));
  if (!pages.length) return;
  const refs = await readRowReferences(engine, sourceId, pages.map(p => ({ slug: p.slug, sourceId })),
    { remote: opts.remote, excludePrivate, surfaceCeiling: opts.surfaceCeiling, surface: 'names', emitNotice: opts.emitNotice });
  // A follow-up for a page outside the caller's home source names its source.
  pages.forEach((p, i) => Object.assign(p, refs.rows[i], sourceId !== opts.home && refs.rows[i]?.next
    ? { next: { ...refs.rows[i]!.next, arguments: { ...refs.rows[i]!.next!.arguments, source_id: sourceId } } } : {}));
  if (refs.notice) opts.emitNotice?.(refs.notice);
  if (!refs.rows.some(r => r.referenced_by_count !== undefined || r.records)) return;
  const coverage = await readMentionCoverage(engine, [sourceId]).catch(() => null);
  const notice = coverage ? mentionCoverageNotice(coverage) : null;
  if (notice) opts.emitNotice?.(notice);
}

async function lookupOne(engine: BrainEngine, sourceId: string, name: string, scope: EntityLookupScope,
  selected: Awaited<ReturnType<typeof selectAcrossSources>>['selected'], opts: { remote: boolean }): Promise<EntityNameRow> {
  if (selected.kind !== 'hit') {
    const suggestions = (selected.kind === 'miss' ? selected.suggestions : []).slice(0, 3).map(s => ({ slug: s.slug, title: s.title }));
    return { name, found: false, ...(suggestions.length ? { suggestions } : {}) };
  }
  const { row } = selected;
  const aka = await readAka(engine, sourceId, row.slug);
  const { identity_siblings } = await readSiblingIdentity(engine, sourceId, row,
    { excludePrivate: scope.excludePrivate, excludeQuarantined: opts.remote, policy: scope.policy, pack: scope.pack });
  const siblingPages = identity_siblings?.pages ?? [];
  const bodies = new Map<string, string | null>([[row.slug, row.compiled_truth]]);
  if (siblingPages.length) {
    const sib = await engine.executeRaw<{ slug: string; source_id: string; compiled_truth: string | null }>(
      `SELECT slug, source_id, ${boundedBodyPrefixSql('pages')} AS compiled_truth FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`,
      [sourceId, siblingPages.map(p => p.slug)]).catch(() => []);
    for (const s of await overlaidBoundedRows(engine, sib)) bodies.set(s.slug, s.compiled_truth);
  }
  return {
    name, found: true, source_id: sourceId, slug: row.slug, title: row.title ?? row.slug, type: row.type ?? null, aka, lead: pageLead(bodies.get(row.slug) ?? null),
    ...(siblingPages.length ? { siblings: siblingPages.map(p => ({ slug: p.slug, title: p.title, type: p.type, aka: p.aka, lead: pageLead(bodies.get(p.slug) ?? null) })) } : {}),
  };
}

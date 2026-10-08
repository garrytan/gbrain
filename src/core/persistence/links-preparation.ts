import type { BrainEngine } from '../engine.ts';
import { isUndefinedTableError } from '../utils.ts';
import type { ParsedPage } from '../import-file.ts';
import { buildBasenameIndex, extractPageLinks, isGlobalBasenameEnabled, makeResolver, resolvedLinkCandidate } from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import { DerivedLinkEndpointChangedError } from '../derived-links.ts';
import { capturedLinkEndpoints, indexLinkSources, loadLinkSourcePolicy, resolveCandidateSources } from '../link-reconciliation.ts';
import { collectWantedLinks, isWantedPagesEnabled, possibleWantedRows } from '../wanted-links.ts';
import { readFix } from '../ops/op-fix.ts';
import { lineGrammarOptions } from '../line-grammar.ts';
import { primeRelationSemantics } from '../link-semantics-pack.ts';

async function liveSlugAliases(engine: BrainEngine, sourceId: string, targets: string[]): Promise<Map<string, string>> {
  if (!targets.length) return new Map();
  try {
    const rows = await engine.executeRaw<{ alias_slug: string; canonical_slug: string }>(`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
      WHERE a.source_id=$1 AND a.alias_slug IN (SELECT unnest($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`, [sourceId, [...new Set(targets)]]);
    return new Map(rows.map(row => [row.alias_slug, row.canonical_slug]));
  } catch (error) {
    if (isUndefinedTableError(error)) return new Map();
    throw error;
  }
}

interface SourceSlugIndex { count: number; hash: bigint; maxId: number; index: Map<string, string[]> }
const sourceSlugIndexes = new WeakMap<BrainEngine, Map<string, Promise<SourceSlugIndex | null>>>();
const SLUG_FINGERPRINT = 'count(*)::int AS n, coalesce(sum(hashtextextended(slug, 0)), 0)::text AS h, coalesce(max(id), 0)::int AS m';

async function refreshSourceSlugIndex(engine: BrainEngine, sourceId: string, state: SourceSlugIndex | null): Promise<SourceSlugIndex> {
  if (state) {
    const [probe] = await engine.executeRaw<{ n: number; h: string; m: number; added: string[]; added_h: string }>(`SELECT ${SLUG_FINGERPRINT},
      coalesce(array_agg(slug) FILTER (WHERE id > $2), '{}') AS added, coalesce(sum(hashtextextended(slug, 0)) FILTER (WHERE id > $2), 0)::text AS added_h
      FROM pages WHERE source_id=$1`, [sourceId, state.maxId]);
    const hash = BigInt(probe!.h);
    if (!probe!.added.length && probe!.n === state.count && hash === state.hash) return state;
    if (probe!.n === state.count + probe!.added.length && hash === state.hash + BigInt(probe!.added_h)) {
      return { count: probe!.n, hash, maxId: probe!.m, index: buildBasenameIndex(probe!.added, state.index) };
    }
  }
  const [all] = await engine.executeRaw<{ n: number; h: string; m: number; slugs: string[] }>(
    `SELECT ${SLUG_FINGERPRINT}, coalesce(array_agg(slug), '{}') AS slugs FROM pages WHERE source_id=$1`, [sourceId]);
  return { count: all!.n, hash: BigInt(all!.h), maxId: all!.m, index: buildBasenameIndex(all!.slugs) };
}

/**
 * The basename index of every slug in a source (getAllSlugs' set), kept per
 * engine and source across link preparations. Each call fingerprints the
 * source's slugs (count, hash sum, max id) and reuses the index when nothing
 * changed, adds the new rows when only inserts happened, else rebuilds; so a
 * write from any process is seen exactly as the per-page slug read saw it.
 */
async function sourceBasenameIndex(engine: BrainEngine, sourceId: string): Promise<Map<string, string[]>> {
  const bySource = sourceSlugIndexes.get(engine) ?? new Map<string, Promise<SourceSlugIndex | null>>();
  sourceSlugIndexes.set(engine, bySource);
  const next = (bySource.get(sourceId) ?? Promise.resolve(null)).then(state => refreshSourceSlugIndex(engine, sourceId, state));
  bySource.set(sourceId, next.catch(() => null));
  return (await next).index;
}

/**
 * Link endpoints by slug: every live page in the origin source, plus other
 * sources' pages for the slugs the origin lacks or a link names elsewhere ($3).
 * The origin read and each source's residual read use (source_id, slug).
 */
export const LINK_ENDPOINTS_SQL = `WITH own AS (
    SELECT slug, source_id, type, knowledge_revision FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL),
  elsewhere AS (SELECT array_agg(k) AS refs FROM unnest($2::text[]) k WHERE k=ANY($3::text[]) OR NOT EXISTS (SELECT 1 FROM own WHERE own.slug=k))
  SELECT slug, source_id, type, knowledge_revision FROM own
  UNION ALL
  SELECT p.slug, p.source_id, p.type, p.knowledge_revision FROM elsewhere e, sources s, LATERAL (SELECT slug, source_id, type, knowledge_revision
    FROM pages WHERE source_id=s.id AND slug=ANY(e.refs) AND deleted_at IS NULL OFFSET 0) p
  WHERE s.id<>$1`;

/**
 * `primeSemantics`: install the pack relation semantics now, during preparation, so apply's
 * replacement does not read them again inside the publication transaction.
 */
export async function prepareAutomaticLinks(engine: BrainEngine, slug: string,
  page: Pick<ParsedPage, 'type' | 'compiled_truth' | 'timeline' | 'frontmatter'>, sourceId: string, primeSemantics = false) {
  if (primeSemantics) await primeRelationSemantics(engine);
  const resolver = makeResolver(engine, { mode: 'live', sourceId, basenameIndex: () => sourceBasenameIndex(engine, sourceId) });
  const opts = { globalBasename: await isGlobalBasenameEnabled(engine), lineGrammar: await lineGrammarOptions(engine),
    pack: (await loadActivePackForLocalEngine(engine, { sourceId }))?.manifest ?? null };
  if (!opts.pack) return { pageKeys: [{ sourceId, slug }], attendanceComplete: true,
    apply: async () => ({ created: 0, removed: 0, errors: 1, unresolved_count: 1 }) };
  const content = `${page.compiled_truth}\n${page.timeline}`;
  const referenced = new Set([slug]);
  const initial = await extractPageLinks(slug, content, page.frontmatter, page.type, resolver,
    { ...opts, onResolvedFrontmatterTarget: target => referenced.add(target) });
  // A link written against a renamed page's old slug follows its slug alias, like get_page does.
  const aliases = await liveSlugAliases(engine, sourceId, initial.candidates.map(c => c.targetSlug));
  const retarget = <T extends { targetSlug: string; targetSourceId?: string }>(c: T): T =>
    aliases.has(c.targetSlug) && (c.targetSourceId ?? sourceId) === sourceId ? { ...c, targetSlug: aliases.get(c.targetSlug)! } : c;
  const keys = [...new Set([...referenced, ...initial.candidates.map(retarget).flatMap(c => [c.targetSlug, c.fromSlug ?? slug])])].sort();
  // Another source's same-slug page only decides a slug the origin lacks (a counted cross_source drop) or one a link names there.
  const endpointRows = await engine.executeRaw<{ slug: string; source_id: string; type: string; knowledge_revision: string }>(LINK_ENDPOINTS_SQL,
    [sourceId, keys, [...new Set(initial.candidates.filter(c => c.targetSourceId && c.targetSourceId !== sourceId).map(c => c.targetSlug))]]);
  const endpoints = indexLinkSources(endpointRows);
  const policy = await loadLinkSourcePolicy(engine, sourceId);
  const metadata = new Map(endpointRows.map(row => [`${row.source_id}\0${row.slug}`, row]));
  endpoints.allSlugs.add(slug);
  endpoints.slugToSources.set(slug, [...new Set([sourceId, ...(endpoints.slugToSources.get(slug) ?? [])])]);
  const resolve = (candidate: Parameters<typeof resolveCandidateSources>[0]) => resolveCandidateSources(candidate, slug,
    sourceId, endpoints.allSlugs, endpoints.slugToSources, policy.allowCrossSource, policy);
  const { candidates, unresolved, attendanceComplete } = await extractPageLinks(slug, content, page.frontmatter, page.type, resolver,
    { ...opts, targetType: (targetSlug, targetSourceId) => {
      const resolved = resolve({ targetSlug, targetSourceId, linkType: '', context: '' });
      return resolved.ok ? (targetSlug === slug && resolved.toSourceId === sourceId ? page.type
        : metadata.get(`${resolved.toSourceId}\0${targetSlug}`)?.type) : undefined;
    } });
  // The rows the store keeps (#6228/#6225), so the receipt's wanted preview never names a target no page can have.
  const wanted = { producers: ['body', 'frontmatter'] as const, rows: await isWantedPagesEnabled(engine)
    ? await possibleWantedRows(engine, sourceId, collectWantedLinks({ candidates: candidates.map(retarget), frontmatterUnresolved: unresolved,
      originSourceId: sourceId, crossSourceAllowed: policy.allowCrossSource || policy.crossSource, resolve }))
    : [] };
  const rows = candidates.map(retarget).flatMap(candidate => {
    const resolved = resolve(candidate);
    if (!resolved.ok) return [];
    if (!candidate.canonicalAttendance && (resolved.fromSourceId !== sourceId || resolved.toSourceId !== sourceId)) return [];
    return [resolvedLinkCandidate(candidate, slug, sourceId, resolved)];
  });
  return { attendanceComplete, pageKeys: [{ sourceId, slug }, ...rows.flatMap(row => [
    { sourceId: row.from_source_id!, slug: row.from_slug }, { sourceId: row.to_source_id!, slug: row.to_slug },
  ])], apply: async (tx: BrainEngine) => {
    if (!attendanceComplete) return { created: 0, removed: 0, errors: 1, unresolved_count: Math.max(1, unresolved.length) };
    const snapshot = await tx.readPageSnapshot(slug, { sourceId });
    if (!snapshot) throw new Error('Automatic link origin disappeared');
    try {
      const result = await tx.replaceDerivedLinks({ slug, sourceId, expectedRevision: snapshot.revision,
        sourceIncarnation: snapshot.sourceIncarnation, snapshot }, rows, { preserveExisting: true, semanticsPrimed: primeSemantics, wanted: { ...wanted, producers: [...wanted.producers] },
        expectedEndpoints: capturedLinkEndpoints(rows, new Map([...metadata,
          [`${sourceId}\0${slug}`, { slug, source_id: sourceId, type: page.type, knowledge_revision: snapshot.revision }]]))
          .filter(endpoint => endpoint.slug !== slug || endpoint.sourceId !== sourceId) });
      return { ...result, errors: 0, unresolved_count: unresolved.length, wanted_count: wanted.rows.length,
        ...(wanted.rows.length ? { wanted: wanted.rows.slice(0, 10).map(row => ({ slug: row.target_ref, source_id: row.target_source_id })),
          wanted_message: 'These link targets have no page yet; each edge is created when its page is. Create the page if it is real, or fix the link if it is a typo.',
          fix: readFix(`Lists every link target in source ${sourceId} that has no page yet, with the pages that link to it, read-only.`,
            { argv: ['gbrain', 'wanted', '--source-id', sourceId], mcp: { tool: 'wanted_pages', arguments: { source_id: sourceId } } }) } : {}) };
    } catch (error) {
      if (!(error instanceof DerivedLinkEndpointChangedError)) throw error;
      return { created: 0, removed: 0, errors: 1, unresolved_count: Math.max(1, unresolved.length) };
    }
  } };
}

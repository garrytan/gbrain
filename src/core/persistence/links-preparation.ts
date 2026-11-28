import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';
import { hasCapability } from '../engine-capabilities.ts';
import type { ParsedPage } from '../import-file.ts';
import { buildBasenameIndex, extractPageLinks, isGlobalBasenameEnabled, makeResolver, type ExtractPageLinksOptions,
  type PageLinksResult } from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import { DerivedLinkEndpointChangedError } from '../derived-links.ts';
import { capturedLinkEndpoints, indexLinkSources, loadLinkSourcePolicy, makeLinkSourceResolver } from '../link-reconciliation.ts';
import { collectWantedLinks, isWantedPagesEnabled, possibleWantedRows, wantedReadAt } from '../wanted-links.ts';
import { readFix } from '../ops/op-fix.ts';
import { readLineGrammarSettings, type LineGrammarSettings } from '../line-grammar.ts';
import { primeRelationSemantics } from '../link-semantics-pack.ts';
import { bodyUnread, isSegmentedPage } from '../page-body/page-shape.ts';
import { extractSegmentedPageLinks, openSegmentedLinkSession, segmentedRoleText } from '../page-body/segment-links.ts';
import { SegmentDerivationRaced } from '../page-body/segment-derive.ts';
import { temporalBodyOf, type TemporalBody } from '../link-temporal-apply.ts';
import { linksFenceProjectionRows, projectLinksFence } from '../links-fence-projection.ts';
import { isQuarantined } from '../quarantine.ts';

/** A body that moved under an incremental read: null, so the caller takes the full pass. */
const raced = (error: unknown): null => {
  if (error instanceof SegmentDerivationRaced) return null;
  throw error;
};

/**
 * The targets that name an old slug of a renamed page, mapped to the page's current slug: a `slug_aliases` row of the
 * source whose alias is not itself a live page of the source and whose canonical slug is. Two typed reads, so every
 * engine serves it: the source's alias rows (listSlugAliases), then which of the slugs they name are live pages of the
 * source (listLinkEndpointPages, whose rows for other sources are dropped). A brain without the alias table has none.
 */
async function liveSlugAliases(engine: BrainEngine, sourceId: string, targets: string[]): Promise<Map<string, string>> {
  if (!targets.length) return new Map();
  const wanted = new Set(targets);
  let hits: { alias_slug: string; canonical_slug: string }[];
  try {
    hits = (await engine.listSlugAliases(sourceId)).filter(row => wanted.has(row.alias_slug));
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', 'slug_aliases')) return new Map();
    throw error;
  }
  if (!hits.length) return new Map();
  const slugs = [...new Set(hits.flatMap(row => [row.alias_slug, row.canonical_slug]))];
  const live = new Set((await engine.listLinkEndpointPages(sourceId, slugs, [])).filter(page => page.source_id === sourceId).map(page => page.slug));
  return new Map(hits.filter(row => !live.has(row.alias_slug) && live.has(row.canonical_slug)).map(row => [row.alias_slug, row.canonical_slug]));
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
export async function sourceBasenameIndex(engine: BrainEngine, sourceId: string): Promise<Map<string, string[]>> {
  // An engine without raw SQL (Rust) cannot run the fingerprint probe: it builds the index from the same set each time.
  if (!hasCapability(engine, 'raw_sql')) return buildBasenameIndex(await engine.getAllSlugs({ sourceId }));
  const bySource = sourceSlugIndexes.get(engine) ?? new Map<string, Promise<SourceSlugIndex | null>>();
  sourceSlugIndexes.set(engine, bySource);
  const next = (bySource.get(sourceId) ?? Promise.resolve(null)).then(state => refreshSourceSlugIndex(engine, sourceId, state));
  bySource.set(sourceId, next.catch(() => null));
  return (await next).index;
}

/** The statement listLinkEndpointPages sends (engine-sql/link-reads.ts), re-exported for the tests that watch it. */
export { LINK_ENDPOINTS_SQL } from '../engine-sql/link-reads.ts';

/**
 * `primeSemantics`: install the pack relation semantics now, during preparation, so apply's
 * replacement does not read them again inside the publication transaction.
 * A stored segmented page (its body unread) is extracted block by block (page-body/segment-links.ts), incrementally:
 * only the runs whose inputs changed are read, the rest come from their page_segment_derivations rows; a body that moves
 * during the read falls back to the full pass. Its temporal inputs are collected here; publication never reads a segmented body.
 */
export async function prepareAutomaticLinks(engine: BrainEngine, slug: string,
  page: Pick<ParsedPage, 'type' | 'compiled_truth' | 'timeline' | 'frontmatter'> & { id?: number }, sourceId: string, primeSemantics = false) {
  if (primeSemantics) await primeRelationSemantics(engine);
  const readAt = await wantedReadAt(engine);
  const resolver = makeResolver(engine, { mode: 'live', sourceId, basenameIndex: () => sourceBasenameIndex(engine, sourceId) });
  // One settings snapshot for the whole extraction; publication validates it (derived-links.ts). An unreadable
  // setting leaves the page's links unpublished (stale) rather than extracted under defaults.
  const settings: LineGrammarSettings | null = await readLineGrammarSettings(engine).catch(() => null);
  const opts = { globalBasename: await isGlobalBasenameEnabled(engine),
    lineGrammar: { enabled: settings?.enabled ?? false, allowUndeclaredTypes: settings?.allowUndeclaredTypes ?? false },
    pack: (await loadActivePackForLocalEngine(engine, { sourceId }))?.manifest ?? null };
  if (!opts.pack || !settings) return { pageKeys: [{ sourceId, slug }], attendanceComplete: true, settings,
    apply: async () => ({ created: 0, removed: 0, errors: 1, unresolved_count: 1 }) };
  const segmented = bodyUnread(page) ? { id: Number(page.id), slug, source_id: sourceId, type: page.type, frontmatter: page.frontmatter } : null;
  // G5: re-derivation also restores the page's links fence edges (a body with no readable fence leaves them alone).
  const fenceLinks = segmented || isQuarantined(page.frontmatter) ? null : await linksFenceProjectionRows(engine, sourceId, page);
  let session = segmented ? await openSegmentedLinkSession(engine, segmented, resolver, opts).catch(raced) : null;
  let roleText: string | undefined;
  const extract = async (o: ExtractPageLinksOptions & { temporal?: boolean }): Promise<PageLinksResult & { temporalBody?: TemporalBody }> => {
    if (!segmented) return extractPageLinks(slug, `${page.compiled_truth}\n${page.timeline}`, page.frontmatter, page.type, resolver, o);
    const targetType = o.targetType;
    const incremental = session && await (targetType ? session.finish({ ...o, targetType }) : session.targets(o)).catch(raced);
    if (incremental) return incremental;
    session = null;
    roleText ??= await segmentedRoleText(engine, segmented);
    return extractSegmentedPageLinks(engine, segmented, resolver, { ...o, roleText });
  };
  const referenced = new Set([slug]);
  const initial = await extract({ ...opts, onResolvedFrontmatterTarget: target => referenced.add(target) });
  // A link written against a renamed page's old slug follows its slug alias, like get_page does.
  const aliases = await liveSlugAliases(engine, sourceId, initial.candidates.map(c => c.targetSlug));
  const retarget = <T extends { targetSlug: string; targetSourceId?: string }>(c: T): T =>
    aliases.has(c.targetSlug) && (c.targetSourceId ?? sourceId) === sourceId ? { ...c, targetSlug: aliases.get(c.targetSlug)! } : c;
  const keys = [...new Set([...referenced, ...initial.candidates.map(retarget).flatMap(c => [c.targetSlug, c.fromSlug ?? slug])])].sort();
  // Another source's same-slug page only decides a slug the origin lacks (a counted cross_source drop) or one a link names there.
  const endpointRows = await engine.listLinkEndpointPages(sourceId, keys,
    [...new Set(initial.candidates.filter(c => c.targetSourceId && c.targetSourceId !== sourceId).map(c => c.targetSlug))]);
  const endpoints = indexLinkSources(endpointRows);
  const policy = await loadLinkSourcePolicy(engine, sourceId);
  const metadata = new Map(endpointRows.map(row => [`${row.source_id}\0${row.slug}`, row]));
  endpoints.allSlugs.add(slug);
  endpoints.slugToSources.set(slug, [...new Set([sourceId, ...(endpoints.slugToSources.get(slug) ?? [])])]);
  // #4680: the source policy decides the target's source (shared with the reconciliation sweep).
  const sources = makeLinkSourceResolver(slug, sourceId, endpoints, policy);
  const { candidates, unresolved, attendanceComplete, temporalBody } = await extract(
    { ...opts, temporal: true, targetType: (targetSlug, targetSourceId) => {
      const resolved = sources.resolve({ targetSlug, targetSourceId, linkType: '', context: '' });
      return resolved.ok ? (targetSlug === slug && resolved.toSourceId === sourceId ? page.type
        : metadata.get(`${resolved.toSourceId}\0${targetSlug}`)?.type) : undefined;
    } });
  // The rows the store keeps (#6228/#6225), so the receipt's wanted preview never names a target no page can have.
  const wanted = { producers: ['body', 'frontmatter'] as const, readAt, rows: await isWantedPagesEnabled(engine)
    ? await possibleWantedRows(engine, sourceId, collectWantedLinks({ candidates: candidates.map(retarget), frontmatterUnresolved: unresolved,
      originSourceId: sourceId, crossSourceAllowed: sources.crossSourceAllowed, resolve: sources.resolve }))
    : [] };
  let skippedCrossSource = 0;
  const rows = candidates.map(retarget).flatMap(candidate => {
    const admitted = sources.admit(candidate);
    if (admitted.ok) return [admitted.row];
    if (admitted.reason === 'cross_source') skippedCrossSource++;
    return [];
  });
  return { attendanceComplete, settings, pageKeys: [{ sourceId, slug }, ...rows.flatMap(row => [
    { sourceId: row.from_source_id!, slug: row.from_slug }, { sourceId: row.to_source_id!, slug: row.to_slug },
  ])], apply: async (tx: BrainEngine) => {
    if (!attendanceComplete) return { created: 0, removed: 0, errors: 1, unresolved_count: Math.max(1, unresolved.length) };
    const snapshot = await tx.readPageSnapshot(slug, { sourceId });
    if (!snapshot) throw new Error('Automatic link origin disappeared');
    // A page stored in segments is never read here: its temporal inputs come from preparation.
    const stored = isSegmentedPage(snapshot.page) ? { temporalBody: temporalBody ?? temporalBodyOf(page) } : {};
    try {
      const result = await tx.replaceDerivedLinks({ slug, sourceId, expectedRevision: snapshot.revision,
        sourceIncarnation: snapshot.sourceIncarnation, snapshot }, rows, { preserveExisting: true, semanticsPrimed: primeSemantics, lineGrammar: settings, wanted: { ...wanted, producers: [...wanted.producers] },
        expectedEndpoints: capturedLinkEndpoints(rows, metadata, { slug, sourceId }), ...stored });
      if (fenceLinks) {
        const fence = await projectLinksFence(tx, snapshot.page, fenceLinks);
        result.created += fence.created;
        result.removed += fence.removed;
      }
      return { ...result, errors: 0, unresolved_count: unresolved.length, skipped_cross_source: skippedCrossSource, wanted_count: wanted.rows.length,
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

import type { BrainEngine, LinkBatchInput } from './engine.ts';
import { extractPageLinks, unwrapWikilink, resolvedLinkCandidate,
  isCrossSourceLinksEnabled, type LinkCandidate, type LinkExtractionPack, type SlugResolver } from './link-extraction.ts';
import { fetchSource, isSourceFederated } from './sources-load.ts';
import { parseMarkdown } from './markdown.ts';
import { isValidSourceId } from './source-id.ts';
import { buildSourceLocalReferenceIndex } from './source-local-reference-index.ts';

export interface LinkPageMetadata {
  slug: string;
  source_id: string;
  type: string;
  title: string;
  aliases?: unknown;
  knowledge_revision: string;
}

export async function loadLinkPageMetadata(engine: Pick<BrainEngine, 'executeRaw'>, sourceId?: string): Promise<LinkPageMetadata[]> {
  return engine.executeRaw<LinkPageMetadata>(`SELECT slug, source_id, type, title, frontmatter->'aliases' AS aliases, knowledge_revision FROM pages
    WHERE deleted_at IS NULL${sourceId ? ' AND source_id=$1' : ''} ORDER BY source_id, slug`, sourceId ? [sourceId] : []);
}

export function makeIndexedLinkResolver(pages: readonly LinkPageMetadata[], sourceId: string): SlugResolver {
  const index = buildSourceLocalReferenceIndex(pages.filter(page => page.source_id === sourceId));
  return {
    async resolveAttendance(name, dirHint) { return this.resolve(name, dirHint); },
    async resolve(name, dirHint) {
      if (!name) return null;
      let value = name.trim();
      const colon = value.indexOf(':');
      if (colon !== -1 && isValidSourceId(value.slice(0, colon))) {
        if (value.slice(0, colon) !== sourceId) return null;
        value = value.slice(colon + 1);
      }
      const matches = index.resolveMatches(value, dirHint);
      return matches.length === 1 ? matches[0] : null;
    },
    async resolveBasenameMatches(name) { return index.basenameMatches(name); },
  };
}

export interface SourceLinkReconciliationResult {
  ok: boolean;
  complete: boolean;
  pagesProcessed: number;
  linksCreated: number;
  linksRemoved: number;
  nextAfterSlug?: string;
  unresolved: Array<{ originSlug: string; field?: string; target: string; reason: 'missing_target' | 'cross_source' | 'target_type_mismatch' }>;
  failures: Array<{ originSlug?: string; code: string }>;
}

export async function reconcileSourceLinks(
  engine: BrainEngine,
  sourceId: string,
  opts: { pack: LinkExtractionPack; afterSlug?: string; limit?: number; globalBasename?: boolean;
    expectedSourceIncarnation?: string },
): Promise<SourceLinkReconciliationResult> {
  if (!isValidSourceId(sourceId)) throw new TypeError('An exact valid source ID is required for reconciliation');
  const limit = opts.limit ?? Infinity;
  if (opts.limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new TypeError('Reconciliation limit must be between 1 and 1000');
  const result: SourceLinkReconciliationResult = { ok: false, complete: false, pagesProcessed: 0,
    linksCreated: 0, linksRemoved: 0, nextAfterSlug: opts.afterSlug, unresolved: [], failures: [] };
  let originSlug: string | undefined;
  try {
    const sources = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    if (!sources.length || (opts.expectedSourceIncarnation && sources[0].incarnation !== opts.expectedSourceIncarnation)) {
      result.failures.push({ code: 'source_identity_changed' });
      return result;
    }
    const sourceIncarnation = sources[0].incarnation;
    const pages = await loadLinkPageMetadata(engine, sourceId);
    const index = new Map(pages.map(page => [page.slug, page]));
    const resolver = makeIndexedLinkResolver(pages, sourceId);
    const remaining = pages.filter(page => !opts.afterSlug || page.slug > opts.afterSlug)
      .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
    for (const metadata of remaining.slice(0, limit)) {
      originSlug = metadata.slug;
      const snapshot = await engine.readPageSnapshot(originSlug, { sourceId });
      if (!snapshot || snapshot.revision !== metadata.knowledge_revision || snapshot.sourceIncarnation !== sourceIncarnation) {
        result.failures.push({ originSlug, code: 'revision_conflict' });
        return result;
      }
      const page = snapshot.page;
      const extracted = await extractPageLinks(page.slug, `${page.compiled_truth}\n${page.timeline}`, page.frontmatter,
        page.type, resolver, { pack: opts.pack, globalBasename: opts.globalBasename,
          targetType: (slug, source) => !source || source === sourceId ? index.get(slug)?.type : undefined });
      for (const ref of extracted.unresolved) {
        const target = unwrapWikilink(ref.name);
        const qualifier = target.split(':')[0];
        const foreign = target.includes(':') && isValidSourceId(qualifier) && qualifier !== sourceId;
        result.unresolved.push({ originSlug: page.slug, field: ref.field, target: ref.name,
          reason: ref.reason ?? (foreign ? 'cross_source' : 'missing_target') });
      }
      if (!extracted.attendanceComplete) {
        result.failures.push({ originSlug, code: 'attendance_resolution_incomplete' });
        return result;
      }
      const rows: LinkBatchInput[] = [];
      for (const candidate of extracted.candidates) {
        const from = candidate.fromSlug ?? page.slug;
        if (candidate.targetSourceId && candidate.targetSourceId !== sourceId) {
          result.unresolved.push({ originSlug, target: `${candidate.targetSourceId}:${candidate.targetSlug}`, reason: 'cross_source' });
          continue;
        }
        if (!index.has(from) || !index.has(candidate.targetSlug)) {
          result.unresolved.push({ originSlug, target: candidate.targetSlug, reason: 'missing_target' });
          continue;
        }
        rows.push(resolvedLinkCandidate(candidate, page.slug, sourceId,
          { fromSlug: from, fromSourceId: sourceId, toSourceId: sourceId }));
      }
      const written = await engine.replaceDerivedLinks({ slug: page.slug, sourceId,
        expectedRevision: snapshot.revision, sourceIncarnation }, rows, { expectedEndpoints:
          [...new Set(rows.flatMap(row => [row.from_slug, row.to_slug]))].map(slug => ({ slug, sourceId,
            revision: index.get(slug)!.knowledge_revision })) });
      result.pagesProcessed++;
      result.linksCreated += written.created;
      result.linksRemoved += written.removed;
      result.nextAfterSlug = page.slug;
    }
    result.ok = true;
    result.complete = remaining.length <= limit;
    return result;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : 'graph_write_failed';
    result.failures.push({ originSlug, code });
    return result;
  }
}

export async function replaceFileLinks(engine: BrainEngine, slug: string, sourceId: string,
  links: LinkBatchInput[], includeFrontmatter: boolean,
  snapshot: NonNullable<Awaited<ReturnType<BrainEngine['readPageSnapshot']>>>,
  ownership: Awaited<ReturnType<typeof fileLinkOwnership>>, content: string,
  opts: { pack: LinkExtractionPack | null; globalBasename: boolean }): Promise<number | null | undefined> {
  const { metadata, resolver, resolve } = ownership;
  const parsed = parseMarkdown(content, `${slug}.md`, { activePack: opts.pack?.page_types ? { page_types: opts.pack.page_types } : undefined });
  const extracted = await extractPageLinks(slug, content, parsed.frontmatter, snapshot.page.type, resolver,
    { ...opts, skipFrontmatter: !includeFrontmatter, targetType: (targetSlug, targetSourceId) => {
      const result = resolve(slug, { targetSlug, targetSourceId, linkType: '', context: '' });
      return result.ok ? metadata.get(`${result.toSourceId}\0${targetSlug}`)?.type : undefined;
    } });
  if (!extracted.attendanceComplete) return null;
  const attendance = extracted.candidates.filter(candidate => candidate.canonicalAttendance
    || (candidate.linkType === 'attended' && candidate.fromSlug && candidate.targetSlug === slug));
  if (!ownership.origins.has(slug) && !attendance.length
    && !links.some(link => link.link_type === 'attended' && link.to_slug === slug && link.origin_slug === slug)) return undefined;
  const rows: LinkBatchInput[] = links.filter(link => !(link.link_type === 'attended' && link.to_slug === slug && link.origin_slug === slug)
    && metadata.has(`${sourceId}\0${link.from_slug}`)
    && metadata.has(`${sourceId}\0${link.to_slug}`)).map(link => ({ ...link,
    from_source_id: sourceId, to_source_id: sourceId, origin_source_id: sourceId }));
  for (const candidate of attendance) {
    const resolved = resolve(slug, candidate);
    if (!resolved.ok) return null;
    rows.push(resolvedLinkCandidate(candidate, slug, sourceId, resolved));
  }
  const result = await engine.replaceDerivedLinks({ slug, sourceId, expectedRevision: snapshot.revision,
    sourceIncarnation: snapshot.sourceIncarnation }, rows, { includeFrontmatter, preserveExisting: true,
    includeLegacyNullProducer: false,
    expectedEndpoints: capturedLinkEndpoints(rows, metadata) });
  return result.created;
}

export async function fileLinkOwnership(engine: BrainEngine, sourceId: string) {
  const pages = await loadLinkPageMetadata(engine);
  const metadata = new Map(pages.map(row => [`${row.source_id}\0${row.slug}`, row]));
  const resolver = makeIndexedLinkResolver(pages, sourceId);
  const { allSlugs, slugToSources } = indexLinkSources(pages);
  const policy = await loadLinkSourcePolicy(engine, sourceId);
  const resolve = (slug: string, candidate: LinkCandidate) => resolveCandidateSources(candidate, slug, sourceId,
    allSlugs, slugToSources, policy.allowCrossSource, policy);
  const origins = await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT o.slug FROM links l
    JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1 AND l.link_source IN ('markdown','wikilink-resolved','frontmatter')
      AND l.link_type='attended' AND l.to_page_id=l.origin_page_id`, [sourceId]);
  return { metadata, resolver, resolve, origins: new Set(origins.map(row => row.slug)) };
}

export function indexLinkSources(pages: ReadonlyArray<{ slug: string; source_id: string }>) {
  const allSlugs = new Set<string>();
  const slugToSources = new Map<string, string[]>();
  for (const page of pages) {
    allSlugs.add(page.slug);
    const sources = slugToSources.get(page.slug) ?? [];
    sources.push(page.source_id);
    slugToSources.set(page.slug, sources);
  }
  return { allSlugs, slugToSources };
}

export async function loadLinkSourcePolicy(engine: BrainEngine, sourceId: string) {
  const [source, crossSource, defaultSourceId] = await Promise.all([
    fetchSource(engine, sourceId), isCrossSourceLinksEnabled(engine), resolveLinkFallbackDefault(engine),
  ]);
  return { allowCrossSource: source !== null && !source.archived && isSourceFederated(source.config), crossSource, defaultSourceId };
}

export function capturedLinkEndpoints(links: LinkBatchInput[], metadata: ReadonlyMap<string, Pick<LinkPageMetadata, 'slug' | 'source_id' | 'knowledge_revision'>>) {
  const keys = new Set(links.flatMap(link => [
    `${link.from_source_id ?? 'default'}\0${link.from_slug}`, `${link.to_source_id ?? 'default'}\0${link.to_slug}`,
  ]));
  return [...keys].map(key => {
    const endpoint = metadata.get(key);
    if (!endpoint) throw new Error('A derived link endpoint was not captured during type resolution');
    return { slug: endpoint.slug, sourceId: endpoint.source_id, revision: endpoint.knowledge_revision };
  });
}

/**
 * v0.42.7 (#1696): pure cross-source resolution for one extracted link
 * candidate. Validates both endpoints exist (else the batch JOIN drops the row),
 * then picks from_source_id / to_source_id: prefer the origin page's source,
 * fall back to 'default', else skip (never push a wrong-source edge). Shared
 * by extractLinksFromDB and extractStaleFromDB so the F10 multi-source
 * resolution and the source-isolation policy can't drift.
 *
 * v0.46.28.0 (#2589): the failure case now carries a `reason` instead of a
 * bare `null`. A target that resolves via `global_basename` to a page that
 * exists ONLY in a source other than the origin's or 'default' was
 * indistinguishable from a genuinely-missing target — both silently dropped
 * the candidate and both counted (misleadingly) as "target page doesn't
 * exist". This stays default-deny by design: cross-source edges remain
 * unwritten (source isolation — see CLAUDE.md), but callers can now
 * attribute the drop correctly instead of reporting a wrong reason.
 *
 * #3478: only a federated origin source may fall back to 'default'; when
 * `allowCrossSource` is false both endpoints must live in the page's own
 * source, else skip with reason 'cross_source' (never push a wrong-source
 * edge).
 *
 * #3908: `opts.crossSource` (the `link_resolution.cross_source` config flag)
 * is the explicit operator opt-in — it supersedes the ambient federation
 * gate, which only exists to stop DEFAULT-ON silent cross-source regrowth.
 * With it on, a cross-source-only candidate resolves with the
 * lexicographically smallest matching source (deterministic, so repeated
 * extracts and both engines converge on the same edge under the
 * (source_id, slug) composite key) instead of dropping with 'cross_source'.
 *
 * #4611: the fallback lane compares against `opts.defaultSourceId` (the
 * configured `sources.default`, resolved once per run by the callers via
 * resolveLinkFallbackDefault) instead of the LITERAL string 'default'.
 * Renaming the brain's default source no longer silently kills the
 * cross-source fallback. Omitted → 'default' (back-compat).
 */
export type CandidateSourceResolution =
  | { ok: true; fromSlug: string; fromSourceId: string; toSourceId: string }
  | { ok: false; reason: 'missing_target' | 'missing_from' | 'cross_source' };

/**
 * #4611: resolve the source id the cross-source link fallback compares
 * against. Reads the operator-configured `sources.default` (same key the
 * write-routing ladder in source-resolver.ts tier 5 reads), silently
 * falling back to the seeded literal 'default' on unset/invalid/config
 * errors — extraction must never fail on a bad config row.
 */
export async function resolveLinkFallbackDefault(
  engine: Pick<BrainEngine, 'getConfig'>,
): Promise<string> {
  try {
    const v = await engine.getConfig('sources.default');
    if (v && isValidSourceId(v)) return v;
  } catch {
    // Best-effort read; the seeded literal below is the safe terminal.
  }
  return 'default';
}

export function resolveCandidateSources(
  c: LinkCandidate,
  pageSlug: string,
  pageSourceId: string,
  allSlugs: Set<string>,
  slugToSources: Map<string, string[]>,
  allowCrossSource: boolean,
  opts: { crossSource?: boolean; defaultSourceId?: string } = {},
): CandidateSourceResolution {
  const fromSlug = c.fromSlug ?? pageSlug;
  if (!allSlugs.has(c.targetSlug)) return { ok: false, reason: 'missing_target' };
  if (!allSlugs.has(fromSlug)) return { ok: false, reason: 'missing_from' };
  const fromSources = slugToSources.get(fromSlug) ?? [];
  const targetSources = slugToSources.get(c.targetSlug) ?? [];
  if (c.targetSourceId) {
    if (!targetSources.includes(c.targetSourceId)) return { ok: false, reason: 'missing_target' };
    if (!fromSources.includes(pageSourceId)) return { ok: false, reason: 'missing_from' };
    if (c.targetSourceId !== pageSourceId && !allowCrossSource && !opts.crossSource) return { ok: false, reason: 'cross_source' };
    return { ok: true, fromSlug, fromSourceId: pageSourceId, toSourceId: c.targetSourceId };
  }
  if (!allowCrossSource && !opts.crossSource) {
    if (!fromSources.includes(pageSourceId) || !targetSources.includes(pageSourceId)) {
      // #3478 isolation × #2589 counting: both endpoints exist but not in
      // the origin's own source — a counted cross-source drop, never an edge.
      return { ok: false, reason: 'cross_source' };
    }
    return { ok: true, fromSlug, fromSourceId: pageSourceId, toSourceId: pageSourceId };
  }
  // #4611: follow the CONFIGURED default source, not the literal 'default'.
  const defaultSourceId = opts.defaultSourceId ?? 'default';
  const fromSourceId = fromSources.includes(pageSourceId) ? pageSourceId
    : (fromSources.includes(defaultSourceId) ? defaultSourceId : fromSources[0]);
  let toSourceId: string;
  if (targetSources.includes(fromSourceId)) {
    toSourceId = fromSourceId;
  } else if (targetSources.includes(defaultSourceId)) {
    toSourceId = defaultSourceId;
  } else if (targetSources.length > 0) {
    // #2589: the target exists ONLY in other sources. Historically this was
    // a silent null (indistinguishable from a missing endpoint — multi-source
    // graphs went sparse with dead_links stuck at 0). Behind the opt-in
    // `link_resolution.cross_source` flag the edge is allowed with a
    // DETERMINISTIC pick (lexicographically smallest source, so repeated
    // extracts and both engines converge on the same edge under the
    // (source_id, slug) composite key); off, callers get the distinguishable
    // 'cross_source' reason to COUNT the drop instead of burying it.
    if (!opts.crossSource) return { ok: false, reason: 'cross_source' };
    // Allocation-free deterministic min (bulk loops call this per candidate;
    // in the motivating federated topology most candidates hit this branch).
    let min = targetSources[0];
    for (const s of targetSources) if (s < min) min = s;
    toSourceId = min;
  } else {
    return { ok: false, reason: 'cross_source' };
  }
  return { ok: true, fromSlug, fromSourceId, toSourceId };
}

/**
 * (slug, source_id) refs for EXACTLY the given slugs, chunked IN-list —
 * the bounded replacement for listAllPageRefs in the sweep's pass 2. Same
 * visibility as listAllPageRefs (deleted_at IS NULL).
 */
export async function lookupRefsForSlugs(
  engine: BrainEngine,
  slugs: string[],
): Promise<{ allSlugs: Set<string>; slugToSources: Map<string, string[]>;
  metadata: Array<{ slug: string; source_id: string; type: string; knowledge_revision: string }> }> {
  const allSlugs = new Set<string>();
  const slugToSources = new Map<string, string[]>();
  const metadata: Array<{ slug: string; source_id: string; type: string; knowledge_revision: string }> = [];
  const CHUNK = 200;
  for (let i = 0; i < slugs.length; i += CHUNK) {
    const chunk = slugs.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
    const rows = await engine.executeRaw<{ slug: string; source_id: string; type: string; knowledge_revision: string }>(
      `SELECT slug, source_id, type, knowledge_revision FROM pages
        WHERE deleted_at IS NULL AND slug IN (${placeholders})`,
      chunk,
    );
    metadata.push(...rows);
    for (const ref of rows) {
      allSlugs.add(ref.slug);
      const list = slugToSources.get(ref.slug) ?? [];
      list.push(ref.source_id);
      slugToSources.set(ref.slug, list);
    }
  }
  return { allSlugs, slugToSources, metadata };
}

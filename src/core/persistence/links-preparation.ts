import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { extractPageLinks, isGlobalBasenameEnabled, makeResolver, resolvedLinkCandidate } from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import { DerivedLinkEndpointChangedError } from '../derived-links.ts';
import { capturedLinkEndpoints, indexLinkSources, loadLinkSourcePolicy, resolveCandidateSources } from '../link-reconciliation.ts';

export async function prepareAutomaticLinks(engine: BrainEngine, slug: string,
  page: Pick<ParsedPage, 'type' | 'compiled_truth' | 'timeline' | 'frontmatter'>, sourceId: string) {
  const resolver = makeResolver(engine, { mode: 'live', sourceId });
  const opts = { globalBasename: await isGlobalBasenameEnabled(engine),
    pack: (await loadActivePackForLocalEngine(engine, { sourceId }))?.manifest ?? null };
  if (!opts.pack) return { pageKeys: [{ sourceId, slug }],
    apply: async () => ({ created: 0, removed: 0, errors: 1, unresolved_count: 1 }) };
  const content = `${page.compiled_truth}\n${page.timeline}`;
  const referenced = new Set([slug]);
  const initial = await extractPageLinks(slug, content, page.frontmatter, page.type, resolver,
    { ...opts, onResolvedFrontmatterTarget: target => referenced.add(target) });
  const keys = [...new Set([...referenced, ...initial.candidates.flatMap(c => [c.targetSlug, c.fromSlug ?? slug])])].sort();
  const endpointRows = await engine.executeRaw<{ slug: string; source_id: string; type: string; knowledge_revision: string }>(
    'SELECT slug, source_id, type, knowledge_revision FROM pages WHERE slug=ANY($1::text[]) AND deleted_at IS NULL', [keys]);
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
  const rows = candidates.flatMap(candidate => {
    const resolved = resolve(candidate);
    if (!resolved.ok) return [];
    if (!candidate.canonicalAttendance && (resolved.fromSourceId !== sourceId || resolved.toSourceId !== sourceId)) return [];
    return [resolvedLinkCandidate(candidate, slug, sourceId, resolved)];
  });
  return { pageKeys: [{ sourceId, slug }, ...rows.flatMap(row => [
    { sourceId: row.from_source_id!, slug: row.from_slug }, { sourceId: row.to_source_id!, slug: row.to_slug },
  ])], apply: async (tx: BrainEngine) => {
    if (!attendanceComplete) return { created: 0, removed: 0, errors: 1, unresolved_count: Math.max(1, unresolved.length) };
    const snapshot = await tx.readPageSnapshot(slug, { sourceId });
    if (!snapshot) throw new Error('Automatic link origin disappeared');
    try {
      const result = await tx.replaceDerivedLinks({ slug, sourceId, expectedRevision: snapshot.revision,
        sourceIncarnation: snapshot.sourceIncarnation }, rows, { preserveExisting: true,
        expectedEndpoints: capturedLinkEndpoints(rows, new Map([...metadata,
          [`${sourceId}\0${slug}`, { slug, source_id: sourceId, type: page.type, knowledge_revision: snapshot.revision }]]))
          .filter(endpoint => endpoint.slug !== slug || endpoint.sourceId !== sourceId) });
      return { ...result, errors: 0, unresolved_count: unresolved.length };
    } catch (error) {
      if (!(error instanceof DerivedLinkEndpointChangedError)) throw error;
      return { created: 0, removed: 0, errors: 1, unresolved_count: Math.max(1, unresolved.length) };
    }
  } };
}

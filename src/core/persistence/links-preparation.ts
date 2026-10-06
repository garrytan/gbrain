import type { BrainEngine } from '../engine.ts';
import { isUndefinedTableError } from '../utils.ts';
import type { ParsedPage } from '../import-file.ts';
import { extractPageLinks, isGlobalBasenameEnabled, makeResolver, resolvedLinkCandidate } from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import { DerivedLinkEndpointChangedError } from '../derived-links.ts';
import { capturedLinkEndpoints, indexLinkSources, loadLinkSourcePolicy, resolveCandidateSources } from '../link-reconciliation.ts';
import { collectWantedLinks, isWantedPagesEnabled } from '../wanted-links.ts';
import { readFix } from '../ops/op-fix.ts';
import { lineGrammarOptions } from '../line-grammar.ts';

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

export async function prepareAutomaticLinks(engine: BrainEngine, slug: string,
  page: Pick<ParsedPage, 'type' | 'compiled_truth' | 'timeline' | 'frontmatter'>, sourceId: string) {
  const resolver = makeResolver(engine, { mode: 'live', sourceId });
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
  const wanted = { producers: ['body', 'frontmatter'] as const, rows: await isWantedPagesEnabled(engine)
    ? collectWantedLinks({ candidates: candidates.map(retarget), frontmatterUnresolved: unresolved, originSourceId: sourceId,
      crossSourceAllowed: policy.allowCrossSource || policy.crossSource, resolve })
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
        sourceIncarnation: snapshot.sourceIncarnation }, rows, { preserveExisting: true, wanted: { ...wanted, producers: [...wanted.producers] },
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

import type { BrainEngine, LinkBatchInput } from './engine.ts';
import type { PageType } from './types.ts';
import { extractPageLinks, unwrapWikilink, type LinkExtractionPack, loadExtractionPack, type SlugResolver } from './link-extraction.ts';
import { lineGrammarOptions } from './line-grammar.ts';
import { buildSourceLocalReferenceIndex } from './source-local-reference-index.ts';
import { isValidSourceId } from './source-id.ts';
import { readRelationSnapshot, replaceDerivedLinks } from './pmbrain-adapters/relation-writer.ts';
import { collectWantedLinks, isWantedPagesEnabled } from './wanted-links.ts';
import { normalizeBasename } from './reference-basename.ts';
import {activeIngestContent} from './pmbrain-adapters/ingest-provenance.ts';

export interface LinkPageMetadata {
  slug: string;
  source_id: string;
  type: string;
  title: string;
  aliases?: unknown;
  knowledge_revision: string;
}

export async function loadLinkPageMetadata(engine: Pick<BrainEngine, 'executeRaw'>, sourceId?:string): Promise<LinkPageMetadata[]> {
  return engine.executeRaw<LinkPageMetadata>(`SELECT p.slug, p.source_id, p.type, p.title, p.knowledge_revision::text AS knowledge_revision,
    COALESCE((SELECT jsonb_agg(COALESCE(a.alias_text,a.alias_norm)) FROM page_aliases a WHERE a.slug=p.slug AND a.source_id=p.source_id), p.frontmatter->'aliases') AS aliases
    FROM pages p WHERE p.deleted_at IS NULL${sourceId?' AND p.source_id=$1':''} ORDER BY p.source_id,p.slug`,sourceId?[sourceId]:[]);
}

export function makeIndexedLinkResolver(pages: readonly LinkPageMetadata[], sourceId: string): SlugResolver {
  const indexes = new Map<string, ReturnType<typeof buildSourceLocalReferenceIndex>>();
  const index = (source: string) => {
    if (!indexes.has(source)) indexes.set(source, buildSourceLocalReferenceIndex(pages.filter(p => p.source_id===source)));
    return indexes.get(source)!;
  };
  const order = sourceId==='default' ? ['default'] : [sourceId,'default'];
  const result = (slug: string, source: string, qualified=false) => ({ slug, sourceId: source, resolutionType: qualified ? 'qualified' as const : 'unqualified' as const });
  const exact = async (slug: string, requestedSourceId?: string) => {
    for (const source of requestedSourceId ? [requestedSourceId] : order) {
      if (!isValidSourceId(source)) return null;
      if (index(source).exactMatches(slug).length===1) return result(slug,source,!!requestedSourceId);
    }
    return null;
  };
  const resolveTarget = async (name: string, dirHint?: string | string[]) => {
    const colon = name.indexOf(':');
    if (colon!==-1 && isValidSourceId(name.slice(0,colon))) return exact(name.slice(colon+1),name.slice(0,colon));
    for (const source of order) {
      const matches=index(source).resolveMatches(name,dirHint);
      if (matches.length>1) return null;
      if (matches.length===1) return result(matches[0]!,source);
    }
    return null;
  };
  return {
    resolveTarget,
    resolveExact: async (name, source) => (await exact(name,source)) ?? (!source && !name.includes('/') ? resolveTarget(name) : null),
    resolveLocalExact: async slug => index(sourceId).exactMatches(slug).length===1 ? result(slug,sourceId) : null,
    slugExists: async (slug, source) => !!(await exact(slug,source)),
    resolve: async (name,hint) => (await resolveTarget(name,hint))?.slug ?? null,
  };
}

export async function prepareLinkReconciliation(engine: BrainEngine) {
  const pages = await loadLinkPageMetadata(engine);
  const metadata = new Map(pages.map(page => [JSON.stringify([page.source_id,page.slug]),page]));
  const resolvers = new Map<string, SlugResolver>();
  const packs = new Map<string, Awaited<ReturnType<typeof loadExtractionPack>>>();
  const lineGrammar = await lineGrammarOptions(engine);
  return async (slug: string, sourceId: string, opts: { includeFrontmatter?: boolean; dryRun?: boolean; pack?:LinkExtractionPack } = {}) => {
    const started=performance.now();
    const snapshot = await readRelationSnapshot(engine,slug,sourceId);
    if (!snapshot || snapshot.page.deleted_at) throw new Error(`Page not found: ${sourceId}:${slug}`);
    if (!resolvers.has(sourceId)) resolvers.set(sourceId, makeIndexedLinkResolver(pages,sourceId));
    if (!packs.has(sourceId)) packs.set(sourceId, await loadExtractionPack(engine,sourceId));
    const page = snapshot.page;
    const active=await activeIngestContent(engine,page);
    const extracted = await extractPageLinks(slug,`${active.compiled_truth}\n${active.timeline}`,page.frontmatter,page.type as PageType,resolvers.get(sourceId)!, {
      pack: opts.pack??packs.get(sourceId), lineGrammar, skipFrontmatter: opts.includeFrontmatter===false,
      targetType: (target,source) => metadata.get(JSON.stringify([source ?? sourceId,target]))?.type,
    });
    for (const ref of extracted.unresolved.filter(ref=>ref.field==='wikilink')) extracted.candidates.push({
      targetSlug:ref.name,targetSourceId:ref.targetSourceId,linkType:'mentions',context:ref.name,linkSource:'markdown',
      authoredRef:{key:JSON.stringify([ref.targetSourceId ?? sourceId,ref.name]),kind:ref.name.includes('/')?'slug':'name',target:ref.name.includes('/')?ref.name:normalizeBasename(ref.name),targetSourceId:ref.targetSourceId},
    });
    let skippedMissingTarget=0;
    const rows: LinkBatchInput[]=[];
    for (const candidate of extracted.candidates) {
      const from_slug=candidate.fromSlug ?? slug;
      const from_source_id=candidate.fromSourceId ?? sourceId;
      const to_source_id=candidate.targetSourceId ?? sourceId;
      if (!metadata.has(JSON.stringify([from_source_id,from_slug])) || !metadata.has(JSON.stringify([to_source_id,candidate.targetSlug]))) { skippedMissingTarget++; continue; }
      rows.push({ from_slug, from_source_id, to_source_id, to_slug:candidate.targetSlug, link_type:candidate.linkType,
        context:candidate.context, link_source:candidate.linkSource ?? 'markdown', origin_slug:candidate.originSlug,
        origin_source_id:sourceId, origin_field:candidate.originField, resolution_type:candidate.resolutionType });
    }
    const endpoints=new Map(rows.flatMap(row => [
      [JSON.stringify([row.from_source_id,row.from_slug]),{ slug:row.from_slug,sourceId:row.from_source_id! }],
      [JSON.stringify([row.to_source_id,row.to_slug]),{ slug:row.to_slug,sourceId:row.to_source_id! }],
    ] as Array<[string,{slug:string;sourceId:string}]>));
    const expectedEndpoints=[...endpoints].map(([key,value]) => ({ ...value, revision:metadata.get(key)!.knowledge_revision }));
    const wanted=await isWantedPagesEnabled(engine) ? collectWantedLinks({candidates:extracted.candidates,
      frontmatterUnresolved:extracted.unresolved.filter(ref=>ref.field!=='wikilink'),originSourceId:sourceId,crossSourceAllowed:true,
      resolve:candidate=>metadata.has(JSON.stringify([candidate.targetSourceId ?? sourceId,candidate.targetSlug])) ? {ok:true} : {ok:false,reason:'missing_target'},
    }) : [];
    const writeStarted=performance.now();
    const written=opts.dryRun ? {created:rows.length,removed:0} : await replaceDerivedLinks(engine, {
      slug,sourceId,expectedRevision:snapshot.revision,sourceIncarnation:snapshot.sourceIncarnation,
    }, rows, {includeFrontmatter:opts.includeFrontmatter,preserveExisting:true,
      wanted:{producers:opts.includeFrontmatter===false?['body']:['body','frontmatter'],rows:wanted},expectedEndpoints:[...expectedEndpoints,...active.origins]});
    return {...written, errors:0, unresolved:extracted.unresolved, skippedMissingTarget, revision:snapshot.revision, page,timings:{resolveMs:writeStarted-started,writeMs:performance.now()-writeStarted}};
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
    const wantedEnabled = await isWantedPagesEnabled(engine);
    const lineGrammar = await lineGrammarOptions(engine);
    const remaining = pages.filter(page => !opts.afterSlug || page.slug > opts.afterSlug)
      .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
    for (const metadata of remaining.slice(0, limit)) {
      originSlug = metadata.slug;
      const snapshot = await readRelationSnapshot(engine,originSlug,sourceId);
      if (!snapshot || snapshot.revision !== metadata.knowledge_revision || snapshot.sourceIncarnation !== sourceIncarnation) {
        result.failures.push({ originSlug, code: 'revision_conflict' });
        return result;
      }
      const page = snapshot.page;
      const active=await activeIngestContent(engine,page);
      const extracted = await extractPageLinks(page.slug, `${active.compiled_truth}\n${active.timeline}`, page.frontmatter,
        page.type as PageType, resolver, { pack: opts.pack, lineGrammar,
          targetType: (slug, source) => !source || source === sourceId ? index.get(slug)?.type : undefined });
      for (const ref of extracted.unresolved) {
        const target = unwrapWikilink(ref.name);
        const qualifier = target.split(':')[0];
        const foreign = target.includes(':') && isValidSourceId(qualifier) && qualifier !== sourceId;
        result.unresolved.push({ originSlug: page.slug, field: ref.field, target: ref.name,
          reason: ref.reason ?? (foreign ? 'cross_source' : 'missing_target') });
      }
      if ('attendanceComplete' in extracted && !extracted.attendanceComplete) {
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
        rows.push({from_slug:from,to_slug:candidate.targetSlug,from_source_id:sourceId,to_source_id:sourceId,
          link_type:candidate.linkType,context:candidate.context,link_source:candidate.linkSource,
          origin_slug:candidate.originSlug,origin_source_id:sourceId,origin_field:candidate.originField});
      }
      const wanted = wantedEnabled ? collectWantedLinks({ candidates: extracted.candidates, frontmatterUnresolved: extracted.unresolved,
        originSourceId: sourceId, crossSourceAllowed: false, resolve: candidate =>
          candidate.targetSourceId && candidate.targetSourceId !== sourceId ? { ok: false, reason: 'cross_source' }
            : !index.has(candidate.targetSlug) ? { ok: false, reason: 'missing_target' } : { ok: true } }) : [];
      const written = await replaceDerivedLinks(engine,{ slug: page.slug, sourceId,
        expectedRevision: snapshot.revision, sourceIncarnation }, rows, { wanted: { producers: ['body', 'frontmatter'], rows: wanted }, expectedEndpoints:
          [...new Set(rows.flatMap(row => [row.from_slug, row.to_slug]))].map(slug => ({ slug, sourceId,
            revision: index.get(slug)!.knowledge_revision })).concat(active.origins) });
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

import type { BrainEngine } from '../engine.ts';
import type { ResolvedPack } from '../schema-pack/registry.ts';
import { parseMarkdown } from '../markdown.ts';
import { extractPageLinks, parseTimelineEntries } from '../link-extraction.ts';
import { loadLinkPageMetadata, makeIndexedLinkResolver } from '../link-reconciliation.ts';
import { extractTimelineFromContent } from '../timeline-extract.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { digest } from '../persistence/digest.ts';
import { readCommittedBlob } from './revision.ts';
import type { CompanyBrainPlan } from './types.ts';
import { QUARANTINE_KEY } from '../quarantine.ts';
import { EMBED_SKIP_KEY } from '../embed-skip.ts';

export async function companyBrainGraphStamp(engine: BrainEngine, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ stamp: string }>(`SELECT md5(COALESCE(string_agg(l.id::text||':'||l.from_page_id::text||':'||l.to_page_id::text||':'||p.id::text||':'||l.link_type||':'||l.link_source||':'||COALESCE(l.origin_field,''),',' ORDER BY l.id),'')) AS stamp
    FROM links l JOIN pages p ON p.id=COALESCE(l.origin_page_id,CASE WHEN l.link_source IN ('markdown','wikilink-resolved') THEN l.from_page_id END)
    WHERE p.source_id=$1 AND l.link_source IN ('markdown','frontmatter','wikilink-resolved')`, [sourceId]);
  return row.stamp;
}

export async function verifyCompanyBrain(engine: BrainEngine, sourceId: string, plan: CompanyBrainPlan, pack: ResolvedPack, signal?: AbortSignal) {
  const metadata = await loadLinkPageMetadata(engine, sourceId);
  const graphStamp = await companyBrainGraphStamp(engine, sourceId);
  const index = new Map(metadata.map(page => [page.slug, page]));
  const resolver = makeIndexedLinkResolver(metadata, sourceId);
  const included = plan.manifest.filter(entry => entry.disposition === 'included' && entry.page);
  const expectedSlugs = new Set(included.map(entry => entry.page!.slug));
  let failures = metadata.filter(page => !expectedSlugs.has(page.slug)).length;
  let links = 0;
  let unresolvedLinks = 0;
  for (const entry of included) {
    signal?.throwIfAborted();
    const slug = entry.page!.slug;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    const content = (await readCommittedBlob(plan.revision!, entry, plan.limits)).toString('utf8');
    const parsed = parseMarkdown(content, slug, { activePack: pack.manifest });
    const page = snapshot?.page;
    if (!page || Object.hasOwn(page.frontmatter, QUARANTINE_KEY) || Object.hasOwn(page.frontmatter, EMBED_SKIP_KEY) ||
      snapshot!.revision !== index.get(slug)?.knowledge_revision || page.source_path !== entry.path ||
      page.type !== parsed.type || page.title !== parsed.title || page.compiled_truth !== parsed.compiled_truth || (page.timeline ?? '') !== (parsed.timeline ?? '') ||
      digest(page.frontmatter) !== digest(parsed.frontmatter) || digest([...(snapshot?.tags ?? [])].sort()) !== digest([...new Set(parsed.tags)].sort())) {
      failures++;
      continue;
    }
    const body = `${parsed.compiled_truth}\n${parsed.timeline ?? ''}`;
    const extracted = await extractPageLinks(slug, body, parsed.frontmatter, parsed.type, resolver, { pack: pack.manifest,
      targetType: (target, source) => !source || source === sourceId ? index.get(target)?.type : undefined });
    unresolvedLinks += extracted.unresolved.length;
    const keys = new Map<string, string | null>();
    for (const candidate of extracted.candidates) {
      const from = candidate.fromSlug ?? slug;
      if (candidate.targetSourceId && candidate.targetSourceId !== sourceId || !index.has(from) || !index.has(candidate.targetSlug)) { unresolvedLinks++; continue; }
      const key = JSON.stringify([from, candidate.targetSlug, candidate.linkType, candidate.linkSource]);
      if (!keys.has(key)) keys.set(key, candidate.originField ?? null);
    }
    links += keys.size;
    const actual = await engine.executeRaw<{ from_slug: string; to_slug: string; from_source: string; to_source: string; link_type: string; link_source: string; origin_field: string | null }>(
      `SELECT f.slug AS from_slug,t.slug AS to_slug,f.source_id AS from_source,t.source_id AS to_source,l.link_type,l.link_source,l.origin_field FROM links l
       JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
       WHERE (l.origin_page_id=$1 OR (l.origin_page_id IS NULL AND l.from_page_id=$1 AND l.link_source IN ('markdown','wikilink-resolved')))
         AND l.link_source IN ('markdown','frontmatter','wikilink-resolved')`, [page.id]);
    const actualKeys = new Map(actual.map(link => [JSON.stringify([link.from_slug, link.to_slug, link.link_type, link.link_source]), link.origin_field]));
    if (keys.size !== actualKeys.size || actual.some(link => link.from_source !== sourceId || link.to_source !== sourceId) ||
      [...keys].some(([key, field]) => !actualKeys.has(key) || actualKeys.get(key) !== field)) failures++;
    const safe = sanitizeRemoteBody(body);
    const timeline = new Map(extractTimelineFromContent(safe, slug).map(t => [JSON.stringify([t.date, t.source, t.summary]), t.detail ?? '']));
    for (const t of parseTimelineEntries(safe)) timeline.set(JSON.stringify([t.date, t.source ?? 'markdown', t.summary]), t.detail ?? '');
    const storedTimeline = await engine.executeRaw<{ date: string; source: string; summary: string; detail: string }>(
      'SELECT date::text,source,summary,detail FROM timeline_entries WHERE page_id=$1 AND event_page_id IS NULL', [page.id]);
    if (storedTimeline.length !== timeline.size || storedTimeline.some(t => timeline.get(JSON.stringify([t.date, t.source, t.summary])) !== (t.detail ?? ''))) failures++;
  }
  return { failures, metadata, graphStamp, links, unresolvedLinks };
}

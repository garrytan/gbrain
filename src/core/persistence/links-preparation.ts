import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { extractPageLinks, isGlobalBasenameEnabled, makeResolver } from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';

/** Resolve outside transactions; install only under the originating page guard. */
export async function prepareAutomaticLinks(engine: BrainEngine, slug: string,
  page: Pick<ParsedPage, 'type' | 'compiled_truth' | 'timeline' | 'frontmatter'>, sourceId: string) {
  const { candidates, unresolved } = await extractPageLinks(slug, `${page.compiled_truth}\n${page.timeline}`,
    page.frontmatter, page.type, makeResolver(engine, { mode: 'live', sourceId }), {
      globalBasename: await isGlobalBasenameEnabled(engine),
      pack: (await loadActivePackForLocalEngine(engine))?.manifest ?? null,
    });
  const previous = [...await engine.getLinks(slug, { sourceId }), ...await engine.getBacklinks(slug, { sourceId })];
  const keys = [...new Set([...candidates.flatMap(c => [c.targetSlug, c.fromSlug ?? slug]),
    ...previous.flatMap(l => [l.from_slug, l.to_slug])])].sort();
  return { pageKeys: keys.map(target => ({ sourceId, slug: target })), apply: async (tx: BrainEngine) => {
    const present = new Set((keys.length ? await tx.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])', [sourceId, keys]) : []).map(row => row.slug));
    const valid = candidates.filter(c => present.has(c.targetSlug) && present.has(c.fromSlug ?? slug));
    const outgoing = await tx.getLinks(slug, { sourceId });
    const incoming = (await tx.getBacklinks(slug, { sourceId })).filter(l => l.link_source === 'frontmatter' && l.origin_slug === slug);
    const managed = outgoing.filter(l => l.link_source == null || ['markdown', 'wikilink-resolved'].includes(l.link_source)
      || l.link_source === 'frontmatter' && l.origin_slug === slug);
    const key = (from: string, to: string, type: string, origin: string | null | undefined) => JSON.stringify([from, to, type, origin ?? 'markdown']);
    const existing = new Map([...managed, ...incoming].map(l => [key(l.from_slug, l.to_slug, l.link_type, l.link_source), l]));
    const wanted = new Set<string>();
    let created = 0, removed = 0;
    for (const c of valid) {
      const from = c.fromSlug ?? slug;
      const linkSource = from === slug ? c.linkSource ?? 'markdown' : 'frontmatter';
      const identity = key(from, c.targetSlug, c.linkType, linkSource);
      if (wanted.has(identity)) continue;
      wanted.add(identity);
      await tx.addLink(from, c.targetSlug, c.context, c.linkType, linkSource, c.originSlug, c.originField,
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      if (!existing.has(identity)) created++;
    }
    for (const [identity, link] of existing) if (!wanted.has(identity)) {
      await tx.removeLink(link.from_slug, link.to_slug, link.link_type, link.link_source ?? undefined,
        { fromSourceId: sourceId, toSourceId: sourceId });
      removed++;
    }
    return { created, removed, errors: 0, unresolved_count: unresolved.length };
  } };
}

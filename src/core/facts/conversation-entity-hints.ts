/**
 * #6731: the entities a conversation page itself names, forwarded to the
 * fact extractor as entity hints.
 *
 * A meeting transcript says "Paul" and "the Maple"; the page already links
 * `people/paul-example` (frontmatter `attendees:`) and
 * `projects/the-maple` (a body wikilink). With those slugs in the prompt the
 * model names the fact by slug and the save-time resolver lands it on that
 * page instead of guessing from a first name.
 *
 * Only edges the page's author wrote count: the page's own frontmatter edges
 * (attendees point at the meeting, with the meeting as origin), body markdown
 * and wikilinks, resolved bare wikilinks and manual links. Derived edges
 * (`mentions`, atom/concept provenance) were inferred from the same text, so
 * they are left out. Hints stay in the page's source (the resolver resolves
 * there) and name live fact-entity pages only. Hints are slugs, and a slug
 * carries the entity's name, so a private entity is hinted only when the
 * run's facts are private too.
 *
 * #6898: a linked page the resolver treats as retired (retiredPageSql) is
 * never hinted; the live page its `superseded_by` / `merged_into` redirect
 * names takes its place (followRetirement), and is checked like any other
 * hint. A retired page whose redirect cannot be followed drops out.
 */
import type { BrainEngine } from '../engine.ts';
import type { FactVisibility } from './visibility.ts';
import { followRetirement, isFactEntityPage, retiredPageSql } from '../entities/resolve.ts';
import { isPrivatePage } from '../search/private-visibility.ts';

/** Hints a conversation page forwards: a meeting's attendees plus what it links run to a few dozen (extract_facts keeps ENTITY_HINTS_CAP). */
export const CONVERSATION_ENTITY_HINTS_CAP = 40;

const AUTHORED_LINK_SOURCES = new Set(['markdown', 'frontmatter', 'wikilink-resolved', 'manual']);

export async function conversationEntityHints(engine: BrainEngine, sourceId: string, pageSlug: string,
  factVisibility: FactVisibility): Promise<string[]> {
  const [outgoing, incoming] = await Promise.all([
    engine.getLinks(pageSlug, { sourceId }),
    engine.getBacklinks(pageSlug, { sourceId }),
  ]);
  const ordered = new Set<string>();
  for (const link of incoming) {
    if (link.link_source === 'frontmatter' && link.origin_slug === pageSlug && link.from_source_id === sourceId
      && (link.origin_source_id ?? sourceId) === sourceId) ordered.add(link.from_slug);
  }
  for (const link of outgoing) {
    if (AUTHORED_LINK_SOURCES.has(link.link_source ?? '') && link.to_source_id === sourceId) ordered.add(link.to_slug);
  }
  ordered.delete(pageSlug);
  if (ordered.size === 0) return [];
  const read = (slugs: string[]) => engine.executeRaw<{ slug: string; type: string | null; frontmatter: unknown; retired: boolean }>(
    `SELECT p.slug, p.type, p.frontmatter, ${retiredPageSql('p')} AS retired FROM pages p
      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND p.deleted_at IS NULL`,
    [sourceId, slugs],
  );
  const pages = new Map((await read([...ordered])).map(row => [row.slug, row]));
  const canonical = new Map<string, string | null>();
  for (const page of pages.values()) {
    if (page.retired) canonical.set(page.slug, (await followRetirement(engine, sourceId, page.slug))?.slug ?? null);
  }
  const targets = [...new Set(canonical.values())].filter((slug): slug is string => slug !== null && !pages.has(slug));
  if (targets.length) for (const row of await read(targets)) pages.set(row.slug, row);
  const hints = new Set<string>();
  for (const linked of ordered) {
    const slug = canonical.has(linked) ? canonical.get(linked) : linked;
    const page = slug ? pages.get(slug) : undefined;
    if (page && !page.retired && isFactEntityPage(page.slug, page.type) && (factVisibility === 'private' || !isPrivatePage(page))) hints.add(page.slug);
  }
  return [...hints].slice(0, CONVERSATION_ENTITY_HINTS_CAP);
}

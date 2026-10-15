/**
 * #6731 — the entities a conversation page itself names, forwarded to the
 * fact extractor as hints.
 *
 * A meeting transcript says "Paul" and "the Maple"; the page that holds it
 * already links `people/paul-example` (frontmatter `attendees:`) and
 * `projects/the-maple` (a body wikilink). Without those, the extractor
 * names facts by first name or by the call's title, and the save-time
 * resolver can only guess. With them, the model names the fact by the exact
 * slug and the resolver lands it on that page.
 *
 * Only edges the page's author wrote count: body markdown/wikilinks,
 * frontmatter (the page's own `attendees:` and similar, outgoing or incoming
 * with this page as origin), resolved bare wikilinks and manual links.
 * Auto-derived edges (`mentions`, atom/concept provenance) are left out: they
 * were inferred from the same text, so feeding them back would only repeat
 * a guess. Hints stay in the page's own source, because the save-time
 * resolver resolves in that source, and only entity pages qualify.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { isFactEntityPage } from '../entities/resolve.ts';
import type { EntityHint } from './extract.ts';

/**
 * How many hints a conversation page forwards. A meeting's attendees plus
 * the companies and properties it links run to a few dozen; the extract_facts
 * op's ENTITY_HINTS_CAP (5) is sized for one agent turn and would drop most
 * of a meeting's attendee list.
 */
export const CONVERSATION_ENTITY_HINTS_CAP = 40;

const AUTHORED_LINK_SOURCES = new Set(['markdown', 'frontmatter', 'wikilink-resolved', 'manual']);

export async function conversationEntityHints(
  engine: BrainEngine,
  sourceId: string,
  page: Pick<Page, 'slug'>,
): Promise<EntityHint[]> {
  const [outgoing, incoming] = await Promise.all([
    engine.getLinks(page.slug, { sourceId }),
    engine.getBacklinks(page.slug, { sourceId }),
  ]);
  const slugs: string[] = [];
  const seen = new Set<string>([page.slug]);
  const add = (slug: string, slugSourceId: string) => {
    if (slugSourceId !== sourceId || seen.has(slug)) return;
    seen.add(slug);
    slugs.push(slug);
  };
  // The page's own frontmatter edges that point at it (attendees → meeting)
  // come first: on a page with more entities than the cap, the people in the
  // room are the ones its facts are most often about.
  for (const link of incoming) {
    if (link.link_source === 'frontmatter' && link.origin_slug === page.slug
      && (link.origin_source_id ?? sourceId) === sourceId) add(link.from_slug, link.from_source_id);
  }
  for (const link of outgoing) {
    if (AUTHORED_LINK_SOURCES.has(link.link_source ?? '')) add(link.to_slug, link.to_source_id);
  }
  const hints: EntityHint[] = [];
  for (const slug of slugs) {
    if (hints.length >= CONVERSATION_ENTITY_HINTS_CAP) break;
    const target = await engine.getPage(slug, { sourceId });
    if (!target || !isFactEntityPage(slug, target.type ?? null)) continue;
    hints.push({ slug, name: target.title || null });
  }
  return hints;
}

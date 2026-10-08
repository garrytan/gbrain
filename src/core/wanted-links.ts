/**
 * Wanted pages: authored links whose target page does not exist yet.
 *
 * Link extraction used to drop such a candidate, so a page that linked to a
 * person before that person's page existed never gained the edge: nothing
 * re-extracted the linking page when the target appeared. Each unresolved
 * authored reference (a body markdown link or wikilink, or a frontmatter link
 * field) is recorded in `wanted_links`, replaced together with the origin's
 * derived links. A live page matching a wanted target and updated after the
 * row's `checked_at` makes the origin stale for extraction
 * (`WANTED_ORIGIN_IS_STALE` in engine-sql/pages.ts), so the next sweep creates the
 * edge and the row disappears. Rows are derived state: the page text is the
 * source of truth.
 */
import type { BrainEngine } from './engine.ts';
import type { LinkCandidate, UnresolvedFrontmatterRef } from './link-extraction.ts';
import { normalizeBasename, unwrapWikilink } from './link-extraction.ts';
import { isValidSourceId } from './source-id.ts';
import type { WantedLinkInput } from './wanted-links-store.ts';

export type { WantedLinkInput, WantedLinksReplacement, WantedProducer } from './wanted-links-store.ts';
export { possibleWantedRows, replaceWantedLinks } from './wanted-links-store.ts';

type Resolution = { ok: true } | { ok: false; reason: string };

/**
 * Wanted rows for one origin page. A body reference is wanted only when every
 * alternative resolution of it failed because the target does not exist in the
 * reference's permitted domain: its qualified source, or the origin's own
 * source for an unqualified reference (a page with that slug in another source
 * does not satisfy it). A qualified reference into a source the origin may not
 * link to is forbidden, never wanted.
 */
export function collectWantedLinks(input: {
  candidates: readonly LinkCandidate[];
  frontmatterUnresolved?: readonly UnresolvedFrontmatterRef[];
  originSourceId: string;
  crossSourceAllowed: boolean;
  resolve: (candidate: LinkCandidate) => Resolution;
}): WantedLinkInput[] {
  const groups = new Map<string, { first: LinkCandidate; resolved: boolean; missing: boolean }>();
  for (const candidate of input.candidates) {
    const ref = candidate.authoredRef;
    if (!ref) continue;
    const result = input.resolve(candidate);
    const group = groups.get(ref.key) ?? { first: candidate, resolved: false, missing: true };
    if (result.ok) group.resolved = true;
    else if (result.reason !== 'missing_target' && result.reason !== 'cross_source') group.missing = false;
    groups.set(ref.key, group);
  }
  const rows = new Map<string, WantedLinkInput>();
  const add = (row: WantedLinkInput) => {
    const key = [row.producer, row.ref_kind, row.target_source_id, row.target_ref].join('\0');
    if (!rows.has(key)) rows.set(key, row);
  };
  for (const { first, resolved, missing } of groups.values()) {
    if (resolved || !missing) continue;
    const ref = first.authoredRef!;
    const targetSourceId = ref.targetSourceId ?? input.originSourceId;
    if (targetSourceId !== input.originSourceId && !input.crossSourceAllowed) continue;
    add({ producer: 'body', ref_kind: ref.kind, target_source_id: targetSourceId, target_ref: ref.target,
      link_type: first.linkType, context: first.context.slice(0, 240) });
  }
  for (const unresolved of input.frontmatterUnresolved ?? []) {
    if (unresolved.reason) continue;
    let target = unwrapWikilink(unresolved.name);
    let targetSourceId = input.originSourceId;
    const colon = target.indexOf(':');
    if (colon > 0 && isValidSourceId(target.slice(0, colon))) {
      targetSourceId = target.slice(0, colon);
      target = target.slice(colon + 1);
      if (targetSourceId !== input.originSourceId && !input.crossSourceAllowed) continue;
    }
    const slugShaped = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9._-]*)+$/.test(target);
    const ref = slugShaped ? target : normalizeBasename(target);
    if (!ref) continue;
    add({ producer: 'frontmatter', ref_kind: slugShaped ? 'slug' : 'name', target_source_id: targetSourceId, target_ref: ref,
      link_type: '', context: `${unresolved.field}: ${unresolved.name}`.slice(0, 240) });
  }
  return [...rows.values()];
}

/** `wanted_pages.enabled` (default on). Off clears an origin's rows on its next extraction. */
export async function isWantedPagesEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const value = await engine.getConfig('wanted_pages.enabled').catch(() => null);
  return value == null || !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}

/** `wanted_pages.remote` (default on; needs `wanted_pages.enabled`): the remote `links` effect records missing mention targets. */
export async function isRemoteWantedPagesEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  const value = await engine.getConfig('wanted_pages.remote').catch(() => null);
  return (value == null || !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase())) && await isWantedPagesEnabled(engine);
}

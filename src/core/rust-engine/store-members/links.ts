/**
 * Link members (BrainEngine addLink, addLinksBatch, removeLink, getLinks, getBacklinks). A write that adds or removes a
 * temporal link refreshes the relationship state it touches, as engine-sql/links.ts does, through the shared builder
 * (link-relationships.ts) after the store call: the keys a delete can change are read before it. The reads serve the
 * page policy, the temporal annotation and the keyset page of `LinkReadScope`.
 */
import type { LinkBatchInput } from '../../engine.ts';
import { annotateTemporalRow, isTemporalLinkType, type EdgeTemporalOpts, type LinkReadPage, type LinkReadScope } from '../../link-validity.ts';
import type { Link } from '../../types.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';
import { linkRelationshipKeysTouching, refreshOnStore } from './link-refresh.ts';
import { checkTemporalDates } from './link-temporal-dates.ts';
import { storePagePolicy } from './private-provenance.ts';

type EndpointSources = { fromSourceId?: string; toSourceId?: string; originSourceId?: string };

export const addLink: StoreMember<[from: string, to: string, context?: string, linkType?: string, linkSource?: string,
  originSlug?: string, originField?: string, opts?: EndpointSources], void> =
  async (brain, from, to, context, linkType, linkSource, originSlug, originField, opts) => {
    const sources = takeOptions('addLink', opts, ['fromSourceId', 'toSourceId', 'originSourceId']);
    await storeCall({ member: 'addLink', slug: from }, () =>
      brain.addLink(from, to, { context, linkType, linkSource, originSlug, originField, ...sources }));
    if (isTemporalLinkType(linkType)) {
      await refreshOnStore(brain, await linkRelationshipKeysTouching(brain, 'addLink', { pairs: [{ from_slug: from,
        from_source_id: opts?.fromSourceId ?? 'default', to_slug: to, to_source_id: opts?.toSourceId ?? 'default' }] }));
    }
  };

const BATCH_FIELDS = ['from_slug', 'to_slug', 'link_type', 'context', 'link_source', 'origin_slug', 'origin_field',
  'from_source_id', 'to_source_id', 'origin_source_id', 'link_kind', 'resolution_type'] as const;

export const addLinksBatch: StoreMember<[links: LinkBatchInput[], opts?: { auditSite?: unknown; signal?: AbortSignal }], number> = async (brain, links, opts) => {
  takeOptions('addLinksBatch', opts, [], ['auditSite', 'signal']);
  throwIfAborted(opts?.signal);
  // The store keeps `link_kind` and `resolution_type` on the link record (gbrain-store links.rs `LinkRecord`).
  for (const link of links) takeOptions('addLinksBatch', link, BATCH_FIELDS);
  const written: number = await storeCall({ member: 'addLinksBatch' }, () => brain.addLinksBatch(links));
  const pairs = links.filter(l => isTemporalLinkType(l.link_type)).map(l => ({ from_slug: l.from_slug,
    from_source_id: l.from_source_id ?? 'default', to_slug: l.to_slug, to_source_id: l.to_source_id ?? 'default' }));
  await refreshOnStore(brain, await linkRelationshipKeysTouching(brain, 'addLinksBatch', { pairs }));
  return written;
};

export const removeLink: StoreMember<[from: string, to: string, linkType?: string, linkSource?: string,
  opts?: { fromSourceId?: string; toSourceId?: string }], number> =
  async (brain, from, to, linkType, linkSource, opts) => {
    const sources = takeOptions('removeLink', opts, ['fromSourceId', 'toSourceId']);
    const before = linkType === undefined || isTemporalLinkType(linkType) ? await linkRelationshipKeysTouching(brain, 'removeLink', {
      pairs: [{ from_slug: from, from_source_id: opts?.fromSourceId ?? 'default', to_slug: to, to_source_id: opts?.toSourceId ?? 'default' }] }) : [];
    const removed: number = await storeCall({ member: 'removeLink', slug: from }, () => brain.removeLink(from, to, { linkType, linkSource, ...sources }));
    if (removed) await refreshOnStore(brain, before);
    return removed;
  };

/**
 * `getLinks` / `getBacklinks`: the store applies the page policy, the keyset page and the temporal match, and returns
 * the raw temporal columns, which are annotated here as engine-sql's `finishTemporal` does. `requireSafeChunks` and
 * `takesHoldersAllowList` (the rest of readPolicyOpts) gate chunk and take reads only; engine-sql's link reads never
 * read them, so the store ignores them too.
 */
async function readLinks(brain: StoreBrain, member: 'getLinks' | 'getBacklinks', slug: string,
  opts: LinkReadScope | undefined): Promise<Link[]> {
  const o = takeOptions(member, opts, ['sourceId', 'sourceIds', 'temporal', 'page', 'excludePrivate'], ['requireSafeChunks', 'takesHoldersAllowList']);
  checkTemporalDates((o.page as LinkReadPage | undefined)?.relationship?.policy);
  const scope = { ...o, excludePrivate: storePagePolicy(member, o.excludePrivate, { callerReaders: true }) ?? null };
  const rows: Link[] = await storeCall({ member, slug }, () => member === 'getLinks' ? brain.getLinks(slug, scope) : brain.getBacklinks(slug, scope));
  const temporal = (o.page as LinkReadPage | undefined)?.count ? undefined : o.temporal as EdgeTemporalOpts | undefined;
  return temporal ? rows.map(r => annotateTemporalRow(r, temporal.asOf)) : rows;
}

export const getLinks: StoreMember<[slug: string, opts?: LinkReadScope], Link[]> = (brain, slug, opts) =>
  readLinks(brain, 'getLinks', slug, opts);

export const getBacklinks: StoreMember<[slug: string, opts?: LinkReadScope], Link[]> = (brain, slug, opts) =>
  readLinks(brain, 'getBacklinks', slug, opts);

/** Link members (BrainEngine addLink, addLinksBatch, removeLink, getLinks, getBacklinks). */
import type { LinkBatchInput } from '../../engine.ts';
import type { LinkReadScope } from '../../link-validity.ts';
import type { Link } from '../../types.ts';
import { storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';

type EndpointSources = { fromSourceId?: string; toSourceId?: string; originSourceId?: string };

export const addLink: StoreMember<[from: string, to: string, context?: string, linkType?: string, linkSource?: string,
  originSlug?: string, originField?: string, opts?: EndpointSources], void> =
  async (brain, from, to, context, linkType, linkSource, originSlug, originField, opts) => {
    const sources = takeOptions('addLink', opts, ['fromSourceId', 'toSourceId', 'originSourceId']);
    await storeCall({ member: 'addLink', slug: from }, () =>
      brain.addLink(from, to, { context, linkType, linkSource, originSlug, originField, ...sources }));
  };

const BATCH_FIELDS = ['from_slug', 'to_slug', 'link_type', 'context', 'link_source', 'origin_slug', 'origin_field',
  'from_source_id', 'to_source_id', 'origin_source_id'] as const;

export const addLinksBatch: StoreMember<[links: LinkBatchInput[], opts?: { auditSite?: unknown; signal?: AbortSignal }], number> = async (brain, links, opts) => {
  takeOptions('addLinksBatch', opts, [], ['auditSite', 'signal']);
  throwIfAborted(opts?.signal);
  // `link_kind` and `resolution_type` are stored beside a link and are not part of what the store keeps today.
  for (const link of links) takeOptions('addLinksBatch', link, BATCH_FIELDS);
  return storeCall({ member: 'addLinksBatch' }, () => brain.addLinksBatch(links));
};

export const removeLink: StoreMember<[from: string, to: string, linkType?: string, linkSource?: string,
  opts?: { fromSourceId?: string; toSourceId?: string }], number> =
  async (brain, from, to, linkType, linkSource, opts) => {
    const sources = takeOptions('removeLink', opts, ['fromSourceId', 'toSourceId']);
    return storeCall({ member: 'removeLink', slug: from }, () => brain.removeLink(from, to, { linkType, linkSource, ...sources }));
  };

export const getLinks: StoreMember<[slug: string, opts?: LinkReadScope], Link[]> = (brain, slug, opts) =>
  storeCall({ member: 'getLinks', slug }, () => brain.getLinks(slug, takeOptions('getLinks', opts, ['sourceId', 'sourceIds'])));

export const getBacklinks: StoreMember<[slug: string, opts?: LinkReadScope], Link[]> = (brain, slug, opts) =>
  storeCall({ member: 'getBacklinks', slug }, () => brain.getBacklinks(slug, takeOptions('getBacklinks', opts, ['sourceId', 'sourceIds'])));

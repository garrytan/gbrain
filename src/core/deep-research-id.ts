import { isValidSourceId } from './source-id.ts';
import { validateSlug } from './utils.ts';
import type { PageKey } from './page-state/types.ts';

const NAMESPACE = 'gbrain-page:';
const PREFIX = `${NAMESPACE}v1:`;

export function encodeDeepResearchId(sourceId: string | undefined, slug: string): string {
  if (!isValidSourceId(sourceId) || typeof slug !== 'string' || validateSlug(slug) !== slug) {
    throw new Error('Invalid search result identity');
  }
  return PREFIX + Buffer.from(JSON.stringify([sourceId, slug]), 'utf8').toString('base64url');
}

export function decodeDeepResearchId(id: string): PageKey | null {
  if (id !== id.trim() && id.trim().startsWith(NAMESPACE)) throw new Error('Invalid result id encoding');
  if (!id.startsWith(NAMESPACE)) return null;
  if (!id.startsWith(PREFIX)) throw new Error('Unsupported result id version');
  const payload = id.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error('Invalid result id encoding');
  const bytes = Buffer.from(payload, 'base64url');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || value.length !== 2 ||
      typeof value[0] !== 'string' || typeof value[1] !== 'string' ||
      encodeDeepResearchId(value[0], value[1]) !== id) {
    throw new Error('Invalid result id payload');
  }
  return { sourceId: value[0], slug: value[1] };
}

export function deepResearchPageUrl(sourceId: string, slug: string): string {
  return `gbrain://page/${encodeURIComponent(sourceId)}/${slug.split('/').map(encodeURIComponent).join('/')}`;
}

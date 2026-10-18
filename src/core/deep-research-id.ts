import { isValidSourceId } from './source-id.ts';
import { validateSlug } from './utils.ts';
import type { PageKey } from './page-state/types.ts';

const NAMESPACE = 'gbrain-page:';
const PREFIX = `${NAMESPACE}v1:`;

/**
 * Large pages (Wave A, T24): an id may carry where to read in the page: the
 * search hit's chunk (`{ c: chunk_id }`) or a window continuation
 * (`{ w: cursor }`). The page identity decodes the same with or without it,
 * and the anchor grants nothing: fetch re-authorizes the page every time.
 */
export interface DeepResearchAnchor { chunkId?: number; cursor?: string }

export function encodeDeepResearchId(sourceId: string | undefined, slug: string, anchor?: DeepResearchAnchor): string {
  if (!isValidSourceId(sourceId) || typeof slug !== 'string' || validateSlug(slug) !== slug) {
    throw new Error('Invalid search result identity');
  }
  const extra = anchor?.chunkId !== undefined ? [{ c: anchor.chunkId }] : anchor?.cursor !== undefined ? [{ w: anchor.cursor }] : [];
  return PREFIX + Buffer.from(JSON.stringify([sourceId, slug, ...extra]), 'utf8').toString('base64url');
}

function anchorOf(value: unknown): DeepResearchAnchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const v = value as Record<string, unknown>;
  if (keys.length === 1 && keys[0] === 'c' && Number.isSafeInteger(v.c) && (v.c as number) > 0) return { chunkId: v.c as number };
  if (keys.length === 1 && keys[0] === 'w' && typeof v.w === 'string' && v.w.length > 0 && v.w.length <= 512) return { cursor: v.w };
  return null;
}

function decodeParts(id: string): { key: PageKey; anchor: DeepResearchAnchor | null } | null {
  if (id !== id.trim() && id.trim().startsWith(NAMESPACE)) throw new Error('Invalid result id encoding');
  if (!id.startsWith(NAMESPACE)) return null;
  if (!id.startsWith(PREFIX)) throw new Error('Unsupported result id version');
  const payload = id.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error('Invalid result id encoding');
  const bytes = Buffer.from(payload, 'base64url');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const anchor = Array.isArray(value) && value.length === 3 ? anchorOf(value[2]) : null;
  if (!Array.isArray(value) || (value.length !== 2 && !(value.length === 3 && anchor)) ||
      typeof value[0] !== 'string' || typeof value[1] !== 'string' ||
      encodeDeepResearchId(value[0], value[1], anchor ?? undefined) !== id) {
    throw new Error('Invalid result id payload');
  }
  return { key: { sourceId: value[0], slug: value[1] }, anchor };
}

export function decodeDeepResearchId(id: string): PageKey | null {
  return decodeParts(id)?.key ?? null;
}

/** The read position an id carries, or null (a plain page id, or a legacy slug). Throws like decodeDeepResearchId on a malformed id. */
export function decodeDeepResearchAnchor(id: string): DeepResearchAnchor | null {
  return decodeParts(id)?.anchor ?? null;
}

export function deepResearchPageUrl(sourceId: string, slug: string): string {
  return `gbrain://page/${encodeURIComponent(sourceId)}/${slug.split('/').map(encodeURIComponent).join('/')}`;
}

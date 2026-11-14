/**
 * Guest notes, slice 3 (GBRA-504): stamps the guest warning onto an op's output. Runs on every op that returns stored
 * text, wrapped once at registration (operation-load.ts finalizeOperation), so every remote, stdio and enforced-member
 * dispatch, the local CLI and in-process callers all get it. The shared page-item walker (access/page-items.ts) finds
 * every page-bearing item; the batched trust load (eligibility/stamp.ts loadPageTrust) decides per row whether its
 * source is a guest source and reads the marks; each guest item gains `trust_tier: external_untrusted`,
 * `origin: "guest"` and its `guest` object, and a remote quote fence around its text names the guest. The stamp is
 * on the handler's result, so dispatch's response-cap fallback, which drops room marks, never drops it.
 */
import type { OperationContext } from '../ops/contract.ts';
import { currentCallerAccess } from '../search/private-visibility.ts';
import { collectPageItems, type Ref } from '../access/page-items.ts';
import { loadPageTrust } from '../eligibility/stamp.ts';
import { relabelGuestQuote } from '../search/transcript-quote.ts';
import { GUEST_ORIGIN, guestQuoteLabel } from './marker.ts';

/** An owner caller sees the guest note's writer: the trusted local CLI, or a credential bound to the owner speaking for no one else. */
export function guestViewerIsOwner(ctx: Pick<OperationContext, 'remote'>): boolean {
  if (ctx.remote === false) return true;
  const access = currentCallerAccess();
  return access.owner && !access.audience?.length;
}

function detachedCopy<T>(value: T): T {
  let copy: T;
  try { copy = structuredClone(value); } catch { return value; }
  if (value && typeof value === 'object' && copy && typeof copy === 'object') {
    for (const key of Object.getOwnPropertySymbols(value)) (copy as Record<symbol, unknown>)[key] = (value as Record<symbol, unknown>)[key];
  }
  return copy;
}

const refSlug = (r: Ref) => (r.kind === 'page' ? r.slug : undefined);

/**
 * `result` with every guest item stamped, on a detached copy (handlers may return cached objects), or `result` itself
 * when nothing in it is a guest row. A failed trust load fails the read rather than return a guest note unmarked.
 */
export async function stampGuestNotes(ctx: Pick<OperationContext, 'engine' | 'remote' | 'sourceId'>, result: unknown): Promise<unknown> {
  if (!result || typeof result !== 'object') return result;
  const found = collectPageItems(result, ctx.sourceId ?? 'default').filter(s => s.ref !== null && s.ref.kind !== 'fact');
  if (!found.length) return result;
  const refs = found.map(s => s.ref!).map(r => r.kind === 'page' ? { source_id: r.source_id, slug: r.slug } : { page_id: (r as { id: number }).id, slug: '' });
  const trust = await loadPageTrust(ctx.engine, refs, { guestWriter: guestViewerIsOwner(ctx), includeDeleted: true });
  const guestOf = (r: Ref) => (r.kind === 'page' ? trust.byKey.get(`${r.source_id}\u0000${r.slug}`) : r.kind === 'page_id' ? trust.byId.get(r.id) : undefined)?.guest;
  if (!found.some(s => guestOf(s.ref!))) return result;
  const copy = detachedCopy(result);
  for (const slot of collectPageItems(copy, ctx.sourceId ?? 'default')) {
    const guest = slot.ref ? guestOf(slot.ref) : undefined;
    if (!guest) continue;
    const h = slot.holder;
    h.trust_tier = 'external_untrusted';
    h.origin = GUEST_ORIGIN;
    h.guest = guest;
    const slug = refSlug(slot.ref!) ?? (typeof h.slug === 'string' ? h.slug : undefined);
    if (!slug) continue;
    for (const [k, v] of Object.entries(h)) if (typeof v === 'string') h[k] = relabelGuestQuote(v, slug, guestQuoteLabel(guest));
  }
  return copy;
}

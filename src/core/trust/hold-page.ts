/**
 * Where an owner release of a held fact lands (decision: quarantine holds follow their page, write-gate-schema.ts).
 * A hold bound to a page id (`page_id`) is released onto that page, whatever it is called now; it is refused, never
 * moved to whichever page holds the old name, when that page is gone (purged). A hold the upgrade could not tie to one
 * page (`page_candidates`) is refused too: dropping it stays possible. An unbound hold keeps the old rule (its slug and its
 * entity name the page).
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import type { WriteGateHold } from '../write-gate-store.ts';

/** A hold as the owner-action adapters carry it: the binding fields are absent on a hold row read before v333. */
export type HoldPageInput = Pick<WriteGateHold, 'id' | 'source_id' | 'slug' | 'payload'> & { page_id?: number | null; page_candidates?: number[] | null };

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Refuses a hold an upgrade marked with candidate pages: it could belong to any of them, so no release may publish it. Drop stays possible. */
export function refuseCandidateHold(hold: HoldPageInput): void {
  if (hold.page_id == null && hold.page_candidates?.length) {
    throw opError('unavailable', `h${hold.id} cannot be released: after an upgrade it could not be tied to one page (it may belong to any of ${hold.page_candidates.length}), so nothing was changed and the fact stays held.`,
      `Drop it with gbrain trust drop h${hold.id}, then remember the fact on the right page yourself if it belongs there. gbrain doctor lists these holds (write_gate_hold_ambiguous).`);
  }
}

/** The page a bound hold belongs to now (its current slug); null for an unbound hold. Throws when the bound page is gone or the hold is ambiguous. */
export async function holdPage(engine: Pick<BrainEngine, 'executeRaw'>, hold: HoldPageInput): Promise<{ id: number; slug: string } | null> {
  refuseCandidateHold(hold);
  if (hold.page_id == null) return null;
  const [page] = await engine.executeRaw<{ id: number; slug: string }>('SELECT id, slug FROM pages WHERE id = $1 AND source_id = $2', [hold.page_id, hold.source_id]);
  if (!page) {
    throw opError('page_not_found', `The page h${hold.id} was held for no longer exists (it was purged); nothing was changed and the fact stays held.`,
      `A page that now has the old name is a different page, so the fact is not released onto it. Drop the hold with gbrain trust drop h${hold.id}, and remember the fact on the right page yourself if it belongs there.`);
  }
  return { id: Number(page.id), slug: page.slug };
}

/** The entity page a held fact is published for: a bound hold whose entity named its own page follows that page's current name. */
export function releaseEntitySlug(hold: Pick<WriteGateHold, 'slug' | 'payload'>, bound: { slug: string } | null): string | null {
  const entity = str(hold.payload.entity_slug);
  return bound && entity === hold.slug ? bound.slug : entity;
}

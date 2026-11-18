/**
 * Facts relink writes: the guarded facts update members (BrainEngine placeRelinkedFact, linkConversationFact) and the
 * conversation relink's page pick (listConversationRelinkPages;
 * src/core/engine-sql/fact-relink-writes.ts), over rust/crates/gbrain-store/src/facts/relink_writes.rs.
 *
 * A fact id or row number the store cannot read as the integer PGLite binds (not a safe integer) refuses rather than
 * guess at the cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { REARMED_REASONS } from '../../facts/conversation-memo.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function requireInteger(member: string, what: string, n: number): void {
  if (!Number.isSafeInteger(n)) refuseMember(member, `a ${what} that is not a safe integer`);
}

export const placeRelinkedFact: Member<'placeRelinkedFact'> = async (brain, sourceId, placement) => {
  requireInteger('placeRelinkedFact', 'fact id', placement.factId);
  const wire = placement.action === 'link'
    ? (requireInteger('placeRelinkedFact', 'row number', placement.rowNum),
      { factId: placement.factId, action: 'link', slug: placement.slug, rowNum: placement.rowNum, context: placement.context })
    : { factId: placement.factId, action: placement.action, slug: placement.slug, context: placement.context };
  const moved: boolean = await storeCall({ member: 'placeRelinkedFact', sourceId }, () => brain.placeRelinkedFact(sourceId, wire));
  return moved === true;
};

export const linkConversationFact: Member<'linkConversationFact'> = async (brain, sourceId, link) => {
  requireInteger('linkConversationFact', 'fact id', link.factId);
  const linked: boolean = await storeCall({ member: 'linkConversationFact', sourceId }, () => brain.linkConversationFact(sourceId, {
    factId: link.factId, pageSlug: link.pageSlug, fact: link.fact, entitySlug: link.entitySlug, context: link.context,
    from: link.from ?? null,
  }));
  return linked === true;
};

export const listConversationRelinkPages: Member<'listConversationRelinkPages'> = async (brain, sourceId, q) => {
  const slugs: string[] = await storeCall({ member: 'listConversationRelinkPages', sourceId }, () => brain.listConversationRelinkPages(sourceId, {
    limit: q.limit, unbacked: q.unbacked, skipTried: q.skipTried, rearmedReasons: REARMED_REASONS,
  }));
  return slugs;
};

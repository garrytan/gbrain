/**
 * Saved facts about the entity a search names. Facts saved with `remember`
 * live in the facts table, not in page chunks, so a search whose words differ
 * from the fact's ("discount code for ONSO" against "Ondresso Systems is being
 * folded into Dovalto Energy") never found them by word overlap, and agents
 * answered from older documents instead of the newer saved correction.
 *
 * When the query names an entity (search/alias-fanout.ts), its newest active
 * facts (also those saved under an identity sibling or its bare name) are
 * returned first. One hop: an entity a returned fact names ("folded into
 * Dovalto Energy", "uses Dovalto Energy's discount code") contributes its own
 * newest facts, tagged `linked_from`, so a redirection reaches the value it
 * points to. Same source scope, active-fact, visibility and read-eligibility
 * rules as recall (quarantined-page and needs_rederive facts hidden, the
 * caller's trust floor applied),
 * and recall's collapse (#7043): copies of one claim read as one fact, before
 * the caps, so they never crowd out a distinct one.
 */

import type { BrainEngine } from '../engine.ts';
import { worldOnlyFacts } from './private-visibility.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { factEntitySlugs } from '../mentions/siblings.ts';
import { resolveQueryEntities, type ResolvedEntity } from './alias-fanout.ts';
import { collapseFactReads } from '../facts/capture-dedup.ts';
import type { FactAttribution } from '../engine.ts';
import type { TrustTier } from '../trust/tier.ts';
import { applySlotEnds } from './slot-ends.ts';

export const ENTITY_FACTS_CAP = 5;
export const LINKED_FACTS_CAP = 3;
const LINKED_ENTITIES_CAP = 2;

export interface EntityFact { id: number; fact: string; entity_slug: string | null; kind: string; valid_from: string | null; source: string; linked_from?: string;
  /** #7043: every entity of the copies this row stands for, and how many rows it stands for. */
  entity_slugs?: string[]; collapsed_count?: number }

/** Rows read per cap so copies of one claim collapse before the cap (#7043). */
export { SAVED_FACTS_COLLAPSE_WINDOW } from '../engine-sql/facts-trust.ts';
/** The columns the collapse reads besides a saved fact's own; `stripCollapseColumns` drops them from the response. */
import { SAVED_FACT_COLLAPSE_COLUMNS, type CollapseColumns } from './saved-fact-collapse.ts';

export { SAVED_FACT_COLLAPSE_COLUMNS, type CollapseColumns };

/** A saved fact as the response carries it, without the collapse columns and member ids. */
export function stripCollapseColumns<T extends CollapseColumns & { collapsed_ids?: number[] }>({ source_id: _s, visibility: _v, created_at: _c, attributed_to: _a, fact_fingerprint: _f, collapsed_ids: _i, ...rest }: T): Omit<T, keyof CollapseColumns | 'collapsed_ids'> {
  return rest;
}

async function newestFacts(engine: BrainEngine, sourceId: string, slugs: string[], opts: { remote: boolean; excludePrivate: boolean; minTrust?: TrustTier }, limit: number): Promise<Array<EntityFact & CollapseColumns>> {
  const rows = await engine.readEntityNewestFacts({ sourceId, slugs, remote: opts.remote, worldOnly: worldOnlyFacts(opts.remote), minTrust: opts.minTrust });
  // GST-3170: a slot value a later one ended at read time is no longer current (slot-ends.ts).
  const current = await applySlotEnds(engine, { sourceId, worldOnly: worldOnlyFacts(opts.remote), excludePrivate: opts.remote || opts.excludePrivate, minTrust: opts.minTrust },
    rows.map(r => ({ ...r, id: Number(r.id) })), { activeOnly: true, entities: [{ source_id: sourceId, slugs }] });
  return (await collapseFactReads(engine, current)).slice(0, limit);
}

/** The named entity's newest facts, then those of entities its facts name, with the collapse columns. Fail-soft: errors return [], but an engine capability refusal is rethrown. */
export async function entitySavedFacts(engine: BrainEngine, entity: ResolvedEntity, opts: { remote: boolean; excludePrivate: boolean; minTrust?: TrustTier }): Promise<Array<EntityFact & CollapseColumns>> {
  try {
    const sourceId = entity.pages[0]!.source_id;
    const own = new Set<string>();
    for (const p of entity.pages) for (const s of await factEntitySlugs(engine, sourceId, p.slug, { excludePrivate: opts.excludePrivate })) own.add(s);
    const facts = await newestFacts(engine, sourceId, [...own], opts, ENTITY_FACTS_CAP);
    const out: Array<EntityFact & CollapseColumns> = [...facts];
    const seenEntities = new Set(own);
    let linked = 0;
    for (const f of facts) {
      if (linked >= LINKED_ENTITIES_CAP) break;
      for (const other of await resolveQueryEntities(engine, f.fact, { sourceId, excludePrivate: opts.excludePrivate })) {
        if (linked >= LINKED_ENTITIES_CAP || other.pages.some(p => seenEntities.has(p.slug))) continue;
        const slugs = new Set<string>();
        for (const p of other.pages) for (const s of await factEntitySlugs(engine, sourceId, p.slug, { excludePrivate: opts.excludePrivate })) slugs.add(s);
        if ([...slugs].some(s => seenEntities.has(s))) continue;
        for (const s of slugs) seenEntities.add(s);
        linked++;
        for (const g of await newestFacts(engine, sourceId, [...slugs], opts, LINKED_FACTS_CAP)) {
          if (!out.some(x => x.id === g.id)) out.push({ ...g, linked_from: f.entity_slug ?? entity.pages[0]!.slug });
        }
      }
    }
    return out;
  } catch (err) {
    rethrowCapabilityRefusal(err);
    return [];
  }
}

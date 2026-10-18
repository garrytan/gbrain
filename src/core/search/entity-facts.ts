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
 * points to. Same source scope, active-fact and visibility rules as recall.
 */

import type { BrainEngine } from '../engine.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { privateProvenanceFilterFragment } from './private-visibility.ts';
import { factEntitySlugs } from '../mentions/siblings.ts';
import { resolveQueryEntities, type ResolvedEntity } from './alias-fanout.ts';

export const ENTITY_FACTS_CAP = 5;
export const LINKED_FACTS_CAP = 3;
const LINKED_ENTITIES_CAP = 2;

export interface EntityFact { id: number; fact: string; entity_slug: string | null; kind: string; valid_from: string; source: string; linked_from?: string }

async function newestFacts(engine: BrainEngine, sourceId: string, slugs: string[], remote: boolean, limit: number): Promise<EntityFact[]> {
  const visibility = remote ? `AND f.visibility = 'world' AND ${privateProvenanceFilterFragment('f')}` : '';
  const rows = await engine.executeRaw<EntityFact>(
    `SELECT f.id, f.fact, f.entity_slug, f.kind, f.valid_from::text AS valid_from, f.source
       FROM facts f
      WHERE f.source_id = $1 AND f.entity_slug = ANY($2::text[])
        AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
        AND f.source != ALL($3::text[])
        ${visibility}
      ORDER BY f.valid_from DESC, f.id DESC
      LIMIT ${limit}`,
    [sourceId, slugs, [...AUDIT_ROW_SOURCES]]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** The named entity's newest facts, then those of entities its facts name. Fail-soft: errors return []. */
export async function entitySavedFacts(engine: BrainEngine, entity: ResolvedEntity, opts: { remote: boolean; excludePrivate: boolean }): Promise<EntityFact[]> {
  try {
    const sourceId = entity.pages[0]!.source_id;
    const own = new Set<string>();
    for (const p of entity.pages) for (const s of await factEntitySlugs(engine, sourceId, p.slug, { excludePrivate: opts.excludePrivate })) own.add(s);
    const facts = await newestFacts(engine, sourceId, [...own], opts.remote, ENTITY_FACTS_CAP);
    const out: EntityFact[] = [...facts];
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
        for (const g of await newestFacts(engine, sourceId, [...slugs], opts.remote, LINKED_FACTS_CAP)) {
          if (!out.some(x => x.id === g.id)) out.push({ ...g, linked_from: f.entity_slug ?? entity.pages[0]!.slug });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

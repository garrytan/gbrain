import type { BrainEngine } from '../engine.ts';
import type { FactsBackstopCtx } from './backstop.ts';
import type { FenceInputFact } from './fence-write.ts';
import type { ExtractedFact } from './extract.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { prepareManagedFactsSession, publishManagedFacts, resolveManagedFactsEmbedding, resumeManagedFacts } from '../persistence/facts-maintenance.ts';

function factsContext(engine: BrainEngine, sourceId: string, requestIntent: Record<string, unknown>, sessionId: string | null = null): FactsBackstopCtx {
  return { engine, sourceId, sessionId, source: 'mcp:extract_facts', remote: false, requestIntent };
}

/** Validates managed fact authority and ownership before a caller spends on a model. No-op when unmanaged. */
export async function managedFactWritePreflight(engine: BrainEngine, sourceId: string): Promise<void> {
  if (!await managedPersistenceEnabled(engine)) return;
  await prepareManagedFactsSession(factsContext(engine, sourceId, { preflight: 'managed_fact_write' }), { turnText: '' });
}

/**
 * Managed brains append entity facts through the coordinator's fact intent
 * (managed_facts_entity): the fence row, its index row and the canonical file
 * publish together, deduplicated and withdrawal-checked at publication. An
 * entity with no live page lands database-only, like the legacy stub guard.
 * The request identity derives from the write itself, so a retried job
 * replays its receipt. Returned ids follow input order.
 */
export async function publishManagedEntityFacts(engine: BrainEngine, sourceId: string, entity: string | null,
  facts: FenceInputFact[], options: { supersede?: boolean; attributeFallback?: boolean } = {}): Promise<{ inserted: number; duplicate: number; superseded: number; ids: number[] }> {
  const out = { inserted: 0, duplicate: 0, superseded: 0, ids: new Array<number>(facts.length) };
  for (const visibility of ['private', 'world'] as const) {
    const positions = facts.flatMap((fact, i) => fact.visibility === visibility ? [i] : []);
    if (!positions.length) continue;
    const group = positions.map(i => facts[i]);
    const ctx = factsContext(engine, sourceId, { writer: 'fence_write', entity, visibility, supersede: options.supersede === true,
      ...(options.attributeFallback ? { attribute_fallback: true } : {}),
      facts: group.map(f => [f.fact, f.kind, f.source, f.notability, f.confidence ?? 1, f.validFrom?.toISOString() ?? null,
        f.validUntil?.toISOString() ?? null, f.sessionId, f.context ?? null]) }, group[0].sessionId);
    const session = (await prepareManagedFactsSession(ctx, { turnText: '' }))!;
    let result = await resumeManagedFacts(engine, session);
    if (!result) {
      const signature = await resolveManagedFactsEmbedding(engine, session.config);
      session.embedding = signature;
      const extracted: ExtractedFact[] = group.map(f => ({ fact: f.fact, kind: f.kind, entity_slug: entity, visibility,
        notability: f.notability, source: f.source, context: f.context ?? null, confidence: f.confidence ?? 1,
        valid_from: f.validFrom, valid_until: f.validUntil ?? null, source_session: f.sessionId,
        embedding: signature && f.embedding_model === signature.model && f.embedding?.length === signature.dimensions ? f.embedding : null }));
      result = await publishManagedFacts(engine, session, ctx, extracted, visibility, undefined,
        { supersede: options.supersede, explicitContext: true, attributeFallback: options.attributeFallback });
    }
    out.inserted += result.inserted;
    out.duplicate += result.duplicate;
    out.superseded += result.superseded;
    positions.forEach((position, i) => { out.ids[position] = result!.fact_ids[i]; });
  }
  return out;
}

/** Shared automatic-capture policy adapter (#capture-policy); explicit writers never call this. */
import type { FactsBackstopCtx } from './backstop.ts';
import type { ExtractedFact } from './extract.ts';
import type { ManagedFactsSession } from '../persistence/facts-maintenance.ts';
import { resolveStrictEntityReference, resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { classifyCaptureValue, captureMode, chooseSpecificEntity, routingTypes } from './capture-policy.ts';
import { isFactWithdrawn } from './withdrawal.ts';
import { linkAllowed } from './subject-infer-write.ts';
import { appendContextNote } from './subject-infer.ts';
import { writeFactsAbsorbLog } from './absorb-log.ts';

export interface CaptureCounts { filtered?: number; rerouted?: number; would_filter?: number; would_reroute?: number; capped?: number; withdrawn_skipped?: number }
export async function applyCapturePolicy(ctx: FactsBackstopCtx, input: ExtractedFact[], visibility: 'private' | 'world', managed: ManagedFactsSession | null) {
  const engine = ctx.engine;
  const filter = captureMode(await engine.getConfig('facts.capture_filter'));
  const routing = captureMode(await engine.getConfig('facts.capture_routing'));
  const counts: CaptureCounts = {};
  if (filter === 'off' && routing === 'off') return { facts: input, counts };
  const facts: ExtractedFact[] = [];
  const broadTypes = routingTypes(await engine.getConfig('facts.routing.broad_types'), 'company');
  const specificTypes = routingTypes(await engine.getConfig('facts.routing.specific_types'), 'person,project,deal');
  const remote = managed ? managed.authority.remote : (ctx.operationContext?.remote ?? ctx.remote) !== false;
  const { excludesPrivateWrites } = await import('../persistence/page-visibility.ts');
  const excludePrivate = managed?.authority.excludePrivate === true || await excludesPrivateWrites(engine, remote);
  const count = (key: keyof CaptureCounts) => { counts[key] = (counts[key] ?? 0) + 1; };
  for (let f of input) {
    if (filter !== 'off' && classifyCaptureValue(f).verdict === 'drop') {
      count(filter === 'on' ? 'filtered' : 'would_filter');
      if (filter === 'on') continue;
    }
    if (routing !== 'off' && f.entity_slug) {
      const original = await resolveEntitySlugWithSource(engine, ctx.sourceId, f.entity_slug);
      if (original && original.source !== 'fallback_slugify') {
        const page = await engine.getPage(original.slug, { sourceId: ctx.sourceId });
        const aliases = await engine.executeRaw<{ alias: string }>('SELECT alias_norm AS alias FROM page_aliases WHERE source_id=$1 AND slug=$2', [ctx.sourceId, original.slug]);
        const chosen = await chooseSpecificEntity({ fact: f.fact, slug: original.slug, broadTypes, specificTypes,
          broadNames: [page?.title ?? '', ...aliases.map(a => a.alias)].filter(Boolean) }, {
          resolve: query => resolveStrictEntityReference(engine, ctx.sourceId, query, { excludePrivate }),
          typeOf: async slug => (await engine.getPage(slug, { sourceId: ctx.sourceId }))?.type ?? null,
          isWithdrawn: slug => isFactWithdrawn(engine, ctx.sourceId, visibility, f.fact, slug),
        });
        if (!chosen.slug && routing === 'on') { count('withdrawn_skipped'); continue; }
        if (chosen.rerouted && chosen.slug && await linkAllowed(ctx, chosen.slug, f.fact, visibility, remote, managed)) {
          count(routing === 'on' ? 'rerouted' : 'would_reroute');
          if (routing === 'on') f = { ...f, entity_slug: chosen.slug, routed_from: original.slug, context: appendContextNote(f.context, `routed from ${original.slug}`) };
        }
      }
    }
    facts.push(f);
  }
  if (Object.keys(counts).length) await writeFactsAbsorbLog(engine, ctx.sourceSlug ?? ctx.sessionId ?? 'turn', 'capture_policy', JSON.stringify(counts), ctx.sourceId);
  return { facts, counts };
}

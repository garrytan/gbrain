/**
 * Write-time fact subject inference for the facts backstop (#5836).
 *
 * The extractor sometimes returns a fact with no entity, or one that names
 * no live page. `inferMissingSubjects` gives such a fact the subject that
 * `inferFactSubject` proves from identity evidence (the page being written,
 * or one exact mention), and marks it `entity_inferred` so the writers
 * annotate its context and never supersede or drop a similar fact for it.
 *
 * Inference is applied only where the fact will be fenced: the unmanaged
 * DB-only branch (no local_path, or write-through off) would leave a
 * row_num-NULL row on a live page and jam the extract_facts legacy guard,
 * so those facts stay unattributed. A link is also dropped whenever the
 * writer would refuse it: caller slug fences, the managed batch's grant and
 * page visibility, a withdrawn claim, or a malformed target fence (which
 * would fail the whole write). Remote callers infer only from the page
 * actually being written and never from pages they cannot read.
 */

import type { BrainEngine } from '../engine.ts';
import type { FactsBackstopCtx } from './backstop.ts';
import type { ExtractedFact } from './extract.ts';
import type { ManagedFactsSession } from '../persistence/facts-maintenance.ts';
import { inferFactSubject, isEntityInferenceEnabled, type InferredVia } from './subject-infer.ts';
import { isNullLikeEntity } from './write-single.ts';

/** The context note an inferred link carries, in the DB row and the fence cell alike. */
export function inferenceNote(via: InferredVia): string {
  return `entity inferred from ${via}`;
}

export async function inferMissingSubjects(ctx: FactsBackstopCtx, facts: ExtractedFact[], visibility: 'private' | 'world',
  pageSlug: string | undefined, managed: ManagedFactsSession | null): Promise<ExtractedFact[]> {
  const engine = ctx.engine;
  if (!facts.length || !(await isEntityInferenceEnabled(engine))) return facts;
  if (!managed && await writesDatabaseOnly(engine, ctx.sourceId)) return facts;
  const { excludesPrivateWrites } = await import('../persistence/page-visibility.ts');
  const remote = managed ? managed.authority.remote : (ctx.operationContext?.remote ?? ctx.remote) !== false;
  const excludePrivate = managed?.authority.excludePrivate === true || await excludesPrivateWrites(engine, remote);
  const fromPage = remote ? pageSlug : ctx.sourceSlug ?? pageSlug;
  const out: ExtractedFact[] = [];
  for (const f of facts) {
    // An extractor-named entity is kept even when it has no page: that name
    // competes with any page the text mentions, so inference never overrides it.
    if (!isNullLikeEntity(f.entity_slug)) { out.push(f); continue; }
    const inferred = await inferFactSubject(engine, ctx.sourceId, { fact: f.fact, pageSlug: fromPage, mode: 'write', excludePrivate });
    if (inferred.slug !== null && await linkAllowed(ctx, inferred.slug, f.fact, visibility, remote, managed)) {
      out.push({ ...f, entity_slug: inferred.slug, entity_inferred: inferred.via });
    } else out.push(f);
  }
  return out;
}

async function writesDatabaseOnly(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const { isWriteThroughDisabled } = await import('../write-through.ts');
  const { lookupSourceLocalPath } = await import('./fence-write.ts');
  return await isWriteThroughDisabled(engine) || await lookupSourceLocalPath(engine, sourceId) === null;
}

async function linkAllowed(ctx: FactsBackstopCtx, slug: string, fact: string, visibility: string, remote: boolean,
  managed: ManagedFactsSession | null): Promise<boolean> {
  const engine = ctx.engine;
  const { isFactWithdrawn } = await import('./withdrawal.ts');
  if (await isFactWithdrawn(engine, ctx.sourceId, visibility, fact, slug)) return false;
  try {
    const op = ctx.operationContext;
    if (remote && op) {
      const { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } = await import('../ops/context.ts');
      validatePageSlug(slug);
      enforceClientSlugFence(op, slug, 'extract_facts');
      enforceSubagentSlugFence(op, slug, 'extract_facts');
    }
    if (managed) {
      const { authorizeWrite } = await import('../persistence/authority.ts');
      const { authorizePageVisibility } = await import('../persistence/page-visibility.ts');
      await authorizeWrite(engine, managed.authority, 'extract_facts', slug);
      await authorizePageVisibility(engine, managed.authority, slug);
    }
  } catch (error) {
    const { OperationError } = await import('../ops/contract.ts');
    if (error instanceof OperationError) return false;
    throw error;
  }
  const page = await engine.readPageSnapshot(slug, { sourceId: ctx.sourceId });
  if (!page) return false;
  const { parseFactsFence } = await import('../facts-fence.ts');
  return parseFactsFence(page.page.compiled_truth).warnings.length === 0;
}

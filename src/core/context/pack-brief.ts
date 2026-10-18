/**
 * context_pack's pull brief (wave 5 D5), peeled from ops/facts.ts so the
 * context_pack handler stays under the unlisted module-size cap. Behavior is
 * unchanged; `BRIEF_INTENTS` here is proactive-brief.ts's list, pinned equal to
 * ops/facts.ts's literal copy by test/proactive-brief.test.ts.
 */
import type { OperationContext } from '../ops/contract.ts';
import { verbError } from '../ops/contract.ts';
import { paramUse } from '../ops/op-fix.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import { assembleBrief, briefView, BRIEF_INTENTS, resolvePullCounterparty } from './proactive-brief.ts';

/**
 * context_pack's pull brief (wave 5 D5): null unless `counterparty` is given.
 * An unresolved counterparty is a labelled empty brief, not an error; an
 * invalid `intent` is invalid_params.
 */
export async function contextPackBrief(
  ctx: OperationContext,
  p: Record<string, unknown>,
  opts: { sourceId: string; includePrivate: boolean; eligibility: ReadEligibility },
): Promise<{ text: string; view: Record<string, unknown> } | null> {
  if (typeof p.counterparty !== 'string' || !p.counterparty.trim()) return null;
  if (p.intent !== undefined && !(BRIEF_INTENTS as readonly unknown[]).includes(p.intent)) {
    throw verbError(
      'invalid_params',
      `context_pack: intent must be one of ${BRIEF_INTENTS.join(', ')}`,
      `Pass ${paramUse(ctx, 'intent', 'meeting')} or omit it.`,
    );
  }
  const local = ctx.remote === false;
  const label = {
    delivery: 'pull' as const,
    intent: (p.intent as string | undefined) ?? null,
    ...(local ? {} : { withheld_arms: ['loops'] }),
  };
  const cp = await resolvePullCounterparty(ctx.engine, opts.sourceId, p.counterparty.slice(0, 200), {
    excludePrivate: !opts.includePrivate, eligibility: opts.eligibility,
  });
  if (!cp) return { text: '', view: { ...label, counterparty: null, items: [], reason: 'counterparty_unresolved' } };
  const now = Date.now();
  const brief = await assembleBrief(ctx.engine, {
    trigger: 'pull',
    counterparties: [cp],
    local,
    includePrivate: opts.includePrivate,
    eligibility: opts.eligibility,
    clock: { now, stopAt: now + CONTEXT_PACK_BRIEF_BUDGET_MS },
  });
  const counterparty = { slug: cp.slug, display: cp.display };
  if (!brief) return { text: '', view: { ...label, counterparty, items: [], reason: 'no_items' } };
  return { text: brief.text, view: { ...label, counterparty, items: briefView(brief).items } };
}

/** Wall-clock cap on the pull brief's queries. */
const CONTEXT_PACK_BRIEF_BUDGET_MS = 1000;

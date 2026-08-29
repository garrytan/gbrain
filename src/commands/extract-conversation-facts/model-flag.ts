/**
 * The --model gate, shared by the extract-conversation-facts CLI (before the
 * job is enqueued), the job handler, and the core.
 */

import { isAvailable } from '../../core/ai/gateway.ts';
import { canonicalLookup } from '../../core/model-pricing.ts';

// ---------------------------------------------------------------------------
// --model gate, shared by the CLI, the job handler and the core.
// ---------------------------------------------------------------------------

/**
 * Why a `--model` id cannot run, or null when it can. isAvailable only proves
 * the provider key; the id itself is checked against the pricing table,
 * because a run always carries a cost cap and BudgetTracker hard-fails
 * reserve() with no_pricing for an unpriced id.
 */
export function validateModelFlag(model: string): string | null {
  if (!isAvailable('chat', model)) {
    return (
      `--model ${model} is not servable by the chat gateway (unknown provider, or its key is missing). ` +
      'Use the provider:model form, e.g. openai:gpt-5.6-sol.'
    );
  }
  if (!canonicalLookup(model)) {
    return (
      `--model ${model} has no pricing entry (src/core/model-pricing.ts), so the --max-cost-usd cap cannot gate it ` +
      'and every segment would fail with no_pricing. Use a priced id (e.g. openai:gpt-5.6-sol) or add the entry first.'
    );
  }
  return null;
}

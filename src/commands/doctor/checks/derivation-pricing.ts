/**
 * derivation_unpriced_model (PR 4, Wave B incremental derivation): segmented pages whose paid derivation (facts,
 * conversation facts, synopsis) stopped or booked its whole reservation because the model has no price. An
 * unpriced model reserves a ceiling estimate (no default changes and no price is invented), so under the per-page cap it
 * gets about one window per page and every call books that ceiling. The receipts on page_segment_derivations say so
 * (reason or kind `unpriced_model`, with the model; unpricedModelReceipt); this check groups them by model and names
 * the fix: register the model's price in `pricing.overrides`; a model priced since is not reported. Reads the database only.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { loadPricingOverrides } from '../../../core/budget/budget-tracker.ts';
import { reservationCostUsd } from '../../../core/budget/reservation-cost.ts';

/** The command that registers `model`'s price in pricing.overrides (src/commands/pricing.ts merges it into the existing map). */
export const pricingCommand = (model: string) => ['gbrain', 'pricing', 'set', model, '--input', '<inputUsdPer1M>', '--output', '<outputUsdPer1M>', '--source', '<pricingPageUrl>'];

async function runDerivationUnpricedModelCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const rows = await connectedEngine(ctx).executeRaw<{ model: string; pipelines: string[]; pages: number; samples: string[] }>(
      `SELECT d.receipt->>'model' AS model, array_agg(DISTINCT d.pipeline ORDER BY d.pipeline) AS pipelines, count(DISTINCT d.page_id)::int AS pages,
              (array_agg(DISTINCT p.source_id || ':' || p.slug))[1:3] AS samples
         FROM page_segment_derivations d JOIN pages p ON p.id = d.page_id AND p.deleted_at IS NULL
        WHERE (d.receipt->>'kind' = 'unpriced_model' OR d.receipt->>'reason' = 'unpriced_model') AND d.receipt->>'model' IS NOT NULL
        GROUP BY 1 ORDER BY 3 DESC, 1`);
    // A model priced since (pricing.overrides) no longer holds anything back: the next run meters it.
    const overrides = await loadPricingOverrides(connectedEngine(ctx));
    const models = rows.filter(r => reservationCostUsd(r.model, 'chat', 1, 1, overrides) === null).map(r => ({ model: r.model, pipelines: r.pipelines ?? [], pages: Number(r.pages), samples: r.samples ?? [], fix: pricingCommand(r.model).join(' ') }));
    if (!models.length) {
      checks.push({ name: 'derivation_unpriced_model', status: 'ok', message: 'No segmented page derivation is held back by a model without a price.', details: { models } });
      return checks;
    }
    const message = `Paid page derivations ran a model with no price, so each call reserved and booked a ceiling estimate and the per-page cap stopped them early: `
      + models.map(m => `${m.model} (${m.pipelines.join(', ')}; ${m.pages} page(s), e.g. ${m.samples.join(', ')}): ${m.fix}`).join('. ')
      + '. Each command writes the model\'s price to pricing.overrides; the next run meters at that price and resumes where it stopped.';
    checks.push({ name: 'derivation_unpriced_model', status: 'warn', message, details: { models },
      fix: agentFix(pricingCommand(models[0]!.model),
        `Registers ${models[0]!.model}'s price in pricing.overrides so its derivations reserve and book its real cost instead of the unpriced ceiling; the rates come from the provider's pricing page, so they are the user's to confirm.`,
        'derivation_unpriced_model', { ask_user: true, inputs: [
          { name: 'inputUsdPer1M', how: 'the provider\'s published input price per million tokens, confirmed with the user' },
          { name: 'outputUsdPer1M', how: 'the provider\'s published output price per million tokens, confirmed with the user' },
          { name: 'pricingPageUrl', how: 'the provider pricing page the rates come from' }] }) });
  } catch (error) {
    checks.push(checkError('derivation_unpriced_model', 'read the derivation receipts', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const derivationUnpricedModelEntry: DoctorEntry = { name: 'derivation_unpriced_model', emits: ['derivation_unpriced_model'], run: runDerivationUnpricedModelCheck };

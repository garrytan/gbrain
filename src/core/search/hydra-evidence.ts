/** Honor requested evidence units while retaining cloud formatting at the presentation boundary. */
import { deliverEvidence, type EvidencePlan } from './evidence-delivery.ts';
import { carryHydraRenderers } from '../hydradb-response.ts';

/** Cloud context is the default; explicit/configured page, section, window and capped auto requests still expand held pages. */
export function hydraEvidencePlan(plan: EvidencePlan | null): EvidencePlan | null {
  return plan?.unit === 'auto' && !plan.explicitUnit && !plan.budgetExplicit ? null : plan;
}

export async function deliverHydraEvidence(...args: Parameters<typeof deliverEvidence>): ReturnType<typeof deliverEvidence> {
  const delivered = await deliverEvidence(...args);
  carryHydraRenderers(delivered.results, args[1]);
  return delivered;
}

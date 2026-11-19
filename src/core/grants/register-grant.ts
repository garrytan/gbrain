/**
 * The scoped grant a manual client registration writes (oauth-provider.ts planManualClient, the up-to-date schema
 * branch of registerClientManual): the agent bindings and the caller's grant patch over the scope defaults, revision 1,
 * validated against the active sources and the operation catalog. Pure: no SQL.
 */
import type { AgentClientBindings } from '../oauth-provider.ts';
import { grantFromRow, normalizeGrantBrain, validateClientGrant, type ClientGrant, type GrantPatch, type GrantValidationContext } from './model.ts';
import { assertGrantPatch } from './service.ts';

export interface ManualClientGrantInput {
  clientId: string;
  name: string;
  scopes: string;
  sourceId: string;
  federated: string[];
  agentBindings?: AgentClientBindings;
  grantPatch?: GrantPatch;
}

export function manualClientGrant(input: ManualClientGrantInput, context: GrantValidationContext): ClientGrant {
  const { clientId, name, scopes, sourceId, federated, agentBindings, grantPatch } = input;
  const initial = grantFromRow({
    client_id: clientId, client_name: name, scope: scopes, source_id: sourceId,
    federated_read: federated, bound_slug_prefixes: agentBindings?.boundSlugPrefixes ?? null,
    allowed_operations: agentBindings?.allowedOperations ?? null,
    bound_tools: agentBindings?.boundTools ?? null,
    bound_source_id: agentBindings?.boundSourceId ?? null, bound_brain_id: agentBindings?.boundBrainId ?? null,
    delegated_slug_prefixes: agentBindings?.delegatedSlugPrefixes ?? agentBindings?.boundSlugPrefixes ?? null,
    delegated_namespace: agentBindings?.delegatedNamespace ?? (agentBindings?.boundSlugPrefixes || agentBindings?.delegatedSlugPrefixes ? 'prefixes' : 'job'),
    bound_max_concurrent: agentBindings?.boundMaxConcurrent ?? 1,
    budget_usd_per_day: agentBindings?.budgetUsdPerDay ?? null,
  });
  if (grantPatch) assertGrantPatch(grantPatch);
  const changes = Object.fromEntries(Object.entries(grantPatch ?? {}).filter(([, value]) => value !== undefined)) as GrantPatch;
  const grant = { ...initial, ...changes, revision: 1 };
  grant.boundBrainId = normalizeGrantBrain(grant.boundBrainId);
  validateClientGrant(grant, context);
  return grant;
}

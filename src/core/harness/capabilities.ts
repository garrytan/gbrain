import type { AuthInfo } from '../ops/contract.ts';
import { hasScope } from '../scope.ts';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { normalizeGrantBrain, validGrantPrefixes } from '../grants/model.ts';
import { shellQuote } from '../mcp-registration.ts';

/** Keep valid bindings implicit so a repair preview cannot replace unrelated
 * restrictions. Missing authority is an operator choice, never a default. */
function delegationRepair(auth: AuthInfo, reasons: readonly string[]) {
  if (!reasons.length) return null;
  const args = ['gbrain', 'auth', 'rescope-client', shellQuote(auth.clientId ?? '<CLIENT_ID>'), '--dry-run', '--json'];
  const missingChoices: Array<{ placeholder: string; instruction: string }> = [];
  const checks: string[] = [];
  const flag = (name: string, value: string) => { args.push(name, shellQuote(value)); };
  const choose = (name: string, placeholder: string, instruction: string) => {
    flag(name, placeholder); missingChoices.push({ placeholder, instruction });
  };
  if (Number.isSafeInteger(auth.grantRevision) && auth.grantRevision! >= 0) flag('--if-version', String(auth.grantRevision));
  else choose('--if-version', '<CURRENT_GRANT_REVISION>', 'Read the current client grant on the host and use its revision.');
  let mutations = 0;
  const change = (fn: () => void) => { fn(); mutations++; };
  if (reasons.includes('agent_scope_missing')) change(() => choose('--scopes', '<APPROVED_SCOPES_INCLUDING_AGENT>',
    'Only if delegation is wanted, review the current host grant and explicitly choose its complete scopes including agent. Token scopes may be narrower than the current grant.'));
  if (reasons.some(r => ['delegated_tools_missing', 'delegated_tools_unavailable'].includes(r))) change(() => choose('--bound-tools', '<REVIEWED_DELEGATED_TOOLS>',
    'Choose a nonempty comma-separated tool list from the host running registry; do not use the whole registry as a fallback.'));
  if (!auth.sourceId || auth.sourceActive === false) {
    change(() => choose('--source', '<APPROVED_ACTIVE_SOURCE>', 'Choose an active source already reviewed for this client.'));
    change(() => flag('--bound-source', '<APPROVED_ACTIVE_SOURCE>'));
  } else if (auth.boundSourceId !== auth.sourceId) change(() => flag('--bound-source', auth.sourceId!));
  if (reasons.includes('delegated_read_source_missing') || !auth.sourceId || auth.sourceActive === false) change(() => choose('--federated-read', '<APPROVED_READ_SOURCES>',
    'Review the complete source list, including the selected delegation source. Preserve existing restrictions unless explicitly changing them.'));
  if (reasons.includes('cross_brain_delegation_unsupported')) change(() => choose('--bound-brain', '<APPROVE_host>',
    'Cross-brain delegation is unsupported. Substitute host only if executing against this brain is intended.'));
  if (reasons.some(r => ['delegated_namespace_ambiguous', 'delegated_path_policy_missing'].includes(r))) {
    change(() => choose('--delegated-namespace', '<CHOOSE_job_OR_prefixes>', 'Choose job for the existing per-job fence, or prefixes for an explicitly reviewed fence.'));
    change(() => choose('--delegated-slug-prefixes', '<APPROVED_PREFIXES_OR_none>', 'Use none with job, or a nonempty comma-separated approved prefix list with prefixes.'));
  }
  if (reasons.includes('delegated_concurrency_invalid')) change(() => choose('--bound-max-concurrent', '<POSITIVE_CONCURRENCY>', 'Choose a positive concurrency limit.'));
  if (reasons.some(r => ['delegated_tools_not_granted', 'submit_agent_not_granted'].includes(r))) change(() => choose('--allowed-operations', '<APPROVED_OPERATION_SNAPSHOT>',
    'Explicitly review the complete operation snapshot, including submit_agent and the chosen delegated tools. Do not refresh an existing snapshot implicitly.'));
  if (reasons.includes('submit_agent_not_visible')) checks.push('Inspect the selected surface and host publish gates; a client repair cannot override a server gate.');
  if (reasons.includes('grant_projection_unavailable')) checks.push('Repair the host schema/authentication projection before deriving a grant change.');
  return {
    preview_command: mutations ? args.join(' ') : null,
    command_kind: mutations ? missingChoices.length ? 'template' : 'preview' : 'host_check',
    missing_choices: missingChoices, operator_checks: checks,
    instructions: 'Replace every placeholder after reviewing the current host grant. This command only previews; inspect the result before explicitly applying the same flags without --dry-run. Omitted tools, operation snapshots, direct fences, finite caps, concurrency, and TTL stay unchanged.',
  };
}

/** Same filters as dispatch/tool advertisement, evaluated once per discovery
 * request. Imports stay lazy because whoami lives in the operation registry. */
export async function resolveAuthCapabilities(auth: AuthInfo, engine: BrainEngine, config: GBrainConfig) {
  const [{ operations, opAllowedForBoundClient }, { filterOpsForSurface, isMcpSurface }, { disabledOpsForPublishGates }, { grantCatalog }] = await Promise.all([
    import('../operations.ts'), import('../../mcp/surface.ts'), import('../../mcp/publish-gates.ts'), import('../grants/profiles.ts'),
  ]);
  const selected = auth.effectiveSurface ?? auth.surface;
  const surface = isMcpSurface(selected) ? selected : 'full';
  const disabled = await disabledOpsForPublishGates(engine, config);
  const visibleOperations = filterOpsForSurface(operations.filter(op => !op.localOnly), surface).filter(op =>
    (hasScope(auth.scopes, op.scope ?? 'read') || (op.agentCallable === true && hasScope(auth.scopes, 'agent')))
    && opAllowedForBoundClient(auth, op) && !disabled.has(op.name)).map(op => op.name);
  return describeAuthCapabilities(auth, { surface, visibleOperations, delegatedTools: grantCatalog().delegateToolNames });
}

/** No credentials or private inventories. Uses the already authenticated grant
 * projection, so a catalog request does not perform one query per operation. */
export function describeAuthCapabilities(auth: AuthInfo, options: { surface?: string; visibleOperations?: readonly string[]; delegatedTools?: ReadonlySet<string> } = {}) {
  const reasons = [...(auth.grantRepairReasons ?? [])];
  if (auth.grantProjectionDegraded) reasons.push('grant_projection_unavailable');
  if (!hasScope(auth.scopes, 'agent')) reasons.push('agent_scope_missing');
  if (!auth.boundTools?.length) reasons.push('delegated_tools_missing');
  if (options.delegatedTools && auth.boundTools?.some(name => !options.delegatedTools!.has(name))) reasons.push('delegated_tools_unavailable');
  if (!auth.sourceId || auth.sourceActive === false || auth.boundSourceId !== auth.sourceId) reasons.push('delegated_source_invalid');
  if (!auth.sourceId || !auth.allowedSources?.includes(auth.sourceId)) reasons.push('delegated_read_source_missing');
  if (normalizeGrantBrain(auth.boundBrainId ?? null) !== null) reasons.push('cross_brain_delegation_unsupported');
  if (auth.delegatedNamespace === 'job') {
    if (auth.delegatedSlugPrefixes != null) reasons.push('delegated_namespace_ambiguous');
  } else if (!validGrantPrefixes(auth.delegatedSlugPrefixes ?? null)) reasons.push('delegated_path_policy_missing');
  if (!Number.isSafeInteger(auth.boundMaxConcurrent) || (auth.boundMaxConcurrent ?? 0) < 1) reasons.push('delegated_concurrency_invalid');
  // Delegated authority is agent + explicit tool bindings, independently of
  // direct read/write scopes. The operation snapshot still caps those tools.
  const effectiveTools = (auth.boundTools ?? []).filter(name =>
    (!options.delegatedTools || options.delegatedTools.has(name))
    && (auth.allowedOperations == null || auth.allowedOperations.includes(name)));
  if (auth.boundTools?.length && effectiveTools.length === 0) reasons.push('delegated_tools_not_granted');
  if (auth.allowedOperations && !auth.allowedOperations.includes('submit_agent')) reasons.push('submit_agent_not_granted');
  if (options.visibleOperations && !options.visibleOperations.includes('submit_agent')) reasons.push('submit_agent_not_visible');
  const unique = [...new Set(reasons)];
  const repair = delegationRepair(auth, unique);
  return {
    profile: auth.grantProfile ?? null,
    grant_revision: auth.grantRevision ?? null,
    issued_scopes: auth.issuedScopes ?? auth.scopes,
    scopes: auth.scopes,
    surface: options.surface ?? auth.surface ?? 'full',
    source_id: auth.sourceId ?? null,
    federated_read: auth.allowedSources ?? [],
    allowed_operations: auth.allowedOperations ?? null,
    ...(options.visibleOperations ? { available_operations: options.visibleOperations } : {}),
    direct_write: { prefixes: auth.boundSlugPrefixes ?? null },
    delegation: {
      tools: auth.boundTools ?? [], effective_tools: effectiveTools, source_id: auth.boundSourceId ?? null,
      brain: auth.boundBrainId ?? 'host', namespace: auth.delegatedNamespace ?? null,
      prefixes: auth.delegatedSlugPrefixes ?? null, concurrency: auth.boundMaxConcurrent ?? null,
      spending: auth.budgetUsdPerDay == null ? { mode: 'unlimited' } : { mode: 'daily_cap', usd: auth.budgetUsdPerDay },
    },
    expires_at: auth.expiresAt ?? null,
    agent_ready: unique.length === 0,
    delegation_repair: repair,
    worker: { status: 'unknown', note: 'Configuration does not prove a worker is running; use an explicit delegated verification.' },
    remediation: unique.map(reason => ({ reason, command: reason === 'agent_scope_missing'
      ? 'Ask the host operator for a delegating-agent profile only if delegation is needed.'
      : repair?.preview_command ?? 'Inspect the current grant, selected surface, and publish gates on the brain host.' })),
  };
}

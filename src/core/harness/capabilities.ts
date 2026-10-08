import type { AuthInfo } from '../ops/contract.ts';
import { hasScope, operationScopesAllowed } from '../scope.ts';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { TOKEN_TTL_MAX_SECONDS, TOKEN_TTL_MIN_SECONDS, normalizeGrantBrain, validGrantPrefixes } from '../grants/model.ts';
import { shellQuote } from '../mcp-registration.ts';
import type { CatalogProvenance } from '../grants/profiles.ts';

type GrantSurface = 'verbs' | 'starter' | 'full';

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
  if (reasons.includes('token_ttl_invalid')) change(() => choose('--token-ttl', '<APPROVED_TTL_SECONDS>',
    `Choose an access-token lifetime from ${TOKEN_TTL_MIN_SECONDS} to ${TOKEN_TTL_MAX_SECONDS} seconds (90 days). Every grant change is refused while the stored lifetime is outside that range.`));
  if (reasons.includes('submit_agent_not_visible')) checks.push('Inspect the selected surface and host publish gates; a client repair cannot override a server gate.');
  if (reasons.includes('grant_projection_unavailable')) checks.push('Repair the host schema/authentication projection before deriving a grant change.');
  return {
    preview_command: mutations ? args.join(' ') : null,
    command_kind: mutations ? missingChoices.length ? 'template' : 'preview' : 'host_check',
    missing_choices: missingChoices, operator_checks: checks,
    instructions: 'Replace every placeholder after reviewing the current host grant. This command only previews; inspect the result before explicitly applying the same flags without --dry-run. Omitted tools, operation snapshots, direct fences, finite caps, concurrency, and TTL stay unchanged.',
  };
}

/** One grant as the diagnosis sees it: the verifier's principal plus the stored axes that decide which operations it can call. */
export interface GrantGapInput {
  scopes: readonly string[];
  /** null = no operation snapshot. */
  allowedOperations: readonly string[] | null;
  boundSlugPrefixes?: string[];
  fenceProjectionDegraded?: boolean;
  grantProjectionDegraded?: boolean;
  /** The client's own stored surface (`oauth_clients.surface`); null = none. */
  clientSurface: GrantSurface | null;
  /** The narrowest surface the server proves it applies to this grant; null = none proven. */
  serverSurface: GrantSurface | null;
  /** Operations a server publish gate disables; never counted as eligible. */
  disabled: ReadonlySet<string>;
}

/**
 * Host-side only: operation NAMES behind each proven blocker. `eligible` is
 * every remote operation the grant's scopes and direct-write fence allow
 * (enabled on this server); operations outside the grant's scopes are never
 * counted, so a writer is not told about admin-only operations. Each blocker
 * is counted independently over that set. Callers receive counts only
 * (`describeGrantDiagnosis`).
 */
export interface GrantGaps {
  missingScopes: string[];
  snapshotExcluded: string[];
  pinExcluded: string[];
  serverExcluded: string[];
  unreachable: string[];
}

export async function grantOperationGaps(input: GrantGapInput): Promise<GrantGaps> {
  const [{ operations, opAllowedForBoundClient }, { filterOpsForSurface }] = await Promise.all([
    import('../operations.ts'), import('../../mcp/surface.ts'),
  ]);
  const fence = { boundSlugPrefixes: input.boundSlugPrefixes, fenceProjectionDegraded: input.fenceProjectionDegraded, grantProjectionDegraded: input.grantProjectionDegraded };
  const eligible = operations.filter(op => !op.localOnly && !input.disabled.has(op.name)
    && operationScopesAllowed([...input.scopes], op) && opAllowedForBoundClient(fence, op));
  const outside = (surface: GrantSurface | null): string[] => {
    if (!surface || surface === 'full') return [];
    const listed = new Set(filterOpsForSurface(eligible, surface).map(op => op.name));
    return eligible.filter(op => !listed.has(op.name)).map(op => op.name);
  };
  const snapshot = input.allowedOperations ? new Set(input.allowedOperations) : null;
  const snapshotExcluded = snapshot ? eligible.filter(op => !snapshot.has(op.name)).map(op => op.name) : [];
  const pinExcluded = outside(input.clientSurface);
  const serverExcluded = outside(input.serverSurface);
  const blocked = new Set([...snapshotExcluded, ...pinExcluded, ...serverExcluded]);
  return {
    missingScopes: ['read', 'write'].filter(scope => !hasScope([...input.scopes], scope)),
    snapshotExcluded, pinExcluded, serverExcluded,
    unreachable: eligible.filter(op => blocked.has(op.name)).map(op => op.name),
  };
}

const operationsWord = (n: number): string => `${n} currently eligible operation${n === 1 ? '' : 's'}`;

/**
 * Inferred grant age, kept apart from the proven blockers. A snapshot that
 * excludes eligible operations proves exclusion, not age: an old profile
 * snapshot and a deliberate restriction look the same. Only a snapshot written
 * with catalog provenance can be said to predate operations.
 */
export function grantAge(snapshotExcluded: readonly string[], hasSnapshot: boolean, provenance: CatalogProvenance | null) {
  if (!hasSnapshot) return { state: 'no_snapshot' as const };
  const n = snapshotExcluded.length;
  if (n === 0) return { state: 'snapshot_complete' as const, excluded_count: 0 };
  if (!provenance) {
    return { state: 'intent_unknown' as const, excluded_count: n,
      statement: `This grant's snapshot excludes ${operationsWord(n)}; original intent unknown.` };
  }
  const known = new Set(provenance.operations);
  const predates = snapshotExcluded.filter(name => !known.has(name)).length;
  const leftOut = n - predates;
  return {
    state: 'provenance_recorded' as const, excluded_count: n, predates_count: predates, excluded_at_snapshot_count: leftOut,
    snapshot_gbrain_version: provenance.gbrain_version,
    statement: predates
      ? `This grant predates ${operationsWord(predates)}: they were added after its operation snapshot was written (gbrain ${provenance.gbrain_version}).`
        + (leftOut ? ` ${leftOut} more existed then and were left out of the snapshot.` : '')
      : `This grant's snapshot excludes ${operationsWord(n)}; all existed when the snapshot was written (gbrain ${provenance.gbrain_version}) and were left out of it.`,
  };
}

/** Who to rescope: an OAuth client by id, a legacy token by `--token <name>` or `--id <uuid>`. */
export type RescopeTarget = { kind: 'oauth_client'; id: string } | { kind: 'legacy_token'; flag: ['--token' | '--id', string] };

/**
 * The host commands that lift snapshot and client-pin blockers. They differ by
 * credential type: tokens refresh their snapshot (`--refresh-operations`
 * previews, `--add` widens by exactly the named operations); clients have no
 * refresh, so they take an explicit `--operations` list plus `--surface full`
 * when their stored surface blocks too. `operations` fills the list; null
 * leaves the `<OPERATIONS>` placeholder for the owner to choose. `all` is the
 * disclosed no-snapshot choice, never the default repair.
 */
export function grantRescopeArgvs(target: RescopeTarget, gaps: Pick<GrantGaps, 'snapshotExcluded' | 'pinExcluded'>, operations: string | null) {
  const value = operations ?? '<OPERATIONS>';
  if (target.kind === 'legacy_token') {
    const base = ['gbrain', 'auth', 'rescope', ...target.flag];
    return { preview: [...base, '--refresh-operations'], apply: [...base, '--refresh-operations', '--add', value],
      all_operations: [...base, '--reset-default', 'operations', '--dry-run'] };
  }
  const base = ['gbrain', 'auth', 'rescope', '--client', target.id];
  const surface = gaps.pinExcluded.length ? ['--surface', 'full'] : [];
  const apply = [...base, ...(gaps.snapshotExcluded.length ? ['--operations', value] : []), ...surface];
  return { preview: [...apply, '--dry-run'], apply, all_operations: [...base, '--operations', 'all', ...surface, '--dry-run'] };
}

/** The proven blockers with counts only. `scope` carries the memory scopes (read, write) the grant lacks, never a count. */
export function grantBlockers(gaps: GrantGaps, surfaces: { clientSurface: GrantSurface | null; clientSurfaceSetBy: string | null; serverSurface: GrantSurface | null }) {
  const blockers: Array<Record<string, unknown>> = [];
  if (gaps.missingScopes.length) blockers.push({ blocker: 'scope', missing_scopes: gaps.missingScopes });
  if (gaps.snapshotExcluded.length) blockers.push({ blocker: 'operation_snapshot', excluded_count: gaps.snapshotExcluded.length });
  if (gaps.pinExcluded.length) blockers.push({ blocker: 'client_pin', surface: surfaces.clientSurface, set_by: surfaces.clientSurfaceSetBy, excluded_count: gaps.pinExcluded.length });
  if (gaps.serverExcluded.length) blockers.push({ blocker: 'server_ceiling', surface: surfaces.serverSurface, excluded_count: gaps.serverExcluded.length });
  return blockers;
}

export const ALL_OPERATIONS_CHOICE = 'no snapshot: every operation the scopes and surface allow, including ones later upgrades add';

/**
 * The caller-safe diagnosis: which proven blockers apply, with counts and no
 * operation names, plus the inferred grant age. The fix names the host
 * commands with an `<OPERATIONS>` placeholder: the brain owner chooses.
 */
export function describeGrantDiagnosis(gaps: GrantGaps, opts: {
  hasSnapshot: boolean; provenance: CatalogProvenance | null; clientSurface: GrantSurface | null; clientSurfaceSetBy: string | null;
  serverSurface: GrantSurface | null; target: RescopeTarget | null;
}) {
  const blockers = grantBlockers(gaps, opts);
  const repairable = opts.target && (gaps.snapshotExcluded.length || gaps.pinExcluded.length);
  const argvs = repairable ? grantRescopeArgvs(opts.target!, gaps, null) : null;
  return {
    blockers,
    unreachable_count: gaps.unreachable.length,
    grant_age: grantAge(gaps.snapshotExcluded, opts.hasSnapshot, opts.provenance),
    fix: argvs ? {
      next: 'tell_user_to_run' as const, actor: 'host_admin' as const,
      argv: argvs.preview,
      then_argv: argvs.apply,
      ...(argvs.apply.includes('<OPERATIONS>') ? { inputs: [{ name: 'OPERATIONS', how: 'The brain owner chooses: the current operation snapshot plus each operation they approve, comma-separated.' }] } : {}),
      why: 'This grant cannot call operations its scopes allow until the brain owner changes it; nothing widens automatically.',
      user_message: `This gbrain connection cannot call ${gaps.unreachable.length} operation(s) its scopes allow. Ask the brain owner to preview the change on the brain host with the command shown, then apply it.`,
      all_operations: { argv: argvs.all_operations, label: ALL_OPERATIONS_CHOICE },
    } : null,
  };
}

/**
 * `whoami.grant_diagnosis` for an authenticated connection. Identity is the
 * verifier's principal (never a display name); provenance is read only for an
 * OAuth client's current snapshot.
 */
export async function resolveGrantDiagnosis(auth: AuthInfo, engine: BrainEngine, config: GBrainConfig, opts: { surfaceCeiling?: GrantSurface; disabled?: ReadonlySet<string> } = {}) {
  const [{ isMcpSurface, surfaceWiderThan }, { disabledOpsForPublishGates }, { readClientCatalogProvenance }] = await Promise.all([
    import('../../mcp/surface.ts'), import('../../mcp/publish-gates.ts'), import('../grants/service.ts'),
  ]);
  const clientSurface = isMcpSurface(auth.surface) ? auth.surface : null;
  const effective = isMcpSurface(auth.effectiveSurface) ? auth.effectiveSurface : null;
  // Server-side narrowing is proven by the transport ceiling, or by an
  // effective surface that no client pin explains.
  const serverSurface = !clientSurface ? effective ?? opts.surfaceCeiling ?? null
    : opts.surfaceCeiling ?? (effective && surfaceWiderThan(clientSurface, effective) ? effective : null);
  const allowedOperations = Array.isArray(auth.allowedOperations) ? auth.allowedOperations : null;
  const gaps = await grantOperationGaps({
    scopes: auth.scopes, allowedOperations, boundSlugPrefixes: auth.boundSlugPrefixes,
    fenceProjectionDegraded: auth.fenceProjectionDegraded, grantProjectionDegraded: auth.grantProjectionDegraded,
    clientSurface, serverSurface, disabled: opts.disabled ?? await disabledOpsForPublishGates(engine, config),
  });
  const principal = auth.principal;
  const provenance = principal?.kind === 'oauth_client' && allowedOperations && gaps.snapshotExcluded.length
    ? await readClientCatalogProvenance(engine, principal.id, allowedOperations) : null;
  const target: RescopeTarget | null = !principal ? null
    : principal.kind === 'oauth_client' ? { kind: 'oauth_client', id: principal.id } : { kind: 'legacy_token', flag: ['--id', principal.id] };
  return describeGrantDiagnosis(gaps, { hasSnapshot: allowedOperations !== null, provenance, clientSurface,
    clientSurfaceSetBy: auth.surfaceSetBy ?? null, serverSurface, target });
}

/** Same filters as dispatch/tool advertisement, evaluated once per discovery
 * request. Imports stay lazy because whoami lives in the operation registry. */
export async function resolveAuthCapabilities(auth: AuthInfo, engine: BrainEngine, config: GBrainConfig, opts: { surfaceCeiling?: GrantSurface } = {}) {
  const [{ operations, opAllowedForBoundClient }, { filterOpsForSurface, isMcpSurface }, { disabledOpsForPublishGates }, { grantCatalog }] = await Promise.all([
    import('../operations.ts'), import('../../mcp/surface.ts'), import('../../mcp/publish-gates.ts'), import('../grants/profiles.ts'),
  ]);
  const selected = auth.effectiveSurface ?? auth.surface;
  const surface = isMcpSurface(selected) ? selected : 'full';
  const disabled = await disabledOpsForPublishGates(engine, config);
  const visibleOperations = filterOpsForSurface(operations.filter(op => !op.localOnly), surface).filter(op =>
    operationScopesAllowed(auth.scopes, op)
    && opAllowedForBoundClient(auth, op) && !disabled.has(op.name)).map(op => op.name);
  // F2: config-plane readiness in the HTTP view (probed entries are host posture, never sent over HTTP).
  const { configReadiness, readinessHttpView } = await import('../readiness.ts');
  return {
    ...describeAuthCapabilities(auth, { surface, visibleOperations, delegatedTools: grantCatalog().delegateToolNames }),
    grant_diagnosis: await resolveGrantDiagnosis(auth, engine, config, { surfaceCeiling: opts.surfaceCeiling, disabled }),
    readiness: readinessHttpView(configReadiness(config, { transport: 'http' }).entries),
  };
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
  if (auth.tokenTtlSeconds != null && (!Number.isSafeInteger(auth.tokenTtlSeconds) || auth.tokenTtlSeconds < TOKEN_TTL_MIN_SECONDS || auth.tokenTtlSeconds > TOKEN_TTL_MAX_SECONDS)) reasons.push('token_ttl_invalid');
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
    shared_skills: {
      protocol_version: 2,
      catalog: options.visibleOperations ? ['list_skills', 'get_skill'].every(name => options.visibleOperations!.includes(name)) : null,
      can_join: options.visibleOperations ? options.visibleOperations.includes('join_brain') : null,
      can_edit: options.visibleOperations ? ['put_skill', 'delete_skill'].every(name => options.visibleOperations!.includes(name)) : null,
      can_publish_policy: options.visibleOperations ? options.visibleOperations.includes('set_skill_policy') : null,
      native_activation: 'unverified',
    },
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

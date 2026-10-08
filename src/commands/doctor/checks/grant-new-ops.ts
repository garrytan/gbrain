/**
 * D4 `grant_new_ops_available` (warn when non-zero): active OAuth clients and
 * legacy tokens that cannot call operations their scopes allow.
 *
 * Proven blockers come from the stored grant: the operation snapshot, the
 * client's own stored surface (pin) and the configured server surface. They
 * are reported apart from inferred grant age: a snapshot that excludes
 * eligible operations proves exclusion, not age, so a grant without catalog
 * provenance says "original intent unknown", and only a snapshot written with
 * provenance can be said to predate operations. Identically shaped grants get
 * identical output, and nothing widens automatically: the fix asks the user
 * and carries the rescope commands, which differ by credential type. The
 * no-snapshot `--operations all` choice is disclosed, never the default.
 *
 * Host-side only (not in the remote doctor): details name the operations.
 */
import type { Action } from '../../../core/agent-output.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { loadConfig, type GBrainConfig } from '../../../core/config.ts';
import { grantFromRow, grantFromTokenRow } from '../../../core/grants/model.ts';
import { readClientCatalogProvenance } from '../../../core/grants/service.ts';
import { ALL_OPERATIONS_CHOICE, grantAge, grantBlockers, grantOperationGaps, grantRescopeArgvs, type GrantGaps, type RescopeTarget } from '../../../core/harness/capabilities.ts';
import { clampSurface, isMcpSurface, minSurface, resolveDefaultClientSurface, resolveSurface, surfaceWiderThan, type McpSurface } from '../../../mcp/surface.ts';
import { disabledOpsForPublishGates } from '../../../mcp/publish-gates.ts';
import type { Check } from '../../doctor.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/mcp/ADMIN.md#grants-that-cannot-reach-new-operations';
const BULK_WRITE = 'put_pages';

interface GrantFinding {
  kind: 'oauth_client' | 'legacy_token';
  id: string;
  name: string;
  profile: string | null;
  blockers: Array<Record<string, unknown>>;
  excluded_operations: { operation_snapshot: string[]; client_pin: string[]; server_ceiling: string[] };
  grant_age: ReturnType<typeof grantAge>;
  preview_argv: string[];
  argv: string[];
  all_operations_argv: string[];
}

function finding(kind: GrantFinding['kind'], id: string, name: string, profile: string | null, gaps: GrantGaps, target: RescopeTarget,
  snapshot: readonly string[] | null, age: ReturnType<typeof grantAge>, surfaces: { client: McpSurface | null; clientSetBy: string | null; server: McpSurface | null }): GrantFinding {
  const bulk = gaps.snapshotExcluded.includes(BULK_WRITE);
  const operations = !bulk ? null : kind === 'legacy_token' ? BULK_WRITE : [...new Set([...(snapshot ?? []), BULK_WRITE])].sort().join(',');
  const argvs = grantRescopeArgvs(target, gaps, operations);
  const blockers = grantBlockers(gaps, { clientSurface: surfaces.client, clientSurfaceSetBy: surfaces.clientSetBy, serverSurface: surfaces.server });
  return {
    kind, id, name, profile, blockers,
    excluded_operations: { operation_snapshot: gaps.snapshotExcluded, client_pin: gaps.pinExcluded, server_ceiling: gaps.serverExcluded },
    grant_age: age, preview_argv: argvs.preview, argv: argvs.apply, all_operations_argv: argvs.all_operations,
  };
}

/** A command for prose: a spelled-out operation list is summarized; details carry the exact argv. */
function shownCommand(argv: string[]): string {
  return argv.map(arg => arg.length > 80 ? `<${arg.split(',').length} operations: see details.grants>` : arg).join(' ');
}

function describeFinding(f: GrantFinding): string {
  const label = f.kind === 'oauth_client' ? `client ${f.name} (${f.id})` : `token ${f.name}`;
  const parts = f.blockers.filter(b => b.blocker !== 'scope').map(b => b.blocker === 'operation_snapshot' ? `its operation snapshot excludes ${b.excluded_count}`
    : b.blocker === 'client_pin' ? `its stored ${b.surface} surface excludes ${b.excluded_count}`
    : `the configured ${b.surface} server surface excludes ${b.excluded_count}`);
  const age = 'statement' in f.grant_age ? ` ${f.grant_age.statement}` : '';
  return `${label}: ${parts.join(', ')}.${age} Preview: ${shownCommand(f.preview_argv)}`;
}

export async function checkGrantNewOps(engine: BrainEngine, opts: { cfg?: GBrainConfig | null } = {}): Promise<Check> {
  try {
    let cfg = opts.cfg;
    if (cfg === undefined) { try { cfg = loadConfig(); } catch { cfg = null; } }
    const disabled = await disabledOpsForPublishGates(engine, cfg);
    const ceiling = clampSurface(resolveSurface(null, cfg), () => {});
    const dcrDefault = await resolveDefaultClientSurface(engine, cfg);
    const findings: GrantFinding[] = [];

    const clients = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM oauth_clients WHERE deleted_at IS NULL ORDER BY client_id');
    for (const row of clients) {
      const grant = grantFromRow(row);
      const client = isMcpSurface(grant.surface) ? grant.surface : null;
      const server = client ? ceiling : minSurface(ceiling, dcrDefault ?? ceiling);
      const gaps = await grantOperationGaps({
        scopes: grant.scopes, allowedOperations: grant.allowedOperations, boundSlugPrefixes: grant.boundSlugPrefixes ?? undefined,
        clientSurface: client, serverSurface: server, disabled,
      });
      if (!gaps.snapshotExcluded.length && !gaps.pinExcluded.length) continue;
      const provenance = gaps.snapshotExcluded.length && grant.allowedOperations
        ? await readClientCatalogProvenance(engine, grant.clientId, grant.allowedOperations) : null;
      findings.push(finding('oauth_client', grant.clientId, grant.clientName, grant.profile, gaps, { kind: 'oauth_client', id: grant.clientId },
        grant.allowedOperations, grantAge(gaps.snapshotExcluded, grant.allowedOperations !== null, provenance),
        { client, clientSetBy: grant.surfaceSetBy, server }));
    }

    const tokens = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE revoked_at IS NULL ORDER BY created_at, id');
    const nameCounts = new Map<string, number>();
    for (const row of tokens) nameCounts.set(String(row.name), (nameCounts.get(String(row.name)) ?? 0) + 1);
    for (const row of tokens) {
      const grant = grantFromTokenRow(row);
      // A drifted or malformed operations axis denies everything; legacy_token_grant_drift owns that report.
      if (grant.permissionsMalformed || grant.drift.includes('operations') || grant.allowedOperations === null) continue;
      const gaps = await grantOperationGaps({ scopes: grant.scopes, allowedOperations: grant.allowedOperations, clientSurface: null,
        serverSurface: ceiling, disabled });
      if (!gaps.snapshotExcluded.length) continue;
      const name = String(row.name);
      const flag: ['--token' | '--id', string] = nameCounts.get(name) === 1 ? ['--token', name] : ['--id', grant.principal.id];
      findings.push(finding('legacy_token', grant.principal.id, name, null, gaps, { kind: 'legacy_token', flag },
        grant.allowedOperations, grantAge(gaps.snapshotExcluded, true, null), { client: null, clientSetBy: null, server: ceiling }));
    }

    const ceilingNote = surfaceWiderThan('full', ceiling)
      ? ` The configured server surface is ${ceiling} (config mcp_surface or GBRAIN_MCP_FORCE_SURFACE); a rescope cannot lift it.` : '';
    if (!findings.length) {
      return { name: 'grant_new_ops_available', status: 'ok', message: `Every active client and token can call the operations its scopes allow.${ceilingNote}`,
        details: { grants: [], server_surface: ceiling, docs: DOCS } };
    }
    const first = findings[0];
    const placeholder = first.argv.includes('<OPERATIONS>');
    const fix: Action = {
      preview_argv: first.preview_argv, argv: first.argv, consent: ['credentials'], actor: 'agent', requires_exclusive: false, docs: DOCS,
      verify: doctorVerify('grant_new_ops_available'),
      why: 'An operation snapshot or a stored client surface keeps this grant from operations its scopes allow; changing it widens what that credential can do.',
      user_message: `${findings.length} connection grant(s) cannot call operations their scopes allow (first: ${first.name}). `
        + `For ${first.name}: preview the change with ${shownCommand(first.preview_argv)}, then apply it; or leave it as it is; `
        + `or remove its snapshot with ${first.all_operations_argv.join(' ')} (${ALL_OPERATIONS_CHOICE}). Which do you want?`,
      ...(placeholder ? { inputs: [{ name: 'OPERATIONS', how: `The operations the user approves for ${first.name}, comma-separated (clients: the whole new snapshot, i.e. the current one plus the approved additions; details.grants[0].excluded_operations lists the candidates).` }] } : {}),
    };
    return {
      name: 'grant_new_ops_available', status: 'warn',
      message: `${findings.length} active grant(s) cannot call operations their scopes allow. `
        + findings.slice(0, 5).map(describeFinding).join('; ')
        + `${findings.length > 5 ? `; and ${findings.length - 5} more in details.grants` : ''}. `
        + `Ask the user before changing any grant; nothing widens automatically, and --operations all (${ALL_OPERATIONS_CHOICE}) is a separate choice, not the default repair.`
        + `${ceilingNote} See ${DOCS}.`,
      details: { grants: findings, server_surface: ceiling, all_operations_choice: ALL_OPERATIONS_CHOICE, docs: DOCS },
      fix,
    };
  } catch (e) {
    return checkError('grant_new_ops_available', 'read client and token grants', e);
  }
}

async function runGrantNewOps(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkGrantNewOps(connectedEngine(ctx)));
  return checks;
}

export const grantNewOpsEntry: DoctorEntry = {
  name: 'grant_new_ops_available',
  emits: ['grant_new_ops_available'],
  run: runGrantNewOps,
};

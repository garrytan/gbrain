import { GRANT_PROFILES, GrantError, validatePrincipalGrant, type GrantPatch, type GrantProfileId } from './model.ts';
import { parseScopeString, assertAllowedScopes } from '../scope.ts';
import { isValidHolder } from '../takes-fence.ts';

export interface RescopeGrantArgs {
  patch: GrantPatch;
  profile?: GrantProfileId;
  expectedRevision?: number;
  repair: boolean;
  dryRun: boolean;
  json: boolean;
  /** No grant field and no --profile: print the stored grants and write nothing (#6993). */
  printOnly: boolean;
}

export function parseRescopeGrantArgs(args: string[]): RescopeGrantArgs {
  return markPrintOnly(parseRescopeGrantFlags(args));
}

function markPrintOnly(result: RescopeGrantArgs): RescopeGrantArgs {
  if (result.profile || Object.keys(result.patch).length > 0) return result;
  if (result.repair) throw new GrantError('invalid_grant', 'Pass a grant field or --profile with --repair');
  return { ...result, printOnly: true };
}

function parseRescopeGrantFlags(args: string[]): RescopeGrantArgs {
  const result: RescopeGrantArgs = { patch: {}, repair: false, dryRun: false, json: false, printOnly: false };
  const csv = (value: string): string[] => value.split(',').map(s => s.trim()).filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--repair') { result.repair = true; continue; }
    if (flag === '--dry-run') { result.dryRun = true; continue; }
    if (flag === '--json') { result.json = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new GrantError('invalid_grant', `${flag} requires a value`);
    switch (flag) {
      case '--source': result.patch.sourceId = value; break;
      case '--federated-read': result.patch.federatedRead = csv(value); break;
      case '--scopes': result.patch.scopes = parseScopeString(value.replaceAll(',', ' ')); assertAllowedScopes(result.patch.scopes); break;
      case '--bound-slug-prefixes': result.patch.boundSlugPrefixes = value === 'none' ? null : csv(value); break;
      case '--allowed-operations':
        if (value === 'all') clearOperationSnapshot(result.patch);
        else result.patch.allowedOperations = csv(value);
        break;
      case '--bound-tools': result.patch.boundTools = csv(value); break;
      case '--bound-source': result.patch.boundSourceId = value; break;
      case '--bound-brain': result.patch.boundBrainId = value === 'current' || value === 'host' ? null : value; break;
      case '--delegated-slug-prefixes': result.patch.delegatedSlugPrefixes = value === 'none' ? null : csv(value); break;
      case '--delegated-namespace':
        if (value !== 'job' && value !== 'prefixes') throw new GrantError('invalid_grant', '--delegated-namespace must be job or prefixes');
        result.patch.delegatedNamespace = value;
        break;
      case '--bound-max-concurrent': case '--max-concurrent': result.patch.boundMaxConcurrent = Number(value); break;
      case '--budget-usd-per-day': result.patch.budgetUsdPerDay = value === 'unlimited' ? null : value; break;
      case '--token-ttl': result.patch.tokenTtlSeconds = Number(value); break;
      case '--surface':
        if (!['verbs', 'starter', 'full', 'clear'].includes(value)) throw new GrantError('invalid_grant', '--surface must be verbs, starter, full, or clear');
        result.patch.surface = value === 'clear' ? null : value as 'verbs' | 'starter' | 'full';
        result.patch.surfaceSetBy = value === 'clear' ? null : 'operator';
        break;
      case '--profile':
        if (!(GRANT_PROFILES as readonly string[]).includes(value)) throw new GrantError('invalid_grant', `Unknown profile: ${value}`);
        result.profile = value as GrantProfileId;
        break;
      case '--if-version':
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new GrantError('invalid_grant', '--if-version must be a non-negative integer');
        result.expectedRevision = Number(value);
        break;
      default: throw new GrantError('invalid_grant', `Unknown flag: ${flag}`);
    }
  }
  assertProfileKept(result, '--allowed-operations all');
  return result;
}

/**
 * `all`: store no operation snapshot, so the scopes and the surface alone
 * decide, including operations later releases add. A null list is valid only
 * without a profile (the profile is where the snapshot came from), so the
 * profile is cleared with it, matching a fresh `register-client`.
 */
function clearOperationSnapshot(patch: GrantPatch): void {
  patch.allowedOperations = null;
  patch.profile = null;
}

function assertProfileKept(result: RescopeGrantArgs, flag: string): void {
  if (result.profile && result.patch.profile === null) {
    throw new GrantError('invalid_grant', `${flag} clears the grant profile and its operation snapshot; pass it or --profile, not both`);
  }
}

// ---------------------------------------------------------------------------
// F3: `gbrain auth rescope`, one command for legacy tokens and OAuth clients.
// ---------------------------------------------------------------------------

export type RescopeCommand =
  | { kind: 'migrate-legacy'; dryRun: boolean; json: boolean }
  | { kind: 'token'; args: string[] }
  | { kind: 'client'; clientId: string; args: string[] }
  | { kind: 'bare'; name: string; args: string[] };

const BOOLEAN_FLAGS = new Set(['--dry-run', '--json', '--refresh-operations', '--all-new', '--adopt-permissions', '--adopt-columns', '--repair']);
const TARGET_USAGE = 'Name what to rescope: --token <name>, --id <uuid>, --client <client-id>, a bare token or client name, or --migrate-legacy';

/** Split the target off `auth rescope` args; the remaining flags go to the token or client parser. */
export function splitRescopeTarget(args: string[]): RescopeCommand {
  const targets: { token?: string; id?: string; client?: string; bare?: string } = {};
  const rest: string[] = [];
  let migrate = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--migrate-legacy') { migrate = true; continue; }
    if (flag === '--token' || flag === '--id' || flag === '--client') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new GrantError('invalid_grant', `${flag} requires a value`);
      targets[flag.slice(2) as 'token' | 'id' | 'client'] = value;
      continue;
    }
    if (!flag.startsWith('--')) {
      if (targets.bare !== undefined) throw new GrantError('invalid_grant', `Unexpected argument: ${flag}`);
      targets.bare = flag;
      continue;
    }
    rest.push(flag);
    if (!BOOLEAN_FLAGS.has(flag) && args[i + 1] !== undefined) rest.push(args[++i]);
  }
  const named = Object.values(targets).filter(v => v !== undefined).length;
  if (migrate) {
    if (named) throw new GrantError('invalid_grant', '--migrate-legacy migrates every unmigrated token; it takes no target');
    const extra = rest.filter(f => f !== '--dry-run' && f !== '--json');
    if (extra.length) throw new GrantError('invalid_grant', `--migrate-legacy changes no grant, so it takes only --dry-run and --json (got ${extra.join(' ')})`);
    return { kind: 'migrate-legacy', dryRun: rest.includes('--dry-run'), json: rest.includes('--json') };
  }
  if (named !== 1) throw new GrantError('invalid_grant', named ? `Pass exactly one target. ${TARGET_USAGE}` : TARGET_USAGE);
  if (targets.token !== undefined) return { kind: 'token', args: [targets.token, ...rest] };
  if (targets.id !== undefined) return { kind: 'token', args: ['--id', targets.id, ...rest] };
  if (targets.client !== undefined) return { kind: 'client', clientId: targets.client, args: rest };
  return { kind: 'bare', name: targets.bare as string, args: rest };
}

const TOKEN_ONLY_FLAGS: Record<string, string> = {
  '--reset-default': 'client_reset_default_unsupported',
  '--refresh-operations': 'client_refresh_operations_unsupported',
  '--add': 'client_refresh_operations_unsupported',
  '--all-new': 'client_refresh_operations_unsupported',
  '--adopt-permissions': 'client_adopt_unsupported',
  '--adopt-columns': 'client_adopt_unsupported',
};

/**
 * Client flags of `auth rescope --client`: the unified `--sources a,b|none`
 * (element 0 = write source, the list = read set unless `--read-sources`
 * names a different one; `none` is the explicit no-source grant that refuses
 * every read and write), `--read-sources`, `--operations a,b|none|all`,
 * `--takes-holders a,b|none` and every `auth rescope-client` flag.
 */
export function parseClientRescopeArgs(clientId: string, args: string[]): RescopeGrantArgs {
  const legacy: string[] = [];
  let sources: string[] | undefined;
  let readSources: string[] | undefined;
  let operations: string[] | 'all' | undefined;
  let takesHolders: string[] | undefined;
  const csv = (value: string): string[] => [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (TOKEN_ONLY_FLAGS[flag]) {
      throw new GrantError('invalid_grant', `${flag} applies to legacy tokens only; OAuth client ${clientId} has no such grant in this release (see gbrain auth rescope --help)`, [TOKEN_ONLY_FLAGS[flag]]);
    }
    if (!['--sources', '--read-sources', '--operations', '--takes-holders'].includes(flag)) {
      legacy.push(flag);
      if (!BOOLEAN_FLAGS.has(flag) && args[i + 1] !== undefined) legacy.push(args[++i]);
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new GrantError('invalid_grant', `${flag} requires a value`);
    if (flag === '--sources') sources = value === 'none' ? [] : csv(value);
    if (flag === '--read-sources') readSources = csv(value);
    if (flag === '--operations') operations = value === 'none' ? [] : value === 'all' ? 'all' : csv(value);
    if (flag === '--takes-holders') takesHolders = value === 'none' ? [] : csv(value);
  }
  const result = parseRescopeGrantFlags(legacy);
  if (sources !== undefined) {
    validatePrincipalGrant({
      principal: { kind: 'oauth_client', id: clientId }, scopes: [], allowedOperations: null, takesHolders: null, revision: 0,
      shape: 'unified', drift: [], permissionsMalformed: false,
      sources: sources.length === 0 ? { kind: 'none' } : { kind: 'federated', writeSource: sources[0], readSources: sources },
    }, { operationNames: new Set() });
    result.patch.sourceId = sources.length === 0 ? null : sources[0];
    result.patch.sourcesNone = sources.length === 0;
  }
  if (readSources !== undefined && readSources.length === 0) throw new GrantError('invalid_grant', '--read-sources needs at least one source id');
  if (sources?.length === 0 && readSources !== undefined) throw new GrantError('invalid_grant', '--sources none grants no source, so it takes no --read-sources');
  if (sources !== undefined || readSources !== undefined) result.patch.federatedRead = readSources ?? sources;
  if (operations === 'all') {
    clearOperationSnapshot(result.patch);
    assertProfileKept(result, '--operations all');
  } else if (operations !== undefined) result.patch.allowedOperations = operations;
  if (takesHolders !== undefined) {
    const invalid = takesHolders.filter(h => !isValidHolder(h));
    if (invalid.length) throw new GrantError('invalid_grant', `Invalid takes holder: ${invalid.join(', ')} (use world, brain, people/<slug>, companies/<slug> or a bare slug)`, ['takes_holders_invalid']);
    result.patch.takesHolders = takesHolders;
  }
  return markPrintOnly(result);
}

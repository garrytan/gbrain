import { GRANT_PROFILES, GrantError, type GrantPatch, type GrantProfileId } from './model.ts';
import { parseScopeString, assertAllowedScopes } from '../scope.ts';

export interface RescopeGrantArgs {
  patch: GrantPatch;
  profile?: GrantProfileId;
  expectedRevision?: number;
  repair: boolean;
  dryRun: boolean;
  json: boolean;
}

export function parseRescopeGrantArgs(args: string[]): RescopeGrantArgs {
  const result: RescopeGrantArgs = { patch: {}, repair: false, dryRun: false, json: false };
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
      case '--allowed-operations': result.patch.allowedOperations = csv(value); break;
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
  if (!result.profile && Object.keys(result.patch).length === 0) throw new GrantError('invalid_grant', 'Pass a grant field or --profile to rescope');
  return result;
}

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { readConnectorCursorState, type ConnectorSourceRow } from '../../../core/connectors/item-holds-store.ts';
import { parseGoogleSourceConfig } from '../../../core/google/source-config.ts';
import type { GoogleApiProblem } from '../../../core/google/types.ts';
import { googleApiAccessFix } from '../../../core/google/api-access.ts';

/**
 * #7073: Google sources whose last sweep could not reach a service because
 * its API is disabled for the OAuth project or its scope was not granted
 * (`api_access` in connector state). Zero-network: it reads the stored
 * result; `gbrain google status` and `gbrain google setup` probe live. One
 * finding names every blocked service with its project and enable link.
 */
export async function googleApiAccessCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const rows = await engine.readDoctorSources('google_connectors') as ConnectorSourceRow[];
    const blocked: Array<{ source_id: string; account: string; at: string; problems: GoogleApiProblem[] }> = [];
    for (const row of rows) {
      if (sourceIds && !sourceIds.includes(row.id)) continue;
      const cfg = parseGoogleSourceConfig(row.config, '');
      const stored = (await readConnectorCursorState(engine, row))?.api_access as { problems?: GoogleApiProblem[]; at?: string } | null | undefined;
      const problems = (stored?.problems ?? []).filter((p) => cfg.services.includes(p.service));
      if (problems.length) blocked.push({ source_id: row.id, account: cfg.account, at: stored?.at ?? '', problems });
    }
    const details = { count: blocked.length, sources: blocked, docs: 'docs/guides/google-connect.md#api-access' };
    if (!blocked.length) return { name: 'google_api_access', status: 'ok', message: 'No Google source recorded a disabled API or missing scope at its last sync.', details };
    const describe = (p: GoogleApiProblem): string => p.code === 'api_not_enabled'
      ? `${p.service}: ${p.api_title} (${p.api}) is disabled for Google Cloud project ${p.project ?? 'unknown'}, enable it at ${p.enable_url}`
      : `${p.service}: the credential was not granted this scope`;
    const first = blocked[0]!;
    return {
      name: 'google_api_access', status: 'warn', details,
      message: blocked.map((b) => `Google source ${b.source_id} (${b.account}) could not reach ${b.problems.length} service(s) at its last sync: ${b.problems.map(describe).join('; ')}.`).join(' ')
        + ' Those services import nothing until this is fixed; gbrain google status re-checks live.',
      fix: googleApiAccessFix(first.account, first.problems),
    };
  } catch (error) {
    return { name: 'google_api_access', status: 'warn', fix_unavailable_reason: 'check_errored', details: { count: 'unknown' },
      message: `Google API access could not be read from source state: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}

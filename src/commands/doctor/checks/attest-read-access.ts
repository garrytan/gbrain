/**
 * GST-1158 F3 doctor check (read-only).
 *
 *  - attest_read_shared_scope: an attest credential set `--attest-read person` whose read grant (federated_read, or
 *    its source grant) includes a source that a different attest credential reads as the scope (attest_read 'scope',
 *    or unset, which reads named sources as the scope). Such a source serves shared turns, so a person credential that
 *    reads it as the person can return that person's restricted pages where a room sees them. Warned, never changed:
 *    whether the credential serves only one person's own turns is the operator's call.
 *
 * Database only, so a repo-less brain gets the same check. Not applicable while no attest credential is set to person.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { authSourcesFromGrant, grantFromClient, grantFromRow, grantFromTokenRow, type PrincipalGrant } from '../../../core/grants/model.ts';
import { NO_SOURCES } from '../../../core/source-id.ts';

const name = 'attest_read_shared_scope';
const SAMPLE = 20;

type Credential = { kind: 'token' | 'client'; id: string; name: string; read: string | null; sources: string[] };

function readSources(grant: PrincipalGrant): string[] {
  const auth = authSourcesFromGrant(grant);
  return (auth.allowedSources ?? [auth.sourceId]).filter(s => s !== NO_SOURCES);
}

async function attestReadVerdict(ctx: DoctorContext): Promise<Check> {
  const engine = connectedEngine(ctx);
  try {
    const rows = await engine.executeRaw<{ kind: 'token' | 'client'; id: string; name: string; row: Record<string, unknown> }>(
      `SELECT 'token' AS kind, t.id::text AS id, t.name, to_jsonb(t) AS row FROM access_tokens t
        WHERE t.revoked_at IS NULL AND to_jsonb(t)->>'attest_actor' IS NOT NULL
       UNION ALL
       SELECT 'client' AS kind, c.client_id AS id, COALESCE(c.client_name, c.client_id) AS name, to_jsonb(c) - 'client_secret_hash' AS row FROM oauth_clients c
        WHERE (to_jsonb(c)->>'deleted_at') IS NULL AND to_jsonb(c)->>'attest_actor' IS NOT NULL
       ORDER BY 1, 3`);
    const credentials: Credential[] = rows.map(r => {
      const row = typeof r.row === 'string' ? JSON.parse(r.row) as Record<string, unknown> : r.row;
      const grant = r.kind === 'token' ? grantFromTokenRow(row) : grantFromClient(grantFromRow(row));
      return { kind: r.kind, id: r.id, name: r.name, read: typeof row.attest_read === 'string' ? row.attest_read : null, sources: readSources(grant) };
    });
    const persons = credentials.filter(c => c.read === 'person');
    if (!persons.length) return infoCheck(name, 'Not applicable: no attest credential reads named sources as the person (--attest-read person).', 'not_applicable');
    const shared = persons.map(p => ({ ...p, shared: p.sources.filter(s => credentials.some(o => o !== p && o.read !== 'person' && o.sources.includes(s))) }))
      .filter(p => p.shared.length);
    const details = { credentials: shared.slice(0, SAMPLE).map(p => ({ kind: p.kind, name: p.name, shared_sources: p.shared })), truncated: shared.length > SAMPLE };
    if (!shared.length) return { name, status: 'ok', details, message: `${persons.length} attest credential(s) read named sources as the person, and none reads a source another attest credential reads as the scope.` };
    const first = shared[0]!;
    return { name, status: 'warn', details,
      message: `${shared.length} attest credential(s) set --attest-read person can read a source another attest credential reads as the scope: `
        + `${shared.slice(0, 5).map(p => `${p.kind} ${p.name} (${p.shared.join(', ')})`).join('; ')}. `
        + 'A call that names such a source reads as the person, so what it returns can reach everyone in a shared turn. Keep person credentials for one person\'s own turns.',
      fix: agentFix(['gbrain', 'access', 'check', first.kind === 'token' ? '--token' : '--client', first.kind === 'token' ? first.name : first.id, '--json'],
        'Read-only: shows the credential\'s grant. Ask the user whether it serves only one person\'s own turns; if not, set it to scope with gbrain auth rescope ... --attest-read scope.', name, { ask_user: true }) };
  } catch (error) {
    return checkError(name, `run ${name}`, error);
  }
}

async function runAttestReadAccess(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { name: _name, ...verdict } = await attestReadVerdict(ctx);
  checks.push({ name: 'attest_read_shared_scope', ...verdict });
  return checks;
}

export const attestReadAccessEntry: DoctorEntry = {
  name: 'attest_read_shared_scope',
  emits: ['attest_read_shared_scope'],
  run: runAttestReadAccess,
};

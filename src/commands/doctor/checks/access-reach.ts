/**
 * GBRA-585 (decision F): who can still reach what, on a brain that grants access per member. Read-only; each check
 * names the count, a few source ids, page slugs or credential names (never content) and a read-only next step, and a
 * remote caller (run_doctor) gets counts only. Everything is database state, so a repo-less brain answers the same.
 *
 *  - access_shared_source_unread: on a brain that serves several people (access serves), a live source no member is
 *    bound to (not personal) holds pages, yet no enabled member's live token or OAuth client reads it, through federation
 *    or a source grant (credentialReadSources, as dispatch resolves an unqualified read), nor config mcp.stdio_member.
 *  - access_disabled_member_credentials: live tokens and OAuth clients bound to a disabled, removed or missing member;
 *    their reads are refused (access_member_disabled), yet gbrain auth list still shows them active.
 * Pages no enabled member reads are access_pages_read_by_nobody's (access-pages-read-by-nobody.ts).
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { brainServes } from '../../../core/access/serves.ts';
import { credentialReadSources, stdioReadSources } from '../../../core/grants/shared-exposure.ts';
import { authSourcesFromGrant, grantFromClient, grantFromRow, grantFromTokenRow, type PrincipalGrant } from '../../../core/grants/model.ts';
import { stdioMemberId } from '../../../core/access/caller.ts';
import { guestSourceSql } from '../../../core/guests/marker.ts';

const SAMPLE = 20;
const SHOWN = 5;
const DOCS = 'docs/guides/troubleshooting.md#access-reach';
const ENABLED = 'm.disabled_at IS NULL AND m.tombstoned_at IS NULL';

async function sharedSourceUnread(engine: BrainEngine, remote: boolean): Promise<Omit<Check, 'name'>> {
  const name = 'access_shared_source_unread';
  if ((await brainServes(engine)).serves === 'one') {
    return infoCheck(name, 'Not applicable: this brain serves one person, so no source has to be shared with members.', 'not_applicable');
  }
  const shared = (await engine.executeRaw<{ id: string }>(
    `SELECT s.id FROM sources s
      WHERE s.archived IS NOT TRUE
        AND NOT EXISTS (SELECT 1 FROM access_member_sources ms WHERE ms.source_id = s.id)
        AND NOT ${guestSourceSql('s.config', 's.id')}
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = s.id AND p.deleted_at IS NULL)
      ORDER BY s.id`)).map(r => r.id);
  const grants: PrincipalGrant[] = [
    ...(await engine.executeRaw<Record<string, unknown>>(
      `SELECT t.* FROM access_tokens t JOIN access_members m ON m.id = t.member_id WHERE t.revoked_at IS NULL AND ${ENABLED}`))
      .map(row => grantFromTokenRow(row as never)),
    ...(await engine.executeRaw<Record<string, unknown>>(
      `SELECT c.* FROM oauth_clients c JOIN access_members m ON m.id = c.member_id WHERE c.deleted_at IS NULL AND ${ENABLED}`))
      .map(row => grantFromClient(grantFromRow(row))),
  ];
  const archived = new Set((await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS TRUE')).map(r => r.id));
  const read = new Set<string>();
  for (const grant of grants) {
    if (archived.has(authSourcesFromGrant(grant).sourceId)) continue;
    for (const s of await credentialReadSources(engine, grant)) read.add(s);
  }
  const stdio = await stdioMemberId(engine);
  if (stdio && (await engine.executeRaw(`SELECT 1 FROM access_members m WHERE m.id = $1 AND ${ENABLED}`, [stdio])).length) {
    for (const s of await stdioReadSources(engine)) read.add(s);
  }
  const unread = shared.filter(s => !read.has(s));
  if (!unread.length) {
    return { status: 'ok', details: remote ? { count: 0 } : { sources: [] },
      message: 'Every shared source that holds pages is read by at least one enabled member\'s live key.' };
  }
  if (remote) {
    return { status: 'warn', details: { count: unread.length },
      message: `${unread.length} shared source(s) hold pages that no enabled member's live key reads. Ask the brain host's operator to run gbrain doctor --only ${name}.` };
  }
  const shown = unread.slice(0, SHOWN).join(', ') + (unread.length > SHOWN ? `, and ${unread.length - SHOWN} more` : '');
  return { status: 'warn', details: { sources: unread, member_keys: grants.length },
    message: `${unread.length} shared source(s) hold pages that no enabled member's live key reads, through federation or a source grant: ${shown}. `
      + 'Members get nothing from them until someone decides who should read them. Ask the user: federating a source (gbrain sources federate <id>) lets every key '
      + 'with no source grant read it; a source grant (gbrain auth rescope --token <name> --sources <ids>) keeps it to the keys named; a source that belongs to '
      + 'one person can be bound to them (gbrain access member source add <member> <id>), and this check then leaves it out. Nothing was changed.',
    fix: agentFix(['gbrain', 'sources', 'list', '--json'],
      'Read-only: lists each source and whether it is federated, so the user can say who should read the ones named here. Change nothing until they decide.', name,
      { ask_user: true, docs: DOCS }) };
}

async function disabledMemberCredentials(engine: BrainEngine, remote: boolean): Promise<Omit<Check, 'name'>> {
  const name = 'access_disabled_member_credentials';
  const state = `CASE WHEN m.id IS NULL THEN 'missing' WHEN m.tombstoned_at IS NOT NULL THEN 'removed' ELSE 'disabled' END`;
  const stale = `(m.id IS NULL OR m.disabled_at IS NOT NULL OR m.tombstoned_at IS NOT NULL)`;
  const rows = await engine.executeRaw<{ kind: 'token' | 'client'; name: string; id: string; member: string; state: string; total: number }>(
    `SELECT x.*, count(*) OVER ()::int AS total FROM (
       SELECT 'token' AS kind, t.name AS name, t.id::text AS id, t.member_id AS member, ${state} AS state
         FROM access_tokens t LEFT JOIN access_members m ON m.id = t.member_id
        WHERE t.revoked_at IS NULL AND t.member_id IS NOT NULL AND ${stale}
       UNION ALL
       SELECT 'client', c.client_name, c.client_id, c.member_id, ${state}
         FROM oauth_clients c LEFT JOIN access_members m ON m.id = c.member_id
        WHERE c.deleted_at IS NULL AND c.member_id IS NOT NULL AND ${stale}) x
     ORDER BY x.name, x.kind, x.id LIMIT ${SAMPLE}`);
  const total = rows[0]?.total ?? 0;
  if (!total) return { status: 'ok', details: { count: 0 }, message: 'No live token or OAuth client is bound to a disabled or removed member.' };
  if (remote) {
    return { status: 'warn', details: { count: total },
      message: `${total} live credential(s) are bound to a disabled or removed member. Ask the brain host's operator to run gbrain doctor --only ${name}.` };
  }
  const credentials = rows.map(({ total: _total, ...r }) => r);
  const first = credentials[0]!;
  return { status: 'warn', details: { count: total, truncated: total > rows.length, credentials },
    message: `${total} live credential(s) are bound to a disabled or removed member, so every read they make is refused (access_member_disabled), yet gbrain auth list still shows them active: `
      + `${credentials.slice(0, SHOWN).map(c => `${c.kind} ${c.name} (${c.member}, ${c.state})`).join(', ')}. `
      + 'Ask the user: when the person has left, revoke each (gbrain auth revoke <name>, or gbrain auth revoke-client <id> for a client); '
      + 'when they are back, gbrain access member enable <member>. Nothing was changed.',
    fix: agentFix(['gbrain', 'access', 'check', first.kind === 'client' ? '--client' : '--token', first.kind === 'client' ? first.id : first.name],
      'Read-only: shows what this credential is bound to and that its reads are refused, so the user can decide whether to revoke it.', name,
      { ask_user: true, docs: DOCS }) };
}

async function runAccessReach(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const remote = ctx.remote === true;
  const checks: Check[] = [];
  checks.push({ name: 'access_shared_source_unread', ...await sharedSourceUnread(engine, remote).catch(e => checkError('access_shared_source_unread', 'run access_shared_source_unread', e)) });
  checks.push({ name: 'access_disabled_member_credentials', ...await disabledMemberCredentials(engine, remote).catch(e => checkError('access_disabled_member_credentials', 'run access_disabled_member_credentials', e)) });
  return checks;
}

export const accessReachEntry: DoctorEntry = {
  name: 'access_shared_source_unread',
  emits: ['access_shared_source_unread', 'access_disabled_member_credentials'],
  run: runAccessReach,
};

/**
 * GBRA-231 shared-agent doctor check (plan section 5, decision D6).
 *
 *  - access_may_act_for_wildcard: credentials (access tokens, OAuth clients) whose may_act_for holds `*`, and a stdio
 *    server whose config mcp.stdio_may_act_for does. Such a credential's harness may name any enabled member as a
 *    request's audience and read what that member reads, so `*` is accepted but warned about; an explicit list is the
 *    narrower setup.
 *
 * A brain that holds no member restriction (config access.restrictions_present) is not applicable: with no member,
 * an audience can only be a guest, who reads nothing a credential could not.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { accessRestrictionsPresent } from '../../../core/search/private-visibility.ts';
import { STDIO_MAY_ACT_FOR_KEY } from '../../../core/access/audience.ts';

const name = 'access_may_act_for_wildcard';
const SAMPLE = 20;

async function sharedAgentVerdict(ctx: DoctorContext): Promise<Check> {
  const engine = connectedEngine(ctx);
  if (!(await accessRestrictionsPresent(engine).catch(() => true))) {
    return infoCheck(name, 'Not applicable: no page names readers and no member exists.', 'not_applicable');
  }
  try {
    const rows = await engine.executeRaw<{ kind: 'token' | 'client'; id: string; name: string }>(
      `SELECT * FROM (
         SELECT 'token' AS kind, id::text AS id, name FROM access_tokens WHERE revoked_at IS NULL AND '*' = ANY(may_act_for)
         UNION ALL
         SELECT 'client' AS kind, client_id AS id, COALESCE(client_name, client_id) AS name FROM oauth_clients WHERE deleted_at IS NULL AND '*' = ANY(may_act_for)
       ) w ORDER BY kind, name LIMIT ${SAMPLE}`);
    const [stdio] = await engine.executeRaw<{ value: string | null }>('SELECT value FROM config WHERE key = $1', [STDIO_MAY_ACT_FOR_KEY]);
    const stdioWild = (stdio?.value ?? '').split(',').map(s => s.trim()).includes('*');
    const named = [...rows.map(r => `${r.kind} ${r.name}`), ...(stdioWild ? [`config ${STDIO_MAY_ACT_FOR_KEY}`] : [])];
    const details = { credentials: rows.map(r => ({ kind: r.kind, name: r.name })), stdio: stdioWild, truncated: rows.length === SAMPLE };
    if (!named.length) return { name, status: 'ok', details, message: 'No credential may act for every member (no may_act_for holds *).' };
    const first = rows[0];
    return { name, status: 'warn', details,
      message: `${named.length} credential(s) may act for any member (may_act_for holds *): ${named.slice(0, 5).join(', ')}. `
        + 'A harness using one can name any enabled member as its audience and read what that member reads. List the people it serves instead.',
      fix: first
        ? agentFix(['gbrain', 'access', 'check', first.kind === 'token' ? '--token' : '--client', first.kind === 'token' ? first.name : first.id, '--json'],
          'Read-only: shows the credential\'s grant and may_act_for. Ask the user which members, groups or guest it serves before narrowing it with gbrain auth rescope ... --may-act-for <list>.', name, { ask_user: true })
        : agentFix(['gbrain', 'config', 'get', STDIO_MAY_ACT_FOR_KEY], `Read-only: shows ${STDIO_MAY_ACT_FOR_KEY}. Ask the user whom the stdio server serves before replacing * with that list.`, name, { ask_user: true }) };
  } catch (error) {
    return checkError(name, `run ${name}`, error);
  }
}

async function runSharedAgentAccess(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { name: _name, ...verdict } = await sharedAgentVerdict(ctx);
  checks.push({ name: 'access_may_act_for_wildcard', ...verdict });
  return checks;
}

export const sharedAgentAccessEntry: DoctorEntry = {
  name: 'access_may_act_for_wildcard',
  emits: ['access_may_act_for_wildcard'],
  run: runSharedAgentAccess,
};

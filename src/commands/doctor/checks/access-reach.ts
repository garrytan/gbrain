/**
 * GBRA-585 (decision F): who can still reach what, on a brain that grants access per member. Read-only; each check
 * names the count, a few source ids, page slugs or credential names (never content) and a read-only next step, and a
 * remote caller (run_doctor) gets counts only. Everything is database state, so a repo-less brain answers the same.
 *
 *  - access_shared_source_unread: on a brain that serves several people (access serves), a live source no member is
 *    bound to (not personal) holds pages, yet no enabled member's live token or OAuth client reads it, through federation
 *    or a source grant (credentialReadSources, as dispatch resolves an unqualified read), nor config mcp.stdio_member.
 *  - access_pages_unreadable: pages that name readers or sit under a folder rule that no enabled member reads (readers
 *    and every rule met by one member's identity) and the owner does not read either (access.owner_reads_restricted on
 *    reads past them, except another member's own member page). Malformed readers and pages waiting for derived readers
 *    have their own checks (member-access.ts) and are left out. One bounded read: a 30 s statement limit on Postgres.
 *  - access_disabled_member_credentials: live tokens and OAuth clients bound to a disabled, removed or missing member;
 *    their reads are refused (access_member_disabled), yet gbrain auth list still shows them active.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { brainServes } from '../../../core/access/serves.ts';
import { accessRestrictionsPresent } from '../../../core/search/private-visibility.ts';
import { credentialReadSources, stdioReadSources } from '../../../core/grants/shared-exposure.ts';
import { grantFromClient, grantFromRow, grantFromTokenRow, type PrincipalGrant } from '../../../core/grants/model.ts';
import { stdioMemberId } from '../../../core/access/caller.ts';
import { ownerMemberId, ownerReadsRestrictedOn } from '../../../core/access/owner.ts';
import { ACCESS_ID_RE, MEMBER_PAGE_PREFIX } from '../../../core/access/principals.ts';

const SAMPLE = 20;
const SHOWN = 5;
const TIMEOUT_MS = 30_000;
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
  const read = new Set<string>();
  for (const grant of grants) for (const s of await credentialReadSources(engine, grant)) read.add(s);
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

async function bounded<T>(engine: BrainEngine, fn: (e: BrainEngine) => Promise<T>): Promise<T> {
  if (engine.kind !== 'postgres') return fn(engine);
  return engine.transaction(async tx => {
    await tx.executeRaw(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
    return fn(tx);
  }, { readOnly: true });
}

async function pagesUnreadable(engine: BrainEngine, remote: boolean): Promise<Omit<Check, 'name'>> {
  const name = 'access_pages_unreadable';
  if (!(await accessRestrictionsPresent(engine))) {
    return infoCheck(name, 'Not applicable: no page names readers and no member exists.', 'not_applicable');
  }
  const owner = await ownerReadsRestrictedOn(engine) ? await ownerMemberId(engine) : null;
  const ownerLive = owner !== null && (await engine.executeRaw(`SELECT 1 FROM access_members m WHERE m.id = $1 AND ${ENABLED}`, [owner])).length > 0;
  const audience = ownerLive ? await engine.executeRaw<{ id: string }>(`SELECT m.id FROM access_members m WHERE m.kind = 'audience' AND ${ENABLED}`) : [];
  const ownPages = ownerLive ? [owner!, ...audience.map(a => a.id).filter(id => ACCESS_ID_RE.test(id))].map(id => `${MEMBER_PAGE_PREFIX}${id}`) : [];
  const rows = await bounded(engine, e => e.executeRaw<{ source_id: string; slug: string; readers: string[] | null; rules: string[] | null; total: number }>(
    `WITH readers AS MATERIALIZED (
       SELECT ARRAY['member:' || m.id] || COALESCE((SELECT array_agg('group:' || gm.group_id) FROM access_group_members gm WHERE gm.member_id = m.id), '{}'::text[]) AS identity
         FROM access_members m WHERE ${ENABLED}),
     reach AS MATERIALIZED (
       SELECT r.identity, COALESCE((SELECT array_agg(ar.source_id || ':' || ar.rule_id) FROM access_rules ar WHERE ar.readable_by && r.identity), '{}'::text[]) AS satisfied
         FROM readers r)
     SELECT p.source_id, p.slug, p.page_readers AS readers, p.folder_rule_ids AS rules, count(*) OVER ()::int AS total
       FROM pages p
      WHERE p.deleted_at IS NULL
        AND ((p.page_readers IS NOT NULL AND p.page_readers <> ARRAY['!nobody']::text[])
          OR (p.page_readers IS NULL AND p.folder_rule_ids IS NOT NULL AND p.frontmatter->'readable_by' IS NULL))
        AND NOT EXISTS (SELECT 1 FROM reach r
          WHERE (p.page_readers IS NULL OR p.page_readers && r.identity) AND (p.folder_rule_ids IS NULL OR p.folder_rule_ids <@ r.satisfied))
        ${ownerLive ? 'AND starts_with(p.slug, $1) AND NOT (p.slug = ANY($2::text[]))' : ''}
      ORDER BY p.source_id, p.slug LIMIT ${SAMPLE}`, ownerLive ? [MEMBER_PAGE_PREFIX, ownPages] : []));
  const total = rows[0]?.total ?? 0;
  if (!total) return { status: 'ok', details: { count: 0 }, message: 'Every page that names readers or sits under a folder rule is readable by an enabled member or the owner.' };
  if (remote) {
    return { status: 'warn', details: { count: total },
      message: `${total} page(s) are readable by no enabled member and not by the owner. Ask the brain host's operator to run gbrain doctor --only ${name}.` };
  }
  const ref = (r: { source_id: string; slug: string }) => `${r.source_id}:${r.slug}`;
  const first = rows[0]!;
  return { status: 'warn',
    details: { count: total, truncated: total > rows.length, samples: rows.map(r => ({ page: ref(r), readers: r.readers, rules: r.rules })) },
    message: `${total} page(s) are readable by no enabled member and not by the owner (e.g. ${rows.slice(0, SHOWN).map(ref).join(', ')}). `
      + 'Usual causes: the members a page names were disabled or removed (a leaver), or a folder rule\'s readers exclude the readers the page names '
      + '(a page written into people/<x>/ before x\'s rule existed). Show who reads one, then ask the user who should: name a live member in its readable_by, '
      + 'or change the rule (gbrain access rule add, which previews first). Nothing was changed.',
    fix: agentFix(['gbrain', 'access', 'who-can-read', first.slug, '--source', first.source_id],
      'Read-only: shows the page\'s readers, its folder rules and which enabled members read it, so the user can say who should.', name,
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
  checks.push({ name: 'access_pages_unreadable', ...await pagesUnreadable(engine, remote).catch(e => checkError('access_pages_unreadable', 'run access_pages_unreadable', e)) });
  checks.push({ name: 'access_disabled_member_credentials', ...await disabledMemberCredentials(engine, remote).catch(e => checkError('access_disabled_member_credentials', 'run access_disabled_member_credentials', e)) });
  return checks;
}

export const accessReachEntry: DoctorEntry = {
  name: 'access_shared_source_unread',
  emits: ['access_shared_source_unread', 'access_pages_unreadable', 'access_disabled_member_credentials'],
  run: runAccessReach,
};

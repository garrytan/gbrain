/**
 * GBRA-218: `gbrain access`, the operator surface for per-member read access.
 *
 *   gbrain access member add|disable|enable|rm|list <id> [--name N] [--groups a,b] [--bind-token <name>]
 *   gbrain access group add|rm|list <group> [--members a,b]
 *   gbrain access who-can-read <slug> [--source <id>]
 *   gbrain access check --token <name>|--client <id> [--as a,b]
 *
 * Trusted local CLI only; everything lives in the database, so a repo-less
 * brain works the same as a git-backed one. Refusals follow the agent
 * operator contract (code, message, why, fix) through exitCliError.
 */
import type { BrainEngine } from '../core/engine.ts';
import { exitCliError, usageError } from '../cli/cli-error.ts';
import { runAccessRules } from './access-rules.ts';
import { opError } from '../core/ops/contract.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { grantFromClient, type PrincipalGrant } from '../core/grants/model.ts';
import { readClientGrant } from '../core/grants/service.ts';
import { resolveTokenGrant } from '../core/grants/legacy-token.ts';
import { isPrivacyPrivatePage } from '../core/search/private-visibility.ts';
import { identityFor, normalizePrincipal, normalizeReaders, readersAllow } from '../core/access/principals.ts';
import { mayActForCovers, singleMemberAudience, type AudiencePrincipal } from '../core/access/audience.ts';
import {
  addGroup, addMember, assertAccessId, disableMember, enableMember, getMember, legacyTokenByName, listGroups, listMembers,
  parseIdList, previewRemoveGroup, previewRemoveMember, removeGroup, removeGroupMembers, removeMember, type MemberRecord,
} from '../core/access/members.ts';

export const ACCESS_USAGE = `gbrain access: per-member read access inside one brain

Members and groups:
  gbrain access member add <id> [--name <display name>] [--groups a,b] [--bind-token <token name>]
  gbrain access member disable <id>          Reversible: the member and its credentials stop reading
  gbrain access member enable <id>
  gbrain access member rm <id> [--yes]       Preview first; --yes removes for good (the id is never reused)
  gbrain access member list [--all]          --all includes removed ids
  gbrain access group add <group> [--members a,b]
  gbrain access group rm <group> [--members a,b] [--yes]
                                             With --members, removes those members; otherwise previews
                                             removing the group (--yes applies)
  gbrain access group list [<group>]

Folder rules (one rulebook per source; the database store on a repo-less source, .gbrain/access.yml on a git one):
  gbrain access rule add --prefix <folder/> --readers a,group:b [--id <rule>] [--source <id>] [--yes]
                                             Preview first; narrowing applies at once
  gbrain access rule rm <rule> [--source <id>] [--yes]
                                             A widening: recorded and held until gbrain access apply
  gbrain access rule list|status|history [--source <id>] [--operation <id>]
  gbrain access rule revert --to <revision> [--source <id>] [--yes]
  gbrain access rule export|import [--file <access.yml>] [--source <id>] [--yes]
  gbrain access rule migrate [--source <id>] [--yes]
                                             Move the rules between the database and git stores
  gbrain access apply [--source <id>] [--revision <n>] [--yes --expect <plan_hash>]
                                             Preview held widenings; --yes approves the previewed plan
  gbrain access resume [--source <id>]       Finish a narrowing that was interrupted while stamping pages

Checks (read-only):
  gbrain access who-can-read <slug> [--source <id>]
                                             The page's readers, its privacy, and which members may read it
  gbrain access check --token <name>|--client <id> [--as a,b]
                                             One credential's grant axes and member identity; --as lists an
                                             audience and reports whether its may_act_for covers it

Bind credentials: gbrain auth create|rescope|register-client ... --member <id>|none [--may-act-for <list>|none]
Preview a member's view: gbrain search "<query>" --as <member>
Every command takes --json.`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw usageError(`${name} requires a value.`, `Put the value right after the flag, as in ${name} VALUE.`);
  return v;
}

const VALUE_FLAGS = new Set(['--name', '--groups', '--bind-token', '--members', '--source', '--token', '--client', '--as']);

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i]!)) { i++; continue; }
    if (!args[i]!.startsWith('--')) out.push(args[i]!);
  }
  return out;
}

function memberLine(m: MemberRecord): string {
  return `  ${m.id}${m.display_name ? ` (${m.display_name})` : ''}  ${m.status}${m.groups.length ? `  groups: ${m.groups.join(', ')}` : ''}`;
}

export interface WhoCanReadEntry {
  slug: string;
  source_id: string;
  readers: string[] | null;
  private: boolean;
  members: string[] | 'every_source_reader';
  note: string;
}

/** Who may read `slug` remotely: its normalized readers, privacy and the enabled members those readers admit. */
export async function whoCanRead(engine: BrainEngine, slug: string, sourceId?: string): Promise<WhoCanReadEntry[]> {
  const rows = await engine.executeRaw<{ slug: string; source_id: string; type: string | null; frontmatter: unknown }>(
    `SELECT slug, source_id, type, frontmatter FROM pages WHERE slug = $1${sourceId ? ' AND source_id = $2' : ''} ORDER BY source_id`,
    sourceId ? [slug, sourceId] : [slug]);
  if (!rows.length) {
    throw opError('not_found', `No page "${slug}"${sourceId ? ` in source ${sourceId}` : ''}.`, 'Check the slug with gbrain list or gbrain search.');
  }
  const members = (await listMembers(engine)).filter(m => m.status === 'enabled');
  return rows.map(row => {
    const fm = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter;
    const readers = normalizeReaders(fm);
    const priv = isPrivacyPrivatePage({ type: row.type, frontmatter: fm });
    const allowed = readers === null ? 'every_source_reader' as const : members.filter(m => readersAllow(fm, identityFor(m.id, m.groups))).map(m => m.id);
    const notes = [
      readers === null ? 'No readable_by: every caller entitled to the source reads it.'
        : readers.includes('!nobody') ? 'readable_by is malformed, so no remote caller reads it; fix the frontmatter.'
        : 'Only credentials bound to these members (directly or through a group) read it remotely; unbound credentials and stdio do not.',
      ...(priv ? ['visibility: private also applies: a member still needs private_pages: granted_sources on this source.'] : []),
      'Derived pages (atoms, facts, chronicle events) of a page that names readers are hidden from every remote caller.',
    ];
    return { slug: row.slug, source_id: row.source_id, readers, private: priv, members: allowed, note: notes.join(' ') };
  });
}

export interface AccessCheckResult {
  credential: { kind: 'token' | 'client'; id: string; name: string };
  grant: { scopes: string[]; sources: PrincipalGrant['sources']; takes_holders: string[] | null; private_pages: PrincipalGrant['privatePages']; operations: string[] | 'unrestricted'; revision: number };
  member: { id: string; status: MemberRecord['status'] | 'missing'; groups: string[] } | null;
  identity: string[];
  may_act_for: string[] | null;
  verdict: 'reads_as_member' | 'unbound' | 'refused';
  explanation: string;
  audience?: Array<{ principal: string; covered_by_may_act_for: boolean }>;
}

/** Every grant axis and the member identity of one credential, as the verifier and dispatch would see it. */
export async function accessCheck(engine: BrainEngine, target: { token?: string; client?: string; as?: string }): Promise<AccessCheckResult> {
  if (!!target.token === !!target.client) throw usageError('Pass exactly one of --token <name> or --client <id>.', 'gbrain access check --token <name> | --client <id> [--as a,b]');
  let credential: AccessCheckResult['credential'];
  let grant: PrincipalGrant;
  let row: Record<string, unknown>;
  if (target.token) {
    const ref = await legacyTokenByName(engine, target.token);
    [row] = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id::text = $1', [ref.id]) as [Record<string, unknown>];
    grant = await resolveTokenGrant(sqlQueryForEngine(engine), row);
    credential = ref;
  } else {
    const client = await readClientGrant(engine, target.client!);
    if (client.revoked) throw opError('client_not_found', `OAuth client "${target.client}" is revoked.`, 'List the clients with gbrain auth clients --json.');
    [row] = await engine.executeRaw<Record<string, unknown>>('SELECT member_id, may_act_for FROM oauth_clients WHERE client_id = $1', [client.clientId]) as [Record<string, unknown>];
    grant = grantFromClient(client);
    credential = { kind: 'client', id: client.clientId, name: client.clientName };
  }
  const boundId = typeof row.member_id === 'string' ? row.member_id : null;
  const rec = boundId ? await getMember(engine, boundId) : null;
  const member = boundId ? { id: boundId, status: rec?.status ?? 'missing' as const, groups: rec?.groups ?? [] } : null;
  const live = member?.status === 'enabled';
  const identity = live ? identityFor(member!.id, member!.groups) : [];
  const mayActFor = Array.isArray(row.may_act_for) ? (row.may_act_for as string[]) : null;
  const verdict: AccessCheckResult['verdict'] = !member ? 'unbound' : live ? 'reads_as_member' : 'refused';
  const explanation = verdict === 'unbound' ? 'Bound to no member: reads every page its grant allows except pages that name readers (readable_by).'
    : verdict === 'refused' ? `Bound to member "${member!.id}", which is ${member!.status}: the credential is refused at verification (access_member_disabled).`
    : `Reads as member "${member!.id}"${member!.groups.length ? ` (groups: ${member!.groups.join(', ')})` : ''}: pages naming readers are visible when they list the member or one of its groups, within the grant below.`;
  const result: AccessCheckResult = {
    credential,
    grant: { scopes: grant.scopes, sources: grant.sources, takes_holders: grant.takesHolders, private_pages: grant.privatePages,
      operations: grant.allowedOperations ?? 'unrestricted', revision: grant.revision },
    member, identity, may_act_for: mayActFor, verdict, explanation,
  };
  if (target.as !== undefined) {
    const audience: NonNullable<AccessCheckResult['audience']> = [];
    for (const entry of target.as.split(',').map(s => s.trim()).filter(Boolean)) {
      const principal = entry === 'guest' ? 'guest' : normalizePrincipal(entry);
      if (!principal) throw opError('access_member_invalid', `"${entry}" is not a valid --as entry.`, 'Use comma-separated member ids, group:ID entries or guest, for example --as alice-example,group:team-a,guest.', { reason: 'ill_formed', why: 'Each audience entry must parse as a principal.' });
      if (principal.startsWith('member:')) {
        const m = await getMember(engine, assertAccessId(principal.slice(7)));
        if (m?.status !== 'enabled') throw opError('access_member_invalid', `--as names "${principal.slice(7)}", which is ${m ? m.status : 'not a member'}.`, 'Check the id with gbrain access member list --all.', { reason: m ? m.status : 'unknown', why: 'An audience names enabled members only; an unknown one is refused rather than ignored.' });
      } else if (principal.startsWith('group:') && !(await listGroups(engine, principal.slice(6))).length) {
        throw opError('access_member_invalid', `--as names group "${principal.slice(6)}", which does not exist.`, 'List groups with gbrain access group list.', { reason: 'unknown_group', why: 'An audience names existing groups only.' });
      }
      audience.push({ principal, covered_by_may_act_for: mayActForCovers(mayActFor, principal as AudiencePrincipal) });
    }
    result.audience = audience;
    const missing = audience.filter(a => !a.covered_by_may_act_for).map(a => a.principal);
    result.explanation += missing.length
      ? ` A request naming this audience is refused (on_behalf_of_not_permitted): may_act_for does not list ${missing.join(', ')}.`
      : ` A request naming this audience reads only the pages every entry may read${singleMemberAudience(audience.map(a => a.principal)) ? '' : ' and no visibility: private page'}, within the grant above.`;
  }
  return result;
}

function print(json: boolean, value: unknown, human: () => string[]): void {
  console.log(json ? JSON.stringify(value, null, 2) : human().join('\n'));
}

async function memberCmd(engine: BrainEngine, sub: string | undefined, args: string[], json: boolean): Promise<void> {
  const id = positionals(args)[0];
  switch (sub) {
    case 'add': {
      const r = await addMember(engine, id, { name: flagValue(args, '--name'), groups: parseIdList(flagValue(args, '--groups'), 'group'), bindToken: flagValue(args, '--bind-token') });
      return print(json, r, () => [`Member added: ${r.member.id}`, memberLine(r.member),
        ...(r.groups_created.length ? [`  Groups created: ${r.groups_created.join(', ')}`] : []),
        ...(r.bound ? [`  Bound token: ${r.bound.name} (${r.bound.id})`] : ['  Bind a credential: gbrain auth rescope --token <name> --member ' + r.member.id]),
        `Preview what it reads: gbrain search "<query>" --as ${r.member.id}`]);
    }
    case 'disable':
    case 'enable': {
      const m = await (sub === 'disable' ? disableMember : enableMember)(engine, id);
      return print(json, { member: m }, () => [`Member ${sub}d: ${m.id}`, memberLine(m),
        sub === 'disable' ? 'Its credentials are refused on their next request; gbrain access member enable undoes this.' : 'Its credentials read again on their next request.']);
    }
    case 'rm': {
      const yes = args.includes('--yes');
      const r = yes ? await removeMember(engine, id) : await previewRemoveMember(engine, id);
      return print(json, { ...r, applied: yes }, () => [
        `${yes ? 'Removed' : 'Would remove'} member ${r.member.id}`,
        `  Bound credentials (${r.bound_credentials.length}): ${r.bound_credentials.map(c => `${c.kind} ${c.name}`).join(', ') || 'none'}`,
        `  Pages naming it (${r.pages.length}${r.pages_truncated ? '+' : ''}): ${r.pages.map(p => `${p.source_id}:${p.slug}`).join(', ') || 'none'}`,
        `  ${r.note}`,
        ...(yes ? [] : [`Apply with: gbrain access member rm ${r.member.id} --yes`])]);
    }
    case 'list': {
      const members = await listMembers(engine, { includeRemoved: args.includes('--all') });
      return print(json, { members }, () => members.length ? ['Members:', ...members.map(memberLine)] : ['No members. Add one: gbrain access member add <id>']);
    }
    default:
      throw usageError(`Unknown access member subcommand: ${sub ?? '(none)'}.`, 'Use add, disable, enable, rm or list (gbrain access --help).');
  }
}

async function groupCmd(engine: BrainEngine, sub: string | undefined, args: string[], json: boolean): Promise<void> {
  const id = positionals(args)[0];
  const members = parseIdList(flagValue(args, '--members'), 'member');
  switch (sub) {
    case 'add': {
      const r = await addGroup(engine, id, members);
      return print(json, r, () => [`Group ${r.created ? 'created' : 'updated'}: ${r.group.id}`, `  Members: ${r.group.members.join(', ') || 'none (matches nobody)'}`]);
    }
    case 'rm': {
      if (members.length) {
        const g = await removeGroupMembers(engine, id, members);
        return print(json, { group: g }, () => [`Group updated: ${g.id}`, `  Members: ${g.members.join(', ') || 'none (matches nobody)'}`]);
      }
      const yes = args.includes('--yes');
      const r = yes ? await removeGroup(engine, id) : await previewRemoveGroup(engine, id);
      return print(json, { ...r, applied: yes }, () => [`${yes ? 'Removed' : 'Would remove'} group ${r.group.id} (members: ${r.group.members.join(', ') || 'none'})`,
        `  Pages naming it (${r.pages.length}${r.pages_truncated ? '+' : ''}): ${r.pages.map(p => `${p.source_id}:${p.slug}`).join(', ') || 'none'}`,
        `  ${r.note}`, ...(yes ? [] : [`Apply with: gbrain access group rm ${r.group.id} --yes`])]);
    }
    case 'list': {
      const groups = await listGroups(engine, id ? assertAccessId(id, 'group') : undefined);
      return print(json, { groups }, () => groups.length ? ['Groups:', ...groups.map(g => `  ${g.id}: ${g.members.join(', ') || 'no members'}`)] : ['No groups.']);
    }
    default:
      throw usageError(`Unknown access group subcommand: ${sub ?? '(none)'}.`, 'Use add, rm or list (gbrain access --help).');
  }
}

export async function runAccess(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { console.log(ACCESS_USAGE); return; }
  const json = args.includes('--json');
  const [cmd, ...rest] = args;
  try {
    if (cmd !== 'check' && rest.some(a => a === '--as' || a.startsWith('--as='))) {
      throw usageError(`--as is not an option of gbrain access ${cmd}.`, 'gbrain access check --token <name> --as a,b evaluates an audience; operations take --as <member> to preview a member view.');
    }
    if (await runAccessRules(engine, cmd!, rest, json)) return;
    switch (cmd) {
      case 'member': return await memberCmd(engine, rest[0], rest.slice(1), json);
      case 'group': return await groupCmd(engine, rest[0], rest.slice(1), json);
      case 'who-can-read': {
        const slug = positionals(rest)[0];
        if (!slug) throw usageError('who-can-read needs a page slug.', 'gbrain access who-can-read <slug> [--source <id>]');
        const pages = await whoCanRead(engine, slug, flagValue(rest, '--source'));
        return print(json, { pages }, () => pages.flatMap(p => [
          `${p.source_id}:${p.slug}`,
          `  Readers: ${p.readers === null ? 'not restricted' : p.readers.join(', ')}${p.private ? '  (visibility: private)' : ''}`,
          `  Members who may read it: ${p.members === 'every_source_reader' ? 'every caller entitled to the source' : p.members.join(', ') || 'none'}`,
          `  ${p.note}`]));
      }
      case 'check': {
        const r = await accessCheck(engine, { token: flagValue(rest, '--token'), client: flagValue(rest, '--client'), as: flagValue(rest, '--as') });
        return print(json, r, () => [
          `${r.credential.kind === 'token' ? 'Token' : 'OAuth client'} ${r.credential.name} (${r.credential.id})`,
          `  Scopes: ${r.grant.scopes.join(', ') || 'none'}`,
          `  Sources: ${JSON.stringify(r.grant.sources)}`,
          `  Operations: ${r.grant.operations === 'unrestricted' ? 'every operation the scopes allow' : r.grant.operations.length}`,
          `  Private pages: ${r.grant.private_pages}`,
          `  Member: ${r.member ? `${r.member.id} (${r.member.status})` : 'none'}${r.member?.groups.length ? `  groups: ${r.member.groups.join(', ')}` : ''}`,
          `  May act for: ${r.may_act_for?.join(', ') ?? 'none'}`,
          ...(r.audience ? [`  Audience: ${r.audience.map(a => `${a.principal}${a.covered_by_may_act_for ? '' : ' (not in may_act_for)'}`).join(', ')}`] : []),
          `  ${r.explanation}`]);
      }
      default:
        throw usageError(`Unknown access subcommand: ${cmd}.`, 'Use member, group, rule, apply, resume, who-can-read or check (gbrain access --help).', { code: 'unknown_command' });
    }
  } catch (e) {
    exitCliError(e, 'access');
  }
}

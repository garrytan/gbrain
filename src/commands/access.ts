/**
 * GBRA-218: `gbrain access`, the operator surface for per-member read access.
 *
 *   gbrain access member add|disable|enable|rm|list <id> [--name N] [--email <addr>] [--groups a,b] [--bind-token <name>]
 *   gbrain access member set <id> --email <addr>|none
 *   gbrain access member link <id>|--email <addr> --qm <canonical id> | unlink --qm <canonical id> | links [--member <id>]
 *   gbrain access member source add|remove|list <member> [<source>]
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
import { runAccessServes } from './access-serves.ts';
import { opError } from '../core/ops/contract.ts';
import { sqlQueryForEngine } from '../core/sql-query.ts';
import { grantFromClient, type PrincipalGrant } from '../core/grants/model.ts';
import { readClientGrant } from '../core/grants/service.ts';
import { resolveTokenGrant } from '../core/grants/legacy-token.ts';
import { accessAllowedSql, folderRulesAllowedSql, isPrivacyPrivatePage, withCallerAccess } from '../core/search/private-visibility.ts';
import { membersReadLineageOn, setMembersReadLineage } from '../core/access/lineage.ts';
import { setMemberLabelledOnly } from '../core/access/labelled-only.ts';
import { folderAccessFor } from '../core/access/caller.ts';
import { identityFor, MEMBER_PAGE_PREFIX, normalizePrincipal, normalizeReaders } from '../core/access/principals.ts';
import { mayActForCovers, singleMemberAudience, type AudiencePrincipal } from '../core/access/audience.ts';
import { linkMember, linkMemberByEmail, listMemberLinks, unlinkMember } from '../core/access/actor.ts';
import { bindMemberSource, listMemberSources, unbindMemberSource } from '../core/access/member-sources.ts';
import { clearOwner, ownerMemberId, ownerReadsRestrictedOn, ownerView, setOwner, setOwnerReadsRestricted, type OwnerView } from '../core/access/owner.ts';
import { stdioBindRoute } from '../core/access/stdio-bind-route.ts';
import {
  addGroup, addMember, assertAccessId, disableMember, enableMember, existingMember, getMember, legacyTokenByName, listGroups, listMembers,
  parseIdList, previewRemoveGroup, previewRemoveMember, removeGroup, removeGroupMembers, removeMember, setMemberEmail, setMemberKind, type MemberRecord,
} from '../core/access/members.ts';

export const ACCESS_USAGE = `gbrain access: per-member read access inside one brain

Members and groups:
  gbrain access member add <id> [--name <display name>] [--email <addr>] [--groups a,b] [--bind-token <token name>] [--kind person|audience]
  gbrain access member kind <id> person|audience
                                             audience: a group chat or shared assistant; the owner reads its own
                                             member page, older versions, derived pages and facts (person: default)
  gbrain access member labelled-only <id> [on|off]
                                             On: every credential bound to the member reads only pages that name it
                                             (readable_by or a rule listing it or its groups); never the owner
  gbrain access member set <id> --email <addr>|none
                                             Declare or clear the email an operator finds the member by
                                             (case-folded, unique per brain)
  gbrain access member disable <id>          Reversible: the member and its credentials stop reading
  gbrain access member enable <id>
  gbrain access member rm <id> [--yes]       Preview first; --yes removes for good (the id is never reused)
  gbrain access member list [--all]          --all includes removed ids
  gbrain access member link <id> --qm <canonical id> [--dry-run]
                                             An attested QM call naming that person reads and writes as <id>
  gbrain access member link --email <addr> --qm <canonical id> [--dry-run]
                                             The same link, to the member that declares <addr>
  gbrain access member unlink --qm <canonical id> [--dry-run]
  gbrain access member links [--member <id>] Canonical ids are compared exactly (no case folding)
  gbrain access member source add <id> <source> [--dry-run]
                                             Personal source: attested calls for anyone else, and scope
                                             reads, stop reading it (hide-only, inside each grant)
  gbrain access member source remove <id> <source> [--yes]
                                             Preview first; removing the last binding makes it readable
                                             again to every attested person whose credential grants it
  gbrain access member source list [<id>]
  gbrain access group add <group> [--members a,b]
  gbrain access group rm <group> [--members a,b] [--yes]
                                             With --members, removes those members; otherwise previews
                                             removing the group (--yes applies)
  gbrain access group list [<group>]

Owner (one member who owns this brain; credentials bound to it read every page, private ones included):
  gbrain access owner                        Show the owner and the credentials that read as it
  gbrain access owner set <member>           The member must be enabled; bind credentials with --member <id>
  gbrain access owner clear                  No owner: every caller reads under the ordinary policy
  gbrain access owner reads-restricted on|off
                                             Off by default. On: the owner's credentials also read pages that
                                             readers lists and folder or page rules keep to other members, and
                                             their derived pages and facts (never another member's member page)
  gbrain access members-read-lineage [on|off]
                                             Off by default. On: a member's credential (speaking for itself) reads
                                             derived pages and facts whose origins it reads, so summaries of a page
                                             reach everyone that page lists

Serves several people (GST-363):
  gbrain access serves [--no-open-pages]     One or several, and why (config access.serves, else 2+ enabled members);
                                             on several, the pages every member's key reads (--no-open-pages skips the count)
  gbrain access serves several --members a,b [--members-file <file>] [--source <id>] [--labelled-only] [--yes]
                                             Preview first; --yes writes access.serves = several, adds each member,
                                             a folder rule people/<member>/ read only by that member, and one key
                                             bound to each member in a 0600 file under <config>/member-keys/.
                                             Both list the pages every member's key can still read (no rule or
                                             readable_by restricts them); --labelled-only keeps each member to the
                                             pages labelled for it (never the owner)

Folder rules (one rulebook per source; the database store on a repo-less source, .gbrain/access.yml on a git one):
  gbrain access rule add --prefix <folder/> | --slug <page> --readers a,group:b [--raw-only] [--id <rule>] [--source <id>] [--yes]
                                             Preview first; narrowing applies at once. --raw-only: the rule keeps
                                             its pages, not their derived pages and facts (transcripts; a widening
                                             held for gbrain access apply when it changes an existing rule)
  gbrain access rule rm <rule> [--source <id>] [--yes]
                                             A widening: recorded and held until gbrain access apply
  gbrain access rule list|status|history [--source <id>] [--operation <id>]
  gbrain access rule revert --to <revision> [--source <id>] [--yes]
  gbrain access rule export|import [--file <access.yml>] [--source <id>] [--yes]
  gbrain access rule migrate [--to git|database] [--source <id>] [--yes]
                                             Move the rules between the database and git stores
                                             (--to database from no store commits nothing)
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

const VALUE_FLAGS = new Set(['--name', '--groups', '--bind-token', '--members', '--members-file', '--source', '--token', '--client', '--as', '--qm', '--member', '--email', '--kind']);

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i]!)) { i++; continue; }
    if (!args[i]!.startsWith('--')) out.push(args[i]!);
  }
  return out;
}

function memberLine(m: MemberRecord): string {
  return `  ${m.id}${m.display_name ? ` (${m.display_name})` : ''}  ${m.status}${m.kind === 'audience' ? '  audience' : ''}${m.labelled_only ? '  labelled-only' : ''}${m.email ? `  email: ${m.email}` : ''}${m.groups.length ? `  groups: ${m.groups.join(', ')}` : ''}`;
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
  const rows = await engine.executeRaw<{ slug: string; source_id: string; type: string | null; frontmatter: unknown; folder_rule_ids: string[] | null }>(
    `SELECT slug, source_id, type, frontmatter, folder_rule_ids FROM pages WHERE slug = $1${sourceId ? ' AND source_id = $2' : ''} ORDER BY source_id`,
    sourceId ? [slug, sourceId] : [slug]);
  if (!rows.length) {
    throw opError('not_found', `No page "${slug}"${sourceId ? ` in source ${sourceId}` : ''}.`, 'Check the slug with gbrain list or gbrain search.');
  }
  const ownerId = await ownerMemberId(engine);
  const optIn = await ownerReadsRestrictedOn(engine) ? ownerId : null;
  const memberLineage = await membersReadLineageOn(engine);
  const enabled = (await listMembers(engine)).filter(m => m.status === 'enabled');
  const audienceIds = enabled.filter(m => m.kind === 'audience').map(m => m.id);
  const members = await Promise.all(enabled.map(async m => {
    const identity = identityFor(m.id, m.groups);
    return { id: m.id, identity, folder: await folderAccessFor(engine, identity) };
  }));
  const labelledOnlyIds = enabled.filter(m => m.labelled_only && m.id !== ownerId).map(m => m.id);
  const entries: WhoCanReadEntry[] = [];
  for (const row of rows) {
    const fm = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter;
    const readers = normalizeReaders(fm);
    const priv = isPrivacyPrivatePage({ type: row.type, frontmatter: fm });
    const ruled = (row.folder_rule_ids?.length ?? 0) > 0;
    const allowed: string[] = [];
    if (readers !== null || ruled) {
      for (const { id, identity, folder } of members) {
        const admitted = await withCallerAccess({ identity, ...folder, restricted: true }, () => engine.executeRaw(
          `SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ${accessAllowedSql('p', identity)}`, [row.source_id, row.slug]));
        if (admitted.length) allowed.push(id);
      }
    }
    const audiencePage = row.slug.startsWith(MEMBER_PAGE_PREFIX) && audienceIds.includes(row.slug.slice(MEMBER_PAGE_PREFIX.length));
    const ownerOpened = !!optIn && (readers !== null || ruled) && !allowed.includes(optIn) && members.some(m => m.id === optIn)
      && (!row.slug.startsWith(MEMBER_PAGE_PREFIX) || row.slug === `${MEMBER_PAGE_PREFIX}${optIn}` || audiencePage);
    if (ownerOpened) allowed.push(optIn!);
    const ownerRecord = members.find(m => m.id === ownerId);
    const audienceOpened = audiencePage && !!ownerRecord && !allowed.includes(ownerRecord.id) && (readers !== null || ruled)
      && (await withCallerAccess({ identity: ownerRecord.identity, ...ownerRecord.folder, restricted: true }, () => engine.executeRaw(
        `SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ${folderRulesAllowedSql('p', ownerRecord.folder.satisfiedRuleIds)}`, [row.source_id, row.slug]))).length > 0;
    if (audienceOpened) allowed.push(ownerRecord!.id);
    const lineageRules = ruled ? await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM unnest($1::text[]) AS x WHERE NOT EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id = $2 AND x = $2 || ':' || r.rule_id AND NOT r.covers_derived)`,
      [row.folder_rule_ids, row.source_id]) : [{ n: 0 }];
    const closesLineage = readers !== null || Number(lineageRules[0]?.n ?? 0) > 0;
    const notes = [
      readers === null ? (ruled ? 'No readable_by, but folder rules cover it: only members who meet every rule read it remotely.' : 'No readable_by: every caller entitled to the source reads it.')
        : readers.includes('!nobody') ? 'readable_by is malformed, so no remote caller reads it; fix the frontmatter.'
        : 'Only credentials bound to these members (directly or through a group) read it remotely; unbound credentials and stdio do not.',
      ...(readers !== null && ruled ? ['Folder rules cover it too: a member must meet readable_by and every rule.'] : []),
      ...(priv ? ['visibility: private also applies: a member still needs private_pages: granted_sources on this source.'] : []),
      !closesLineage && ruled ? 'Every rule covering it is raw only (covers_derived: false): its derived pages and facts are not kept to its readers; whoever reads a derived page reads it.'
        : memberLineage && closesLineage ? 'Derived pages (atoms, facts, chronicle events) of it are read by the members listed here that read every origin (access.members_read_lineage is on, gbrain access members-read-lineage off turns it off) and by the owner when listed; every other remote caller gets not_found.'
        : 'Derived pages (atoms, facts, chronicle events) of a page that names readers are hidden from every remote caller.',
      ...(ownerOpened ? [`The owner (${optIn}) reads it too, and its derived pages and facts: access.owner_reads_restricted is on (gbrain access owner reads-restricted off turns it off).`] : []),
      ...(audienceOpened || (audiencePage && ownerOpened) ? [`It is the member page of an audience member (gbrain access member kind), so the owner (${ownerId}) reads it, its older versions, its derived pages and its facts as if it named the owner.`] : []),
      ...(labelledOnlyIds.length ? [`Labelled-only members (${labelledOnlyIds.join(', ')}) read it only when it names them: readable_by or a rule listing them or their groups${readers === null && !ruled ? ', so none of them reads it' : ''}; a derived page or fact that names nobody is hidden from them${memberLineage ? ' unless every origin names them' : ''}.`] : []),
    ];
    entries.push({ slug: row.slug, source_id: row.source_id, readers, private: priv, members: readers === null && !ruled ? 'every_source_reader' : allowed, note: notes.join(' ') });
  }
  return entries;
}

export interface AccessCheckResult {
  credential: { kind: 'token' | 'client'; id: string; name: string };
  grant: { scopes: string[]; sources: PrincipalGrant['sources']; takes_holders: string[] | null; private_pages: PrincipalGrant['privatePages']; operations: string[] | 'unrestricted'; revision: number };
  member: { id: string; status: MemberRecord['status'] | 'missing'; groups: string[]; kind?: MemberRecord['kind'] } | null;
  identity: string[];
  may_act_for: string[] | null;
  verdict: 'reads_as_member' | 'unbound' | 'refused';
  /** GST-363: marked with auth rescope --reads-unscoped --yes, so it reads unscoped on purpose on a brain that serves several people. */
  reads_unscoped: boolean;
  /** GST-2059: the credential reads as the brain owner (config access.owner_member). */
  owner: boolean;
  /** GST-2490: access.owner_reads_restricted is on, so the owner's credentials read past readers lists and rules. */
  owner_reads_restricted: boolean;
  /** GBRA-108 design 3: access.members_read_lineage is on, so a member's reads pass derived pages and facts whose origins it reads. */
  members_read_lineage: boolean;
  /** GBRA-108 design 1: the credential's member is labelled-only, so it reads only pages that name it. */
  labelled_only: boolean;
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
    [row] = await engine.executeRaw<Record<string, unknown>>('SELECT member_id, may_act_for, reads_unscoped FROM oauth_clients WHERE client_id = $1', [client.clientId]) as [Record<string, unknown>];
    grant = grantFromClient(client);
    credential = { kind: 'client', id: client.clientId, name: client.clientName };
  }
  const boundId = typeof row.member_id === 'string' ? row.member_id : null;
  const rec = boundId ? await getMember(engine, boundId) : null;
  const member = boundId ? { id: boundId, status: rec?.status ?? 'missing' as const, groups: rec?.groups ?? [], ...(rec ? { kind: rec.kind } : {}) } : null;
  const live = member?.status === 'enabled';
  const identity = live ? identityFor(member!.id, member!.groups) : [];
  const mayActFor = Array.isArray(row.may_act_for) ? (row.may_act_for as string[]) : null;
  const verdict: AccessCheckResult['verdict'] = !member ? 'unbound' : live ? 'reads_as_member' : 'refused';
  const readsUnscoped = row.reads_unscoped != null;
  const ownerId = await ownerMemberId(engine);
  const owner = live && member!.id === ownerId;
  const ownerReadsRestricted = !!ownerId && await ownerReadsRestrictedOn(engine);
  const memberLineage = await membersReadLineageOn(engine);
  const labelledOnly = live && !owner && rec?.labelled_only === true;
  const explanation = verdict === 'unbound' ? 'Bound to no member: reads every page its grant allows except pages that name readers (readable_by).'
      + (readsUnscoped ? ' Marked --reads-unscoped: on a brain that serves several people it reads every page no rule restricts, for any asker (gbrain auth rescope --reads-unscoped none removes the mark).' : '')
    : verdict === 'refused' ? `Bound to member "${member!.id}", which is ${member!.status}: the credential is refused at verification (access_member_disabled).`
    : `Reads as member "${member!.id}"${member!.groups.length ? ` (groups: ${member!.groups.join(', ')})` : ''}: pages naming readers are visible when they list the member or one of its groups, within the grant below.`
      + (owner ? ' It is the brain owner: it also reads visibility: private pages, privacy-alias pages, derived and pinned-question pages and private facts in every source the grant reads.' : '')
      + (ownerReadsRestricted ? (owner
        ? ' access.owner_reads_restricted is on: in reads it also reads pages that readers lists and folder or page rules keep to other members, and their derived pages and facts, except another member\'s own member page.'
        : ` access.owner_reads_restricted is on: the brain owner (${ownerId}) also reads the pages this credential's readers lists and rules keep to it, except its own member page.`) : '')
      + (owner ? ' In reads it also reads derived pages and facts whose origins it reads.'
        : memberLineage ? ' access.members_read_lineage is on: in reads, speaking for itself, it also reads derived pages and facts whose origins it reads.' : '')
      + (rec?.kind === 'audience' ? ` It is an audience member (a group chat or shared assistant)${ownerId && !owner ? `: the brain owner (${ownerId}) reads its own member page, older versions, derived pages and facts as if they named the owner` : ''}.` : '')
      + (labelledOnly ? ` It is labelled-only (gbrain access member labelled-only ${member!.id} off clears it): it reads only pages whose readable_by names the member or one of its groups, or that a rule listing them covers; every unlabelled page its grant would open, and every derived page and fact that names nobody${memberLineage ? ' (unless every origin names it)' : ''}, is hidden.` : '');
  const result: AccessCheckResult = {
    credential,
    grant: { scopes: grant.scopes, sources: grant.sources, takes_holders: grant.takesHolders, private_pages: grant.privatePages,
      operations: grant.allowedOperations ?? 'unrestricted', revision: grant.revision },
    member, identity, may_act_for: mayActFor, verdict, reads_unscoped: readsUnscoped, owner, owner_reads_restricted: ownerReadsRestricted, members_read_lineage: memberLineage, labelled_only: labelledOnly, explanation,
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
      : ` A request naming this audience reads only the pages every entry may read${singleMemberAudience(audience.map(a => a.principal)) ? (owner && audience[0]!.principal !== `member:${member!.id}` ? ', without the owner\'s privacy relaxation' : '') : ' and no visibility: private page'}, within the grant above.`;
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
      const r = await addMember(engine, id, { name: flagValue(args, '--name'), email: flagValue(args, '--email'), groups: parseIdList(flagValue(args, '--groups'), 'group'), bindToken: flagValue(args, '--bind-token'), kind: flagValue(args, '--kind'), remote: false });
      return print(json, r, () => [`Member added: ${r.member.id}`, memberLine(r.member),
        ...(r.groups_created.length ? [`  Groups created: ${r.groups_created.join(', ')}`] : []),
        ...(r.bound ? [`  Bound token: ${r.bound.name} (${r.bound.id})`] : ['  Bind a credential: gbrain auth rescope --token <name> --member ' + r.member.id]),
        `Preview what it reads: gbrain search "<query>" --as ${r.member.id}`]);
    }
    case 'kind': {
      const kind = positionals(args)[1];
      if (kind !== 'person' && kind !== 'audience') throw usageError('access member kind needs a member id and person or audience.', 'gbrain access member kind <id> person|audience');
      const r = await setMemberKind(engine, id, kind, { remote: false });
      return print(json, r, () => [`${r.changed ? 'Member updated' : 'Unchanged'}: ${r.member.id}`, memberLine(r.member),
        r.member.kind === 'audience' ? 'The brain owner reads its own member page, older versions, derived pages and facts as if they named the owner. gbrain access member kind ' + r.member.id + ' person undoes this.'
          : 'A person: the owner reads its member page only when listed.']);
    }
    case 'labelled-only': {
      const value = positionals(args)[1];
      if (!id || (value !== undefined && value !== 'on' && value !== 'off')) throw usageError('access member labelled-only needs a member id and on or off.', 'gbrain access member labelled-only <id> [on|off]');
      const r = value === undefined ? { member: await existingMember(engine, id, 'read'), changed: false } : await setMemberLabelledOnly(engine, id, value === 'on', { remote: false });
      return print(json, r, () => [`${value === undefined ? 'Member' : r.changed ? 'Member updated' : 'Unchanged'}: ${r.member.id}`, memberLine(r.member),
        r.member.labelled_only ? `Labelled-only: every credential bound to it reads only pages that name it (readable_by or a rule listing it or its groups). gbrain access member labelled-only ${r.member.id} off clears it.`
          : 'Not labelled-only: its credentials read every page their grant and readers allow.']);
    }
    case 'disable':
    case 'enable': {
      const m = await (sub === 'disable' ? disableMember : enableMember)(engine, id);
      return print(json, { member: m }, () => [`Member ${sub}d: ${m.id}`, memberLine(m),
        sub === 'disable' ? 'Its credentials are refused on their next request; gbrain access member enable undoes this.' : 'Its credentials read again on their next request.']);
    }
    case 'set': {
      const email = flagValue(args, '--email');
      if (email === undefined) throw usageError('access member set needs --email <addr>|none.', 'gbrain access member set <id> --email <addr>|none');
      const r = await setMemberEmail(engine, id, email === 'none' ? null : email);
      return print(json, r, () => [`${r.changed ? 'Member updated' : 'Unchanged'}: ${r.member.id}`, memberLine(r.member)]);
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
    case 'link':
    case 'unlink':
    case 'links':
      return memberLinksCmd(engine, sub, args, json, id);
    case 'source':
      return memberSourceCmd(engine, args, json);
    default:
      throw usageError(`Unknown access member subcommand: ${sub ?? '(none)'}.`, 'Use add, set, kind, labelled-only, disable, enable, rm, list, link, unlink, links or source (gbrain access --help).');
  }
}

/** GST-359 C1: links from a trusted system's canonical person ids to members (database only, repo-less or not). */
async function memberLinksCmd(engine: BrainEngine, sub: 'link' | 'unlink' | 'links', args: string[], json: boolean, id: string | undefined): Promise<void> {
  if (sub === 'links') {
    const member = flagValue(args, '--member');
    const links = await listMemberLinks(engine, member ? { member: assertAccessId(member) } : {});
    return print(json, { links }, () => links.length ? ['Links:', ...links.map(l => `  ${l.system}:${l.external_id} -> ${l.member_id}`)] : ['No links. Add one: gbrain access member link <id> --qm <canonical id>']);
  }
  const externalId = flagValue(args, '--qm');
  if (externalId === undefined) throw usageError(`access member ${sub} needs --qm <canonical id>.`, sub === 'link' ? 'gbrain access member link <id>|--email <addr> --qm <canonical id> [--dry-run]' : 'gbrain access member unlink --qm <canonical id> [--dry-run]');
  const dryRun = args.includes('--dry-run');
  const email = flagValue(args, '--email');
  if (email !== undefined && (sub === 'unlink' || id !== undefined)) {
    throw usageError(sub === 'link' ? 'access member link takes a member id or --email, not both.' : 'access member unlink takes only --qm.',
      sub === 'link' ? 'gbrain access member link <id> --qm <canonical id>, or gbrain access member link --email <addr> --qm <canonical id>' : 'gbrain access member unlink --qm <canonical id> [--dry-run]');
  }
  const r = sub === 'unlink' ? await unlinkMember(engine, 'qm', externalId, { dryRun })
    : email !== undefined ? await linkMemberByEmail(engine, email, 'qm', externalId, { dryRun }) : await linkMember(engine, id, 'qm', externalId, { dryRun });
  return print(json, r, () => [`${r.applied ? (sub === 'link' ? 'Linked' : 'Unlinked') : `Would ${sub}`} ${r.link.system}:${r.link.external_id} ${sub === 'link' ? '->' : 'from'} ${r.link.member_id}`,
    r.applied ? 'Takes effect on the next attested call.' : `Apply without --dry-run.`]);
}

/** GBRA-284: personal sources, bound to the member they belong to (database only, repo-less or not). */
async function memberSourceCmd(engine: BrainEngine, args: string[], json: boolean): Promise<void> {
  const [sub, member, source] = positionals(args);
  switch (sub) {
    case 'add': {
      if (!member || !source) throw usageError('access member source add needs a member and a source.', 'gbrain access member source add <id> <source> [--dry-run]');
      const r = await bindMemberSource(engine, member, source, { dryRun: args.includes('--dry-run') });
      return print(json, r, () => [
        `${r.applied ? 'Bound' : r.changed ? 'Would bind' : 'Already bound:'} ${r.binding.source_id} to ${r.binding.member_id}`,
        `  Owners of ${r.binding.source_id}: ${r.owners.join(', ')}`,
        `  Attested calls for anyone else, and every scope read, stop reading ${r.binding.source_id}; it is read only where a credential already grants it.`,
        ...(r.changed && !r.applied ? ['Apply without --dry-run.'] : r.applied ? ['Takes effect on the next attested call.'] : [])]);
    }
    case 'remove': {
      if (!member || !source) throw usageError('access member source remove needs a member and a source.', 'gbrain access member source remove <id> <source> [--yes]');
      const yes = args.includes('--yes');
      const r = await unbindMemberSource(engine, member, source, { apply: yes });
      return print(json, r, () => [
        `${yes ? 'Unbound' : 'Would unbind'} ${r.binding.source_id} from ${r.binding.member_id}`,
        r.still_personal
          ? `  ${r.binding.source_id} stays personal (owners: ${r.owners.join(', ')}).`
          : `  ${r.binding.source_id} stops being personal: every attested person whose credential grants it reads it again.`,
        ...(yes ? [] : [`Apply with: gbrain access member source remove ${r.binding.member_id} ${r.binding.source_id} --yes`])]);
    }
    case 'list': {
      const bindings = await listMemberSources(engine, member ? { member } : {});
      return print(json, { bindings }, () => bindings.length
        ? ['Personal sources:', ...bindings.map(b => `  ${b.source_id} -> ${b.member_id}`)]
        : ['No personal sources. Bind one: gbrain access member source add <id> <source>']);
    }
    default:
      throw usageError(`Unknown access member source subcommand: ${sub ?? '(none)'}.`, 'Use add, remove or list (gbrain access --help).');
  }
}

export function ownerLines(v: OwnerView): string[] {
  if (!v.owner) return v.inactive ? [`Owner: none in effect. access.owner_member names "${v.inactive.value}": ${v.inactive.reason}`, 'Fix it with gbrain access owner set <member> or gbrain access owner clear.']
    : ['Owner: none. Every remote caller reads under the ordinary policy (no visibility: private page without a grant).', 'Name one: gbrain access owner set <member>'];
  return [`Owner: ${v.owner}`,
    `  Credentials that read as the owner (${v.bound_credentials.length}): ${v.bound_credentials.map(c => `${c.kind} ${c.name}`).join(', ') || 'none'}`,
    v.reads_restricted
      ? '  Owner reads member-restricted pages: on (access.owner_reads_restricted). Its credentials read pages that readers lists and folder or page rules keep to other members, and their derived pages and facts; never another member\'s own member page. Turn off: gbrain access owner reads-restricted off'
      : '  Owner reads member-restricted pages: off. It reads a page that names readers or sits under a rule only when listed. Turn on: gbrain access owner reads-restricted on',
    `  Bind one: gbrain auth rescope --token <name> --member ${v.owner}. Stdio: ${stdioBindRoute(v.owner).text}`];
}

async function ownerCmd(engine: BrainEngine, sub: string | undefined, args: string[], json: boolean): Promise<void> {
  switch (sub) {
    case undefined:
    case '--json':
    case 'show': {
      const v = await ownerView(engine);
      return print(json, v, () => ownerLines(v));
    }
    case 'set': {
      const v = await setOwner(engine, positionals(args)[0]);
      return print(json, v, () => ownerLines(v));
    }
    case 'clear': {
      const v = await clearOwner(engine);
      return print(json, v, () => ownerLines(v));
    }
    case 'reads-restricted': {
      const value = positionals(args)[0];
      if (value !== 'on' && value !== 'off') throw usageError('access owner reads-restricted needs on or off.', 'gbrain access owner reads-restricted on|off');
      const v = await setOwnerReadsRestricted(engine, value === 'on', { remote: false });
      return print(json, v, () => ownerLines(v));
    }
    default:
      throw usageError(`Unknown access owner subcommand: ${sub}.`, 'Use gbrain access owner, gbrain access owner set <member>, gbrain access owner clear or gbrain access owner reads-restricted on|off.');
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
      case 'owner': return await ownerCmd(engine, rest[0], rest.slice(1), json);
      case 'members-read-lineage': {
        const value = positionals(rest)[0];
        if (value !== undefined && value !== 'on' && value !== 'off') throw usageError('access members-read-lineage takes on or off.', 'gbrain access members-read-lineage [on|off]');
        const v = value === undefined ? { members_read_lineage: await membersReadLineageOn(engine) } : await setMembersReadLineage(engine, value === 'on', { remote: false });
        return print(json, v, () => [v.members_read_lineage
          ? 'Members read lineage: on (access.members_read_lineage). A member\'s credential speaking for itself reads derived pages and facts whose origins it reads, so summaries of a page reach everyone that page lists. Turn off: gbrain access members-read-lineage off'
          : 'Members read lineage: off. Derived pages and facts of a page that names readers or sits under a rule are hidden from every member but the owner. Turn on: gbrain access members-read-lineage on']);
      }
      case 'serves': return await runAccessServes(engine, positionals(rest)[0], rest, json, flagValue);
      case 'group': return await groupCmd(engine, rest[0], rest.slice(1), json);
      case 'who-can-read': {
        const slug = positionals(rest)[0];
        if (!slug) throw usageError('who-can-read needs a page slug.', 'gbrain access who-can-read <slug> [--source <id>]');
        const pages = await whoCanRead(engine, slug, flagValue(rest, '--source'));
        return print(json, { pages }, () => pages.flatMap(p => [
          `${p.source_id}:${p.slug}`,
          `  Readers: ${p.readers === null ? 'no readable_by' : p.readers.join(', ')}${p.private ? '  (visibility: private)' : ''}`,
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
          `  Member: ${r.member ? `${r.member.id} (${r.member.status})` : 'none'}${r.member?.groups.length ? `  groups: ${r.member.groups.join(', ')}` : ''}${r.labelled_only ? '  labelled-only' : ''}`,
          `  May act for: ${r.may_act_for?.join(', ') ?? 'none'}`,
          ...(r.audience ? [`  Audience: ${r.audience.map(a => `${a.principal}${a.covered_by_may_act_for ? '' : ' (not in may_act_for)'}`).join(', ')}`] : []),
          `  ${r.explanation}`]);
      }
      default:
        throw usageError(`Unknown access subcommand: ${cmd}.`, 'Use member, owner, members-read-lineage, serves, group, rule, apply, resume, who-can-read or check (gbrain access --help).', { code: 'unknown_command' });
    }
  } catch (e) {
    exitCliError(e, 'access');
  }
}

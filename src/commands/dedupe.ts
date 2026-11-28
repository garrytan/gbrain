/**
 * gbrain dedupe: duplicate person and company pages (plan autoplan-20261117192252).
 *
 * --preview lists groups that are likely one entity, with the evidence and a class; read-only, no API key. `--json` prints
 * the versioned contract gbrain-evals scores (core/entities/duplicates.ts, research/entity-resolution/finder-contract.md).
 * A group the owner decided is left out: a rejected pair never shows again, and a confirmed group is listed by
 * gbrain entity-identity-list instead.
 *
 * confirm and reject record the owner's decisions (core/entities/identity-decisions.ts): in git first on a brain with a
 * repository, in the database otherwise. confirm links cross-source groups as one identity, which rank_entities and
 * enrichment then count once; a bulk confirm covers only clean company groups and is bound to the hash it printed; a person
 * group that shares an account or registry id, and a group whose only shared keys are contact or handle keys, is confirmed
 * alone. reject records "different people or companies" (with each member's fingerprint, so a rename or a move to another
 * source keeps the pair apart) and undoes a confirm or a link the company sweep made. reconcile also runs that sweep over
 * every company (core/entities/company-auto-link.ts); sync runs it over the companies it changed. decide records the
 * owner's choice for each Google Contacts contact that waits (dedupe-decide.ts) and undo removes
 * decisions by id. auto links the person pairs of the classes that passed their labelled sample
 * (core/entities/evidence/auto.ts), as decisions undo removes, and collapses same-source C7 pairs by pointer and alias
 * (core/entities/evidence/collapse.ts), which undo and reject also take back. Nothing here renames or deletes a page.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { DUPLICATE_KINDS, entityPagesOf, findTypedDuplicateGroups, type DuplicateEvidence, type DuplicateGroup, type DuplicateKind, type DuplicateResult, type EntityKind, type EntityPage } from '../core/entities/duplicates.ts';
import { autoLinkCompanies } from '../core/entities/company-auto-link.ts';
import { canonicalOf, decidedSets, decisionId, fillDecisionEvidence, forgetDecisions, identityHome, reconcileDecisions, recordDecisions, unpublishableMembers, type DecisionInput, type RecordResult } from '../core/entities/identity-decisions.ts';
import type { IdentityDecisionsRead, IdentityMemberRef } from '../core/engine-sql/identity-decisions.ts';
import { identityIdsForPages, isEntityId, listEntityIdentities, validateEntityId } from '../core/entity-identity.ts';
import { opError, OperationError } from '../core/ops/contract.ts';
import { parseSourceConfig } from '../core/sources-load.ts';
import { APPLE_CONTACTS_LINK_ORIGIN, unlinkContact } from '../core/apple-contacts/identity-match.ts';
import { GOOGLE_CONTACTS_LINK_ORIGIN, IDENTITY_LINKS_CONFIG_KEY, identityLinksOn, linkGoogleContacts, unlinkGoogleContacts } from '../core/google/contact-identity.ts';
import { decideContacts } from './dedupe-decide.ts';
import { classifyPairs, samplePairs, seededPick, type ClassesReport, type ClassifyOptions } from '../core/entities/evidence/classes.ts';
import { AUTO_CLASSES, AUTO_DECIDED_BY, CORRECTS_PREFIX, applyAutoLinks, autoLinksSince, autoSwitchKey, collapsesSince, correctionsSince, parseAutoClass, planAutoLinks, switchAutoClassOff } from '../core/entities/evidence/auto.ts';
import { loadConfig } from '../core/config.ts';
import { listCollapses, undoCollapse, type CollapseOutcome } from '../core/entities/evidence/collapse.ts';
import { PAIR_CLASSES, parsePairClass } from '../core/entities/evidence/combine.ts';
import { EXA_SWITCH_KEY, exaSettings } from '../core/entities/evidence/exa.ts';

const CONTACT_LINK_ORIGINS: string[] = [APPLE_CONTACTS_LINK_ORIGIN, GOOGLE_CONTACTS_LINK_ORIGIN];

const HELP = `Usage: gbrain dedupe --preview [--json] [--kind cross-source|in-source|conflict|thin] [--source <id>]
       gbrain dedupe confirm [--json]
       gbrain dedupe confirm --clean [--expect <hash>] [--json]
       gbrain dedupe confirm <group-id>... [--join <entity_id>] [--json]
       gbrain dedupe reject <group-id>... [--json]
       gbrain dedupe reconcile [--json]
       gbrain dedupe link-contacts --source <id> [--apply | --unlink] [--json]
       gbrain dedupe decide --source <id> --file <choices.json> [--dry-run] [--json]
       gbrain dedupe undo <decision-id | collapse-id>... [--json]
       gbrain dedupe classes [--source <id>] [--exa [--dry-run]] [--json]
       gbrain dedupe sample --class <class> [--n 100] [--seed <n>] [--source <id>] [--exa [--dry-run]] [--json]
       gbrain dedupe sample --class <class> --since <7d> [--n 20] [--seed <n>] [--json]
       gbrain dedupe auto [--apply] [--source <id>] [--json]
       gbrain dedupe auto --off <class> | --on <class> [--json]

List groups of person and company pages that are likely the same person or company, with the evidence
(shared keys by type, never their values) and a class: clean, likely, weak, thin or conflict.
clean: the pages share an account or registry id (LinkedIn, GitHub or a declared id) and exactly the same name,
and no two of them list different domains; it is a strong hint for review, not proof they are one person or company.
The preview is read-only; groups you confirmed or rejected are not listed again.

  --preview         list the groups (the default)
  --json            print JSON (for --preview, the versioned contract)
  --kind <kind>     only groups of this kind (hyphens or underscores)
                    a cross-source pair whose ids disagree is listed with class conflict but keeps kind
                    cross_source, so filter by class (class == conflict in --json), not --kind, to see every conflict
  --source <id>     only groups with a member in this source

confirm             the confirm list: cross-source groups you can confirm, each with a hint line; changes nothing
confirm <id>...     record that each group is one person or company; rankings and enrichment count it once
                    a person group that shares an id, and a group whose only shared keys are email, phone,
                    X handle or domain, is confirmed on its own
  --join <entity>   a page of the group is already in this identity group: add the other pages to it
confirm --clean     list the clean company groups a bulk confirm covers and print their hash; changes nothing
  --expect <hash>   confirm exactly those groups; refuses (preview_changed) if the list changed since
reject <id>...      record that the pages are different people or companies: the pair is never proposed again, even
                    after a page is renamed or moved to another source, and a confirmed or automatic group is
                    unlinked (<id> may be its identity id, or a collapse id: the collapse is undone too); two pages
                    in one source also get distinct_from
reconcile           write decisions the database holds alone into git, re-read the committed decisions, link
                    pages that arrived since and link every company group that qualifies; run it after doctor
                    reports a drift
link-contacts       count how the contact pages of a Google Contacts source would link; changes nothing
  --source <id>     the Google Contacts source (required)
  --apply           link each contact page to the one person page with exactly the same email or phone, and keep
                    the contacts each sync changes linked (sets google_contacts.identity_links on)
  --unlink          remove every link the source made and stop linking (sets google_contacts.identity_links off)
                    a contact whose email or phone matches two or more people, or one person whose page has another
                    name, stays unlinked and waits for you in gbrain sync status; nothing matches by name alone; gbrain dedupe reject on a contact and person pair
                    removes its link for good; --json without --apply also lists each waiting contact with its
                    candidates and what matched (email or phone, never the value)
decide              record your choice for each waiting contact of a Google Contacts source, from a JSON file of
                    lines {"contact_slug": "...", "action": "...", "candidate": "source:slug"}:
                    link (the one candidate named), new (make a person page named after the contact and link it),
                    reject (a different person from each candidate listed, or from every candidate when none is),
                    ignore (not a person: never linked or proposed again), skip (nothing); each line prints the
                    command that undoes it, and a line that cannot apply is set aside while the rest are recorded
  --source <id>     the Google Contacts source (required)
  --file <path>     the choices file (required)
  --dry-run         print what each line would do; changes nothing
undo <id>...        remove the decisions with these ids (gbrain dedupe decide prints them): a link is unlinked, and a
                    rejected or ignored contact waits for you again; a collapse id takes the collapse back (the page
                    loses its merged_into and the kept page the aliases the collapse added)
classes             count the pairs of person pages by class and by what would happen to them, from the evidence:
                    shared ids, emails and phones (C1 to C7), your email pages (E1, E3, E4) and chat pages (M1 to M3);
                    changes nothing
  --exa             also search the web (Exa) for pairs that would otherwise wait: needs EXA_API_KEY and
                    ${EXA_SWITCH_KEY} on; sends only a name plus one work clue (company, job title or company-site
                    label), never for a private, family or minor page; cached, and capped per run and in total
  --dry-run         with --exa: count the queries a run would send and their cost; sends nothing
sample              a seeded random sample of one class's pairs with their evidence, for labelling; changes nothing
  --class <class>   ${PAIR_CLASSES.join(', ')}
  --n <n>           how many pairs (default 100); a smaller class is sampled whole
  --seed <n>        the sample's seed (default 1); the same seed and brain give the same sample
  --since <Nd|Nh>   sample the automatic links of one class recorded in that time instead (the weekly check:
                    --since 7d --n 20)
auto                list the pairs of person pages joined automatically, in the classes that passed a labelled
                    sample (${AUTO_CLASSES.join(', ')}): C2, an email or phone only those two person pages hold, in two
                    sources, is linked; C7, two pages in one source with the same name and a shared id, is collapsed
                    (the newer page gets merged_into the older one, which gains its name as an alias; only
                    frontmatter changes, in one commit on a source with a repository); a pair with a family, minor or
                    non-person page, names that disagree unless one is a handle, a contradiction, a page in two such
                    pairs (in any source), or a page already in an identity group is set aside; changes nothing
  --apply           do it: one "same" decision per C2 pair (decided_by dedupe:auto:<class>) and one write per
                    collapse, each printed with the gbrain dedupe undo command that takes it back (a later --apply
                    can do it again) and the gbrain dedupe reject command that keeps a wrong pair apart for good
  --off <class>     stop the class and take back everything it did
  --on <class>      do the class again from the next --apply

Companies link automatically: each sync links the cross-source company groups its changed pages belong to when
they are clean, share a LinkedIn company page or their own site's domain, and name no different countries
(identity rows established_by dedupe:auto, in the database only). gbrain dedupe reject undoes one.
People are linked automatically only by gbrain dedupe auto --apply, and contact pages by exactly the same email or
phone (Apple Contacts, and Google Contacts after link-contacts --apply).

Decisions are kept in .gbrain/identity/ in the brain's repository (committed through gbrain git commit-push),
or in the database on a brain with no repository. Nothing renames or deletes a page; only auto collapses one.
`;

/** Frontmatter fields the confirm list compares between members, beyond identity keys (the Captain's ruling on the bench run). */
const DIFF_FIELDS = ['company', 'employer', 'organization', 'job_title', 'role', 'position', 'city', 'location', 'born', 'birth_year', 'birthday', 'birthdate'];
const CONFIRMABLE = new Set(['clean', 'likely', 'weak']);
const DECIDED_BY = 'owner';

function evidenceText(e: DuplicateEvidence): string {
  const others = e.other_pages_same_name === undefined ? '' : `also on ${e.other_pages_same_name} same-name and ${e.other_pages_other_name} other-name page(s)`;
  const veto = e.veto ? 'veto (if they are one person, correct the wrong id on one page)' : '';
  return [e.rule, e.key, e.role_address ? 'role address' : '', others, veto].filter(Boolean).join(' ');
}

const memberText = (m: IdentityMemberRef) => `${m.source_id}:${m.slug}`;
const contactOnly = (g: DuplicateGroup) => g.evidence.some(e => e.rule === 'contact_key_only');
const sharesId = (g: DuplicateGroup) => g.evidence.some(e => e.matcher === 'shared_key' && e.key_class === 'exclusive');

export interface Scan { result: DuplicateResult; read: IdentityDecisionsRead; kindOf: Map<string, EntityKind>; pages: Map<string, EntityPage> }

/** Confirmed on its own, after reading its hint line: contact-only groups, and person groups that share an id (gate_rev 7). */
const confirmAlone = (s: Scan, g: DuplicateGroup) => contactOnly(g) || (s.kindOf.get(g.id) === 'person' && sharesId(g));
/** A group holding two pages of one source: those are collapsed (their in_source group), never linked by a confirm. */
const sharesSource = (g: DuplicateGroup) => new Set(g.members.map(m => m.source_id)).size < g.members.length;
const otherNamePages = (g: DuplicateGroup) => g.evidence.reduce((n, e) => n + (e.other_pages_other_name ?? 0), 0);

async function readDecisions(engine: BrainEngine): Promise<IdentityDecisionsRead> {
  return engine.listIdentityDecisions();
}

/** The preview: every current group with confirmed and rejected ones left out. Read-only; learning_derive and learned read it too. */
export async function scan(engine: BrainEngine, opts: { kind?: DuplicateKind; sourceId?: string } = {}): Promise<Scan> {
  const read = await readDecisions(engine);
  const { result, kindOf, pages } = await findTypedDuplicateGroups(engine, { ...opts, decided: decidedSets(read) });
  return { result, read, kindOf, pages };
}

/** Whether `gbrain dedupe confirm <id>` takes this group; every current group takes reject. */
export const confirmable = (g: DuplicateGroup) => g.kind === 'cross_source' && CONFIRMABLE.has(g.class) && !sharesSource(g);

export async function runDedupe(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  const sub = args[0];
  if (sub === 'confirm') return runConfirm(engine, args.slice(1));
  if (sub === 'reject') return runReject(engine, args.slice(1));
  if (sub === 'reconcile') return runReconcile(engine, args.slice(1));
  if (sub === 'link-contacts') return runLinkContacts(engine, args.slice(1));
  if (sub === 'decide') return runDecide(engine, args.slice(1));
  if (sub === 'undo') return runUndo(engine, args.slice(1));
  if (sub === 'classes' || sub === 'sample') return runClasses(engine, sub, args.slice(1));
  if (sub === 'auto') return runAuto(engine, args.slice(1));
  let json = false;
  let kind: DuplicateKind | undefined;
  let sourceId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--preview') continue;
    if (a === '--json') { json = true; continue; }
    if (a === '--kind' || a === '--source') {
      const v = args[++i];
      if (!v) { console.error(`gbrain dedupe: ${a} needs a value.\n\n${HELP}`); setCliExitVerdict(2); return; }
      if (a === '--source') { sourceId = v; continue; }
      const k = v.replace(/-/g, '_').replace(/^conflicts$/, 'conflict') as DuplicateKind;
      if (!DUPLICATE_KINDS.includes(k)) { console.error(`gbrain dedupe: unknown --kind ${v}; use cross-source, in-source, conflict or thin.`); setCliExitVerdict(2); return; }
      kind = k;
      continue;
    }
    console.error(`gbrain dedupe: unknown argument ${a}.\n\n${HELP}`);
    setCliExitVerdict(2);
    return;
  }
  const { result } = await scan(engine, { kind, sourceId });
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  const { by_kind, by_class } = result.counts;
  console.log(`${result.groups.length} duplicate group(s): ${DUPLICATE_KINDS.map(k => `${k} ${by_kind[k]}`).join(', ')} (clean ${by_class.clean}). Nothing was changed.`);
  for (const g of result.groups) {
    console.log(`\n${g.id}  ${g.kind}  ${g.class}`);
    console.log(`  members:  ${g.members.map(memberText).join(', ')}`);
    console.log(`  evidence: ${g.evidence.map(evidenceText).join('; ')}`);
  }
  if (result.counts.crowded_key_values) console.log(`\n${result.counts.crowded_key_values} key value(s) carried by more than five pages were not used as keys.`);
}

interface Flags { json: boolean; ids: string[]; clean: boolean; expect?: string; join?: string }

function parseFlags(cmd: string, args: string[], allowed: Set<string>): Flags | null {
  const f: Flags = { json: false, ids: [], clean: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') { f.json = true; continue; }
    if (a === '--clean' && allowed.has(a)) { f.clean = true; continue; }
    if ((a === '--expect' || a === '--join') && allowed.has(a)) {
      const v = args[++i];
      if (!v) { console.error(`gbrain dedupe ${cmd}: ${a} needs a value.\n\n${HELP}`); setCliExitVerdict(2); return null; }
      if (a === '--expect') f.expect = v; else f.join = validateEntityId(v);
      continue;
    }
    if (a.startsWith('-')) { console.error(`gbrain dedupe ${cmd}: unknown argument ${a}.\n\n${HELP}`); setCliExitVerdict(2); return null; }
    f.ids.push(a);
  }
  return f;
}

/**
 * Groups a bulk confirm covers: clean cross-source company groups that are not contact-only, whose pages are in no
 * identity group and, on a brain whose decisions go to git, whose pages may all be named in its repository. Person
 * groups are never in it (gate_rev 7): each is confirmed on its own.
 */
async function bulkGroups(engine: BrainEngine, s: Scan, groups: DuplicateGroup[], inIdentity: Map<string, string>): Promise<DuplicateGroup[]> {
  const candidates = groups.filter(g => g.kind === 'cross_source' && g.class === 'clean' && s.kindOf.get(g.id) === 'company' && !confirmAlone(s, g)
    && !g.members.some(m => inIdentity.has(memberText(m))));
  const home = await identityHome(engine);
  if (!home) return candidates;
  const blocked = await unpublishableMembers(engine, home.sourceId, candidates);
  return candidates.filter((_, i) => blocked[i] === null);
}

export function previewHash(groups: DuplicateGroup[]): string {
  const lines = groups.map(g => `${g.id}\t${g.members.map(memberText).join('\t')}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** The identity group each member sits in; a group the company sweep made is left out, since a confirm takes it over. */
async function identitiesOf(engine: BrainEngine, groups: DuplicateGroup[]): Promise<Map<string, string>> {
  const ids = await identityIdsForPages(engine, groups.flatMap(g => g.members.map(m => ({ sourceId: m.source_id, slug: m.slug }))));
  return new Map([...ids].filter(([, id]) => !id.startsWith('dedupe-auto/')));
}

function fieldValue(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return (typeof v === 'string' ? v : JSON.stringify(v)).trim().toLowerCase() || null;
}

async function differingFields(engine: BrainEngine, g: DuplicateGroup): Promise<Array<{ field: string; values: Array<string | null> }>> {
  const pages = await Promise.all(g.members.map(m => engine.getPage(m.slug, { sourceId: m.source_id })));
  const out: Array<{ field: string; values: Array<string | null> }> = [];
  for (const field of DIFF_FIELDS) {
    const raw = pages.map(p => (p?.frontmatter as Record<string, unknown> | undefined)?.[field]);
    const values = raw.map(fieldValue);
    if (new Set(values.filter((v): v is string => v !== null)).size > 1) out.push({ field, values: raw.map(v => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v))) });
  }
  return out;
}

function hintLine(g: DuplicateGroup): string {
  const shared = g.evidence.filter(e => e.matcher === 'shared_key')
    .map(e => e.key_class === 'exclusive' ? `${e.key} (account or registry id)`
      : `${e.key}${e.role_address ? ' (role address)' : ''}, also on ${e.other_pages_same_name ?? 0} same-name and ${e.other_pages_other_name ?? 0} other-name page(s)`);
  const differs = g.evidence.filter(e => e.rule === 'key_differs').map(e => e.key);
  return `shared ${shared.join('; ') || 'none'}; differing keys ${differs.join(', ') || 'none'}`;
}

async function confirmList(engine: BrainEngine, s: Scan, json: boolean): Promise<void> {
  const entries = s.result.groups.filter(g => g.kind === 'cross_source' && CONFIRMABLE.has(g.class) && !sharesSource(g));
  const inIdentity = await identitiesOf(engine, entries);
  const bulk = new Set((await bulkGroups(engine, s, entries, inIdentity)).map(g => g.id));
  const rank = (g: DuplicateGroup) => (bulk.has(g.id) ? 0 : !contactOnly(g) ? (g.class === 'weak' ? 2 : 1) : otherNamePages(g) > 0 ? 4 : 3);
  entries.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
  const rows = [];
  for (const g of entries) {
    const fields = await differingFields(engine, g);
    const identities = g.members.map(m => inIdentity.get(memberText(m))).filter((x): x is string => !!x);
    rows.push({ g, fields, identities });
  }
  if (json) {
    console.log(JSON.stringify({
      schema_version: 1, clean_preview_hash: previewHash(entries.filter(g => bulk.has(g.id))),
      entries: rows.map(({ g, fields, identities }) => ({
        id: g.id, class: g.class, members: g.members, bulk: bulk.has(g.id), contact_key_only: contactOnly(g), confirm_alone: confirmAlone(s, g),
        hints: g.evidence.filter(e => e.matcher === 'shared_key' && e.key_class !== 'exclusive')
          .map(e => ({ key: e.key, role_address: e.role_address ?? false, other_pages_same_name: e.other_pages_same_name ?? 0, other_pages_other_name: e.other_pages_other_name ?? 0 })),
        differing_keys: g.evidence.filter(e => e.rule === 'key_differs').map(e => e.key),
        differing_fields: fields.map(f => f.field),
        ...(identities.length ? { in_identity: [...new Set(identities)] } : {}),
      })),
    }, null, 2));
    return;
  }
  console.log(`${rows.length} group(s) you can confirm (${bulk.size} clean company group(s), covered by gbrain dedupe confirm --clean; person groups are confirmed one at a time). Nothing was changed.`);
  for (const { g, fields, identities } of rows) {
    const how = bulk.has(g.id) ? 'clean' : contactOnly(g) ? 'contact keys only: confirm on its own' : confirmAlone(s, g) ? `${g.class} person, shares an id: confirm on its own` : g.class;
    console.log(`\n${g.id}  ${how}`);
    console.log(`  members:  ${g.members.map(memberText).join(', ')}`);
    if (confirmAlone(s, g)) console.log(`  hint:     ${hintLine(g)}`);
    for (const f of fields) console.log(`  differs:  ${f.field}: ${f.values.map(v => v ?? '(none)').join(' | ')}`);
    if (identities.length) console.log(`  already:  in identity ${[...new Set(identities)].join(', ')} (confirm with --join <entity_id>)`);
  }
}

function notConfirmable(g: DuplicateGroup, reason: string, why: string): OperationError {
  return opError('dedupe_group_not_confirmable', `gbrain dedupe confirm: ${g.id} (${g.kind}, ${g.class}) ${why}; nothing was written.`,
    'Run gbrain dedupe confirm to see the groups you can confirm and how.', { reason,
      fix: { argv: ['gbrain', 'dedupe', 'confirm'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Prints the confirm list with a hint line per entry; changes nothing.' } });
}

function unknownGroup(id: string): OperationError {
  return opError('dedupe_group_unknown', `gbrain dedupe: no current group or recorded decision has the id ${id}; nothing was written.`,
    'Read the current groups with gbrain dedupe --preview and use an id it prints.',
    { fix: { argv: ['gbrain', 'dedupe', '--preview'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the current groups and their ids; changes nothing.' } });
}

function storedText(r: RecordResult): string {
  if (r.store === 'database') return 'Recorded in the database (this brain has no repository).';
  const commit = r.receipt?.commit ? `commit ${r.receipt.commit.slice(0, 12)}` : 'git';
  return `Recorded in ${r.home!.sourceId}:.gbrain/identity/ (${commit}, ${r.receipt?.outcome}).${r.receipt?.note ? ' ' + r.receipt.note : ''}`;
}

async function runConfirm(engine: BrainEngine, args: string[]): Promise<void> {
  const f = parseFlags('confirm', args, new Set(['--clean', '--expect', '--join']));
  if (!f) return;
  if (f.clean && f.ids.length) { console.error('gbrain dedupe confirm: --clean takes no group ids.'); setCliExitVerdict(2); return; }
  const s = await scan(engine);
  const { result, read } = s;
  if (!f.clean && !f.ids.length) return confirmList(engine, s, f.json);
  const home = await identityHome(engine);
  let chosen: DuplicateGroup[];
  let entityFor = (g: DuplicateGroup) => g.id;
  if (f.clean) {
    const eligible = result.groups.filter(g => g.kind === 'cross_source');
    chosen = await bulkGroups(engine, s, eligible, await identitiesOf(engine, eligible));
    const hash = previewHash(chosen);
    if (!f.expect) {
      if (f.json) { console.log(JSON.stringify({ preview_hash: hash, groups: chosen.map(g => ({ id: g.id, members: g.members })) }, null, 2)); return; }
      console.log(`${chosen.length} clean company group(s) a bulk confirm covers (hash ${hash}). Person groups are confirmed one at a time. Nothing was changed.`);
      for (const g of chosen) console.log(`  ${g.id}  ${g.members.map(memberText).join(', ')}`);
      if (chosen.length) console.log(`\nConfirm exactly these with: gbrain dedupe confirm --clean --expect ${hash}`);
      return;
    }
    if (f.expect !== hash) {
      throw opError('preview_changed', `gbrain dedupe confirm --clean: the clean groups changed since the preview you read (hash ${f.expect}, now ${hash}); nothing was written.`,
        'Read the list again with gbrain dedupe confirm --clean and confirm with the hash it prints.',
        { fix: { argv: ['gbrain', 'dedupe', 'confirm', '--clean'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Prints the current clean groups and their hash; changes nothing.' } });
    }
  } else {
    chosen = [];
    for (const id of [...new Set(f.ids)]) {
      const g = result.groups.find(x => x.id === id);
      if (!g) {
        if (read.decisions.some(d => d.verdict === 'same' && d.group_id === id)) { console.log(`${id} is already confirmed.`); continue; }
        throw unknownGroup(id);
      }
      if (g.class === 'conflict') throw notConfirmable(g, 'conflict', 'is a conflict: an account or registry id disagrees, so it is never confirmed');
      if (g.kind === 'thin') throw notConfirmable(g, 'thin', 'is a thin page beside a fuller page; it is collapsed, not confirmed');
      if (g.kind !== 'cross_source') throw notConfirmable(g, 'in_source', 'has its pages in one source; same-source duplicates are collapsed, not linked');
      if (sharesSource(g)) throw notConfirmable(g, 'same_source_members', 'holds two pages of one source; collapse them if they are one page, or record them as different with gbrain dedupe reject <their in_source group id> if they are not, then confirm the group the next preview shows');
      if (!CONFIRMABLE.has(g.class)) throw notConfirmable(g, 'conflict', 'is not a confirmable class');
      if (contactOnly(g) && f.ids.length > 1) throw notConfirmable(g, 'contact_key_only_batch', 'shares only contact or handle keys, so it is confirmed on its own, after reading its hint line');
      if (confirmAlone(s, g) && f.ids.length > 1) throw notConfirmable(g, 'person_id_batch', 'is a person group that shares an account or registry id, so it is confirmed on its own, after reading its hint line');
      chosen.push(g);
    }
    const inIdentity = await identitiesOf(engine, chosen);
    for (const g of chosen) {
      const held = [...new Set(g.members.map(m => inIdentity.get(memberText(m))).filter((x): x is string => !!x))];
      if (f.join && !held.includes(f.join)) throw unknownGroup(f.join);
      if (held.length && !(held.length === 1 && held[0] === f.join)) {
        const member = g.members.find(m => inIdentity.has(memberText(m)))!;
        throw opError('identity_member_in_other_group',
          `gbrain dedupe confirm: ${memberText(member)} of ${g.id} is already in identity group ${held.join(', ')}; nothing was written.`,
          held.length === 1 ? `Add the other pages to that group with gbrain dedupe confirm ${g.id} --join ${held[0]}, or remove the page from it first.`
            : 'The pages sit in several identity groups; remove them from the groups you do not want first.',
          { fix: { argv: ['gbrain', 'entity-identity-list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists identity groups and their members; changes nothing.' } });
      }
    }
    if (f.join && chosen.length) {
      const joined = [...(await listEntityIdentities(engine, { entityId: f.join })).map(m => memberText(m)), ...chosen.flatMap(g => g.members.map(memberText))];
      const rejected = read.decisions.find(d => d.verdict === 'different' && d.members.filter(m => joined.includes(memberText(m))).length > 1);
      if (rejected) {
        const pair = rejected.members.filter(m => joined.includes(memberText(m))).slice(0, 2).map(memberText);
        throw notConfirmable(chosen[0]!, 'rejected_pair', `with --join ${f.join} would put ${pair.join(' and ')} in one identity, but they are recorded as different people or companies (decision ${rejected.decision_id})`);
      }
      entityFor = () => f.join!;
    }
  }
  if (!chosen.length) { if (f.json) console.log(JSON.stringify({ confirmed: [] })); else console.log('Nothing to confirm.'); return; }
  const decisions: DecisionInput[] = [];
  for (const g of chosen) {
    decisions.push({ verdict: 'same', members: g.members, group_id: g.id, entity_id: entityFor(g), canonical: await canonicalOf(engine, g.members, home?.sourceId ?? null), decided_by: DECIDED_BY });
  }
  const r = await recordDecisions(engine, decisions, `dedupe: confirm ${decisions.length} duplicate group(s) as one person or company`);
  const pending = (await engine.listIdentityDecisions()).pending;
  if (f.json) {
    console.log(JSON.stringify({ confirmed: decisions.map(d => ({ group_id: d.group_id, entity_id: d.entity_id, canonical: d.canonical, members: d.members })), store: r.store,
      ...(r.receipt ? { commit: r.receipt.commit, outcome: r.receipt.outcome, ...(r.receipt.note ? { note: r.receipt.note } : {}) } : {}), pending }, null, 2));
    return;
  }
  for (const d of decisions) console.log(`Confirmed ${d.group_id} as one: ${d.members.map(memberText).join(', ')} (identity ${d.entity_id}, canonical ${memberText(d.canonical!)}).`);
  console.log(storedText(r));
  if (pending.length) console.log(`${pending.length} member page(s) are not linked yet (page missing or in another group); gbrain doctor lists them.`);
}

async function runReject(engine: BrainEngine, args: string[]): Promise<void> {
  const f = parseFlags('reject', args, new Set());
  if (!f) return;
  if (!f.ids.length) { console.error(`gbrain dedupe reject: name at least one group id.\n\n${HELP}`); setCliExitVerdict(2); return; }
  const { result, read } = await scan(engine);
  const same = read.decisions.filter(d => d.verdict === 'same');
  const decisions: DecisionInput[] = [];
  const collapsed = new Map((await listCollapses(engine)).map(c => [c.collapse, c]));
  const uncollapse = [...new Set(f.ids)].filter(id => collapsed.has(id)).map(id => collapsed.get(id)!);
  for (const c of uncollapse) {
    decisions.push({ verdict: 'different', members: [{ source_id: c.source_id, slug: c.retired }, { source_id: c.source_id, slug: c.canonical }], group_id: c.collapse,
      entity_id: null, canonical: null, decided_by: `${CORRECTS_PREFIX}${AUTO_DECIDED_BY}${c.class}` });
  }
  for (const id of [...new Set(f.ids)].filter(x => !collapsed.has(x))) {
    const confirmed = same.filter(d => d.entity_id === id);
    const linked = confirmed.length || !isEntityId(id) ? [] : await listEntityIdentities(engine, { entityId: id });
    const contacts = linked.filter(m => !m.canonical && CONTACT_LINK_ORIGINS.includes(m.established_by));
    const person = linked.find(m => m.canonical) ?? linked.find(m => !contacts.includes(m));
    const auto = (linked.some(m => m.established_by === 'dedupe:auto') ? linked.filter(m => m.established_by === 'dedupe:auto')
      : contacts.length && person ? [person, ...contacts] : []).map(m => ({ source_id: m.source_id, slug: m.slug }));
    const members = confirmed.length ? confirmed.map(d => ({ members: d.members, group_id: d.group_id ?? id,
      decided_by: d.decided_by.startsWith(AUTO_DECIDED_BY) ? `${CORRECTS_PREFIX}${d.decided_by}` : DECIDED_BY }))
      : [result.groups.find(g => g.id === id)?.members ?? read.decisions.find(d => d.group_id === id)?.members ?? (auto.length > 1 ? auto : undefined)]
        .filter((m): m is IdentityMemberRef[] => !!m).map(m => ({ members: m, group_id: id, decided_by: DECIDED_BY }));
    if (!members.length) throw unknownGroup(id);
    for (const m of members) decisions.push({ verdict: 'different', members: m.members, group_id: m.group_id, entity_id: null, canonical: null, decided_by: m.decided_by });
  }
  const pages = await entityPagesOf(engine, decisions.flatMap(d => d.members));
  for (const d of decisions) d.evidence = d.members.map(m => pages.get(`${m.source_id}\t${m.slug}`)?.fingerprint).filter((x): x is string => !!x);
  for (const d of decisions) if (uncollapse.some(c => c.collapse === d.group_id) && (d.evidence?.length ?? 0) < 2) d.evidence = [];
  const undone = new Set(decisions.map(d => decisionId(d.members)));
  for (const d of decisions) {
    const keys = new Set(d.members.map(memberText));
    const other = same.find(s => !undone.has(s.decision_id) && s.members.some(m => keys.has(memberText(m))));
    if (!other) continue;
    const member = other.members.find(m => keys.has(memberText(m)))!;
    const both = [...new Set([...f.ids, other.entity_id!])];
    throw opError('identity_member_in_other_group',
      `gbrain dedupe reject: ${memberText(member)} of ${d.group_id} is in the group you confirmed as one person (${other.entity_id}); nothing was written.`,
      `To undo that confirm too, reject them together: gbrain dedupe reject ${both.join(' ')}.`,
      { fix: { ask_user: true, argv: ['gbrain', 'dedupe', 'reject', ...both], consent: [], actor: 'user', requires_exclusive: false,
        why: 'Records the groups as different people or companies in one command and removes the confirmed links.',
        user_message: `${memberText(member)} is in the group you confirmed as one person (${other.entity_id}). Should I undo that confirm as well?`,
        verify: { argv: ['gbrain', 'doctor', '--only', 'entity_duplicates', '--json'] } } });
  }
  const r = await recordDecisions(engine, decisions, `dedupe: record ${decisions.length} group(s) as different people or companies`);
  const uncollapsed: CollapseOutcome[] = [];
  for (const c of uncollapse) uncollapsed.push(await undoCollapse(engine, c, loadConfig()));
  if (uncollapse.length) await fillDecisionEvidence(engine);
  await unlinkRejectedContacts(engine, decisions);
  const sameSource = await markDistinct(engine, decisions);
  if (f.json) {
    console.log(JSON.stringify({ rejected: decisions.map(d => ({ group_id: d.group_id, members: d.members })), store: r.store,
      ...(r.receipt ? { commit: r.receipt.commit, outcome: r.receipt.outcome, ...(r.receipt.note ? { note: r.receipt.note } : {}) } : {}), distinct_from: sameSource,
      ...(uncollapsed.length ? { collapses: uncollapsed } : {}) }, null, 2));
  } else {
    for (const d of decisions) console.log(`Recorded ${d.group_id} as different people or companies: ${d.members.map(memberText).join(', ')}. It will not be proposed again.`);
    console.log(storedText(r));
    for (const c of uncollapsed) console.log(collapseText(c));
    for (const s of sameSource) console.log(`  ${s.source_id}:${s.slug} distinct_from: ${s.status}`);
  }
  if (uncollapsed.some(c => c.status !== 'undone')) setCliExitVerdict(1);
  const changed = sameSource.filter(s => s.status === 'changed');
  if (changed.length) {
    throw opError('dedupe_page_changed', `gbrain dedupe reject: the decision is recorded, but ${changed.map(s => `${s.source_id}:${s.slug}`).join(', ')} changed while its distinct_from line was written, so it was not edited.`,
      `Run the same command again (gbrain dedupe reject ${f.ids.join(' ')}); only the page edit is retried.`,
      { fix: { argv: ['gbrain', 'dedupe', '--preview'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the current groups; changes nothing.' } });
  }
}

/** A contact page a contacts source linked to a person this decision separates leaves that group now; its next sync leaves it out too. */
async function unlinkRejectedContacts(engine: BrainEngine, decisions: DecisionInput[]): Promise<void> {
  for (const d of decisions) {
    for (const m of d.members) {
      const row = (await listEntityIdentities(engine, { slug: m.slug, slugSourceId: m.source_id })).find(x => x.slug === m.slug && x.source_id === m.source_id);
      if (!row || row.canonical || !CONTACT_LINK_ORIGINS.includes(row.established_by)) continue;
      const together = (await listEntityIdentities(engine, { entityId: row.entity_id })).map(memberText);
      if (!d.members.some(o => o !== m && together.includes(memberText(o)))) continue;
      await unlinkContact(engine, row.entity_id, m.slug, m.source_id, row.established_by);
    }
  }
}

async function runLinkContacts(engine: BrainEngine, args: string[]): Promise<void> {
  let json = false, apply = false, unlink = false, sourceId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--apply') apply = true;
    else if (a === '--unlink') unlink = true;
    else if (a === '--source' && args[i + 1]) sourceId = args[++i];
    else { console.error(`gbrain dedupe link-contacts: unknown argument ${a}.\n\n${HELP}`); setCliExitVerdict(2); return; }
  }
  if (!sourceId || (apply && unlink)) { console.error(`gbrain dedupe link-contacts: pass --source <id>, with at most one of --apply and --unlink.\n\n${HELP}`); setCliExitVerdict(2); return; }
  await assertGoogleSource(engine, 'link-contacts', sourceId);
  if (unlink) {
    const unlinked = await unlinkGoogleContacts(engine, sourceId);
    await engine.setConfig(IDENTITY_LINKS_CONFIG_KEY, 'off');
    if (json) console.log(JSON.stringify({ source_id: sourceId, mode: 'unlink', unlinked, identity_links: 'off' }, null, 2));
    else console.log(`Removed the links of ${unlinked} contact page(s) of ${sourceId} and set ${IDENTITY_LINKS_CONFIG_KEY} off; syncs no longer link contacts.`);
    return;
  }
  const counts = await linkGoogleContacts(engine, sourceId, { apply, listReviews: json && !apply });
  if (apply) await engine.setConfig(IDENTITY_LINKS_CONFIG_KEY, 'on');
  if (json) { console.log(JSON.stringify({ source_id: sourceId, mode: apply ? 'apply' : 'dry_run', ...counts, ...(apply ? { identity_links: 'on' } : {}) }, null, 2)); return; }
  const would = apply ? '' : 'would be ';
  console.log([
    `${counts.contacts} contact page(s) in ${sourceId}${apply ? '' : ' (dry run: nothing was written)'}:`,
    `  ${counts.linked} ${would}linked to the one person page with exactly the same email or phone`,
    `  ${counts.already_linked} already linked`,
    `  ${counts.waiting} match two or more people and wait for you (gbrain sync status --source ${sourceId})`,
    `  ${counts.name_disagrees} match one person whose page has another name and wait for you`,
    `  ${counts.no_match} match no person page`,
    `  ${counts.rejected} match only people you recorded as different people`,
    `  ${counts.ignored} marked as not a person`,
    `  ${counts.other_writer} sit in an identity group another writer made and are left as they are`,
    `  ${counts.unlinked} earlier link(s) ${would}removed`,
    apply ? `Set ${IDENTITY_LINKS_CONFIG_KEY} on: each sync links the contacts it changes. Undo one link with gbrain dedupe reject, all of them with --unlink.`
      : `Link them with gbrain dedupe link-contacts --source ${sourceId} --apply.`,
  ].join('\n'));
}

async function assertGoogleSource(engine: BrainEngine, cmd: string, sourceId: string): Promise<void> {
  const source = (await engine.listAllSources()).find(s => s.id === sourceId);
  if (!source) {
    const archived = (await engine.listAllSources({ includeArchived: true })).some(s => s.id === sourceId);
    throw opError('unknown_source', `gbrain dedupe ${cmd}: source ${sourceId} is ${archived ? 'archived' : 'not registered'}; nothing was written.`,
      'Pass the id of an active Google Contacts source.',
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the source ids, read-only.' } });
  }
  if (parseSourceConfig(source.config).kind !== 'google') {
    throw opError('invalid_source', `gbrain dedupe ${cmd}: source ${sourceId} is not a Google source, so it has no Google Contacts pages; nothing was written.`,
      'Pass the id of a Google source that syncs contacts. Apple Contacts sources link their contact pages on every sync already.',
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the sources and their kinds, read-only.' } });
  }
}

async function runDecide(engine: BrainEngine, args: string[]): Promise<void> {
  let json = false, dryRun = false, sourceId: string | undefined, file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--source' && args[i + 1]) sourceId = args[++i];
    else if (a === '--file' && args[i + 1]) file = args[++i];
    else { console.error(`gbrain dedupe decide: unknown argument ${a}.\n\n${HELP}`); setCliExitVerdict(2); return; }
  }
  if (!sourceId || !file) { console.error(`gbrain dedupe decide: pass --source <id> and --file <choices.json>.\n\n${HELP}`); setCliExitVerdict(2); return; }
  await assertGoogleSource(engine, 'decide', sourceId);
  let choices: unknown;
  try { choices = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw opError('invalid_params', `gbrain dedupe decide: ${file} is not a readable JSON file (${e instanceof Error ? e.message : String(e)}); nothing was written.`,
      'Write the choices as a JSON array of {"contact_slug", "action", "candidate"} lines.');
  }
  if (!Array.isArray(choices)) {
    throw opError('invalid_params', `gbrain dedupe decide: ${file} holds no JSON array; nothing was written.`, 'Write the choices as a JSON array of {"contact_slug", "action", "candidate"} lines.');
  }
  const r = await decideContacts(engine, sourceId, choices, { dryRun });
  if (r.refused) setCliExitVerdict(1);
  const rec = r.recorded;
  if (json) {
    console.log(JSON.stringify({ source_id: r.source_id, mode: r.mode, lines: r.lines, refused: r.refused, ...(rec ? { store: rec.store,
      ...(rec.receipt ? { commit: rec.receipt.commit, outcome: rec.receipt.outcome, ...(rec.receipt.note ? { note: rec.receipt.note } : {}) } : {}) } : {}) }, null, 2));
    return;
  }
  for (const l of r.lines) {
    const what = l.status === 'refused' ? `set aside (${l.reason}): ${l.message}` : l.status === 'skipped' ? 'skipped'
      : `${l.status === 'recorded' ? 'recorded' : 'would record'} ${l.decisions.join(', ')}${l.page ? ` with new page ${l.page}` : ''}`;
    console.log(`${l.contact_slug || '(no contact_slug)'}  ${l.action || '(no action)'}: ${what}`);
    for (const u of l.undo ?? []) console.log(`  undo: ${u}`);
  }
  console.log(r.mode === 'dry_run' ? 'Dry run: nothing was written.' : rec ? storedText(rec) : 'Nothing was recorded.');
  if (r.refused) console.log(`${r.refused} line(s) were set aside; fix them and run a file holding only those lines (the others are recorded).`);
}

async function runUndo(engine: BrainEngine, args: string[]): Promise<void> {
  const f = parseFlags('undo', args, new Set());
  if (!f) return;
  if (!f.ids.length) { console.error(`gbrain dedupe undo: pass the decision ids to remove.\n\n${HELP}`); setCliExitVerdict(2); return; }
  const collapsed = new Map((await listCollapses(engine)).map(c => [c.collapse, c]));
  const ids = f.ids.filter(id => !collapsed.has(id));
  const undone: CollapseOutcome[] = [];
  for (const id of new Set(f.ids.filter(x => collapsed.has(x)))) undone.push(await undoCollapse(engine, collapsed.get(id)!, loadConfig()));
  if (undone.some(c => c.status !== 'undone')) setCliExitVerdict(1);
  if (!ids.length) {
    if (f.json) console.log(JSON.stringify({ removed: [], collapses: undone }, null, 2));
    else for (const c of undone) console.log(collapseText(c));
    return;
  }
  const before = (await engine.listIdentityDecisions()).decisions.filter(d => ids.includes(d.decision_id));
  const r = await forgetDecisions(engine, ids, `dedupe: undo ${ids.length} duplicate decision(s)`);
  if (await identityLinksOn(engine)) {
    const google = new Set((await engine.listAllSources()).filter(s => parseSourceConfig(s.config).kind === 'google').map(s => s.id));
    const bySource = new Map<string, string[]>();
    for (const m of before.flatMap(d => d.members)) if (google.has(m.source_id)) bySource.set(m.source_id, [...bySource.get(m.source_id) ?? [], m.slug]);
    for (const [sourceId, slugs] of bySource) await linkGoogleContacts(engine, sourceId, { apply: true, slugs });
  }
  if (f.json) {
    console.log(JSON.stringify({ removed: r.removed, store: r.store, ...(r.receipt ? { commit: r.receipt.commit, outcome: r.receipt.outcome } : {}), ...(undone.length ? { collapses: undone } : {}) }, null, 2));
    return;
  }
  for (const c of undone) console.log(collapseText(c));
  console.log(`Removed ${r.removed.length} decision(s): ${r.removed.join(', ')}.`);
  console.log(r.store === 'database' ? 'Removed from the database (this brain has no repository).'
    : r.receipt ? `Removed from ${r.home!.sourceId}:.gbrain/identity/ (commit ${r.receipt.commit?.slice(0, 12) ?? 'none'}, ${r.receipt.outcome}).${r.receipt.note ? ' ' + r.receipt.note : ''}`
      : 'Removed from the database; none of them was in git.');
}

/** Two or more members in one writable source also get `distinct_from` (through the page door, as extraction-review distinct does). */
async function markDistinct(engine: BrainEngine, decisions: DecisionInput[]): Promise<Array<{ source_id: string; slug: string; status: string }>> {
  const out: Array<{ source_id: string; slug: string; status: string }> = [];
  const sources = new Map((await engine.listAllSources()).map(s => [s.id, s]));
  for (const d of decisions) {
    const bySource = new Map<string, string[]>();
    for (const m of d.members) bySource.set(m.source_id, [...(bySource.get(m.source_id) ?? []), m.slug]);
    for (const [sourceId, slugs] of bySource) {
      if (slugs.length < 2) continue;
      const [of, ...rest] = slugs as [string, ...string[]];
      if (parseSourceConfig(sources.get(sourceId)?.config).mirror_read_only === true) {
        for (const slug of rest) out.push({ source_id: sourceId, slug, status: 'skipped_read_only_source' });
        continue;
      }
      const { extractionOperations } = await import('../core/ops/extraction.ts');
      const op = extractionOperations.find(o => o.name === 'extraction_review')!;
      const ctx = { engine, config: loadConfig() ?? ({ engine: engine.kind } as never), remote: false, dryRun: false, sourceId,
        logger: { info() {}, warn() {}, error() {} } } as unknown as Parameters<typeof op.handler>[0];
      const res = await op.handler(ctx, { action: 'distinct', slugs: rest, of }) as { results: Array<{ slug: string; status: string }> };
      for (const x of res.results) out.push({ source_id: sourceId, slug: x.slug, status: x.status });
    }
  }
  return out;
}

async function runReconcile(engine: BrainEngine, args: string[]): Promise<void> {
  const f = parseFlags('reconcile', args, new Set());
  if (!f) return;
  const r = await reconcileDecisions(engine);
  const auto = await autoLinkCompanies(engine);
  if (f.json) { console.log(JSON.stringify(r, null, 2)); return; }
  if (r.store === 'database') console.log(`Duplicate decisions are kept in the database (no repository). Linked ${r.applied?.linked ?? 0} page(s), unlinked ${r.applied?.unlinked ?? 0}.`);
  else console.log(`Wrote ${r.written} decision(s) into git and re-read the committed decisions of source ${r.projection?.source_id} (${r.projection?.upserted ?? 0} updated, ${r.projection?.removed ?? 0} removed, ${r.projection?.linked ?? 0} page(s) linked).`
    + (r.projection?.invalid.length ? ` ${r.projection.invalid.length} file(s) did not validate: ${r.projection.invalid.join(', ')}.` : ''));
  if (r.git_kept?.length) console.log(`${r.git_kept.length} decision(s) the database held differently are already committed; git wins, so the database now has the committed verdict: ${r.git_kept.join(', ')}.`);
  if (r.pending.length) console.log(`${r.pending.length} member page(s) are still not linked: ${r.pending.slice(0, 10).map(p => `${p.source_id}:${p.slug} (${p.reason})`).join(', ')}.`);
  console.log(auto.skipped_sweep === 'no_checkout' ? 'Companies that share an id are linked by the host that holds the checkout of the decisions; none were linked here.'
    : `Companies that share an id: linked ${auto.linked} group(s), unlinked ${auto.unlinked}${auto.skipped ? `, ${auto.skipped} changed while they were linked and wait for the next sync` : ''}.`);
}

/** gbrain dedupe classes and gbrain dedupe sample (GST-3609): read-only counts and labelling samples of candidate person pairs. */
async function runClasses(engine: BrainEngine, cmd: 'classes' | 'sample', args: string[]): Promise<void> {
  let json = false, exa = false, dryRun = false, sourceId: string | undefined, cls: string | undefined, n: number | undefined, seed = 1, since: number | undefined;
  const usage = (why: string) => { console.error(`gbrain dedupe ${cmd}: ${why}.\n\n${HELP}`); setCliExitVerdict(2); };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') { json = true; continue; }
    if (a === '--exa') { exa = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    const valued = cmd === 'sample' ? ['--source', '--class', '--n', '--seed', '--since'] : ['--source'];
    if (!valued.includes(a)) return usage(`unknown argument ${a}`);
    const v = args[++i];
    if (!v) return usage(`${a} needs a value`);
    if (a === '--source') sourceId = v;
    else if (a === '--class') cls = v;
    else if (a === '--since') {
      const m = /^(\d+)([dh])$/.exec(v.trim());
      if (!m || Number(m[1]) < 1) return usage('--since takes a time like 7d or 24h');
      since = Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
    }
    else {
      const num = Number(v);
      if (!Number.isInteger(num) || num < (a === '--n' ? 1 : 0)) return usage(`${a} takes a whole number${a === '--n' ? ' of at least 1' : ''}`);
      if (a === '--n') n = num; else seed = num;
    }
  }
  if (dryRun && !exa) return usage('--dry-run goes with --exa');
  if (since !== undefined) {
    const autoClass = cls === undefined ? null : parseAutoClass(cls);
    if (!autoClass) return usage(`with --since, pass --class with one of the automatic classes: ${AUTO_CLASSES.join(', ')}`);
    if (exa || sourceId) return usage('--since samples recorded links: it takes no --exa or --source');
    const from = Date.now() - since;
    const read = await engine.listIdentityDecisions();
    const live = autoClass === 'C7'
      ? (await collapsesSince(engine, from)).map(c => ({ decision: c.collapse, members: [{ source_id: c.source_id, slug: c.retired }, { source_id: c.source_id, slug: c.canonical }],
        decided_at: c.at, reject: `gbrain dedupe reject ${c.collapse}` }))
      : autoLinksSince(read, from, autoClass).map(d => ({ decision: d.decision_id, members: d.members, entity_id: d.entity_id, decided_at: d.decided_at, reject: `gbrain dedupe reject ${d.entity_id}` }));
    const corrected = correctionsSince(read, from, autoClass).map(d => ({ decision: d.decision_id, members: d.members, decided_at: d.decided_at, corrected: true as const }));
    const recent = [...live, ...corrected].sort((a, b) => (a.decision < b.decision ? -1 : a.decision > b.decision ? 1 : 0));
    const links = seededPick(recent, n ?? 20, seed);
    if (json) { console.log(JSON.stringify({ class: autoClass, since_hours: since / 3_600_000, n: n ?? 20, seed, total: recent.length, corrected: corrected.length, links }, null, 2)); return; }
    const what = autoClass === 'C7' ? 'collapse(s)' : 'link(s)';
    console.log(`${links.length} of ${recent.length} automatic ${autoClass} ${what} from the last ${since / 3_600_000} hour(s) (seed ${seed}), ${corrected.length} of them already rejected by you. Label each one same, different or unsure.`);
    for (const l of links) {
      console.log(`${l.decision}  ${l.members.map(memberText).join('  +  ')}  (${l.decided_at}); ${'reject' in l ? `if they are different people, keep it apart for good: ${l.reject}` : 'you rejected it: count it as different'}`);
    }
    return;
  }
  const pairClass = cls === undefined ? null : parsePairClass(cls);
  if (cmd === 'sample' && !pairClass) return usage(`pass --class with one of ${PAIR_CLASSES.join(', ')}`);
  const opts: ClassifyOptions = { ...(sourceId ? { sourceId } : {}) };
  if (exa) {
    const settings = await exaSettings(engine, process.env);
    if (!dryRun && (!settings.enabled || !settings.hasKey)) {
      throw opError('dedupe_exa_off', `gbrain dedupe ${cmd} --exa: web search is off on this brain (${[!settings.hasKey ? 'EXA_API_KEY is not set' : '', !settings.enabled ? `${EXA_SWITCH_KEY} is not on` : ''].filter(Boolean).join(', ')}); nothing was sent.`,
        `Count the queries and their cost first with gbrain dedupe ${cmd} --exa --dry-run, then set EXA_API_KEY and run gbrain config set ${EXA_SWITCH_KEY} on.`,
        { fix: { argv: ['gbrain', 'dedupe', 'classes', '--exa', '--dry-run', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Counts the queries a web search would send and what they would cost; sends nothing.' } });
    }
    opts.exa = dryRun ? { mode: 'dry_run', settings } : { mode: 'live', settings, apiKey: process.env.EXA_API_KEY!.trim() };
  }
  const { report, pairs } = await classifyPairs(engine, opts);
  if (cmd === 'sample') {
    const picked = samplePairs(pairs, pairClass!, n ?? 100, seed);
    const total = report.classes[pairClass!];
    if (json) { console.log(JSON.stringify({ schema_version: report.schema_version, class: pairClass, n: n ?? 100, seed, total, pairs: picked, exa: report.exa }, null, 2)); return; }
    console.log(`${picked.length} of ${total} pair(s) in class ${pairClass} (seed ${seed}). Label each one same, different or unsure.`);
    for (const p of picked) {
      console.log(`${p.id}  ${p.members.map(m => `${m.source_id}:${m.slug} (${m.title})`).join('  +  ')}`);
      console.log(`    base ${p.base}; signals ${p.signals.join(' ') || 'none'}; would ${p.verdict}: ${p.reason}`);
    }
    return;
  }
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(classesText(report));
}

async function runAuto(engine: BrainEngine, args: string[]): Promise<void> {
  let json = false, apply = false, sourceId: string | undefined, off: string | undefined, on: string | undefined;
  const usage = (why: string) => { console.error(`gbrain dedupe auto: ${why}.\n\n${HELP}`); setCliExitVerdict(2); };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') { json = true; continue; }
    if (a === '--apply') { apply = true; continue; }
    if (!['--source', '--off', '--on'].includes(a)) return usage(`unknown argument ${a}`);
    const v = args[++i];
    if (!v) return usage(`${a} needs a value`);
    if (a === '--source') sourceId = v; else if (a === '--off') off = v; else on = v;
  }
  if (off !== undefined || on !== undefined) {
    if ((off !== undefined && on !== undefined) || apply || sourceId) return usage('--off and --on take one class and no other flag but --json');
    const cls = parseAutoClass((off ?? on)!);
    if (!cls) return usage(`${off !== undefined ? '--off' : '--on'} takes one of ${AUTO_CLASSES.join(', ')}`);
    if (on !== undefined) {
      await engine.setConfig(autoSwitchKey(cls), 'on');
      if (json) console.log(JSON.stringify({ class: cls, switch: 'on', removed: [] }, null, 2));
      else console.log(`Automatic ${cls} links are on; gbrain dedupe auto --apply links the pairs that qualify.`);
      return;
    }
    const { removed, left } = await switchAutoClassOff(engine, cls, loadConfig());
    if (left.length) setCliExitVerdict(1);
    if (json) console.log(JSON.stringify({ class: cls, switch: 'off', removed, ...(left.length ? { left } : {}) }, null, 2));
    else {
      console.log(`Automatic ${cls} ${cls === 'C7' ? 'collapses' : 'links'} are off; removed ${removed.length}. gbrain dedupe auto --on ${cls} switches the class back on.`);
      if (left.length) console.log(`${left.length} collapse(s) were not undone because a page changed since: ${left.join(', ')} (run gbrain dedupe undo <id> for each)`);
    }
    return;
  }
  const plan = await planAutoLinks(engine, sourceId ? { sourceId } : {});
  const r = apply ? await applyAutoLinks(engine, plan, loadConfig()) : null;
  if (r?.collapses.some(c => c.status !== 'collapsed')) setCliExitVerdict(1);
  if (json) {
    const rec = r?.record;
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', ...plan, ...(r ? { linked: r.linked, changed: r.changed, collapsed: r.collapses } : {}),
      ...(rec ? { store: rec.store, ...(rec.receipt ? { commit: rec.receipt.commit, outcome: rec.receipt.outcome } : {}) } : {}) }, null, 2));
    return;
  }
  const switches = AUTO_CLASSES.map(c => `${c} ${plan.switches[c]}`).join(', ');
  const linked = r ? r.linked.length : plan.links.length;
  const collapsed = r ? r.collapses.filter(c => c.status === 'collapsed').length : plan.collapses.length;
  console.log(`${apply ? 'Linked' : 'Would link'} ${linked} pair(s) of person pages and ${apply ? 'collapsed' : 'collapse'} ${collapsed} automatically (${switches}); ${plan.set_aside.length} set aside.`
    + (apply ? '' : ' Nothing was changed; do it with gbrain dedupe auto --apply.'));
  for (const l of plan.links) {
    const done = !r || r.linked.includes(l.decision);
    console.log(`  ${l.decision}  ${l.members.map(memberText).join('  +  ')}  (${l.class}${r ? (done ? `; a wrong one for good: gbrain dedupe reject ${l.entity_id}; undo: gbrain dedupe undo ${l.decision}` : '; not linked: its pages were rejected, linked or switched off since the plan') : ''})`);
  }
  for (const c of plan.collapses) {
    const out = r?.collapses.find(x => x.collapse === c.collapse);
    console.log(`  ${c.collapse}  ${c.source_id}:${c.retired}  ->  ${c.canonical}  (C7, ${c.store}${c.aliases.length ? `, alias ${c.aliases.join(', ')}` : ''}${out ? `; ${collapseText(out).trim()}` : ''})`);
  }
  for (const s of plan.set_aside) console.log(`  set aside (${s.reason}): ${s.members.map(memberText).join('  +  ')}`);
  if (r?.record) console.log(storedText(r.record));
}

function collapseText(c: CollapseOutcome): string {
  if (c.status === 'skipped') {
    return `  ${c.collapse} not written: ${c.reason === 'frontmatter_not_editable' ? 'a page\'s frontmatter cannot be edited line by line without touching other keys; edit it by hand' : 'a page changed since it was read; run the command again'}`;
  }
  const where = c.store === 'git' ? `commit ${c.commit?.slice(0, 12) ?? 'none'}${c.outcome ? `, ${c.outcome}` : ''}${c.note ? `. ${c.note}` : ''}` : 'through the page door; each page keeps its earlier version (gbrain revert)';
  return c.status === 'undone' ? `  undid collapse ${c.collapse} (${where})`
    : `  collapsed ${c.collapse} (${where}); a wrong one for good: gbrain dedupe reject ${c.collapse}; undo: gbrain dedupe undo ${c.collapse}`;
}

function classesText(r: ClassesReport): string {
  const lines = [`${r.pairs} candidate pair(s) of person pages (nothing was written):`];
  lines.push(`  would link ${r.verdicts.link}, collapse ${r.verdicts.collapse}, wait ${r.verdicts.wait}, mark different ${r.verdicts.different}`);
  lines.push('  by class: ' + PAIR_CLASSES.map(c => `${c} ${r.classes[c]}`).join(', '));
  lines.push(`  left out: ${r.skipped.already_linked} already linked, ${r.skipped.decided_apart} you recorded as different, ${r.skipped.large_groups} name group(s) of more than 10 pages, ${r.skipped.no_class} with names that disagree and nothing shared, ${r.skipped.copies} mirror copies (one page kept in two sources)`);
  lines.push(`  evidence read: ${r.email.pages} email page(s); ${r.messaging.pages} chat page(s) in ${r.messaging.chats} chat(s), ${r.messaging.one_to_one} one-to-one${r.messaging.too_large ? `, ${r.messaging.too_large} too large to read` : ''}; Signal has no reader`);
  const seg = r.messaging.segmented_page;
  if (seg.read || seg.set_aside) lines.push(`  chat pages stored in segments: ${seg.read} read whole, ${seg.set_aside} set aside (over 24 MiB or not readable as one body; their chats add no evidence)${seg.set_aside ? ': ' + seg.pages.slice(0, 20).map(p => `${p.source_id}:${p.slug}`).join(', ') + (seg.set_aside > 20 ? ` and ${seg.set_aside - 20} more (--json lists every one)` : '') : ''}`);
  if (r.exa.mode === 'off') lines.push('  web search: off (add --exa)');
  else {
    const x = r.exa;
    const blocked = Object.entries(x.blocked).map(([k, v]) => `${v} ${k}`).join(', ');
    lines.push(x.mode === 'dry_run'
      ? `  web search dry run: ${x.queries} distinct quer(ies), ${x.cached} cached; a run would send ${x.sent} for $${x.cost_usd.toFixed(2)}${x.unsent ? ` and stop at the ${x.stopped === 'run_cap' ? `per-run cap (${x.run_cap})` : `total cap ($${x.total_cap_usd})`} with ${x.unsent} left` : ''}; all of them would cost $${x.uncapped_cost_usd.toFixed(2)}; spent so far $${x.spent_total_usd.toFixed(2)}`
      : `  web search: sent ${x.sent} quer(ies) for $${x.cost_usd.toFixed(2)}, ${x.cached} cached${x.withdrawn ? `, ${x.withdrawn} dropped because a page changed since the scan` : ''}${x.stopped ? `, stopped (${x.stopped}) with ${x.unsent} left` : ''}; spent so far $${x.spent_total_usd.toFixed(2)} of $${x.total_cap_usd}`);
    if (blocked) lines.push(`  kept away from web search: ${blocked} page(s)`);
  }
  return lines.join('\n');
}

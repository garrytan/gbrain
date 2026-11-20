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
 * alone. reject records "different people or companies" and undoes a confirm.
 * Nothing here merges, renames or deletes a page; nothing is linked without the owner.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { DUPLICATE_KINDS, findTypedDuplicateGroups, type DuplicateEvidence, type DuplicateGroup, type DuplicateKind, type DuplicateResult, type EntityKind } from '../core/entities/duplicates.ts';
import { canonicalOf, decidedSets, decisionId, identityHome, reconcileDecisions, recordDecisions, unpublishableMembers, type DecisionInput, type RecordResult } from '../core/entities/identity-decisions.ts';
import type { IdentityDecisionsRead, IdentityMemberRef } from '../core/engine-sql/identity-decisions.ts';
import { identityIdsForPages, listEntityIdentities, validateEntityId } from '../core/entity-identity.ts';
import { opError, OperationError } from '../core/ops/contract.ts';
import { parseSourceConfig } from '../core/sources-load.ts';

const HELP = `Usage: gbrain dedupe --preview [--json] [--kind cross-source|in-source|conflict|thin] [--source <id>]
       gbrain dedupe confirm [--json]
       gbrain dedupe confirm --clean [--expect <hash>] [--json]
       gbrain dedupe confirm <group-id>... [--join <entity_id>] [--json]
       gbrain dedupe reject <group-id>... [--json]
       gbrain dedupe reconcile [--json]

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
reject <id>...      record that the pages are different people or companies: the pair is never proposed again, and a
                    confirmed group is unlinked; two pages in one source also get distinct_from
reconcile           write decisions the database holds alone into git, re-read the committed decisions and
                    link pages that arrived since; run it after doctor reports a drift

Decisions are kept in .gbrain/identity/ in the brain's repository (committed through gbrain git commit-push),
or in the database on a brain with no repository. Nothing merges, renames or deletes a page.
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

interface Scan { result: DuplicateResult; read: IdentityDecisionsRead; kindOf: Map<string, EntityKind> }

/** Confirmed on its own, after reading its hint line: contact-only groups, and person groups that share an id (gate_rev 7). */
const confirmAlone = (s: Scan, g: DuplicateGroup) => contactOnly(g) || (s.kindOf.get(g.id) === 'person' && sharesId(g));
const otherNamePages = (g: DuplicateGroup) => g.evidence.reduce((n, e) => n + (e.other_pages_other_name ?? 0), 0);

async function readDecisions(engine: BrainEngine): Promise<IdentityDecisionsRead> {
  return engine.listIdentityDecisions();
}

async function scan(engine: BrainEngine, opts: { kind?: DuplicateKind; sourceId?: string } = {}): Promise<Scan> {
  const read = await readDecisions(engine);
  const { result, kindOf } = await findTypedDuplicateGroups(engine, { ...opts, decided: decidedSets(read) });
  return { result, read, kindOf };
}

export async function runDedupe(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  const sub = args[0];
  if (sub === 'confirm') return runConfirm(engine, args.slice(1));
  if (sub === 'reject') return runReject(engine, args.slice(1));
  if (sub === 'reconcile') return runReconcile(engine, args.slice(1));
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

async function identitiesOf(engine: BrainEngine, groups: DuplicateGroup[]): Promise<Map<string, string>> {
  return identityIdsForPages(engine, groups.flatMap(g => g.members.map(m => ({ sourceId: m.source_id, slug: m.slug }))));
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
  const entries = s.result.groups.filter(g => g.kind === 'cross_source' && CONFIRMABLE.has(g.class));
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
  for (const id of [...new Set(f.ids)]) {
    const confirmed = same.filter(d => d.entity_id === id);
    const members = confirmed.length ? confirmed.map(d => ({ members: d.members, group_id: d.group_id ?? id }))
      : [result.groups.find(g => g.id === id)?.members ?? read.decisions.find(d => d.group_id === id)?.members]
        .filter((m): m is IdentityMemberRef[] => !!m).map(m => ({ members: m, group_id: id }));
    if (!members.length) throw unknownGroup(id);
    for (const m of members) decisions.push({ verdict: 'different', members: m.members, group_id: m.group_id, entity_id: null, canonical: null, decided_by: DECIDED_BY });
  }
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
  const sameSource = await markDistinct(engine, decisions);
  if (f.json) {
    console.log(JSON.stringify({ rejected: decisions.map(d => ({ group_id: d.group_id, members: d.members })), store: r.store,
      ...(r.receipt ? { commit: r.receipt.commit, outcome: r.receipt.outcome, ...(r.receipt.note ? { note: r.receipt.note } : {}) } : {}), distinct_from: sameSource }, null, 2));
  } else {
    for (const d of decisions) console.log(`Recorded ${d.group_id} as different people or companies: ${d.members.map(memberText).join(', ')}. It will not be proposed again.`);
    console.log(storedText(r));
    for (const s of sameSource) console.log(`  ${s.source_id}:${s.slug} distinct_from: ${s.status}`);
  }
  const changed = sameSource.filter(s => s.status === 'changed');
  if (changed.length) {
    throw opError('dedupe_page_changed', `gbrain dedupe reject: the decision is recorded, but ${changed.map(s => `${s.source_id}:${s.slug}`).join(', ')} changed while its distinct_from line was written, so it was not edited.`,
      `Run the same command again (gbrain dedupe reject ${f.ids.join(' ')}); only the page edit is retried.`,
      { fix: { argv: ['gbrain', 'dedupe', '--preview'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the current groups; changes nothing.' } });
  }
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
      const { loadConfig } = await import('../core/config.ts');
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
  if (f.json) { console.log(JSON.stringify(r, null, 2)); return; }
  if (r.store === 'database') console.log(`Duplicate decisions are kept in the database (no repository). Linked ${r.applied?.linked ?? 0} page(s), unlinked ${r.applied?.unlinked ?? 0}.`);
  else console.log(`Wrote ${r.written} decision(s) into git and re-read the committed decisions of source ${r.projection?.source_id} (${r.projection?.upserted ?? 0} updated, ${r.projection?.removed ?? 0} removed, ${r.projection?.linked ?? 0} page(s) linked).`
    + (r.projection?.invalid.length ? ` ${r.projection.invalid.length} file(s) did not validate: ${r.projection.invalid.join(', ')}.` : ''));
  if (r.git_kept?.length) console.log(`${r.git_kept.length} decision(s) the database held differently are already committed; git wins, so the database now has the committed verdict: ${r.git_kept.join(', ')}.`);
  if (r.pending.length) console.log(`${r.pending.length} member page(s) are still not linked: ${r.pending.slice(0, 10).map(p => `${p.source_id}:${p.slug} (${p.reason})`).join(', ')}.`);
}

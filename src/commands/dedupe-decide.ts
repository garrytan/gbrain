/**
 * The owner's own decisions for the contacts of a Google Contacts source that wait for a person (gbrain dedupe decide,
 * GST-3609). A choices file holds one line per contact, `{ contact_slug, action, candidate? }`:
 *
 *   - link:   the contact and the one candidate named are the same person (a "same" decision for exactly that pair, or
 *             for the contact and every copy of the candidate in other sources when it is mirrored: mirrorSets; the
 *             contact joins the candidate's identity group, or a new one with the candidate as its canonical page);
 *   - new:    none of the candidates: a person page named after the contact is made in the default source and the
 *             contact is linked to it: on a brain with a repository the page file is committed with the decisions and
 *             then imported, so git has it first; without one it is written through put_page;
 *   - reject: the contact is a different person from each candidate listed (`candidate` or `candidates`, with its
 *             copies in other sources), or from every current candidate when none is listed: one "different" decision per pair, so the contact still waits on
 *             any candidate not rejected;
 *   - ignore: not a person (a shared inbox, a service): a one-member "different" decision, which keeps the contact out of
 *             every identity group and off the list of contacts that wait;
 *   - skip:   nothing.
 *
 * Every decision of the run is recorded in one write through recordDecisions: in git in the default source's repository
 * when the brain has one (one commit, with the files of the pages `new` made, so a database rebuilt from git keeps
 * them), in the database otherwise. A line that cannot apply
 * is set aside with its reason and the others are still recorded. Each line names the command that undoes it
 * (gbrain dedupe undo <decision id>..., and gbrain delete for a page `new` made). --dry-run plans and writes nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import type { BrainEngine } from '../core/engine.ts';
import type { IdentityMemberRef } from '../core/engine-sql/identity-decisions.ts';
import { decidedSets, decisionId, identityHome, memberKey, recordDecisions, storeMismatch, unpublishableMembers, type DecisionInput, type RecordResult } from '../core/entities/identity-decisions.ts';
import { listEntityIdentities } from '../core/entity-identity.ts';
import { exactPersonMatches, mirrorSets } from '../core/apple-contacts/identity-match.ts';
import { parsePhoneCountryCode, PHONE_COUNTRY_CODE_CONFIG_KEY } from '../core/phone-key.ts';
import { slugifyEntity } from '../core/enrichment-service.ts';
import { importFromFile } from '../core/import-file.ts';
import { DEFAULT_SOURCE_ID } from '../core/sync-failure-ledger.ts';
import { contactPages, GOOGLE_CONTACTS_LINK_ORIGIN, identityLinksOn, linkGoogleContacts, unlinkGoogleContactPage } from '../core/google/contact-identity.ts';

export const CONTACT_ACTIONS = ['link', 'new', 'reject', 'ignore', 'skip'] as const;
export type ContactAction = typeof CONTACT_ACTIONS[number];
/** The group_id of an ignore decision: the contact is not a person. */
export const NOT_A_PERSON = 'not-a-person';
const DECIDED_BY = 'owner';

export interface DecideLine {
  contact_slug: string;
  action: string;
  status: 'would_record' | 'recorded' | 'skipped' | 'refused';
  /** The decision ids the line records, sorted. */
  decisions: string[];
  /** The person page `new` makes, as source:slug. */
  page?: string;
  /** The commands that undo the line. */
  undo?: string[];
  reason?: string;
  message?: string;
}

export interface DecideResult {
  source_id: string;
  mode: 'dry_run' | 'apply';
  lines: DecideLine[];
  refused: number;
  recorded?: RecordResult;
}

const text = (m: IdentityMemberRef) => `${m.source_id}:${m.slug}`;
const parseRef = (v: unknown): IdentityMemberRef | null => {
  const m = typeof v === 'string' ? /^([^:\s]+):(\S.*)$/.exec(v.trim()) : null;
  return m ? { source_id: m[1]!, slug: m[2]! } : null;
};
const entityFor = (m: IdentityMemberRef) => `person-${createHash('sha256').update(memberKey(m)).digest('hex').slice(0, 16)}`;

interface Planned { line: DecideLine; decisions: DecisionInput[]; contact: IdentityMemberRef; newPage?: { ref: IdentityMemberRef; title: string }; unlinkFirst: boolean }

/** Plans every line of a choices file and, unless dryRun, records them. */
export async function decideContacts(engine: BrainEngine, sourceId: string, choices: unknown[], opts: { dryRun: boolean }): Promise<DecideResult> {
  const entries = choices.map(c => (c && typeof c === 'object' ? c as Record<string, unknown> : {}));
  const slugs = [...new Set(entries.map(e => e.contact_slug).filter((s): s is string => typeof s === 'string'))];
  const contacts = new Map((slugs.length ? await contactPages(engine, sourceId, slugs) : []).map(c => [c.slug, c]));
  const apart = decidedSets(await engine.listIdentityDecisions()).apart;
  const home = await identityHome(engine);
  const countryCode = parsePhoneCountryCode(await engine.getConfig(PHONE_COUNTRY_CODE_CONFIG_KEY));
  const taken = new Set<string>();
  const done = new Set<string>();
  const planned: Planned[] = [];
  const lines: DecideLine[] = [];

  for (const e of entries) {
    const line: DecideLine = { contact_slug: typeof e.contact_slug === 'string' ? e.contact_slug : '', action: typeof e.action === 'string' ? e.action : '', status: 'refused', decisions: [] };
    lines.push(line);
    const refuse = (reason: string, message: string) => { line.reason = reason; line.message = message; };
    if (!line.contact_slug || !line.action) { refuse('invalid_line', 'A line needs contact_slug and action.'); continue; }
    if (!(CONTACT_ACTIONS as readonly string[]).includes(line.action)) { refuse('unknown_action', `action must be one of ${CONTACT_ACTIONS.join(', ')}.`); continue; }
    const row = contacts.get(line.contact_slug);
    if (!row) { refuse('unknown_contact', `${line.contact_slug} is not a contact page of ${sourceId}.`); continue; }
    if (done.has(row.slug)) { refuse('duplicate_contact', 'An earlier line of the file already decides this contact.'); continue; }
    if (line.action === 'skip') { line.status = 'skipped'; done.add(row.slug); continue; }
    const contact = { source_id: sourceId, slug: row.slug };
    const key = memberKey(contact);
    const ignored = apart.find(set => set.length === 1 && memberKey(set[0]!) === key);
    if (ignored && line.action !== 'ignore') { refuse('contact_ignored', `${line.contact_slug} is marked as not a person; undo that first: gbrain dedupe undo ${decisionId(ignored)}`); continue; }
    const current = (await listEntityIdentities(engine, { slug: row.slug, slugSourceId: sourceId })).find(m => m.slug === row.slug && m.source_id === sourceId) ?? null;
    const otherGroup = current && current.established_by !== GOOGLE_CONTACTS_LINK_ORIGIN ? current.entity_id : null;
    const p: Planned = { line, decisions: [], contact, unlinkFirst: false };
    const found = await exactPersonMatches(engine, sourceId, row.emails, row.phones, countryCode);
    const sets = mirrorSets(found.pages, found, apart);
    const setOf = (m: IdentityMemberRef) => sets.find(set => set.some(x => memberKey(x) === memberKey(m))) ?? [m];

    if (line.action === 'ignore') {
      if (otherGroup) { refuse('contact_in_other_group', `${line.contact_slug} is in identity group ${otherGroup}, which another writer made; remove it from that group first.`); continue; }
      p.decisions.push({ verdict: 'different', members: [contact], group_id: NOT_A_PERSON, entity_id: null, canonical: null, decided_by: DECIDED_BY });
    } else if (line.action === 'reject') {
      const listed = [...(Array.isArray(e.candidates) ? e.candidates : []), ...(e.candidate !== undefined ? [e.candidate] : [])];
      let targets: IdentityMemberRef[];
      if (listed.length) {
        const refs = listed.map(parseRef);
        if (refs.some(r => !r)) { refuse('invalid_candidate', 'A candidate is written source:slug.'); continue; }
        if (refs.some(r => memberKey(r!) === key)) { refuse('invalid_candidate', `${line.contact_slug} is the contact itself; to mark it as not a person, use ignore.`); continue; }
        targets = [...new Map((refs as IdentityMemberRef[]).flatMap(setOf).map(m => [memberKey(m), m])).values()];
      } else {
        const rejected = new Set(apart.filter(set => set.some(m => memberKey(m) === key)).flatMap(set => set.map(memberKey)));
        targets = found.pages.filter(m => !rejected.has(memberKey(m)));
        if (!targets.length) { refuse('no_candidates', `${line.contact_slug} has no candidate left to reject.`); continue; }
      }
      const missing = [];
      for (const t of targets) if (!await engine.getPage(t.slug, { sourceId: t.source_id })) missing.push(text(t));
      if (missing.length) { refuse('unknown_candidate', `No live page ${missing.join(', ')}.`); continue; }
      for (const t of targets) p.decisions.push({ verdict: 'different', members: [contact, t], group_id: null, entity_id: null, canonical: null, decided_by: DECIDED_BY });
    } else {
      let person: IdentityMemberRef;
      let people: IdentityMemberRef[];
      let entityId: string;
      if (line.action === 'link') {
        if (e.candidate === undefined) { refuse('candidate_required', 'link names the one candidate: candidate: "source:slug".'); continue; }
        const cand = parseRef(e.candidate);
        if (!cand) { refuse('invalid_candidate', 'A candidate is written source:slug.'); continue; }
        const page = await engine.getPage(cand.slug, { sourceId: cand.source_id });
        if (!page || memberKey(cand) === key) { refuse('unknown_candidate', `No live page ${text(cand)} to link.`); continue; }
        if (page.type !== 'person') { refuse('not_a_person_page', `${text(cand)} is a ${page.type} page, not a person page.`); continue; }
        people = setOf(cand);
        const apartSet = apart.find(set => set.some(m => memberKey(m) === key) && set.some(m => people.some(x => memberKey(x) === memberKey(m))));
        if (apartSet) { refuse('rejected_pair', `${line.contact_slug} and ${text(cand)} are recorded as different people; undo that first: gbrain dedupe undo ${decisionId(apartSet)}`); continue; }
        person = people[0]!;
        let held: string | undefined;
        for (const m of [cand, ...people]) {
          held ??= (await listEntityIdentities(engine, { slug: m.slug, slugSourceId: m.source_id })).find(x => x.slug === m.slug && x.source_id === m.source_id)?.entity_id;
        }
        entityId = held ?? entityFor(person);
      } else {
        if (!row.title?.trim()) { refuse('no_title', `${line.contact_slug} has no name to give a new person page.`); continue; }
        const named = slugifyEntity(row.title, 'person');
        const base = named.endsWith('/') ? `${named}contact-${createHash('sha256').update(`${sourceId}:${row.slug}`).digest('hex').slice(0, 12)}` : named;
        let slug = base;
        for (let i = 2; taken.has(slug) || (home && existsSync(join(home.root, `${slug}.md`)))
          || await engine.getPage(slug, { sourceId: DEFAULT_SOURCE_ID, includeDeleted: true }); i++) slug = `${base}-${i}`;
        taken.add(slug);
        person = { source_id: DEFAULT_SOURCE_ID, slug };
        people = [person];
        p.newPage = { ref: person, title: row.title.trim() };
        entityId = entityFor(person);
        line.page = text(person);
      }
      if (otherGroup && otherGroup !== entityId) { refuse('contact_in_other_group', `${line.contact_slug} is in identity group ${otherGroup}, which another writer made; remove it from that group first.`); continue; }
      p.unlinkFirst = !!current && !otherGroup;
      p.decisions.push({ verdict: 'same', members: [contact, ...people], group_id: null, entity_id: entityId, canonical: person, decided_by: DECIDED_BY });
    }
    if (home) {
      const blocked = (await unpublishableMembers(engine, home.sourceId, p.decisions)).find(b => b !== null);
      if (blocked) { refuse('not_publishable', `${text(blocked.member)} is ${blocked.why}; this brain keeps decisions in the default source's repository, where its name would be readable.`); continue; }
    }
    line.status = 'would_record';
    line.decisions = p.decisions.map(d => decisionId(d.members)).sort();
    line.undo = [`gbrain dedupe undo ${line.decisions.join(' ')}`, ...(p.newPage ? [`gbrain delete ${p.newPage.ref.slug} --source ${p.newPage.ref.source_id}`] : [])];
    done.add(row.slug);
    planned.push(p);
  }

  const result = (recorded?: RecordResult): DecideResult => ({ source_id: sourceId, mode: opts.dryRun ? 'dry_run' : 'apply', lines,
    refused: lines.filter(l => l.status === 'refused').length, ...(recorded ? { recorded } : {}) });
  if (opts.dryRun || !planned.length) return result();
  if (!home) {
    const read = await engine.listIdentityDecisions();
    if (read.decisions.some(d => d.origin === 'git')) throw storeMismatch(read.decisions);
  }

  const ready: Planned[] = [];
  for (const p of planned) {
    if (p.newPage && !home) {
      try { await putPersonPage(engine, p.newPage.ref, p.newPage.title); } catch (err) {
        Object.assign(p.line, { status: 'refused', decisions: [], undo: undefined, reason: 'page_write_failed', message: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
    ready.push(p);
  }
  if (!ready.length) return result();
  const pages = home ? ready.flatMap(p => p.newPage ? [{ path: `${p.newPage.ref.slug}.md`, text: personPage(p.newPage.title) }] : []) : [];
  const recorded = await recordDecisions(engine, ready.flatMap(p => p.decisions), `dedupe: decide ${ready.length} contact(s) of ${sourceId}`, pages);
  if (home) for (const f of pages) await importFromFile(engine, join(home.root, f.path), f.path, { sourceId: home.sourceId, noEmbed: true });
  const unlink = ready.filter(p => p.unlinkFirst);
  for (const p of unlink) await unlinkGoogleContactPage(engine, sourceId, p.contact.slug);
  if (pages.length || unlink.length) await engine.applyIdentityDecisions({});
  for (const p of ready) p.line.status = 'recorded';
  if (await identityLinksOn(engine)) await linkGoogleContacts(engine, sourceId, { apply: true, slugs: ready.map(p => p.contact.slug) });
  return result(recorded);
}

const personPage = (title: string) => `---\n${dump({ type: 'person', title }, { lineWidth: -1 })}---\n\n# ${title}\n`;

/** On a brain with no repository: a person page with only its type and name, through the write door as a trusted local caller. */
async function putPersonPage(engine: BrainEngine, page: IdentityMemberRef, title: string): Promise<void> {
  const { operations } = await import('../core/operations.ts');
  const { loadConfig } = await import('../core/config.ts');
  const op = operations.find(o => o.name === 'put_page')!;
  const ctx = { engine, config: loadConfig() ?? ({ engine: engine.kind } as never), remote: false, dryRun: false, sourceId: page.source_id,
    logger: { info() {}, warn() {}, error() {} } } as unknown as Parameters<typeof op.handler>[0];
  await op.handler(ctx, { slug: page.slug, source_id: page.source_id, content: personPage(title), request_id: randomUUID() });
}

/**
 * Dedupe v2 PR C (GST-3609, GST-3642): what the labelled sample changed, on a repo-less PGLite brain with placeholder
 * people. Candidates: a mirror copy (one page kept under its slug in two sources) is no pair, an id that a page with
 * another name also holds proves nothing, a page that is not a person and a page of the owner's own family never link,
 * and a family office or a school parent is not the owner's family. gbrain dedupe auto: preview, apply, undo, reject,
 * --off and --on, the weekly sample of recorded links, the doctor line, and the pairs it holds back (two full names that
 * disagree, a restricted page, a contact matching two pages under one slug that are not copies of each other).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { dedupeAutoLinksEntry } from '../src/commands/doctor/checks/entity-duplicates.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { classifyPairs, type ClassifiedPair } from '../src/core/entities/evidence/classes.ts';
import { readsAsNonPerson, sensitivityOf } from '../src/core/entities/evidence/people.ts';

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-dedupe-auto-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  for (const s of ['people-b', 'people-c']) await engine.executeRaw(`INSERT INTO sources(id,name) VALUES('${s}','${s}') ON CONFLICT DO NOTHING`);
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const person = (slug: string, title: string, frontmatter: Record<string, unknown> = {}, sourceId = 'default') =>
  engine.putPage(slug, { type: 'person', title, compiled_truth: `${title} notes.`, timeline: '', frontmatter } as never, { sourceId } as never);
async function dedupe(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runDedupe(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}
const withTitle = (pairs: ClassifiedPair[], title: string) => pairs.filter(p => p.members.some(m => m.title === title));
const one = (pairs: ClassifiedPair[], title: string) => { const found = withTitle(pairs, title); expect(found.length).toBe(1); return found[0]!; };
const identities = async () => engine.executeRaw<{ slug: string; source_id: string; entity_id: string }>(
  'SELECT p.slug, ei.source_id, ei.entity_id FROM entity_identities ei JOIN pages p ON p.id = ei.page_id ORDER BY p.slug, ei.source_id');
const doctorLine = async () => {
  const ctx = { engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext;
  const [c] = await dedupeAutoLinksEntry.run(ctx) as Array<{ name: string; status: string; message: string; details: { links: number } }>;
  return c!;
};

describe('candidates after the labelled sample', () => {
  test('a page and its mirror copy are no pair, and a third page pairs with one copy only', async () => {
    await person('people/amy-example', 'Amy Example', { email: 'amy@example.invalid', company: 'Acme Example' });
    await person('people/amy-example', 'Amy Example', { email: 'amy@example.invalid' }, 'people-b');
    await person('contacts/amy-example', 'Amy Example', {}, 'people-c');
    const { report, pairs } = await classifyPairs(engine);
    const amy = one(pairs, 'Amy Example');
    expect(amy.members.map(m => m.source_id).sort()).toEqual(['default', 'people-c']);
    expect(amy.base).toBe('C5');
    expect(report.skipped.copies).toBe(2);
  });

  test('pages under one slug in two sources that disagree stay a pair', async () => {
    await person('people/bea-example', 'Bea Example', { company: 'Acme Example' });
    await person('people/bea-example', 'Bea Example', { company: 'Beta Example' }, 'people-b');
    expect(one((await classifyPairs(engine)).pairs, 'Bea Example').base).toBe('C5');
  });

  test('an id that a page with another name also holds proves nothing; an id only one name holds still does', async () => {
    await person('people/cleo-example', 'Cleo Example', { linkedin: 'in/cleo-co' });
    await person('contacts/cleo-example', 'Cleo Example', { linkedin: 'https://linkedin.com/in/cleo-co' }, 'people-b');
    await person('people/dev-cofounder', 'Dev Cofounder', { linkedin: 'in/cleo-co' });
    await person('people/finn-example', 'Finn Example', { github: 'finn-ex' });
    await person('contacts/finn-example', 'Finn Example', { github: 'https://github.com/finn-ex' }, 'people-b');
    const { pairs } = await classifyPairs(engine);
    const cleo = withTitle(pairs, 'Cleo Example').find(p => p.members.every(m => m.title === 'Cleo Example'))!;
    expect(cleo).toMatchObject({ base: 'C6', verdict: 'wait' });
    expect(cleo.why).toContain('shared linkedin also on a page with another name');
    expect(one(pairs, 'Finn Example')).toMatchObject({ base: 'C3', verdict: 'link' });
  });

  test('a page whose title is a room, a team, a mailbox or a business never links', async () => {
    await person('people/example-team-room', 'Example Team Room', { email: 'room@example.invalid' });
    await person('contacts/example-team-room', 'Example Team Room', { email: 'room@example.invalid' }, 'people-b');
    expect(one((await classifyPairs(engine)).pairs, 'Example Team Room')).toMatchObject({ base: 'C1', verdict: 'wait', reason: 'not a person page', hold: 'not_a_person' });
    for (const t of ['Example Partners', 'Room 7', 'Acme Example Construction', 'Acme Example Inc', 'acmeclientservice']) expect(readsAsNonPerson(t)).toBe(true);
    for (const t of ['Alice Example', 'Steamboat', 'Teamore Example', 'Grace Fundy']) expect(readsAsNonPerson(t)).toBe(false);
  });

  test('a family office, family friends or someone else\'s relative is no hold on linking, but still kept from web search', async () => {
    const link = (k: Record<string, unknown>) => sensitivityOf(k, new Date('2026-11-25'), 'link');
    expect(link({ tags: ['Family Office'] })).toBeNull();
    expect(sensitivityOf({ tags: ['Family Office'] })).toBe('family');
    expect(link({ groups: ['Family friends'] })).toBeNull();
    expect(link({ relationship: 'wife of a colleague' })).toBeNull();
    expect(link({ relationship: 'school parent' })).toBeNull();
    expect(link({ relationship: "a friend's son" })).toBeNull();
    expect(sensitivityOf({ relationship: 'school parent' })).toBe('family');
    expect(link({ relationship: 'my sister' })).toBe('family');
    expect(link({ tags: ['Close Family'] })).toBe('family');
    expect(link({ family: true })).toBe('family');
    expect(link({ birth_year: 2015 })).toBe('minor');
    for (const r of ['wife of 12 years', 'mother of my kids', "my wife's sister", 'brother (friends with Bob)', 'daughter, goes to Example school', 'son-in-law']) {
      expect([r, link({ relationship: r })]).toEqual([r, 'family']);
    }
    expect(sensitivityOf({ relationship: 'son-in-law' })).toBe('family');
    expect(link({ relationship: ['spouse', 'sister of a colleague'] })).toBe('family');
    expect(link({ relationship: 'sister', relation: 'wife of Bob' })).toBe('family');
    for (const r of ['mother of Emma', 'husband of ten years', 'wife of many years', 'mother of the kids']) {
      expect([r, link({ relationship: r })]).toEqual([r, 'family']);
    }
    expect(link({ tags: ['friends-and-family'] })).toBe('family');
    const at = new Date('2026-11-25');
    expect(sensitivityOf({ birthdate: '2008-12-31' }, at, 'link')).toBe('minor');
    expect(sensitivityOf({ birthdate: new Date('2010-05-01') }, at, 'link')).toBe('minor');
    expect(sensitivityOf({ birth_year: 2008 }, at, 'link')).toBe('minor');
    expect(sensitivityOf({ birthdate: '2008-01-01' }, at, 'link')).toBeNull();
    expect(sensitivityOf({ birth_year: 2007 }, at, 'link')).toBeNull();
    await person('people/gus-example', 'Gus Example', { email: 'gus@example.invalid', tags: ['family-office'] });
    await person('contacts/gus-example', 'Gus Example', { email: 'gus@example.invalid' }, 'people-b');
    await person('people/hope-example', 'Hope Example', { email: 'hope@example.invalid', relationship: 'sister' });
    await person('contacts/hope-example', 'Hope Example', { email: 'hope@example.invalid' }, 'people-b');
    const { pairs } = await classifyPairs(engine);
    expect(one(pairs, 'Gus Example')).toMatchObject({ base: 'C1', verdict: 'link' });
    expect(one(pairs, 'Hope Example')).toMatchObject({ base: 'C1', verdict: 'wait', reason: 'family or minor page', hold: 'family' });
  });
});

describe('gbrain dedupe auto', () => {
  let linked = '';
  test('preview links C2 pairs only and changes nothing; a family page and a page in two pairs are left out', async () => {
    await person('people/hal-example', 'Hal Example', { phone: '+1 555-555-0201' });
    await person('contacts/hal-card', 'halcard', { phones: ['(555) 555-0201'] }, 'people-c');
    await person('people/ivo-example', 'Ivo Example', { phone: '+1 555-555-0202', tags: ['Family'] });
    await person('contacts/ivo-card', 'Ivan Card', { phone: '+1 555-555-0202' }, 'people-c');
    await person('people/jo-example', 'Jo Example', { phones: ['+1 555-555-0203', '+1 555-555-0204'] });
    await person('contacts/jo-one', 'jayone', { phone: '+1 555-555-0203' }, 'people-b');
    await person('contacts/jo-two', 'jaytwo', { phone: '+1 555-555-0204' }, 'people-c');
    const before = await identities();
    const plan = JSON.parse(await dedupe(['auto', '--json']));
    expect(plan).toMatchObject({ mode: 'preview', switches: { C2: 'on' } });
    expect(plan.links.map((l: any) => l.members.map((m: any) => m.slug).sort())).toEqual([['contacts/hal-card', 'people/hal-example']]);
    expect(plan.links[0]).toMatchObject({ class: 'C2', canonical: { source_id: 'default', slug: 'people/hal-example' } });
    expect(plan.set_aside.map((s: any) => s.reason)).toEqual(['shared_member', 'shared_member']);
    expect(await identities()).toEqual(before);
    expect((await engine.listIdentityDecisions()).decisions).toHaveLength(0);
  });

  test('--apply records one undoable decision per pair, links the pages, and a second run finds nothing new', async () => {
    const text = await dedupe(['auto', '--apply']);
    const decisions = (await engine.listIdentityDecisions()).decisions;
    expect(decisions).toHaveLength(1);
    linked = decisions[0]!.decision_id;
    expect(decisions[0]).toMatchObject({ verdict: 'same', decided_by: 'dedupe:auto:C2', entity_id: `person-${linked}` });
    expect(text).toContain(`undo: gbrain dedupe undo ${linked}`);
    expect((await identities()).filter(r => r.entity_id === `person-${linked}`).map(r => r.slug).sort()).toEqual(['contacts/hal-card', 'people/hal-example']);
    expect(JSON.parse(await dedupe(['auto', '--json'])).links).toEqual([]);
  });

  test('the doctor line and the weekly sample read the recorded links', async () => {
    const line = await doctorLine();
    expect(line).toMatchObject({ name: 'dedupe_auto_links', status: 'ok', details: { links: 1 } });
    expect(line.message).toContain(`C2 1 (undo: gbrain dedupe undo ${linked}; a wrong one for good: gbrain dedupe reject <identity id>; all of them: gbrain dedupe auto --off C2)`);
    expect(await dedupe(['sample', '--class', 'C2', '--since', '7d'])).toContain(`keep it apart for good: gbrain dedupe reject person-${linked}`);
    const sample = JSON.parse(await dedupe(['sample', '--class', 'C2', '--since', '7d', '--json']));
    expect(sample).toMatchObject({ class: 'C2', total: 1, n: 20 });
    expect(sample.links[0].decision).toBe(linked);
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await dedupe(['sample', '--class', 'C5', '--since', '7d', '--json'])).toBe('');
      expect(String(err.mock.calls[0]?.[0])).toContain('with --since, pass --class with one of the automatic classes: C2');
    } finally { err.mockRestore(); setCliExitVerdict(0); }
  });

  test('undo unlinks and a later run links again; reject keeps the pair apart for good', async () => {
    await dedupe(['undo', linked]);
    expect((await identities()).some(r => r.entity_id === `person-${linked}`)).toBe(false);
    await dedupe(['auto', '--apply']);
    expect((await identities()).filter(r => r.entity_id === `person-${linked}`)).toHaveLength(2);
    await dedupe(['reject', `person-${linked}`]);
    expect((await identities()).some(r => r.entity_id === `person-${linked}`)).toBe(false);
    expect(JSON.parse(await dedupe(['auto', '--json'])).links).toEqual([]);
  });

  test('--off removes every link of the class and stops it; --on starts it again', async () => {
    await person('people/kai-example', 'Kai Example', { email: 'kai@example.invalid' });
    await person('contacts/kai-card', 'kaiwork', { email: 'kai@example.invalid' }, 'people-c');
    await dedupe(['auto', '--apply']);
    const kai = (await engine.listIdentityDecisions()).decisions.find(d => d.decided_by === 'dedupe:auto:C2' && d.verdict === 'same')!;
    expect(kai.members.map(m => m.slug).sort()).toEqual(['contacts/kai-card', 'people/kai-example']);
    const off = JSON.parse(await dedupe(['auto', '--off', 'c2', '--json']));
    expect(off).toEqual({ class: 'C2', switch: 'off', removed: [kai.decision_id] });
    expect((await identities()).some(r => r.slug === 'people/kai-example')).toBe(false);
    expect(JSON.parse(await dedupe(['auto', '--json']))).toMatchObject({ switches: { C2: 'off' }, links: [] });
    await dedupe(['auto', '--on', 'C2']);
    expect(JSON.parse(await dedupe(['auto', '--apply', '--json'])).links).toHaveLength(1);
  });

  test('a page in two pairs is set aside whatever --source a run names, and a page already in a group takes no new page', async () => {
    await person('people/max-example', 'Max Example', { phone: '+1 555-555-0301', email: 'max@example.invalid' });
    await person('contacts/max-b', 'mo.other', { phone: '+1 555-555-0301' }, 'people-b');
    await person('contacts/max-c', 'zedother', { email: 'max@example.invalid' }, 'people-c');
    const scoped = JSON.parse(await dedupe(['auto', '--source', 'people-b', '--apply', '--json']));
    expect(scoped.links).toEqual([]);
    expect(scoped.set_aside).toContainEqual(expect.objectContaining({ reason: 'shared_member', members: [{ source_id: 'default', slug: 'people/max-example' }, { source_id: 'people-b', slug: 'contacts/max-b' }] }));
    await person('people/nia-example', 'Nia Example', { phone: '+1 555-555-0302', email: 'nia@example.invalid' });
    await person('contacts/nia-b', 'nellb', { phone: '+1 555-555-0302' }, 'people-b');
    expect(JSON.parse(await dedupe(['auto', '--apply', '--json'])).links.map((l: any) => l.members.map((m: any) => m.slug).sort())).toEqual([['contacts/nia-b', 'people/nia-example']]);
    await person('contacts/nia-c', 'norac', { email: 'nia@example.invalid' }, 'people-c');
    const later = JSON.parse(await dedupe(['auto', '--apply', '--json']));
    expect(later.links).toEqual([]);
    expect(later.set_aside).toContainEqual(expect.objectContaining({ reason: 'in_group', members: [{ source_id: 'default', slug: 'people/nia-example' }, { source_id: 'people-c', slug: 'contacts/nia-c' }] }));
    expect((await identities()).some(r => r.slug === 'contacts/nia-c')).toBe(false);
  });

  test('two full names that disagree, a restricted page, and a contact matching two pages under one slug that are not copies are held', async () => {
    await person('people/rex-example', 'Rex Example', { email: 'rex@example.invalid' });
    await person('contacts/rex-card', 'Rita Sample', { email: 'rex@example.invalid' }, 'people-c');
    await person('people/sol-example', 'Sol Example', { email: 'sol@example.invalid', readable_by: ['alice-example'] });
    await person('contacts/sol-card', 'solcard', { email: 'sol@example.invalid' }, 'people-c');
    await person('people/pat-example', 'Pat Example', { email: 'pat.one@example.invalid' });
    await person('people/pat-example', 'Pat Example', { email: 'pat.two@example.invalid' }, 'people-b');
    await person('people/pat-example', 'Pat Example', {}, 'people-c');
    await person('contacts/pat-card', 'patcard', { emails: ['pat.one@example.invalid', 'pat.two@example.invalid'] }, 'people-c');
    const { pairs } = await classifyPairs(engine);
    expect(one(pairs, 'Rex Example')).toMatchObject({ base: 'C2', hold: 'names_disagree' });
    expect(one(pairs, 'Sol Example')).toMatchObject({ base: 'C2', hold: 'restricted' });
    expect(withTitle(pairs, 'patcard').map(p => p.members.map(m => m.source_id).sort().join('+')).sort()).toEqual(['default+people-c', 'people-b+people-c']);
    const plan = JSON.parse(await dedupe(['auto', '--json']));
    const slugs = plan.links.flatMap((l: any) => l.members.map((m: any) => m.slug));
    for (const s of ['people/rex-example', 'people/sol-example', 'contacts/pat-card']) expect([s, slugs.includes(s)]).toEqual([s, false]);
    expect(plan.set_aside.filter((s: any) => s.members.some((m: any) => m.slug === 'contacts/pat-card')).map((s: any) => s.reason)).toEqual(['shared_member', 'shared_member']);
  });
});

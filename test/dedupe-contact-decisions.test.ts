/**
 * gbrain dedupe decide (GST-3609): the owner's own choices for the Google Contacts that wait for a person. One run reads a
 * choices file and, per contact, links it to the one candidate chosen, makes a new person page and links it, records it
 * as a different person from each listed candidate (pairwise only), marks it as not a person, or skips it; each line names
 * the command that undoes it. link-contacts' dry run lists the waiting contacts with what matched (email or phone, never
 * the value). Both stores: the database on a brain with no repository, git on one with a repository, where the decisions
 * survive a database rebuilt from git. Made-up names and .invalid addresses only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import { listEntityIdentities } from '../src/core/entity-identity.ts';
import { readIdentityReviews } from '../src/core/apple-contacts/identity-match.ts';
import { linkGoogleContacts, unlinkGoogleContactPage } from '../src/core/google/contact-identity.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { performSync } from '../src/commands/sync.ts';
import { decisionId, IDENTITY_DIR } from '../src/core/entities/identity-decisions.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ref = (source_id: string, slug: string) => ({ source_id, slug });

function harness(get: () => BrainEngine, dir: () => string) {
  const page = (slug: string, title: string, frontmatter: Record<string, unknown>, sourceId = 'default') =>
    get().putPage(slug, { type: 'person', title, compiled_truth: `${title} notes.`, timeline: '', frontmatter } as never, { sourceId } as never);
  const contact = (id: string, title: string, emails: string[], phones: string[] = []) =>
    page(`people/${id}`, title, { google_contact_id: `people/${id}`, emails, ...(phones.length ? { phones } : {}) }, 'gc');
  const linkOf = async (slug: string, sourceId: string) => (await listEntityIdentities(get(), { slug, slugSourceId: sourceId })).find(m => m.slug === slug && m.source_id === sourceId) ?? null;
  async function dedupe(args: string[]): Promise<string> {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try { await runDedupe(get(), args); } finally { spy.mockRestore(); }
    return lines.join('\n');
  }
  const json = async (args: string[]) => JSON.parse(await dedupe([...args, '--json']));
  let n = 0;
  const choices = (lines: unknown[]) => { const f = join(dir(), `choices-${++n}.json`); writeFileSync(f, JSON.stringify(lines)); return f; };
  const decisions = () => get().executeRaw<{ decision_id: string; verdict: string; origin: string; members: unknown }>(
    'SELECT decision_id, verdict, origin, members FROM entity_identity_reviews ORDER BY decision_id');
  const waiting = async () => ((await json(['link-contacts', '--source', 'gc'])).reviews as Array<{ contact_slug: string; reason: string; candidates: Array<{ candidate: string; matched: string[] }> }>)
    .map(r => [r.contact_slug, r.reason, r.candidates.map(c => [c.candidate, c.matched])]);
  return { page, contact, linkOf, dedupe, json, choices, decisions, waiting };
}

describe('without a repository', () => {
  let home: string;
  let engine: BrainEngine;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-contact-decisions-'));
    engine = await connectTemplateBrain(join(home, 'database'));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('people-b','people-b') ON CONFLICT DO NOTHING");
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('gc','gc','{"kind":"google"}'::jsonb) ON CONFLICT DO NOTHING`);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
  const h = harness(() => engine, () => home);

  test('the dry run lists each waiting contact with its candidates and what matched, never the value, and writes nothing', async () => {
    await h.page('people/alice-example', 'Alice Example', { email: 'alice@example.invalid' });
    await h.page('people/alice-sample', 'Alice Sample', { phones: ['+1 555-555-0110'] }, 'people-b');
    await h.contact('c-alice', 'Alice Example', ['alice@example.invalid'], ['(555) 555-0110']);
    await h.page('people/bob-example', 'Bob Example', { email: 'bob@example.invalid' });
    await h.page('people/bob-other', 'Bob Example', { email: 'bob@example.invalid' }, 'people-b');
    await h.contact('c-bob', 'Bob Example', ['bob@example.invalid']);
    await h.page('people/carol-example', 'Carol Example', { email: 'noreply@acme.invalid' });
    await h.contact('c-noreply', 'Acme Notifications', ['noreply@acme.invalid']);
    await h.page('people/dana-a', 'Dana Example', { email: 'dana@example.invalid' });
    await h.page('people/dana-b', 'Dana Example', { email: 'dana@example.invalid' }, 'people-b');
    await h.contact('c-dana', 'Dana Example', ['dana@example.invalid']);
    await h.page('people/erin-a', 'Erin Example', { email: 'erin@example.invalid' });
    await h.page('people/erin-b', 'Erin Example', { email: 'erin@example.invalid' }, 'people-b');
    await h.contact('c-erin', 'Erin Example', ['erin@example.invalid']);
    await h.page('people/gina-a', 'Gina Example', { email: 'gina@example.invalid' });
    await h.page('people/gina-b', 'Gina Example', { email: 'gina@example.invalid' }, 'people-b');
    await h.contact('c-gina', 'Gina Example', ['gina@example.invalid']);

    const dry = await h.json(['link-contacts', '--source', 'gc']);
    expect(dry).toMatchObject({ mode: 'dry_run', contacts: 6, waiting: 5, name_disagrees: 1, ignored: 0 });
    expect(await h.waiting()).toEqual([
      ['people/c-alice', 'several_people', [['default:people/alice-example', ['email']], ['people-b:people/alice-sample', ['phone']]]],
      ['people/c-bob', 'several_people', [['default:people/bob-example', ['email']], ['people-b:people/bob-other', ['email']]]],
      ['people/c-dana', 'several_people', [['default:people/dana-a', ['email']], ['people-b:people/dana-b', ['email']]]],
      ['people/c-erin', 'several_people', [['default:people/erin-a', ['email']], ['people-b:people/erin-b', ['email']]]],
      ['people/c-gina', 'several_people', [['default:people/gina-a', ['email']], ['people-b:people/gina-b', ['email']]]],
      ['people/c-noreply', 'name_disagrees', [['default:people/carol-example', ['email']]]],
    ]);
    expect(JSON.stringify(dry.reviews)).not.toMatch(/@|555/);
    expect(await h.decisions()).toEqual([]);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM entity_identities'))[0]!.n).toBe(0);
    expect(await readIdentityReviews(engine, 'gc')).toEqual([]);
    await h.dedupe(['link-contacts', '--source', 'gc', '--apply']);
    expect((await readIdentityReviews(engine, 'gc')).map(r => r.slug)).toEqual(['people/c-alice', 'people/c-bob', 'people/c-dana', 'people/c-erin', 'people/c-gina', 'people/c-noreply']);
  });

  const file = () => h.choices([
    { contact_slug: 'people/c-alice', action: 'reject', candidate: 'default:people/alice-example' },
    { contact_slug: 'people/c-bob', action: 'reject' },
    { contact_slug: 'people/c-noreply', action: 'ignore' },
    { contact_slug: 'people/c-dana', action: 'new' },
    { contact_slug: 'people/c-erin', action: 'link', candidate: 'people-b:people/erin-b' },
    { contact_slug: 'people/c-gina', action: 'skip' },
  ]);
  const alice = ref('gc', 'people/c-alice'), bob = ref('gc', 'people/c-bob'), noreply = ref('gc', 'people/c-noreply');
  const ids = {
    alice: decisionId([alice, ref('default', 'people/alice-example')]),
    bob1: decisionId([bob, ref('default', 'people/bob-example')]), bob2: decisionId([bob, ref('people-b', 'people/bob-other')]),
    noreply: decisionId([noreply]),
    dana: decisionId([ref('gc', 'people/c-dana'), ref('default', 'people/dana-example')]),
    erin: decisionId([ref('gc', 'people/c-erin'), ref('people-b', 'people/erin-b')]),
  };

  test('--dry-run prints what each line would do and its undo command, and writes nothing', async () => {
    const pagesBefore = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
    const dry = await h.json(['decide', '--source', 'gc', '--file', file(), '--dry-run']);
    expect(dry.mode).toBe('dry_run');
    expect(dry.lines.map((l: { contact_slug: string; action: string; status: string; decisions: string[] }) => [l.contact_slug, l.action, l.status, l.decisions])).toEqual([
      ['people/c-alice', 'reject', 'would_record', [ids.alice]],
      ['people/c-bob', 'reject', 'would_record', [ids.bob1, ids.bob2].sort()],
      ['people/c-noreply', 'ignore', 'would_record', [ids.noreply]],
      ['people/c-dana', 'new', 'would_record', [ids.dana]],
      ['people/c-erin', 'link', 'would_record', [ids.erin]],
      ['people/c-gina', 'skip', 'skipped', []],
    ]);
    expect(dry.lines[3].page).toBe('default:people/dana-example');
    expect(dry.lines[1].undo).toEqual([`gbrain dedupe undo ${[ids.bob1, ids.bob2].sort().join(' ')}`]);
    expect(dry.lines[3].undo).toEqual([`gbrain dedupe undo ${ids.dana}`, 'gbrain delete people/dana-example --source default']);
    expect(await h.decisions()).toEqual([]);
    expect(await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages')).toEqual(pagesBefore);
    const text = await h.dedupe(['decide', '--source', 'gc', '--file', file(), '--dry-run']);
    expect(text).toContain('Dry run: nothing was written.');
    expect(text).toContain(`undo: gbrain dedupe undo ${ids.noreply}`);
  });

  test('decide records each line in the database: a pairwise reject of both clears a contact, of one leaves it waiting on the other; ignore stops re-proposal; new makes the page and links it; link joins exactly that pair', async () => {
    const out = await h.json(['decide', '--source', 'gc', '--file', file()]);
    expect(out.store).toBe('database');
    expect(out.lines.map((l: { status: string }) => l.status)).toEqual(['recorded', 'recorded', 'recorded', 'recorded', 'recorded', 'skipped']);
    const rows = await h.decisions();
    expect(rows.map(r => [r.decision_id, r.verdict, r.origin])).toEqual([
      [ids.alice, 'different', 'database'], [ids.bob1, 'different', 'database'], [ids.bob2, 'different', 'database'],
      [ids.noreply, 'different', 'database'], [ids.dana, 'same', 'database'], [ids.erin, 'same', 'database'],
    ].sort((a, b) => a[0]!.localeCompare(b[0]!)));

    const dana = await engine.getPage('people/dana-example', { sourceId: 'default' });
    expect({ type: dana?.type, title: dana?.title }).toEqual({ type: 'person', title: 'Dana Example' });
    expect((await h.linkOf('people/c-dana', 'gc'))?.entity_id).toBe((await h.linkOf('people/dana-example', 'default'))!.entity_id);
    const erin = await h.linkOf('people/c-erin', 'gc');
    expect(erin?.established_by).toBe('dedupe:confirm');
    expect(erin?.entity_id).toBe((await h.linkOf('people/erin-b', 'people-b'))!.entity_id);
    expect(await h.linkOf('people/erin-a', 'default')).toBeNull();

    expect(await h.waiting()).toEqual([
      ['people/c-alice', 'several_people', [['people-b:people/alice-sample', ['phone']]]],
      ['people/c-gina', 'several_people', [['default:people/gina-a', ['email']], ['people-b:people/gina-b', ['email']]]],
    ]);
    const counts = await h.json(['link-contacts', '--source', 'gc']);
    expect(counts).toMatchObject({ waiting: 2, name_disagrees: 0, ignored: 1, rejected: 1, other_writer: 2 });
    expect((await readIdentityReviews(engine, 'gc')).filter(r => !r.decided).map(r => r.slug)).toEqual(['people/c-alice', 'people/c-gina']);
    await h.dedupe(['link-contacts', '--source', 'gc', '--apply']);
    expect(await h.linkOf('people/c-alice', 'gc')).toBeNull();
    expect(await h.linkOf('people/c-noreply', 'gc')).toBeNull();
  });

  test('a line that cannot apply is set aside with its reason and the rest still record', async () => {
    const out = await h.json(['decide', '--source', 'gc', '--file', h.choices([
      { contact_slug: 'people/c-nobody', action: 'ignore' },
      { contact_slug: 'people/c-gina', action: 'link' },
      { contact_slug: 'people/c-gina', action: 'link', candidate: 'default:people/missing' },
      { contact_slug: 'people/c-gina', action: 'merge' },
      { contact_slug: 'people/c-gina', action: 'reject', candidate: 'default:people/gina-a' },
    ])]);
    expect(out.lines.map((l: { status: string; reason?: string }) => [l.status, l.reason ?? null])).toEqual([
      ['refused', 'unknown_contact'], ['refused', 'candidate_required'], ['refused', 'unknown_candidate'], ['refused', 'unknown_action'], ['recorded', null],
    ]);
    expect(await h.waiting()).toContainEqual(['people/c-gina', 'several_people', [['people-b:people/gina-b', ['email']]]]);
  });

  test('undo removes a decision: the ignored contact is proposed again and the linked one is unlinked', async () => {
    const out = await h.json(['undo', ids.noreply, ids.erin]);
    expect(out.removed).toEqual([ids.noreply, ids.erin]);
    expect((await h.decisions()).map(r => r.decision_id)).not.toContain(ids.noreply);
    expect(await h.linkOf('people/c-erin', 'gc')).toBeNull();
    const again = (await h.waiting()).map(r => r[0]);
    expect(again).toContain('people/c-noreply');
    expect(again).toContain('people/c-erin');
    await expect(h.dedupe(['undo', ids.noreply])).rejects.toMatchObject({ code: 'dedupe_decision_unknown' });
  });
});

describe('one person mirrored into other sources', () => {
  let home: string;
  let engine: BrainEngine;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-contact-mirrors-'));
    engine = await connectTemplateBrain(join(home, 'database'));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('mirror-b','mirror-b','{"mirror_read_only":true}'::jsonb), ('mirror-c','mirror-c','{"mirror_read_only":true}'::jsonb) ON CONFLICT DO NOTHING`);
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('gc','gc','{"kind":"google"}'::jsonb) ON CONFLICT DO NOTHING`);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
  const h = harness(() => engine, () => home);
  const ids = (slug: string) => engine.executeRaw<{ source_id: string; entity_id: string; canonical: boolean; established_by: string }>(
    'SELECT ei.source_id, ei.entity_id, ei.canonical, ei.established_by FROM entity_identities ei JOIN pages p ON p.id = ei.page_id WHERE p.slug = $1 ORDER BY ei.source_id', [slug]);

  test('copies of one page in other sources that carry the same matched key and name are one person: the contact links to all of them, canonical in the default source', async () => {
    for (const s of ['default', 'mirror-b', 'mirror-c']) await h.page('people/hank-example', 'Hank Example', { email: 'hank@example.invalid' }, s);
    await h.contact('c-hank', 'Hank Example', ['hank@example.invalid']);
    expect(await h.json(['link-contacts', '--source', 'gc'])).toMatchObject({ linked: 1, waiting: 0 });
    await h.dedupe(['link-contacts', '--source', 'gc', '--apply']);
    const rows = await ids('people/hank-example');
    const contact = await ids('people/c-hank');
    expect(rows.map(r => [r.source_id, r.canonical, r.established_by])).toEqual([
      ['default', true, 'google-contacts'], ['mirror-b', false, 'google-contacts'], ['mirror-c', false, 'google-contacts']]);
    expect(new Set([...rows, ...contact].map(r => r.entity_id)).size).toBe(1);
    expect(contact.map(r => r.source_id)).toEqual(['gc']);
    await h.dedupe(['link-contacts', '--source', 'gc', '--unlink']);
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM entity_identities'))[0]!.n).toBe(0);
  });

  test('a copy that carries a different email is another candidate, so the contact waits on both', async () => {
    await h.page('people/ivy-example', 'Ivy Example', { email: 'ivy@example.invalid' });
    await h.page('people/ivy-example', 'Ivy Example', { email: 'ivy.old@example.invalid' }, 'mirror-b');
    await h.contact('c-ivy', 'Ivy Example', ['ivy@example.invalid', 'ivy.old@example.invalid']);
    expect(await h.waiting()).toContainEqual(['people/c-ivy', 'several_people', [['default:people/ivy-example', ['email']], ['mirror-b:people/ivy-example', ['email']]]]);
    expect((await ids('people/c-ivy'))).toEqual([]);
  });

  test('the review list shows a mirror set as one person, and decide link joins the contact to the whole set', async () => {
    await h.page('people/jo-example', 'Jo Example', { email: 'jo@example.invalid' });
    await h.page('people/jo-example', 'Jo Example', { email: 'jo@example.invalid' }, 'mirror-b');
    await h.page('people/jo-other', 'Jo Other', { email: 'jo@example.invalid' });
    await h.contact('c-jo', 'Jo Example', ['jo@example.invalid']);
    const review = ((await h.json(['link-contacts', '--source', 'gc'])).reviews as Array<{ contact_slug: string; candidates: Array<{ candidate: string; mirrors?: string[] }> }>)
      .find(r => r.contact_slug === 'people/c-jo')!;
    expect(review.candidates.map(c => [c.candidate, c.mirrors ?? []])).toEqual([
      ['default:people/jo-example', ['mirror-b:people/jo-example']], ['default:people/jo-other', []]]);
    const out = await h.json(['decide', '--source', 'gc', '--file', h.choices([{ contact_slug: 'people/c-jo', action: 'link', candidate: 'default:people/jo-example' }])]);
    expect(out.lines[0].decisions).toEqual([decisionId([ref('gc', 'people/c-jo'), ref('default', 'people/jo-example'), ref('mirror-b', 'people/jo-example')])]);
    const entity = (await ids('people/c-jo'))[0]!.entity_id;
    expect((await ids('people/jo-example')).map(r => [r.source_id, r.entity_id, r.canonical])).toEqual([['default', entity, true], ['mirror-b', entity, false]]);
    expect(await ids('people/jo-other')).toEqual([]);
  });

  test('unlinking a contact of one Google source keeps the link another Google source made to the same person', async () => {
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('gc2','gc2','{"kind":"google"}'::jsonb) ON CONFLICT DO NOTHING`);
    await h.page('people/kim-example', 'Kim Example', { email: 'kim@example.invalid' });
    await h.contact('c-kim', 'Kim Example', ['kim@example.invalid']);
    await h.page('people/c-kim2', 'Kim Example', { google_contact_id: 'people/c-kim2', emails: ['kim@example.invalid'] }, 'gc2');
    await linkGoogleContacts(engine, 'gc', { apply: true, slugs: ['people/c-kim'] });
    await linkGoogleContacts(engine, 'gc2', { apply: true, slugs: ['people/c-kim2'] });
    const entity = (await ids('people/kim-example'))[0]!.entity_id;
    expect((await ids('people/c-kim2'))[0]?.entity_id).toBe(entity);
    await unlinkGoogleContactPage(engine, 'gc', 'people/c-kim');
    expect(await ids('people/c-kim')).toEqual([]);
    expect((await ids('people/c-kim2'))[0]?.entity_id).toBe(entity);
    expect((await ids('people/kim-example'))[0]?.entity_id).toBe(entity);
  });

  test('copies the owner recorded as different people are two candidates, never collapsed into one group', async () => {
    await h.page('people/lee-example', 'Lee Example', { email: 'lee@example.invalid' });
    await h.page('people/lee-example', 'Lee Example', { email: 'lee@example.invalid' }, 'mirror-b');
    await engine.applyIdentityDecisions({ upsert: [{ decision_id: decisionId([ref('default', 'people/lee-example'), ref('mirror-b', 'people/lee-example')]), verdict: 'different',
      members: [ref('default', 'people/lee-example'), ref('mirror-b', 'people/lee-example')], group_id: null, entity_id: null, canonical: null, decided_by: 'owner',
      origin: 'database', home_source_id: null, git_blob: null }] });
    await h.contact('c-lee', 'Lee Example', ['lee@example.invalid']);
    await h.dedupe(['link-contacts', '--source', 'gc', '--apply']);
    expect(await ids('people/c-lee')).toEqual([]);
    expect(await ids('people/lee-example')).toEqual([]);
    expect((await readIdentityReviews(engine, 'gc')).find(r => r.slug === 'people/c-lee')).toEqual(expect.objectContaining({
      candidates: [ref('default', 'people/lee-example'), ref('mirror-b', 'people/lee-example')], decided: 'different' }));
  });

  test('a contact left with one candidate after a pairwise reject keeps waiting, even when that candidate is in another decision', async () => {
    await h.page('people/max-a', 'Max Example', { email: 'max@example.invalid' });
    await h.page('people/max-b', 'Max Example', { email: 'max@example.invalid' }, 'mirror-b');
    await h.page('people/max-c', 'Max Other', { email: 'max.c@example.invalid' }, 'mirror-c');
    await h.contact('c-max', 'Max Example', ['max@example.invalid']);
    await h.json(['decide', '--source', 'gc', '--file', h.choices([{ contact_slug: 'people/c-max', action: 'reject', candidate: 'default:people/max-a' }])]);
    await engine.applyIdentityDecisions({ upsert: [{ decision_id: decisionId([ref('mirror-b', 'people/max-b'), ref('mirror-c', 'people/max-c')]), verdict: 'different',
      members: [ref('mirror-b', 'people/max-b'), ref('mirror-c', 'people/max-c')], group_id: null, entity_id: null, canonical: null, decided_by: 'owner',
      origin: 'database', home_source_id: null, git_blob: null }] });
    await h.dedupe(['link-contacts', '--source', 'gc', '--apply']);
    expect((await readIdentityReviews(engine, 'gc')).find(r => r.slug === 'people/c-max')).toEqual(expect.objectContaining({ candidates: [ref('mirror-b', 'people/max-b')] }));
    expect((await readIdentityReviews(engine, 'gc')).find(r => r.slug === 'people/c-max')?.decided).toBeUndefined();
    expect(await h.waiting()).toContainEqual(['people/c-max', 'several_people', [['mirror-b:people/max-b', ['email']]]]);
  });
});

describe('with a repository', () => {
  let engine: BrainEngine;
  let root: string;
  let dir: string;
  beforeAll(async () => {
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    await hasPendingMigrations(pglite);
    engine = pglite;
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('gc','gc','{"kind":"google"}'::jsonb) ON CONFLICT DO NOTHING`);
    dir = mkdtempSync(join(tmpdir(), 'gbrain-contact-decisions-git-'));
    root = join(dir, 'repo');
    mkdirSync(join(root, 'people'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'Test');
    for (const [slug, title, email] of [['alice-example', 'Alice Example', 'alice@example.invalid'], ['alice-sample', 'Alice Sample', 'alice@example.invalid'],
      ['bob-example', 'Bob Example', 'bob@example.invalid'], ['bob-other', 'Bob Other', 'bob@example.invalid']]) {
      writeFileSync(join(root, 'people', `${slug}.md`), `---\ntype: person\ntitle: ${title}\nemail: ${email}\n---\n${title} notes.\n`);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'pages');
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
    await syncHome();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });
  const syncHome = () => performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true, concurrency: 1 });
  const h = harness(() => engine, () => dir);
  const committed = (id: string) => git(root, 'show', `HEAD:${IDENTITY_DIR}/${id}.md`);

  test('decisions are committed to git in one commit, survive a database rebuilt from git, and undo removes the file', async () => {
    await h.contact('c-alice', 'Alice Example', ['alice@example.invalid']);
    await h.contact('c-bob', 'Bob Example', ['bob@example.invalid']);
    await h.contact('c-carol', 'Carol Example', ['alice@example.invalid']);
    await h.contact('c-dan', 'Dan Sample', ['bob@example.invalid']);
    const commits = Number(git(root, 'rev-list', '--count', 'HEAD'));
    const out = await h.json(['decide', '--source', 'gc', '--file', h.choices([
      { contact_slug: 'people/c-alice', action: 'link', candidate: 'default:people/alice-example' },
      { contact_slug: 'people/c-bob', action: 'reject', candidate: 'default:people/bob-example' },
      { contact_slug: 'people/c-carol', action: 'ignore' },
      { contact_slug: 'people/c-dan', action: 'new' },
    ])]);
    expect(out.store).toBe('git');
    expect(Number(git(root, 'rev-list', '--count', 'HEAD'))).toBe(commits + 1);
    const link = decisionId([ref('gc', 'people/c-alice'), ref('default', 'people/alice-example')]);
    const reject = decisionId([ref('gc', 'people/c-bob'), ref('default', 'people/bob-example')]);
    const ignore = decisionId([ref('gc', 'people/c-carol')]);
    expect(git(root, 'show', 'HEAD:people/dan-sample.md')).toContain('title: Dan Sample');
    expect(committed(link)).toContain('verdict: same');
    expect(committed(reject)).toContain('verdict: different');
    expect(committed(ignore)).toContain('verdict: different');
    expect(git(root, 'status', '--porcelain')).toBe('');
    const recorded = await h.decisions();
    expect(recorded.map(r => r.origin)).toEqual(['git', 'git', 'git', 'git']);
    const before = await h.waiting();
    expect(before).toEqual([['people/c-bob', 'several_people', [['default:people/bob-other', ['email']]]]]);

    await engine.executeRaw('DELETE FROM entity_identity_reviews');
    await engine.executeRaw('DELETE FROM entity_identities');
    await engine.executeRaw("DELETE FROM pages WHERE source_id = 'default' AND slug = 'people/dan-sample'");
    await syncHome();
    expect(await h.decisions()).toEqual(recorded);
    expect((await h.linkOf('people/c-alice', 'gc'))?.entity_id).toBe((await h.linkOf('people/alice-example', 'default'))!.entity_id);
    expect(await h.waiting()).toEqual(before);
    expect((await h.linkOf('people/c-dan', 'gc'))?.entity_id).toBe((await h.linkOf('people/dan-sample', 'default'))!.entity_id);

    const undone = await h.json(['undo', ignore]);
    expect(undone).toMatchObject({ removed: [ignore], store: 'git' });
    expect(() => committed(ignore)).toThrow();
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect((await h.decisions()).map(r => r.decision_id)).not.toContain(ignore);
    expect((await h.waiting()).map(r => r[0])).toContain('people/c-carol');
  });

  test('new for contacts whose names have no letters or digits makes one page per contact, never people/.md', async () => {
    await h.contact('c-party', '🎉🎉', ['party@example.invalid']);
    await h.contact('c-bang', '!!!', ['bang@example.invalid']);
    const out = await h.json(['decide', '--source', 'gc', '--file', h.choices([
      { contact_slug: 'people/c-party', action: 'new' },
      { contact_slug: 'people/c-bang', action: 'new' },
    ])]);
    expect(out.lines.map((l: { status: string }) => l.status)).toEqual(['recorded', 'recorded']);
    const made = out.lines.map((l: { page: string }) => l.page.replace(/^default:/, '')) as string[];
    expect(new Set(made).size).toBe(2);
    for (const slug of made) expect(slug).toMatch(/^people\/[a-z0-9][a-z0-9-]*$/);
    expect(() => git(root, 'show', 'HEAD:people/.md')).toThrow();
    for (const slug of made) expect(git(root, 'show', `HEAD:${slug}.md`)).toContain('type: person');
    const party = (await h.linkOf('people/c-party', 'gc'))?.entity_id;
    const bang = (await h.linkOf('people/c-bang', 'gc'))?.entity_id;
    expect(party).toBeTruthy();
    expect(bang).toBeTruthy();
    expect(party).not.toBe(bang);
    expect(party).toBe((await h.linkOf(made[0]!, 'default'))?.entity_id);
    expect(bang).toBe((await h.linkOf(made[1]!, 'default'))?.entity_id);
  });
});

describe('a decide line that would quietly undo an earlier choice is refused', () => {
  let home: string;
  let engine: BrainEngine;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-contact-decide-guards-'));
    engine = await connectTemplateBrain(join(home, 'database'));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('gc','gc','{"kind":"google"}'::jsonb) ON CONFLICT DO NOTHING`);
    await h.page('people/hana-a', 'Hana Example', { emails: ['hana@example.invalid'] });
    await h.page('people/hana-b', 'Hana Example', { emails: ['hana@example.invalid'] });
    await h.contact('c-hana', 'Hana Example', ['hana@example.invalid']);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
  const h = harness(() => engine, () => home);
  const pair = decisionId([ref('gc', 'people/c-hana'), ref('default', 'people/hana-a')]);

  test('link to a candidate the owner rejected is refused rejected_pair, and the reject stays recorded', async () => {
    const rejected = await h.json(['decide', '--source', 'gc', '--file', h.choices([{ contact_slug: 'people/c-hana', action: 'reject', candidate: 'default:people/hana-a' }])]);
    expect(rejected.lines[0].status).toBe('recorded');
    const out = await h.json(['decide', '--source', 'gc', '--file', h.choices([{ contact_slug: 'people/c-hana', action: 'link', candidate: 'default:people/hana-a' }])]);
    expect([out.lines[0].status, out.lines[0].reason]).toEqual(['refused', 'rejected_pair']);
    expect(out.lines[0].message).toContain(`gbrain dedupe undo ${pair}`);
    expect((await h.decisions()).map(r => [r.decision_id, r.verdict])).toEqual([[pair, 'different']]);
    expect(await h.linkOf('people/c-hana', 'gc')).toBeNull();
  });

  test('reject naming the contact itself is refused invalid_candidate and records nothing', async () => {
    const before = (await h.decisions()).map(r => r.decision_id);
    const out = await h.json(['decide', '--source', 'gc', '--file', h.choices([{ contact_slug: 'people/c-hana', action: 'reject', candidate: 'gc:people/c-hana' }])]);
    expect([out.lines[0].status, out.lines[0].reason]).toEqual(['refused', 'invalid_candidate']);
    expect((await h.decisions()).map(r => r.decision_id)).toEqual(before);
  });
});

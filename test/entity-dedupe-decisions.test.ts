/**
 * Duplicate people PR 2 (plan autoplan-20261117192252, Decisions A, B, C, E): the owner confirms and rejects the groups
 * gbrain dedupe --preview shows, the decisions are kept (in git first on a brain with a repository, in the database on
 * one without), and a confirmed group counts once.
 *
 * 1. Protects: gbrain dedupe confirm writes the decision and every identity row in one transaction (a failure on the
 *    second member writes nothing); a bulk confirm covers only clean groups and is bound to the hash it printed; a
 *    contact-only group is confirmed alone, with a hint line; conflicts are never confirmed; a page already in another
 *    group refuses unless --join names it; reject keeps the pair out of every later preview and undoes a confirm; the
 *    hand-link ops never move a confirmed member; the preview of groups nobody decided is unchanged; rank_entities and
 *    enrichment tiering count a confirmed group once, and a remote caller scoped to one source sees no member outside
 *    it; on a repository brain the decision file is committed before any row exists, a database rebuilt from git gets
 *    every decision back, a page imported later is linked on the next sync, a decision kept only in the database moves
 *    into git with reconcile (doctor reports the drift until then), a host without the checkout refuses, and a pair
 *    with a read-only source is recorded in the home source only.
 * 2. Fails when: a confirm writes part of a group; a decision lives only in the database on a repository brain; a
 *    rejected pair comes back; a confirmed person ranks twice.
 * 3. Real seams: both engines (Postgres with DATABASE_URL), real git repositories, performSync, the CLI module, the
 *    rank_entities and entity_identity ops, enrichEntity. Made-up names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { performSync } from '../src/commands/sync.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { linkEntityIdentity } from '../src/core/entity-identity.ts';
import { enrichEntity } from '../src/core/enrichment-service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { applyIdentityProjection, decisionId, IDENTITY_DIR, identityHome, planIdentityProjection, projectIdentityDecisions } from '../src/core/entities/identity-decisions.ts';
import { entityDuplicatesEntry } from '../src/commands/doctor/checks/entity-duplicates.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

for (const backend of testBackends()) describe(backend, () => {
let engine: BrainEngine;
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
let clone: { close: () => Promise<void> } | undefined;
beforeAll(async () => {
  if (backend === 'postgres') { template = await persistencePostgresTemplate(requirePostgresTestDatabase()); return; }
  const pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  engine = pglite;
}, 120_000);
afterAll(async () => {
  if (backend === 'postgres') { await clone?.close(); await template?.dispose(); return; }
  await engine.disconnect();
});
beforeEach(async () => {
  if (backend === 'postgres') {
    await clone?.close();
    const c = await template!.clone();
    engine = c.engine; clone = c;
  } else {
    await resetPgliteState(engine as PGLiteEngine);
  }
  __resetPrivateVisibilityCacheForTests();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING");
}, 60_000);

const page = (slug: string, title: string, frontmatter: Record<string, unknown>, sourceId: string, body = `${title}.`) =>
  engine.putPage(slug, { type: 'person', title, compiled_truth: body, timeline: '', frontmatter } as never, { sourceId });

async function cli(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runDedupe(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}
const cliJson = async (args: string[]) => JSON.parse(await cli([...args, '--json']));
const preview = async () => (await cliJson(['--preview'])).groups as Array<{ id: string; kind: string; class: string; members: Array<{ source_id: string; slug: string }> }>;
const groupOf = async (slug: string) => (await preview()).find(g => g.members.every(m => m.slug === slug))!.id;
const rows = async () => ({
  decisions: await engine.executeRaw<{ decision_id: string; verdict: string; origin: string; entity_id: string | null; git_blob: string | null }>(
    'SELECT decision_id, verdict, origin, entity_id, git_blob FROM entity_identity_reviews ORDER BY decision_id'),
  identities: await engine.executeRaw<{ entity_id: string; source_id: string; slug: string; established_by: string; canonical: boolean }>(
    'SELECT ei.entity_id, ei.source_id, p.slug, ei.established_by, ei.canonical FROM entity_identities ei JOIN pages p ON p.id = ei.page_id ORDER BY ei.source_id, p.slug'),
});

/** alice: clean (shared LinkedIn, same name); bob: contact-only (shared email); carol: conflict (GitHub differs); dan: weak (name only). */
async function seed(home = 'default') {
  await page('people/alice-example', 'Alice Example', { linkedin: 'https://www.linkedin.com/in/alice-example/', city: 'Springfield' }, home,
    'Alice Example works at Acme Example and has the longer page.');
  await page('people/alice-example', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example', city: 'Shelbyville' }, 'source-b');
  await page('people/bob-sample', 'Bob Sample', { email: 'bob@example.com' }, home);
  await page('people/bob-sample', 'Bob Sample', { email: 'bob@example.com' }, 'source-b');
  await page('people/carol-example', 'Carol Example', { email: 'carol@example.com', github: 'carol-example' }, home);
  await page('people/carol-example', 'Carol Example', { email: 'carol@example.com', github: 'carol-other' }, 'source-b');
  await page('people/dan-sample', 'Dan Sample', {}, home);
  await page('people/dan-sample', 'Dan Sample', {}, 'source-b');
}

const opCtx = (overrides: Partial<OperationContext> = {}) => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, ...overrides,
} as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

describe('without a repository', () => {
  test('the confirm list writes nothing, puts clean groups first and gives a contact-only group its hint line', async () => {
    await seed();
    const list = await cliJson(['confirm']);
    expect(list.entries.map((e: { id: string; bulk: boolean; contact_key_only: boolean }) => [e.bulk, e.contact_key_only]))
      .toEqual([[true, false], [false, false], [false, true]]);
    const alice = list.entries[0];
    expect(alice.members.map((m: { source_id: string }) => m.source_id)).toEqual(['default', 'source-b']);
    expect(alice.differing_fields).toEqual(['city']);
    expect(list.entries[2].hints).toEqual([{ key: 'email', role_address: false, other_pages_same_name: 0, other_pages_other_name: 0 }]);
    expect(list.entries.some((e: { id: string }) => e.id === 'conflict')).toBe(false);
    const text = await cli(['confirm']);
    expect(text).toContain('differs:  city: Springfield | Shelbyville');
    expect(text).toContain('hint:     shared email, also on 0 same-name and 0 other-name page(s); differing keys none');
    expect(await rows()).toEqual({ decisions: [], identities: [] });
  });

  test('confirm records the group and links every page in one transaction; undecided groups preview unchanged', async () => {
    await seed();
    const before = await preview();
    const alice = await groupOf('people/alice-example');
    const out = await cli(['confirm', alice]);
    expect(out).toContain('Recorded in the database (this brain has no repository).');
    const after = await rows();
    expect(after.decisions).toEqual([{ decision_id: decisionId([{ source_id: 'default', slug: 'people/alice-example' }, { source_id: 'source-b', slug: 'people/alice-example' }]),
      verdict: 'same', origin: 'database', entity_id: alice, git_blob: null }]);
    expect(after.identities).toEqual([
      { entity_id: alice, source_id: 'default', slug: 'people/alice-example', established_by: 'dedupe:confirm', canonical: true },
      { entity_id: alice, source_id: 'source-b', slug: 'people/alice-example', established_by: 'dedupe:confirm', canonical: false },
    ]);
    expect(await preview()).toEqual(before.filter(g => g.id !== alice));
  });

  test('a failure while linking the second member leaves no decision and no identity row', async () => {
    await seed();
    const alice = await groupOf('people/alice-example');
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION dedupe_test_fail() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.source_id = 'source-b' THEN RAISE EXCEPTION 'forced failure on the second member'; END IF; RETURN NEW; END $f$`);
    await engine.executeRaw('CREATE TRIGGER dedupe_test_fail BEFORE INSERT ON entity_identities FOR EACH ROW EXECUTE FUNCTION dedupe_test_fail()');
    try {
      await expect(cli(['confirm', alice])).rejects.toThrow('forced failure on the second member');
      expect(await rows()).toEqual({ decisions: [], identities: [] });
    } finally {
      await engine.executeRaw('DROP TRIGGER dedupe_test_fail ON entity_identities');
      await engine.executeRaw('DROP FUNCTION dedupe_test_fail()');
    }
  });

  test('refusals: unknown id, a conflict, a contact-only group with others, a page in another group (and --join)', async () => {
    await seed();
    const groups = await preview();
    const id = (slug: string) => groups.find(g => g.members.every(m => m.slug === slug))!;
    expect(id('people/carol-example').class).toBe('conflict');
    await expect(cli(['confirm', 'dedupe/0000000000000000'])).rejects.toMatchObject({ code: 'dedupe_group_unknown' });
    await expect(cli(['confirm', id('people/carol-example').id])).rejects.toMatchObject({ code: 'dedupe_group_not_confirmable', reason: 'conflict' });
    await expect(cli(['confirm', id('people/alice-example').id, id('people/bob-sample').id])).rejects.toMatchObject({ code: 'dedupe_group_not_confirmable', reason: 'contact_key_only_batch' });
    await linkEntityIdentity(engine, { entityId: 'alice-by-hand', slug: 'people/alice-example', sourceId: 'default', canonical: true });
    await expect(cli(['confirm', id('people/alice-example').id])).rejects.toMatchObject({ code: 'identity_member_in_other_group' });
    expect((await rows()).decisions).toEqual([]);
    await cli(['confirm', id('people/alice-example').id, '--join', 'alice-by-hand']);
    expect((await rows()).identities).toEqual([
      { entity_id: 'alice-by-hand', source_id: 'default', slug: 'people/alice-example', established_by: 'manual', canonical: true },
      { entity_id: 'alice-by-hand', source_id: 'source-b', slug: 'people/alice-example', established_by: 'dedupe:confirm', canonical: false },
    ]);
    await cli(['confirm', id('people/bob-sample').id]);
    expect((await rows()).decisions.map(d => d.verdict)).toEqual(['same', 'same']);
  });

  test('a bulk confirm covers only clean groups and is bound to the hash it printed', async () => {
    await seed();
    const listed = await cliJson(['confirm', '--clean']);
    expect(listed.groups.map((g: { id: string }) => g.id)).toEqual([await groupOf('people/alice-example')]);
    await expect(cli(['confirm', '--clean', '--expect', '0000000000000000'])).rejects.toMatchObject({ code: 'preview_changed' });
    expect((await rows()).decisions).toEqual([]);
    await cli(['confirm', '--clean', '--expect', listed.preview_hash]);
    expect((await rows()).identities.map(r => r.slug)).toEqual(['people/alice-example', 'people/alice-example']);
    expect((await cliJson(['confirm', '--clean'])).groups).toEqual([]);
  });

  test('reject keeps the pair out of every later preview and undoes a confirm; hand links never move a confirmed page', async () => {
    await seed();
    const bob = await groupOf('people/bob-sample');
    await cli(['reject', bob]);
    expect((await preview()).some(g => g.id === bob)).toBe(false);
    const alice = await groupOf('people/alice-example');
    await cli(['confirm', alice]);
    await expect(op('entity_identity_unlink').handler(opCtx(), { entity_id: alice, slug: 'people/alice-example', source_id: 'source-b' }))
      .rejects.toMatchObject({ code: 'identity_link_owned_by_dedupe' });
    await expect(op('entity_identity_link').handler(opCtx(), { entity_id: 'elsewhere', slug: 'people/alice-example', source_id: 'source-b' }))
      .rejects.toMatchObject({ code: 'identity_link_owned_by_dedupe' });
    expect((await rows()).identities).toHaveLength(2);
    await cli(['reject', alice]);
    const after = await rows();
    expect(after.identities).toEqual([]);
    expect(after.decisions.map(d => d.verdict)).toEqual(['different', 'different']);
    expect((await preview()).some(g => g.id === alice || g.id === bob)).toBe(false);
  });

  test('two confirmed decisions that share one identity group link with exactly one canonical page', async () => {
    await seed();
    const mk = (slug: string) => {
      const members = [{ source_id: 'default', slug }, { source_id: 'source-b', slug }];
      return { decision_id: decisionId(members), verdict: 'same', members, group_id: `g-${slug}`, entity_id: 'shared-example',
        canonical: { source_id: 'default', slug }, decided_by: 'test', origin: 'database', home_source_id: 'default', git_blob: null };
    };
    await engine.applyIdentityDecisions({ upsert: [mk('people/alice-example'), mk('people/dan-sample')] } as never);
    const linked = (await rows()).identities;
    expect(linked).toHaveLength(4);
    expect(linked.filter(r => r.canonical)).toHaveLength(1);
  });

  test('reject undoes every confirm of an identity group and refuses a larger group that overlaps one; --join needs an existing group', async () => {
    await seed();
    await expect(cli(['confirm', await groupOf('people/dan-sample'), '--join', 'nobody-example'])).rejects.toMatchObject({ code: 'dedupe_group_unknown' });
    const alice = await groupOf('people/alice-example');
    await cli(['confirm', alice]);
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-c', 'source-c') ON CONFLICT DO NOTHING");
    await page('people/alice-example', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' }, 'source-c');
    const wider = (await preview()).find(g => g.members.length === 3)!;
    await expect(cli(['reject', wider.id])).rejects.toMatchObject({ code: 'identity_member_in_other_group' });
    expect((await rows()).decisions.map(d => d.verdict)).toEqual(['same']);
    await cli(['confirm', wider.id, '--join', alice]);
    expect((await rows()).identities.filter(r => r.slug === 'people/alice-example')).toHaveLength(3);
    await cli(['reject', alice]);
    const after = await rows();
    expect(after.identities).toEqual([]);
    expect(after.decisions.map(d => d.verdict)).toEqual(['different', 'different']);
  });

  test('two confirmed identities that share a page are rejected together, as the refusal names', async () => {
    await seed();
    const pair = (entity: string, slug: string) => {
      const members = [{ source_id: 'default', slug: 'people/alice-example' }, { source_id: 'source-b', slug }];
      return { decision_id: decisionId(members), verdict: 'same', members, group_id: entity, entity_id: entity,
        canonical: members[0], decided_by: 'test', origin: 'database', home_source_id: 'default', git_blob: null };
    };
    await engine.applyIdentityDecisions({ upsert: [pair('ga-example', 'people/alice-example'), pair('gb-example', 'people/dan-sample')] } as never);
    const err = await cli(['reject', 'ga-example']).catch(e => e);
    expect(err).toMatchObject({ code: 'identity_member_in_other_group' });
    expect(err.fix.argv).toEqual(['gbrain', 'dedupe', 'reject', 'ga-example', 'gb-example']);
    await cli(err.fix.argv.slice(2));
    expect((await rows()).decisions.map(d => d.verdict)).toEqual(['different', 'different']);
    expect((await rows()).identities).toEqual([]);
  });

  test('a rejected group cannot be confirmed by its id; the different decision stays', async () => {
    await seed();
    const bob = await groupOf('people/bob-sample');
    await cli(['reject', bob]);
    await expect(cli(['confirm', bob])).rejects.toMatchObject({ code: 'dedupe_group_unknown' });
    expect((await rows()).decisions.map(d => d.verdict)).toEqual(['different']);
  });

  test('a confirm that joins a hand-made group with no canonical page makes the decision canonical', async () => {
    await seed();
    await linkEntityIdentity(engine, { entityId: 'alice-by-hand', slug: 'people/alice-example', sourceId: 'default', canonical: false });
    await cli(['confirm', await groupOf('people/alice-example'), '--join', 'alice-by-hand']);
    expect((await rows()).identities.map(r => [r.source_id, r.established_by, r.canonical])).toEqual([['default', 'manual', true], ['source-b', 'dedupe:confirm', false]]);
  });

  test('pages confirmed as one identity across several decisions are not proposed again', async () => {
    await seed();
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-c', 'source-c') ON CONFLICT DO NOTHING");
    await page('people/alice-example', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' }, 'source-c');
    const same = (members: Array<{ source_id: string; slug: string }>) => ({ decision_id: decisionId(members), verdict: 'same', members, group_id: null, entity_id: 'alice-joined',
      canonical: members[0], decided_by: 'test', origin: 'database', home_source_id: null, git_blob: null });
    const a = { source_id: 'default', slug: 'people/alice-example' }, b = { source_id: 'source-b', slug: 'people/alice-example' }, c = { source_id: 'source-c', slug: 'people/alice-example' };
    await engine.applyIdentityDecisions({ upsert: [same([a, b]), same([b, c])] } as never);
    expect((await preview()).filter(g => g.members.some(m => m.slug === 'people/alice-example'))).toEqual([]);
  });

  test('--join refuses when the joined identity would hold two pages recorded as different people', async () => {
    await seed();
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-c', 'source-c') ON CONFLICT DO NOTHING");
    await page('people/ae-sample', 'Ae Sample', {}, 'source-c');
    await linkEntityIdentity(engine, { entityId: 'alice-by-hand', slug: 'people/alice-example', sourceId: 'default', canonical: true });
    await linkEntityIdentity(engine, { entityId: 'alice-by-hand', slug: 'people/ae-sample', sourceId: 'source-c', canonical: false });
    const apart = [{ source_id: 'source-b', slug: 'people/alice-example' }, { source_id: 'source-c', slug: 'people/ae-sample' }];
    await engine.applyIdentityDecisions({ upsert: [{ decision_id: decisionId(apart), verdict: 'different', members: apart, group_id: null, entity_id: null, canonical: null,
      decided_by: 'owner', origin: 'database', home_source_id: null, git_blob: null }] } as never);
    await expect(cli(['confirm', await groupOf('people/alice-example'), '--join', 'alice-by-hand'])).rejects.toMatchObject({ code: 'dedupe_group_not_confirmable', reason: 'rejected_pair' });
    expect((await rows()).identities.map(r => [r.source_id, r.established_by])).toEqual([['default', 'manual'], ['source-c', 'manual']]);
  });

  test('confirm of an already-confirmed group with --join writes nothing and does not throw when the joined identity holds a rejected pair', async () => {
    await seed();
    const alice = await groupOf('people/alice-example');
    await cli(['confirm', alice]);
    await linkEntityIdentity(engine, { entityId: 'bob-by-hand', slug: 'people/bob-sample', sourceId: 'default', canonical: true });
    await linkEntityIdentity(engine, { entityId: 'bob-by-hand', slug: 'people/bob-sample', sourceId: 'source-b', canonical: false });
    const bob = [{ source_id: 'default', slug: 'people/bob-sample' }, { source_id: 'source-b', slug: 'people/bob-sample' }];
    await engine.applyIdentityDecisions({ upsert: [{ decision_id: decisionId(bob), verdict: 'different', members: bob, group_id: null, entity_id: null, canonical: null,
      decided_by: 'owner', origin: 'database', home_source_id: null, git_blob: null }] } as never);
    const before = await rows();
    const out = await cli(['confirm', alice, '--join', 'bob-by-hand']);
    expect(out).toContain(`${alice} is already confirmed.`);
    expect(out).toContain('Nothing to confirm.');
    expect(await rows()).toEqual(before);
  });

  test('a brain with no repository records a group with a page in an owner-only source in the database', async () => {
    await seed();
    await engine.executeRaw("UPDATE sources SET config = $1::jsonb WHERE id = 'source-b'", ['{"owner_only": true}']);
    await cli(['confirm', await groupOf('people/alice-example')]);
    expect((await rows()).decisions.map(d => [d.verdict, d.origin])).toEqual([['same', 'database']]);
  });

  test('a page pair in one source also gets distinct_from through the page door', async () => {
    await page('people/erin-example', 'Erin Example', { email: 'erin@example.com' }, 'default');
    await page('people/erin-example-2', 'Erin Example', { email: 'erin@example.com' }, 'default');
    const erin = (await preview()).find(g => g.kind === 'in_source')!;
    expect(erin).toBeDefined();
    await cli(['reject', erin.id]);
    const p = await engine.getPage('people/erin-example-2', { sourceId: 'default' });
    expect(p!.frontmatter.distinct_from).toEqual(['people/erin-example']);
    expect(await preview()).toEqual([]);
  });

  test('rank_entities counts a confirmed person once; a caller scoped to one source sees no member outside it', async () => {
    await seed();
    for (const [slug, src] of [['notes/n1', 'default'], ['notes/n2', 'source-b'], ['notes/n3', 'default']] as const) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Note.', timeline: '', frontmatter: {} } as never, { sourceId: src });
    }
    const link = (from: string, fromSrc: string, toSrc: string) => engine.addLink(from, 'people/alice-example', '', 'references', 'manual', undefined, undefined, { fromSourceId: fromSrc, toSourceId: toSrc });
    await link('notes/n1', 'default', 'default');
    await link('notes/n2', 'source-b', 'source-b');
    await link('notes/n3', 'default', 'default');
    await link('notes/n3', 'default', 'source-b');
    const rank = async (ctx: OperationContext) => ((await op('rank_entities').handler(ctx, { types: ['person'] })) as { entities: Array<{ slug: string; source_id: string; inbound: number }> })
      .entities.map(e => [e.source_id, e.slug, e.inbound]);
    expect(await rank(opCtx())).toEqual([['default', 'people/alice-example', 2], ['source-b', 'people/alice-example', 2]]);
    await cli(['confirm', await groupOf('people/alice-example')]);
    expect(await rank(opCtx())).toEqual([['default', 'people/alice-example', 3]]);
    const scoped = opCtx({ remote: true, transport: 'stdio', auth: { allowedSources: ['source-b'] } as never } as Partial<OperationContext>);
    expect(await rank(scoped)).toEqual([['source-b', 'people/alice-example', 1]]);
  });

  test('enrichment tiering counts the mentions in every source of a confirmed group', async () => {
    await seed();
    const note = (slug: string, sourceId: string) => importFromContent(engine, slug, `---\ntype: note\ntitle: ${slug}\n---\nMet Alice Example at the conference.\n`, { sourceId, noEmbed: true });
    await note('notes/m0', 'default');
    for (const n of ['notes/m1', 'notes/m2', 'notes/m3']) await note(n, 'source-b');
    const tier = async () => (await enrichEntity(engine, { entityName: 'Alice Example', entityType: 'person', context: 'test', sourceSlug: 'notes/m1' }, { sourceId: 'default' })).mentionCount;
    const before = await tier();
    await cli(['confirm', await groupOf('people/alice-example')]);
    expect(before).toBe(1);
    expect(await tier()).toBe(4);
  });
});

describe('with a repository', () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'dedupe-decisions-'));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    mkdirSync(join(root, 'people'), { recursive: true });
    for (const [slug, title, fm] of [['alice-example', 'Alice Example', 'linkedin: https://www.linkedin.com/in/alice-example/'], ['bob-sample', 'Bob Sample', 'email: bob@example.com'],
      ['dan-sample', 'Dan Sample', '']]) {
      writeFileSync(join(root, 'people', `${slug}.md`), `---\ntype: person\ntitle: ${title}\n${fm}\n---\n${title} works at Acme Example, with the longer page.\n`);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'pages');
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
    await syncHome();
    await page('people/alice-example', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' }, 'source-b');
    await page('people/bob-sample', 'Bob Sample', { email: 'bob@example.com' }, 'source-b');
    await page('people/dan-sample', 'Dan Sample', {}, 'source-b');
  });
  const syncHome = () => performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true, concurrency: 1 });
  const committed = (id: string) => git(root, 'show', `HEAD:${IDENTITY_DIR}/${id}.md`);
  const doctor = async () => (await entityDuplicatesEntry.run({ engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0] as { status: string; message: string; details: any; fix: any };

  test('decisions are committed before any row; a database rebuilt from git keeps them; a page imported later links on the next sync', async () => {
    const alice = await groupOf('people/alice-example');
    const bob = await groupOf('people/bob-sample');
    const pagesBefore = await engine.getPage('people/alice-example', { sourceId: 'source-b' });
    await engine.executeRaw("UPDATE sources SET config = '{\"mirror_read_only\": true}' WHERE id = 'source-b'");
    const out = await cli(['confirm', alice]);
    expect(out).toContain('Recorded in default:.gbrain/identity/');
    await cli(['reject', bob]);
    const aliceId = decisionId([{ source_id: 'default', slug: 'people/alice-example' }, { source_id: 'source-b', slug: 'people/alice-example' }]);
    const bobId = decisionId([{ source_id: 'default', slug: 'people/bob-sample' }, { source_id: 'source-b', slug: 'people/bob-sample' }]);
    expect(committed(aliceId)).toContain('verdict: same');
    expect(committed(bobId)).toContain('verdict: different');
    expect(git(root, 'status', '--porcelain')).toBe('');
    const recorded = await rows();
    expect(recorded.decisions.map(d => [d.decision_id, d.verdict, d.origin, !!d.git_blob])).toEqual([[aliceId, 'same', 'git', true], [bobId, 'different', 'git', true]].sort());
    const pageAfter = await engine.getPage('people/alice-example', { sourceId: 'source-b' });
    expect({ t: pageAfter!.compiled_truth, f: pageAfter!.frontmatter, u: String(pageAfter!.updated_at) }).toEqual({ t: pagesBefore!.compiled_truth, f: pagesBefore!.frontmatter, u: String(pagesBefore!.updated_at) });

    await engine.executeRaw('DELETE FROM entity_identity_reviews');
    await engine.executeRaw('DELETE FROM entity_identities');
    await engine.deletePage('people/alice-example', { sourceId: 'source-b' });
    await syncHome();
    const rebuilt = await rows();
    expect(rebuilt.decisions).toEqual(recorded.decisions);
    expect(rebuilt.identities.map(r => r.source_id)).toEqual(['default']);
    expect((await engine.listIdentityDecisions()).pending).toEqual([{ decision_id: aliceId, source_id: 'source-b', slug: 'people/alice-example', reason: 'page_missing' }]);
    expect((await doctor()).message).toContain('1 page(s) of confirmed groups are not linked');
    await page('people/alice-example', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' }, 'source-b');
    await syncHome();
    expect((await rows()).identities.map(r => [r.source_id, r.established_by, r.canonical])).toEqual([['default', 'dedupe:confirm', true], ['source-b', 'dedupe:confirm', false]]);
    expect((await preview()).map(g => g.members[0]!.slug)).toEqual(['people/dan-sample']);
  });

  test('a decision the database holds alone moves into git with reconcile; doctor reports the drift until then', async () => {
    await engine.applyIdentityDecisions({ upsert: [{ decision_id: decisionId([{ source_id: 'default', slug: 'people/dan-sample' }, { source_id: 'source-b', slug: 'people/dan-sample' }]),
      verdict: 'different', members: [{ source_id: 'default', slug: 'people/dan-sample' }, { source_id: 'source-b', slug: 'people/dan-sample' }],
      group_id: null, entity_id: null, canonical: null, decided_by: 'owner', origin: 'database', home_source_id: null, git_blob: null }] });
    const drift = await doctor();
    expect(drift.status).toBe('warn');
    expect(drift.message).toContain('1 duplicate decision(s) are in the database but not in git (source default)');
    await cli(['reconcile']);
    expect((await rows()).decisions.map(d => d.origin)).toEqual(['git']);
    expect((await doctor()).message).not.toContain('drift');
  });

  test('a projection read before a newer decision was committed never writes its older verdict back', async () => {
    const members = [{ source_id: 'default', slug: 'people/alice-example' }, { source_id: 'source-b', slug: 'people/alice-example' }];
    const alice = await groupOf('people/alice-example');
    await cli(['confirm', alice]);
    await engine.applyIdentityDecisions({ remove: [decisionId(members)] });
    const home = (await identityHome(engine))!;
    const stale = await planIdentityProjection(engine, home);
    expect(stale.upsert.map(d => d.verdict)).toEqual(['same']);
    await cli(['reject', alice]);
    expect(committed(decisionId(members))).toContain('verdict: different');
    await applyIdentityProjection(engine, stale);
    expect((await rows()).decisions.map(d => [d.decision_id, d.verdict])).toEqual([[decisionId(members), 'different']]);
    expect((await rows()).identities).toEqual([]);
  });

  test('doctor offers reconcile only for drift reconcile can clear; a missing page or an invalid file gets its own remedy', async () => {
    const alice = await groupOf('people/alice-example');
    await cli(['confirm', alice]);
    await engine.deletePage('people/alice-example', { sourceId: 'source-b' });
    await engine.applyIdentityDecisions({});
    const missing = await doctor();
    expect(missing.status).toBe('warn');
    expect(missing.message).toContain('1 page(s) of confirmed groups are not linked (source-b:people/alice-example page_missing)');
    expect(missing.fix.argv).not.toEqual(['gbrain', 'dedupe', 'reconcile']);
    expect(missing.fix.user_message).toContain(`gbrain dedupe reject ${alice}`);
    await page('people/alice-example', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' }, 'source-b');
    await engine.applyIdentityDecisions({});
    const bad = [{ source_id: 'default', slug: 'people/dan-sample' }, { source_id: 'source-b', slug: 'people/dan-sample' }];
    mkdirSync(join(root, IDENTITY_DIR), { recursive: true });
    writeFileSync(join(root, IDENTITY_DIR, `${decisionId(bad)}.md`), '---\nverdict: maybe\n---\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'a decision file that does not validate');
    await syncHome();
    const invalid = await doctor();
    expect(invalid.status).toBe('warn');
    expect(invalid.message).toContain(`1 committed decision file(s) do not validate: ${IDENTITY_DIR}/${decisionId(bad)}.md`);
    expect(invalid.message).not.toContain('not read into the database');
    expect(invalid.fix.argv).not.toEqual(['gbrain', 'dedupe', 'reconcile']);
    expect(invalid.details.drift.invalid_files).toEqual([`${IDENTITY_DIR}/${decisionId(bad)}.md`]);
  });

  test('doctor keeps offering reconcile for a confirmed page restored outside sync, which reconcile links', async () => {
    const alice = await groupOf('people/alice-example');
    await cli(['confirm', alice]);
    await engine.deletePage('people/alice-example', { sourceId: 'source-b' });
    await engine.applyIdentityDecisions({});
    await page('people/alice-example', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example' }, 'source-b');
    expect((await engine.listIdentityDecisions()).pending.map(p => p.reason)).toEqual(['unlinked']);
    expect((await doctor()).fix.argv).toEqual(['gbrain', 'dedupe', 'reconcile']);
    await cli(['reconcile']);
    expect((await engine.listIdentityDecisions()).pending).toEqual([]);
  });

  test('a projection whose apply goes stale reads again; five stale applies in a row throw and write nothing', async () => {
    const members = [{ source_id: 'default', slug: 'people/alice-example' }, { source_id: 'source-b', slug: 'people/alice-example' }];
    await cli(['confirm', await groupOf('people/alice-example')]);
    await engine.applyIdentityDecisions({ remove: [decisionId(members)] });
    const home = (await identityHome(engine))!;
    const real = engine.applyIdentityDecisions.bind(engine);
    let staleLeft = 1;
    const spy = spyOn(engine, 'applyIdentityDecisions').mockImplementation(async (input) =>
      input.expectRevision !== undefined && staleLeft-- > 0 ? { upserted: 0, removed: 0, linked: 0, unlinked: 0, stale: true } : real(input));
    try {
      expect((await projectIdentityDecisions(engine, home)).upserted).toBe(1);
      expect((await rows()).decisions.map(d => d.verdict)).toEqual(['same']);
      await real({ remove: [decisionId(members)] });
      staleLeft = 5;
      await expect(projectIdentityDecisions(engine, home)).rejects.toThrow('changed while they were being projected, 5 times in a row');
      expect((await rows()).decisions).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  test('a failed read of the committed decisions removes nothing', async () => {
    await cli(['confirm', await groupOf('people/alice-example')]);
    const before = await rows();
    const home = (await identityHome(engine))!;
    await expect(projectIdentityDecisions(engine, home, 'refs/heads/no-such-branch')).rejects.toThrow('git ls-tree failed');
    expect(await rows()).toEqual(before);
    expect(before.identities).toHaveLength(2);
  });

  test('a committed decision file with an unreadable date is skipped and the others still project', async () => {
    const bad = [{ source_id: 'default', slug: 'people/bob-sample' }, { source_id: 'source-b', slug: 'people/bob-sample' }];
    const good = [{ source_id: 'default', slug: 'people/dan-sample' }, { source_id: 'source-b', slug: 'people/dan-sample' }];
    const file = (members: typeof bad, at: string) => ['---', 'verdict: different', 'members:', ...members.flatMap(m => [`  - source_id: ${m.source_id}`, `    slug: ${m.slug}`]),
      'decided_by: owner', `decided_at: '${at}'`, '---', ''].join('\n');
    mkdirSync(join(root, IDENTITY_DIR), { recursive: true });
    writeFileSync(join(root, IDENTITY_DIR, `${decisionId(bad)}.md`), file(bad, '2026-13-45'));
    writeFileSync(join(root, IDENTITY_DIR, `${decisionId(good)}.md`), file(good, '2026-11-17T00:00:00.000Z'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'decisions');
    const r = await projectIdentityDecisions(engine, (await identityHome(engine))!);
    expect(r.invalid).toEqual([`${IDENTITY_DIR}/${decisionId(bad)}.md`]);
    expect((await rows()).decisions.map(d => d.decision_id)).toEqual([decisionId(good)]);
  });

  test('a committed decision file whose YAML aliases expand past the bound is refused as invalid, not parsed', async () => {
    const members = [{ source_id: 'default', slug: 'people/bob-sample' }, { source_id: 'source-b', slug: 'people/bob-sample' }];
    const bomb = ['a: &a ["' + 'x'.repeat(64) + '"]', ...Array.from({ length: 12 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(8).fill('*' + String.fromCharCode(97 + i)).join(', ')}]`)];
    const text = ['---', 'verdict: different', 'members:', ...members.flatMap(m => [`  - source_id: ${m.source_id}`, `    slug: ${m.slug}`]),
      'decided_by: owner', 'notes:', ...bomb.map(l => '  ' + l), '---', ''].join('\n');
    mkdirSync(join(root, IDENTITY_DIR), { recursive: true });
    writeFileSync(join(root, IDENTITY_DIR, `${decisionId(members)}.md`), text);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'decision');
    const r = await projectIdentityDecisions(engine, (await identityHome(engine))!);
    expect(r.invalid).toEqual([`${IDENTITY_DIR}/${decisionId(members)}.md`]);
    expect((await rows()).decisions).toEqual([]);
  });

  test('confirm and reject refuse a group with a page in an owner-only source when decisions go to git', async () => {
    const alice = await groupOf('people/alice-example');
    const bob = await groupOf('people/bob-sample');
    await engine.executeRaw("UPDATE sources SET config = $1::jsonb WHERE id = 'source-b'", ['{"kind": "imessage"}']);
    await expect(cli(['confirm', alice])).rejects.toMatchObject({ code: 'dedupe_group_not_confirmable', reason: 'owner_only_source' });
    await expect(cli(['reject', bob])).rejects.toMatchObject({ code: 'dedupe_group_not_confirmable', reason: 'owner_only_source' });
    expect(await rows()).toEqual({ decisions: [], identities: [] });
    expect(existsSync(join(root, IDENTITY_DIR))).toBe(false);
  });

  test('reconcile and doctor leave out a decision whose owner-only source is archived or whose source was removed', async () => {
    const dbRow = (members: Array<{ source_id: string; slug: string }>) => ({ decision_id: decisionId(members), verdict: 'different', members, group_id: null, entity_id: null,
      canonical: null, decided_by: 'owner', origin: 'database', home_source_id: null, git_blob: null });
    await engine.applyIdentityDecisions({ upsert: [
      dbRow([{ source_id: 'default', slug: 'people/bob-sample' }, { source_id: 'source-b', slug: 'people/bob-sample' }]),
      dbRow([{ source_id: 'default', slug: 'people/dan-sample' }, { source_id: 'source-gone', slug: 'people/dan-sample' }]),
    ] } as never);
    await engine.executeRaw("UPDATE sources SET config = $1::jsonb, archived = true WHERE id = 'source-b'", ['{"owner_only": true}']);
    expect((await doctor()).message).not.toContain('in the database but not in git');
    expect((await cliJson(['reconcile'])).written).toBe(0);
    expect(existsSync(join(root, IDENTITY_DIR))).toBe(false);
  });

  test('a page outside the default source that not every reader may read keeps its group out of the repository', async () => {
    await page('people/alice-example', 'Alice Example', { linkedin: 'linkedin.com/in/alice-example', readable_by: ['alice-example'] }, 'source-b');
    await expect(cli(['confirm', await groupOf('people/alice-example')])).rejects.toMatchObject({ code: 'dedupe_group_not_confirmable', reason: 'restricted_page' });
    expect(existsSync(join(root, IDENTITY_DIR))).toBe(false);
  });

  test('a symlink where a decision file goes is refused and the file it points to is untouched', async () => {
    const alice = await groupOf('people/alice-example');
    const id = decisionId([{ source_id: 'default', slug: 'people/alice-example' }, { source_id: 'source-b', slug: 'people/alice-example' }]);
    const outside = join(mkdtempSync(join(tmpdir(), 'dedupe-outside-')), 'keep.txt');
    writeFileSync(outside, 'keep\n');
    mkdirSync(join(root, IDENTITY_DIR), { recursive: true });
    symlinkSync(outside, join(root, IDENTITY_DIR, `${id}.md`));
    await expect(cli(['confirm', alice])).rejects.toMatchObject({ code: 'commit_paths_invalid' });
    expect(readFileSync(outside, 'utf8')).toBe('keep\n');
    expect((await rows()).decisions).toEqual([]);
  });

  test('reconcile never rewrites a committed decision from the database: git wins and the disagreement is reported', async () => {
    const members = [{ source_id: 'default', slug: 'people/dan-sample' }, { source_id: 'source-b', slug: 'people/dan-sample' }];
    const id = decisionId(members);
    mkdirSync(join(root, IDENTITY_DIR), { recursive: true });
    writeFileSync(join(root, IDENTITY_DIR, `${id}.md`), ['---', 'verdict: different', 'members:', ...members.flatMap(m => [`  - source_id: ${m.source_id}`, `    slug: ${m.slug}`]),
      'decided_by: owner', "decided_at: '2026-11-17T00:00:00.000Z'", '---', ''].join('\n'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'decision');
    const file = committed(id);
    await engine.applyIdentityDecisions({ upsert: [{ decision_id: id, verdict: 'same', members, group_id: null, entity_id: 'dan-joined', canonical: members[0],
      decided_by: 'owner', origin: 'database', home_source_id: null, git_blob: null }] } as never);
    const r = await cliJson(['reconcile']);
    expect({ written: r.written, git_kept: r.git_kept }).toEqual({ written: 0, git_kept: [id] });
    expect(committed(id)).toBe(file);
    expect((await rows()).decisions.map(d => [d.decision_id, d.verdict, d.origin])).toEqual([[id, 'different', 'git']]);
  });

  test('a clean group with a page in an owner-only source is left out of the bulk confirm list, so it cannot wedge it', async () => {
    await engine.executeRaw("UPDATE sources SET config = $1::jsonb WHERE id = 'source-b'", ['{"owner_only": true}']);
    const list = await cliJson(['confirm', '--clean']);
    expect(list.groups).toEqual([]);
    expect(await cli(['confirm', '--clean', '--expect', list.preview_hash])).toContain('Nothing to confirm.');
  });

  test('a host that does not see the checkout refuses instead of writing a decision only the database holds', async () => {
    await cli(['reject', await groupOf('people/bob-sample')]);
    const dan = await groupOf('people/dan-sample');
    renameSync(join(root, '.git'), join(root, '.git-away'));
    try {
      await expect(cli(['confirm', dan])).rejects.toMatchObject({ code: 'dedupe_decision_store_mismatch' });
      expect((await rows()).decisions).toHaveLength(1);
      expect((await doctor()).message).toContain('this host sees no repository');
    } finally {
      renameSync(join(root, '.git-away'), join(root, '.git'));
    }
    expect(existsSync(join(root, IDENTITY_DIR))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
});

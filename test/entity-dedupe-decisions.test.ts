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
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { decisionId, IDENTITY_DIR } from '../src/core/entities/identity-decisions.ts';
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

  test('a rejected group cannot be confirmed by its id; the different decision stays', async () => {
    await seed();
    const bob = await groupOf('people/bob-sample');
    await cli(['reject', bob]);
    await expect(cli(['confirm', bob])).rejects.toMatchObject({ code: 'dedupe_group_unknown' });
    expect((await rows()).decisions.map(d => d.verdict)).toEqual(['different']);
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
  const doctor = async () => (await entityDuplicatesEntry.run({ engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0] as { status: string; message: string; details: any };

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

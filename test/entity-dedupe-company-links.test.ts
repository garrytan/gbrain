/**
 * Duplicate people PR 3, part 2 (plan autoplan-20261117192252 Decision F, narrowed at gate_rev 7): company pages that the
 * finder calls clean are linked automatically after each sync; person pages never are.
 *
 * 1. Protects: a company pair in two sources with the same GitHub login and exactly the same name is linked as one identity
 *    ('dedupe:auto') by the sweep, listed by gbrain dedupe --preview --kind auto with its undo, counted once by
 *    rank_entities and reported by doctor; a person pair with the same evidence is never linked, stays on the confirm list
 *    to be confirmed on its own with a hint line, and is left out of confirm --clean; the first sweep after an upgrade
 *    writes no automatic row for a person; reject removes the automatic rows and no later sweep recreates them; a page
 *    linked by hand or an unverified stub keeps its group out of the sweep; a confirm takes the pages over from the
 *    automatic link; the hand-link ops refuse an automatic row; an id a person page also carries keeps a company pair
 *    unlinked; enrichment counts a linked company once; doctor's reject suggestion for a decision with no group id
 *    names its identity, which reject accepts.
 * 2. Fails when: a person is linked without the owner; a rejected company pair comes back; the sweep moves a hand link.
 * 3. Real seams: both engines (Postgres with DATABASE_URL), the sync hook, the CLI module, the rank_entities and
 *    entity_identity ops, the doctor check. Made-up names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { linkEntityIdentity } from '../src/core/entity-identity.ts';
import { decisionId, syncIdentityDecisions } from '../src/core/entities/identity-decisions.ts';
import { entityDuplicatesEntry } from '../src/commands/doctor/checks/entity-duplicates.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { enrichEntity } from '../src/core/enrichment-service.ts';
import { importFromContent } from '../src/core/import-file.ts';

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

const put = (type: 'person' | 'company', slug: string, title: string, frontmatter: Record<string, unknown>, sourceId: string) =>
  engine.putPage(slug, { type, title, compiled_truth: `${title}.`, timeline: '', frontmatter } as never, { sourceId });

/** acme: a company pair sharing a GitHub login; alice: a person pair sharing a GitHub login. Same names, two sources. */
async function seed() {
  for (const s of ['default', 'source-b']) {
    await put('company', 'companies/acme-example', 'Acme Example', { github: 'acme-example' }, s);
    await put('person', 'people/alice-example', 'Alice Example', { github: 'alice-example' }, s);
  }
}

async function cli(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runDedupe(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}
const cliJson = async (args: string[]) => JSON.parse(await cli([...args, '--json']));
const groupOf = async (slug: string) => ((await cliJson(['--preview'])).groups as Array<{ id: string; members: Array<{ slug: string }> }>)
  .find(g => g.members.every(m => m.slug === slug))!.id;
const sweep = () => syncIdentityDecisions(engine, 'default');
const identities = () => engine.executeRaw<{ entity_id: string; source_id: string; slug: string; established_by: string; canonical: boolean }>(
  'SELECT ei.entity_id, ei.source_id, p.slug, ei.established_by, ei.canonical FROM entity_identities ei JOIN pages p ON p.id = ei.page_id ORDER BY ei.source_id, p.slug');
const doctor = async () => (await entityDuplicatesEntry.run({ engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0] as
  { status: string; message: string; details: any; fix: any };
const opCtx = () => ({ engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false } as unknown as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

test('a company pair with the same GitHub login and name is linked after a sync; the person pair beside it is not', async () => {
  await seed();
  const acme = await groupOf('companies/acme-example');
  await sweep();
  expect(await identities()).toEqual([
    { entity_id: acme, source_id: 'default', slug: 'companies/acme-example', established_by: 'dedupe:auto', canonical: true },
    { entity_id: acme, source_id: 'source-b', slug: 'companies/acme-example', established_by: 'dedupe:auto', canonical: false },
  ]);
  const listed = await cliJson(['--preview', '--kind', 'auto']);
  expect(listed.auto).toEqual([{ id: acme, members: [{ source_id: 'default', slug: 'companies/acme-example' }, { source_id: 'source-b', slug: 'companies/acme-example' }],
    undo: ['gbrain', 'dedupe', 'reject', acme] }]);
  const check = await doctor();
  expect(check.message).toContain('1 company group(s) are linked automatically');
  expect(check.details.groups.map((g: { members: Array<{ slug: string }> }) => g.members[0]!.slug)).toEqual(['people/alice-example']);
  await sweep();
  expect((await identities()).length).toBe(2);
});

test('a person pair that shares an id stays on the confirm list, alone and with a hint line, and out of confirm --clean', async () => {
  await seed();
  await sweep();
  const alice = await groupOf('people/alice-example');
  const list = await cliJson(['confirm']);
  expect(list.entries.map((e: { id: string; bulk: boolean; confirm_alone: boolean }) => [e.id, e.bulk, e.confirm_alone])).toEqual([[alice, false, true]]);
  expect(await cli(['confirm'])).toContain('hint:     shared github (account or registry id); differing keys none');
  expect((await cliJson(['confirm', '--clean'])).groups).toEqual([]);
  expect((await identities()).filter(r => r.slug.startsWith('people/'))).toEqual([]);
  await cli(['confirm', alice]);
  expect((await identities()).filter(r => r.slug.startsWith('people/')).map(r => r.established_by)).toEqual(['dedupe:confirm', 'dedupe:confirm']);
});

test('the first sweep after an upgrade writes no automatic row for a person, however many person pairs share an id', async () => {
  for (const s of ['default', 'source-b']) for (const n of ['alice', 'bob', 'carol']) {
    await put('person', `people/${n}-example`, `${n[0]!.toUpperCase()}${n.slice(1)} Example`, { github: `${n}-example`, linkedin: `linkedin.com/in/${n}-example` }, s);
  }
  expect((await cliJson(['--preview'])).groups.filter((g: { class: string }) => g.class === 'clean').length).toBe(3);
  await sweep();
  expect(await identities()).toEqual([]);
  expect((await cliJson(['--preview', '--kind', 'auto'])).auto).toEqual([]);
});

test('reject removes the automatic rows and no later sweep links the pair again', async () => {
  await seed();
  await sweep();
  const acme = await groupOf('companies/acme-example');
  const out = await cli(['reject', acme]);
  expect(out).toContain('Removed 2 automatic company link(s).');
  expect(await identities()).toEqual([]);
  await sweep();
  await cli(['reconcile']);
  expect(await identities()).toEqual([]);
  const decisions = await engine.listIdentityDecisions();
  expect(decisions.decisions.map(d => [d.decision_id, d.verdict])).toEqual([[decisionId([{ source_id: 'default', slug: 'companies/acme-example' },
    { source_id: 'source-b', slug: 'companies/acme-example' }]), 'different']]);
});

test('a page linked by hand, an unverified stub, a quarantined or a flagged page keeps its company group out of the sweep', async () => {
  await seed();
  await linkEntityIdentity(engine, { entityId: 'acme-by-hand', slug: 'companies/acme-example', sourceId: 'default', canonical: true });
  for (const [name, extra] of [['beta', { provenance: 'auto-extracted', status: 'unverified' }], ['gamma', { quarantine: { reason: 'junk', detail: 'test' } }],
    ['delta', { content_flag: { reason: 'markup_heavy', detail: 'test' } }]] as const) {
    const title = `${name[0]!.toUpperCase()}${name.slice(1)} Example`;
    await put('company', `companies/${name}-example`, title, { github: `${name}-example` }, 'default');
    await put('company', `companies/${name}-example`, title, { github: `${name}-example`, ...extra }, 'source-b');
  }
  await sweep();
  expect(await identities()).toEqual([{ entity_id: 'acme-by-hand', source_id: 'default', slug: 'companies/acme-example', established_by: 'manual', canonical: true }]);
});

test('a company id a person page also carries keeps the company pair out of the sweep, as the preview keeps it out of clean', async () => {
  await seed();
  await put('person', 'people/bob-sample', 'Bob Sample', { github: 'acme-example' }, 'default');
  expect((await cliJson(['--preview'])).groups.find((g: { members: Array<{ slug: string }> }) => g.members[0]!.slug === 'companies/acme-example')?.class).not.toBe('clean');
  await sweep();
  expect(await identities()).toEqual([]);
});

test('enrichment tiering counts the mentions in every source of an automatically linked company', async () => {
  await seed();
  const note = (slug: string, sourceId: string) => importFromContent(engine, slug, `---\ntype: note\ntitle: ${slug}\n---\nMet the Acme Example team at the conference.\n`, { sourceId, noEmbed: true });
  await note('notes/m0', 'default');
  for (const n of ['notes/m1', 'notes/m2']) await note(n, 'source-b');
  const tier = async () => (await enrichEntity(engine, { entityName: 'Acme Example', entityType: 'company', context: 'test', sourceSlug: 'notes/m1' }, { sourceId: 'default' })).mentionCount;
  const before = await tier();
  await sweep();
  expect(before).toBe(1);
  expect(await tier()).toBe(3);
});

test('a confirm takes the pages over from the automatic link; the hand-link ops refuse an automatic row', async () => {
  await seed();
  await sweep();
  const acme = await groupOf('companies/acme-example');
  await expect(op('entity_identity_unlink').handler(opCtx(), { entity_id: acme, slug: 'companies/acme-example', source_id: 'source-b' }))
    .rejects.toMatchObject({ code: 'identity_link_owned_by_dedupe' });
  expect((await cliJson(['confirm'])).entries.map((e: { id: string }) => e.id)).not.toContain(acme);
  await cli(['confirm', acme]);
  expect((await identities()).filter(r => r.slug.startsWith('companies/')).map(r => [r.entity_id, r.established_by]))
    .toEqual([[acme, 'dedupe:confirm'], [acme, 'dedupe:confirm']]);
  await sweep();
  expect((await identities()).filter(r => r.established_by === 'dedupe:auto')).toEqual([]);
});

test('rank_entities counts an automatically linked company once', async () => {
  await seed();
  for (const [slug, src] of [['notes/n1', 'default'], ['notes/n2', 'source-b']] as const) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Note.', timeline: '', frontmatter: {} } as never, { sourceId: src });
    await engine.addLink(slug, 'companies/acme-example', '', 'references', 'manual', undefined, undefined, { fromSourceId: src, toSourceId: src });
  }
  const rank = async () => ((await op('rank_entities').handler(opCtx(), { types: ['company'] })) as { entities: Array<{ slug: string; source_id: string; inbound: number }> })
    .entities.map(e => [e.source_id, e.slug, e.inbound]);
  expect(await rank()).toEqual([['default', 'companies/acme-example', 1], ['source-b', 'companies/acme-example', 1]]);
  await sweep();
  expect(await rank()).toEqual([['default', 'companies/acme-example', 2]]);
});

test("doctor's reject suggestion for a decision with no group id names its identity, and reject accepts it", async () => {
  await seed();
  const members = [{ source_id: 'default', slug: 'people/alice-example' }, { source_id: 'source-b', slug: 'people/gone-example' }];
  await engine.applyIdentityDecisions({ upsert: [{ decision_id: decisionId(members), verdict: 'same', members, group_id: null, entity_id: 'alice-identity',
    canonical: members[0]!, decided_by: 'owner', decided_at: '2026-11-18T00:00:00Z', origin: 'database', home_source_id: null, git_blob: null }] });
  const check = await doctor();
  expect(check.fix.user_message).toContain('`gbrain dedupe reject alice-identity`');
  await cli(['reject', 'alice-identity']);
  expect((await engine.listIdentityDecisions()).decisions.map(d => d.verdict)).toEqual(['different']);
});
});

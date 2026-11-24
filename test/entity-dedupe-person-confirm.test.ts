/**
 * Duplicate people PR 3, part 2 (plan autoplan-20261117192252, gate_rev 7): a person's pages are never linked without the
 * owner. Automatic company linking was taken out of this PR on 2026-11-19 and follows on its own (GST-3127).
 *
 * 1. Protects: after a sync, neither a company pair nor a person pair that share a GitHub login and exactly the same name
 *    is linked; both wait on the confirm list, the company pair in the bulk confirm and the person pair on its own with
 *    a hint line naming the shared id; a sync writes no identity row for a person however many person pairs share ids;
 *    doctor's reject suggestion for a decision with no group id names its identity, which reject accepts.
 * 2. Fails when: a sync links pages by itself; a person pair is offered for bulk confirm.
 * 3. Real seams: both engines (Postgres with DATABASE_URL), the sync hook, the CLI module, the doctor check. Made-up names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { decisionId, syncIdentityDecisions } from '../src/core/entities/identity-decisions.ts';
import { entityDuplicatesEntry } from '../src/commands/doctor/checks/entity-duplicates.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';

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
const sync = () => syncIdentityDecisions(engine, 'default');
const identities = () => engine.executeRaw<{ entity_id: string; source_id: string; slug: string; established_by: string; canonical: boolean }>(
  'SELECT ei.entity_id, ei.source_id, p.slug, ei.established_by, ei.canonical FROM entity_identities ei JOIN pages p ON p.id = ei.page_id ORDER BY ei.source_id, p.slug');
const doctor = async () => (await entityDuplicatesEntry.run({ engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0] as
  { status: string; message: string; details: any; fix: any };

test('after a sync, a company pair and a person pair that share an id stay unlinked and wait on the confirm list', async () => {
  await seed();
  await sync();
  expect(await identities()).toEqual([]);
  const acme = await groupOf('companies/acme-example');
  const alice = await groupOf('people/alice-example');
  const list = await cliJson(['confirm']);
  expect(list.entries.map((e: { id: string; bulk: boolean; confirm_alone: boolean }) => [e.id, e.bulk, e.confirm_alone])).toEqual([[acme, true, false], [alice, false, true]]);
  expect((await cliJson(['confirm', '--clean'])).groups.map((g: { id: string }) => g.id)).toEqual([acme]);
});

test('a person pair that shares an id is confirmed on its own, with a hint line, and never in confirm --clean', async () => {
  await seed();
  await sync();
  const alice = await groupOf('people/alice-example');
  expect(await cli(['confirm'])).toContain('hint:     shared github (account or registry id); differing keys none');
  expect((await cliJson(['confirm', '--clean'])).groups.map((g: { id: string }) => g.id)).not.toContain(alice);
  expect((await identities()).filter(r => r.slug.startsWith('people/'))).toEqual([]);
  await cli(['confirm', alice]);
  expect((await identities()).filter(r => r.slug.startsWith('people/')).map(r => r.established_by)).toEqual(['dedupe:confirm', 'dedupe:confirm']);
});

test('a cross-source group holding two pages of one source is never confirmed or listed; its same-source pair is collapsed or rejected first', async () => {
  await put('person', 'people/alice-example', 'Alice Example', {}, 'default');
  await put('person', 'people/alice-example-2', 'Alice Example', {}, 'default');
  await put('person', 'people/alice-example', 'Alice Example', {}, 'source-b');
  const groups = (await cliJson(['--preview'])).groups as Array<{ id: string; kind: string }>;
  const cross = groups.find(g => g.kind === 'cross_source')!;
  expect((await cliJson(['confirm'])).entries.map((e: { id: string }) => e.id)).not.toContain(cross.id);
  const refusal = await cli(['confirm', cross.id]).then(() => null, (e: unknown) => e as { code: string; reason: string; message: string });
  expect(refusal).toMatchObject({ code: 'dedupe_group_not_confirmable', reason: 'same_source_members' });
  expect(refusal!.message).toContain('gbrain dedupe reject');
  expect(await identities()).toEqual([]);
});

test('a sync writes no identity row for a person, however many person pairs share an id', async () => {
  for (const s of ['default', 'source-b']) for (const n of ['alice', 'bob', 'carol']) {
    await put('person', `people/${n}-example`, `${n[0]!.toUpperCase()}${n.slice(1)} Example`, { github: `${n}-example`, linkedin: `linkedin.com/in/${n}-example` }, s);
  }
  expect((await cliJson(['--preview'])).groups.filter((g: { class: string }) => g.class === 'clean').length).toBe(3);
  await sync();
  expect(await identities()).toEqual([]);
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

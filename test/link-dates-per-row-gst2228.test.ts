/**
 * GST-2228: each row of a page's `## Links` section keeps its own dates. A row is keyed (to, type, source), and its
 * `valid_from` / `valid_until` cells are stored as dated statements in link_transitions together with the row's source
 * (`link_source`). So when a writer re-creates a links section that a page rewrite dropped, each kept row gets back its
 * own dates, and `remove_link` on one source deletes that row's dates and no other row's.
 *
 * Before this, statements had no source, so the rebuilt section had to pair dates to rows by position: two rows of one
 * relationship could swap dates, a later `remove_link` on one source then deleted the other row's dates, and a row
 * removed while the section was gone left its dates behind for the next rebuild to trip over. Statements written before
 * the column existed have no source; with several kept rows for their relationship the writer refuses
 * (`link_dates_unattributed`) instead of guessing, and with one kept row the dates are that row's.
 * Managed brain, repo-less and Git-backed; PGLite, and Postgres from test/postgres-unit-arms.txt.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { parseLinksFence, readPageLinksFence, renderLinksFence, type LinksFenceRow } from '../src/core/links-fence.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

type Storage = 'repo-less' | 'git';
const gitSetup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

const ALICE = 'people/alice-example';
const PERSON = (body: string) => `---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\n${body}`;
const COMPANY = (title: string) => `---\ntype: company\ntitle: ${title}\n---\n\n# ${title}\n\nA company.\n`;
const ACME = 'companies/acme-example';
const BETA: LinksFenceRow = { to: 'companies/beta-example', type: 'advises', source: 'manual', context: 'board seat' };
const FIRST_STINT: LinksFenceRow = { to: ACME, type: 'works_at', source: 'manual', validFrom: '2020-01-01', validUntil: '2021-01-01', context: 'first stint' };
const SECOND_STINT: LinksFenceRow = { to: ACME, type: 'works_at', source: 'crm-import', validFrom: '2022-01-01', context: 'second stint' };
const SECTION = (rows: LinksFenceRow[]) => `## Links\n\n${renderLinksFence(rows)}\n`;
const DROPPED = 'Alice, rewritten by an agent without the links section.\n';

const op = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, unknown>>;
const put = async (ctx: OperationContext, slug: string, content: string) => {
  const prior = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  await op(ctx, 'put_page', { slug, content, ...(prior ? { expected_revision: prior.revision } : {}) });
};
const addBeta = (ctx: OperationContext) => op(ctx, 'add_link', { from: ALICE, to: BETA.to, link_type: BETA.type, context: BETA.context });
const revision = async (engine: BrainEngine) => (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!.revision;

/** Alice's manual dated statements, one string per statement: `<to> <kind> <date> <source or NULL>`. */
const statements = async (engine: BrainEngine) => (await engine.executeRaw<{ to: string; kind: string; on: string; source: string | null }>(
  `SELECT t.slug AS to, lt.kind, lt.occurred_on::text AS on, lt.link_source AS source FROM link_transitions lt
     JOIN pages f ON f.id=lt.from_page_id JOIN pages t ON t.id=lt.to_page_id
    WHERE f.source_id='default' AND f.slug=$1 AND lt.producer='manual'`, [ALICE]))
  .map(row => `${row.to} ${row.kind} ${row.on} ${row.source ?? 'NULL'}`).sort();
/** The same statements without their source, so the two loss tests read the same on a brain that predates the column. */
const dates = async (engine: BrainEngine) => (await engine.executeRaw<{ to: string; kind: string; on: string }>(
  `SELECT t.slug AS to, lt.kind, lt.occurred_on::text AS on FROM link_transitions lt JOIN pages f ON f.id=lt.from_page_id JOIN pages t ON t.id=lt.to_page_id
    WHERE f.source_id='default' AND f.slug=$1 AND lt.producer='manual'`, [ALICE])).map(row => `${row.to} ${row.kind} ${row.on}`).sort();
const edges = async (engine: BrainEngine) => (await engine.executeRaw<{ to: string; source: string }>(
  `SELECT t.slug AS to, l.link_source AS source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.source_id='default' AND f.slug=$1 AND l.origin_field='links_fence'`, [ALICE])).map(row => `${row.to} ${row.source}`).sort();
const sortRows = (rows: LinksFenceRow[]) => [...rows].sort((a, b) => `${a.to}${a.source}`.localeCompare(`${b.to}${b.source}`));
const pageRows = async (engine: BrainEngine) => sortRows(readPageLinksFence((await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!.page).rows);
/** Simulates statements written before link_transitions had a source column. */
const forgetSources = (engine: BrainEngine) => engine.executeRaw(
  `UPDATE link_transitions SET link_source=NULL WHERE producer='manual' AND from_page_id=(SELECT id FROM pages WHERE source_id='default' AND slug=$1)`, [ALICE]);

async function seed(ctx: OperationContext) {
  await put(ctx, ACME, COMPANY('Acme Example'));
  await put(ctx, BETA.to, COMPANY('Beta Example'));
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  for (const storage of ['repo-less', 'git'] as Storage[]) {
    const opts = { databaseUrl, ...(storage === 'git' ? { setup: gitSetup } : {}) };
    const fileRows = async (engine: BrainEngine, root: string) => {
      if (storage === 'git') await settleManagedGitEffects(engine);
      return sortRows(parseLinksFence(readFileSync(join(root, `${ALICE}.md`), 'utf8')).rows);
    };

    describe(`each links-section row keeps its own dates (${backend}, ${storage})`, () => {
      test('two rows of one relationship from different sources: the rebuilt section keeps each row\'s dates, and remove_link on one source keeps the other\'s', () => managedBrain(async ({ engine, ctx, root }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([FIRST_STINT, SECOND_STINT])}`));
        await put(ctx, ALICE, PERSON(DROPPED));
        await addBeta(ctx);
        expect(await pageRows(engine)).toEqual(sortRows([FIRST_STINT, SECOND_STINT, BETA]));
        await op(ctx, 'remove_link', { from: ALICE, to: ACME, link_type: 'works_at', link_source: 'crm-import' });
        expect(await pageRows(engine)).toEqual(sortRows([FIRST_STINT, BETA]));
        expect(await dates(engine)).toEqual([`${ACME} end 2021-01-01`, `${ACME} start 2020-01-01`]);
        expect(await statements(engine)).toEqual([`${ACME} end 2021-01-01 manual`, `${ACME} start 2020-01-01 manual`]);
        expect(await fileRows(engine, root)).toEqual(sortRows([FIRST_STINT, BETA]));
      }, opts), 180_000);

      test('a row removed while the section is gone takes its dates with it, and the next add_link keeps the remaining row exactly', () => managedBrain(async ({ engine, ctx, root }) => {
        const current: LinksFenceRow = { to: ACME, type: 'works_at', source: 'manual', validFrom: '2022-01-01', context: 'current stint' };
        const past: LinksFenceRow = { ...FIRST_STINT, source: 'crm-import' };
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([current, past])}`));
        await put(ctx, ALICE, PERSON(DROPPED));
        await op(ctx, 'remove_link', { from: ALICE, to: ACME, link_type: 'works_at', link_source: 'crm-import' });
        expect(await dates(engine)).toEqual([`${ACME} start 2022-01-01`]);
        await addBeta(ctx);
        expect(await pageRows(engine)).toEqual(sortRows([current, BETA]));
        expect(await dates(engine)).toEqual([`${ACME} start 2022-01-01`]);
        expect(await statements(engine)).toEqual([`${ACME} start 2022-01-01 manual`]);
        expect(await fileRows(engine, root)).toEqual(sortRows([current, BETA]));
      }, opts), 180_000);

      test('two rows of one relationship sharing a date both show it after the section is rebuilt', () => managedBrain(async ({ engine, ctx }) => {
        const fromCrm: LinksFenceRow = { to: ACME, type: 'works_at', source: 'crm-import', validFrom: '2020-01-01', context: 'from the import' };
        const byHand: LinksFenceRow = { to: ACME, type: 'works_at', source: 'manual', validFrom: '2020-01-01', context: 'typed in' };
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([fromCrm, byHand])}`));
        await put(ctx, ALICE, PERSON(DROPPED));
        await addBeta(ctx);
        expect(await pageRows(engine)).toEqual(sortRows([fromCrm, byHand, BETA]));
        expect(await statements(engine)).toEqual([`${ACME} start 2020-01-01 crm-import`, `${ACME} start 2020-01-01 manual`]);
      }, opts), 180_000);

      test('statements from before the source column, several kept rows: add_link and remove_link refuse link_dates_unattributed and change nothing', () => managedBrain(async ({ engine, ctx }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([FIRST_STINT, SECOND_STINT])}`));
        await put(ctx, ALICE, PERSON(DROPPED));
        await forgetSources(engine);
        const before = { revision: await revision(engine), statements: await statements(engine), edges: await edges(engine) };
        expect(before.statements).toEqual([`${ACME} end 2021-01-01 NULL`, `${ACME} start 2020-01-01 NULL`, `${ACME} start 2022-01-01 NULL`]);
        const refusal = { code: 'link_dates_unattributed', message: expect.stringMatching(new RegExp(`${ACME}[^]*edit_page`)) };
        await expect(addBeta(ctx)).rejects.toMatchObject(refusal);
        await expect(op(ctx, 'remove_link', { from: ALICE, to: ACME, link_type: 'works_at', link_source: 'crm-import' })).rejects.toMatchObject(refusal);
        expect({ revision: await revision(engine), statements: await statements(engine), edges: await edges(engine) }).toEqual(before);
      }, opts), 180_000);

      test('statements from before the source column, one kept row: add_link puts them on that row and labels them with its source', () => managedBrain(async ({ engine, ctx, root }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([FIRST_STINT])}`));
        await put(ctx, ALICE, PERSON(DROPPED));
        await forgetSources(engine);
        await addBeta(ctx);
        expect(await pageRows(engine)).toEqual(sortRows([FIRST_STINT, BETA]));
        expect(await statements(engine)).toEqual([`${ACME} end 2021-01-01 manual`, `${ACME} start 2020-01-01 manual`]);
        expect(await fileRows(engine, root)).toEqual(sortRows([FIRST_STINT, BETA]));
      }, opts), 180_000);

      test('a page that still has its links section labels statements from before the source column on its next write', () => managedBrain(async ({ engine, ctx }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([FIRST_STINT, SECOND_STINT])}`));
        await forgetSources(engine);
        await put(ctx, ALICE, PERSON(`Alice v2.\n\n${SECTION([FIRST_STINT, SECOND_STINT])}`));
        expect(await statements(engine)).toEqual([`${ACME} end 2021-01-01 manual`, `${ACME} start 2020-01-01 manual`, `${ACME} start 2022-01-01 crm-import`]);
      }, opts), 180_000);

      test('append_page text holding a links fence is refused and the page keeps its links', () => managedBrain(async ({ engine, ctx }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([FIRST_STINT])}`));
        await put(ctx, ALICE, PERSON(DROPPED));
        const before = await revision(engine);
        await expect(op(ctx, 'append_page', { slug: ALICE, text: SECTION([BETA]) })).rejects.toMatchObject({ code: 'append_links_fence' });
        expect(await revision(engine)).toBe(before);
        expect(await edges(engine)).toEqual([`${ACME} manual`]);
      }, opts), 180_000);

      test('append_page text without links markers is appended unchanged', () => managedBrain(async ({ engine, ctx }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([FIRST_STINT])}`));
        await op(ctx, 'append_page', { slug: ALICE, text: 'Alice joined the example reading group.' });
        expect((await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!.page.compiled_truth).toContain('Alice joined the example reading group.');
        expect(await edges(engine)).toEqual([`${ACME} manual`]);
        expect(await pageRows(engine)).toEqual([FIRST_STINT]);
      }, opts), 180_000);
    });
  }
}

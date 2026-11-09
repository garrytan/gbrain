/**
 * A page rewrite that drops its `## Links` section leaves the section's edges in place (an absent links fence retires
 * nothing). `add_link` used to build a brand-new section holding only its own row, and projecting it deleted every
 * other edge the dropped section held, with their dates, and no record to restore them from. `add_link` now renders the
 * kept edges (type, provenance, context, dates) into the section it creates. A link the user withdrew (remove_link while
 * the section is gone, an explicit empty section, or a row deleted inside the section) stays withdrawn. `append_page`
 * text holding a links fence marker is refused, as facts and takes markers are.
 * Managed brain, repo-less and Git-backed; PGLite, and Postgres from test/postgres-unit-arms.txt.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { linksFenceRowProblem, parseLinksFence, readPageLinksFence, renderLinksFence } from '../src/core/links-fence.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

type Storage = 'repo-less' | 'git';
const gitSetup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

const ALICE = 'people/alice-example';
const PERSON = (body: string) => `---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\n${body}`;
const COMPANY = (title: string) => `---\ntype: company\ntitle: ${title}\n---\n\n# ${title}\n\nA company.\n`;
const ACME = { to: 'companies/acme-example', type: 'works_at', source: 'manual', validFrom: '2025-03-01', context: 'met at a conference' };
const BETA = { to: 'companies/beta-example', type: 'advises', source: 'manual', context: 'board seat' };
const GAMMA = { to: 'companies/gamma-example', type: 'invested_in', source: 'manual', context: 'seed round' };
const ACME_PAST = { to: ACME.to, type: 'works_at', source: 'manual', validFrom: '2020-01-01', validUntil: '2021-01-01', context: 'first stint' };
const ACME_AGAIN = { to: ACME.to, type: 'works_at', source: 'crm-import', validFrom: '2022-01-01', context: 'second stint' };
const SECTION = (rows: Array<typeof ACME | typeof BETA | typeof ACME_PAST>) => `## Links\n\n${renderLinksFence(rows)}\n`;

const op = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, unknown>>;
const put = async (ctx: OperationContext, slug: string, content: string) => {
  const prior = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  await op(ctx, 'put_page', { slug, content, ...(prior ? { expected_revision: prior.revision } : {}) });
};
const addLink = (ctx: OperationContext, row: { to: string; type: string; context: string; validFrom?: string }) =>
  op(ctx, 'add_link', { from: ALICE, to: row.to, link_type: row.type, context: row.context, ...(row.validFrom ? { valid_from: row.validFrom } : {}) });

const edges = (engine: BrainEngine) => engine.executeRaw<{ to: string; type: string; source: string; context: string }>(
  `SELECT t.slug AS to, l.link_type AS type, l.link_source AS source, l.context FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.source_id='default' AND f.slug=$1 AND l.origin_field='links_fence' ORDER BY t.slug`, [ALICE]);
const transitions = (engine: BrainEngine) => engine.executeRaw<{ to: string; type: string; kind: string; on: string }>(
  `SELECT t.slug AS to, lt.link_type AS type, lt.kind, lt.occurred_on::text AS on FROM link_transitions lt JOIN pages f ON f.id=lt.from_page_id
    JOIN pages t ON t.id=lt.to_page_id WHERE f.source_id='default' AND f.slug=$1 AND lt.producer='manual' ORDER BY t.slug, lt.kind`, [ALICE]);
const fenceRows = async (engine: BrainEngine) => readPageLinksFence((await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!.page).rows;
const edgeOf = ({ to, type, source, context }: { to: string; type: string; source: string; context: string }) => ({ to, type, source, context });

async function seed(ctx: OperationContext) {
  await put(ctx, ACME.to, COMPANY('Acme Example'));
  await put(ctx, BETA.to, COMPANY('Beta Example'));
  await put(ctx, GAMMA.to, COMPANY('Gamma Example'));
}

test('an explicit empty links section parses as a read fence with no rows', () => {
  expect(parseLinksFence(`## Links\n\n${renderLinksFence([])}\n`)).toEqual({ state: 'parsed', rows: [], warnings: [] });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  for (const storage of ['repo-less', 'git'] as Storage[]) {
    const opts = { databaseUrl, ...(storage === 'git' ? { setup: gitSetup } : {}) };
    const fileHolds = async (engine: BrainEngine, root: string, present: string[], absent: string[] = []) => {
      if (storage === 'git') await settleManagedGitEffects(engine);
      const rows = parseLinksFence(readFileSync(join(root, `${ALICE}.md`), 'utf8')).rows.map(row => row.to);
      expect(rows).toEqual(present);
      for (const slug of absent) expect(rows).not.toContain(slug);
    };

    describe(`a links section re-created by add_link keeps the edges a dropped section left (${backend}, ${storage})`, () => {
      test('put with a links section, put without it, add_link, then a tag: both edges and both rows survive with dates and context', () => managedBrain(async ({ engine, ctx, root }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([ACME])}`));
        expect(await edges(engine)).toEqual([edgeOf(ACME)]);
        await put(ctx, ALICE, PERSON('Alice v2, rewritten by an agent without the links section.\n'));
        expect(await edges(engine)).toEqual([edgeOf(ACME)]);
        await addLink(ctx, BETA);
        await op(ctx, 'add_tag', { slug: ALICE, tag: 'example' });
        expect(await edges(engine)).toEqual([edgeOf(ACME), edgeOf(BETA)]);
        expect(await transitions(engine)).toEqual([{ to: ACME.to, type: ACME.type, kind: 'start', on: ACME.validFrom }]);
        expect(await fenceRows(engine)).toEqual([ACME, BETA]);
        await fileHolds(engine, root, [ACME.to, BETA.to]);
      }, opts), 180_000);

      test('two kept rows to the same page and type with different sources and dates: add_link succeeds and every dated statement survives', () => managedBrain(async ({ engine, ctx, root }) => {
        const bySource = <T extends { source: string }>(rows: T[]) => [...rows].sort((a, b) => a.source.localeCompare(b.source));
        const byDate = <T extends { kind: string; on: string }>(rows: T[]) => [...rows].sort((a, b) => `${a.kind}${a.on}`.localeCompare(`${b.kind}${b.on}`));
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([ACME_PAST, ACME_AGAIN])}`));
        const stated = byDate(await transitions(engine));
        expect(stated).toEqual([{ to: ACME.to, type: 'works_at', kind: 'end', on: '2021-01-01' },
          { to: ACME.to, type: 'works_at', kind: 'start', on: '2020-01-01' }, { to: ACME.to, type: 'works_at', kind: 'start', on: '2022-01-01' }]);
        await put(ctx, ALICE, PERSON('Alice v2, rewritten by an agent without the links section.\n'));
        await addLink(ctx, BETA);
        await op(ctx, 'add_tag', { slug: ALICE, tag: 'example' });
        expect(bySource(await edges(engine))).toEqual(bySource([edgeOf(ACME_PAST), edgeOf(ACME_AGAIN), edgeOf(BETA)]));
        expect(byDate(await transitions(engine))).toEqual(stated);
        const rows = await fenceRows(engine);
        expect(rows.map(linksFenceRowProblem)).toEqual([null, null, null]);
        expect(rows.flatMap(row => row.to === ACME.to ? [row.validFrom, row.validUntil] : []).filter(Boolean).sort()).toEqual(['2020-01-01', '2021-01-01', '2022-01-01']);
        await fileHolds(engine, root, [ACME.to, ACME.to, BETA.to]);
      }, opts), 180_000);

      test('a link removed with remove_link while the section is gone stays removed after a later add_link', () => managedBrain(async ({ engine, ctx, root }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([ACME])}`));
        await put(ctx, ALICE, PERSON('Alice v2, rewritten by an agent without the links section.\n'));
        await op(ctx, 'remove_link', { from: ALICE, to: ACME.to, link_type: ACME.type });
        expect(await edges(engine)).toEqual([]);
        await addLink(ctx, BETA);
        await op(ctx, 'add_tag', { slug: ALICE, tag: 'example' });
        expect(await edges(engine)).toEqual([edgeOf(BETA)]);
        expect(await fenceRows(engine)).toEqual([BETA]);
        await fileHolds(engine, root, [BETA.to], [ACME.to]);
      }, opts), 180_000);

      test('links retired by an explicit empty section stay retired after the section is dropped and add_link re-creates it', () => managedBrain(async ({ engine, ctx, root }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([ACME])}`));
        await put(ctx, ALICE, PERSON(`Alice v2.\n\n## Links\n\n${renderLinksFence([])}\n`));
        expect(await edges(engine)).toEqual([]);
        await put(ctx, ALICE, PERSON('Alice v3, rewritten by an agent without the links section.\n'));
        await addLink(ctx, BETA);
        await op(ctx, 'add_tag', { slug: ALICE, tag: 'example' });
        expect(await edges(engine)).toEqual([edgeOf(BETA)]);
        expect(await fenceRows(engine)).toEqual([BETA]);
        await fileHolds(engine, root, [BETA.to], [ACME.to]);
      }, opts), 180_000);

      test('a row deleted inside a present section stays deleted after the section is dropped and add_link re-creates it', () => managedBrain(async ({ engine, ctx, root }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([ACME, BETA])}`));
        await put(ctx, ALICE, PERSON(`Alice v2.\n\n${SECTION([BETA])}`));
        expect(await edges(engine)).toEqual([edgeOf(BETA)]);
        await put(ctx, ALICE, PERSON('Alice v3, rewritten by an agent without the links section.\n'));
        await addLink(ctx, GAMMA);
        await op(ctx, 'add_tag', { slug: ALICE, tag: 'example' });
        expect(await edges(engine)).toEqual([edgeOf(BETA), edgeOf(GAMMA)]);
        expect(await fenceRows(engine)).toEqual([BETA, GAMMA]);
        expect(await transitions(engine)).toEqual([]);
        await fileHolds(engine, root, [BETA.to, GAMMA.to], [ACME.to]);
      }, opts), 180_000);

      test('append_page text holding a links fence is refused and the page keeps its edges', () => managedBrain(async ({ engine, ctx }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([ACME])}`));
        await put(ctx, ALICE, PERSON('Alice v2, rewritten by an agent without the links section.\n'));
        const before = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!.revision;
        await expect(op(ctx, 'append_page', { slug: ALICE, text: SECTION([BETA]) })).rejects.toMatchObject({ code: 'append_links_fence' });
        expect((await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!.revision).toBe(before);
        expect(await edges(engine)).toEqual([edgeOf(ACME)]);
      }, opts), 180_000);

      test('append_page text without links markers is appended unchanged', () => managedBrain(async ({ engine, ctx }) => {
        await seed(ctx);
        await put(ctx, ALICE, PERSON(`Alice v1.\n\n${SECTION([ACME])}`));
        await op(ctx, 'append_page', { slug: ALICE, text: 'Alice joined the example reading group.' });
        expect((await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!.page.compiled_truth).toContain('Alice joined the example reading group.');
        expect(await edges(engine)).toEqual([edgeOf(ACME)]);
        expect(await fenceRows(engine)).toEqual([ACME]);
      }, opts), 180_000);
    });
  }
}

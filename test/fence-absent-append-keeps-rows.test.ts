/**
 * A page rewrite that drops its `## Facts` or takes section keeps the section's rows live under a `fence_absent`
 * hold until the user decides. gbrain's own appends (remember, takes_add) used to build a brand-new section holding only
 * the new row, so the next ordinary write (a tag, a timeline entry, an append, a get/put round trip) read that section as
 * the user's answer and expired the remembered facts or deleted the takes it no longer listed. The append now renders
 * the held rows back into the section it creates. A row the user withdrew (forget, takes_remove, an explicit empty
 * section) stays withdrawn.
 * Managed brain, repo-less (a plain content root) and Git-backed; PGLite, and Postgres from test/postgres-unit-arms.txt.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { emptyFenceBlock } from '../src/core/generations/fence.ts';
import { publishManagedEntityFacts } from '../src/core/facts/managed-fact-write.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { redirectManagedPhantom } from '../src/core/cycle/phantom-redirect-managed.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

type Storage = 'repo-less' | 'git';
const STORAGES: Storage[] = ['repo-less', 'git'];
const gitSetup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

const PERSON = (body: string) => `---\ntype: person\ntitle: Alice Example\n---\n\n# Alice Example\n\n${body}`;
const COMPANY = (body: string) => `---\ntype: company\ntitle: Acme Example\n---\n\n# Acme Example\n\n${body}`;
const FACT_A = 'Alice Example is allergic to peanuts';
const FACT_B = 'Alice Example rides a bike to work';
const TAKE_A = 'Acme Example reaches profitability in 2027';
const TAKE_B = 'Acme Example hires a finance lead this year';

const op = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, unknown>>;
const revision = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
const put = async (ctx: OperationContext, slug: string, content: string) => {
  const prior = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  await op(ctx, 'put_page', { slug, content, ...(prior ? { expected_revision: prior.revision } : {}) });
};
const remember = (ctx: OperationContext, slug: string, fact: string) =>
  op(ctx, 'remember', { fact, entity: slug, provenance: 'test', content_origin: 'user_said' });

const facts = (engine: BrainEngine, slug: string) => engine.executeRaw<{ id: number; fact: string; row_num: number | null; expired: boolean }>(
  "SELECT id::int AS id, fact, row_num, expired_at IS NOT NULL AS expired FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY id", [slug]);
const takes = (engine: BrainEngine, slug: string) => engine.executeRaw<{ row_num: number; claim: string; active: boolean }>(
  "SELECT t.row_num, t.claim, t.active FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY t.row_num", [slug]);
const body = async (engine: BrainEngine, slug: string) => {
  const page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
  return `${page.compiled_truth}\n${page.timeline ?? ''}`;
};
const fenceFacts = async (engine: BrainEngine, slug: string) => parseFactsFence(await body(engine, slug)).facts.filter(f => f.active).map(f => f.claim).sort();
const fenceTakes = async (engine: BrainEngine, slug: string) => parseTakesFence(await body(engine, slug)).takes.map(t => t.claim).sort();
const held = (engine: BrainEngine, slug: string) => engine.executeRaw<{ kind: string }>(
  "SELECT kind FROM derived_generations WHERE source_id='default' AND owner_key=$1 AND state='held' ORDER BY kind", [`page:${slug}`]);

/** The writes that used to read the re-created section as proof: each is an ordinary page write that projects the fences. */
const FOLLOW_UPS: Array<[string, (ctx: OperationContext, slug: string) => Promise<unknown>]> = [
  ['tag', (ctx, slug) => op(ctx, 'add_tag', { slug, tag: 'example' })],
  ['timeline entry', (ctx, slug) => op(ctx, 'add_timeline_entry', { slug, date: '2026-01-01', summary: 'An example event' })],
  ['append', (ctx, slug) => op(ctx, 'append_page', { slug, text: 'An appended line.' })],
  ['get/edit/put round trip', async (ctx, slug) => {
    const page = await op(ctx, 'get_page', { slug, include_content: true }) as { content: string; revision: string };
    await op(ctx, 'put_page', { slug, content: page.content.replace('rewritten', 'edited'), expected_revision: page.revision });
  }],
];

async function checkFileHolds(engine: BrainEngine, root: string, storage: Storage, slug: string, claims: string[]) {
  if (storage === 'git') await settleManagedGitEffects(engine);
  const file = readFileSync(join(root, `${slug}.md`), 'utf8');
  for (const claim of claims) expect(file).toContain(claim);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  for (const storage of STORAGES) {
    const opts = { databaseUrl, ...(storage === 'git' ? { setup: gitSetup } : {}) };

    describe(`a section re-created by gbrain's own append keeps the rows a fenceless rewrite left held (${backend}, ${storage})`, () => {
      for (const [name, followUp] of FOLLOW_UPS) {
        test(`fact: remember, fenceless put, remember, then ${name}: the first fact stays live`, () => managedBrain(async ({ engine, ctx, root }) => {
          const slug = 'people/alice-example';
          await put(ctx, slug, PERSON('Alice v1.\n'));
          await remember(ctx, slug, FACT_A);
          await put(ctx, slug, PERSON('Alice v2, rewritten by an agent without the facts section.\n'));
          expect((await facts(engine, slug)).map(f => [f.fact, f.row_num, f.expired])).toEqual([[FACT_A, 1, false]]);
          await remember(ctx, slug, FACT_B);
          expect(await fenceFacts(engine, slug)).toEqual([FACT_A, FACT_B].sort());
          await followUp(ctx, slug);
          expect((await facts(engine, slug)).map(f => [f.fact, f.row_num, f.expired])).toEqual([[FACT_A, 1, false], [FACT_B, 2, false]]);
          expect(await fenceFacts(engine, slug)).toEqual([FACT_A, FACT_B].sort());
          expect(await held(engine, slug)).toEqual([]);
          await checkFileHolds(engine, root, storage, slug, [FACT_A, FACT_B]);
        }, opts), 180_000);
      }

      test('fact: the managed entity-fact writer (extraction, Google loops) keeps the held fact when it re-creates the section', () => managedBrain(async ({ engine, ctx, root }) => {
        const slug = 'people/alice-example';
        await put(ctx, slug, PERSON('Alice v1.\n'));
        await remember(ctx, slug, FACT_A);
        await put(ctx, slug, PERSON('Alice v2, rewritten by an agent without the facts section.\n'));
        await publishManagedEntityFacts(engine, 'default', slug, [{ fact: FACT_B, kind: 'fact', notability: 'medium', source: 'test-extractor',
          visibility: 'world', validFrom: new Date('2026-01-01'), sessionId: null, confidence: 1 } as never]);
        expect(await fenceFacts(engine, slug)).toEqual([FACT_A, FACT_B].sort());
        await op(ctx, 'add_tag', { slug, tag: 'example' });
        expect((await facts(engine, slug)).map(f => [f.fact, f.row_num, f.expired])).toEqual([[FACT_A, 1, false], [FACT_B, 2, false]]);
        expect(await held(engine, slug)).toEqual([]);
        await checkFileHolds(engine, root, storage, slug, [FACT_A, FACT_B]);
      }, opts), 180_000);

      test('fact: facts relink keeps the held fact when it re-creates the section', () => managedBrain(async ({ engine, ctx, root }) => {
        const slug = 'people/alice-example';
        await put(ctx, slug, PERSON('Alice v1.\n'));
        await remember(ctx, slug, FACT_A);
        await put(ctx, slug, PERSON('Alice v2, rewritten by an agent without the facts section.\n'));
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.insertFact({ fact: FACT_B, kind: 'fact', entity_slug: null,
          visibility: 'world', source: 'chat' } as never, { source_id: 'default' }), TEST_WRITE_ATTRIBUTION));
        expect((await runFactsRelink(engine, { sourceId: 'default', config: ctx.config, llm: false })).linked).toBe(1);
        expect(await fenceFacts(engine, slug)).toEqual([FACT_A, FACT_B].sort());
        await op(ctx, 'add_tag', { slug, tag: 'example' });
        expect((await facts(engine, slug)).map(f => [f.fact, f.expired])).toEqual([[FACT_A, false], [FACT_B, false]]);
        expect(await held(engine, slug)).toEqual([]);
        await checkFileHolds(engine, root, storage, slug, [FACT_A, FACT_B]);
      }, opts), 180_000);

      test('fact: a phantom redirect into the page keeps the held fact when it re-creates the section', () => managedBrain(async ({ engine, ctx, root }) => {
        const slug = 'people/alice-example';
        await put(ctx, slug, PERSON('Alice v1.\n'));
        await remember(ctx, slug, FACT_A);
        await put(ctx, slug, PERSON('Alice v2, rewritten by an agent without the facts section.\n'));
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.putPage('alice', { type: 'person', title: 'alice', timeline: '', frontmatter: {},
          compiled_truth: '# alice\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n\n'
            + '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
            + `| 1 | ${FACT_B} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n<!--- gbrain:facts:end -->` }, { sourceId: 'default' }), TEST_WRITE_ATTRIBUTION));
        const phantom = (await engine.readPageSnapshot('alice', { sourceId: 'default' }))!;
        writeFileSync(join(root, 'alice.md'), serializePageToMarkdown(phantom.page, phantom.tags));
        expect(await redirectManagedPhantom(engine, phantom.page, slug, 'default')).toEqual({ outcome: 'redirected', canonical: slug });
        expect(await fenceFacts(engine, slug)).toEqual([FACT_A, FACT_B].sort());
        await op(ctx, 'add_tag', { slug, tag: 'example' });
        expect((await facts(engine, slug)).filter(f => !f.expired).map(f => f.fact).sort()).toEqual([FACT_A, FACT_B].sort());
        expect(await held(engine, slug)).toEqual([]);
        await checkFileHolds(engine, root, storage, slug, [FACT_A, FACT_B]);
      }, opts), 180_000);

      test('take: takes_add, fenceless put, takes_add, then a tag: the first take is not deleted', () => managedBrain(async ({ engine, ctx, root }) => {
        const slug = 'companies/acme-example';
        await put(ctx, slug, COMPANY('Acme v1.\n'));
        await op(ctx, 'takes_add', { slug, claim: TAKE_A, kind: 'bet', holder: 'world' });
        await put(ctx, slug, COMPANY('Acme v2, rewritten without the takes section.\n'));
        expect((await takes(engine, slug)).map(t => t.claim)).toEqual([TAKE_A]);
        await op(ctx, 'takes_add', { slug, claim: TAKE_B, kind: 'bet', holder: 'world' });
        expect(await fenceTakes(engine, slug)).toEqual([TAKE_A, TAKE_B].sort());
        expect(await held(engine, slug)).toEqual([]);
        await op(ctx, 'add_tag', { slug, tag: 'example' });
        expect(await takes(engine, slug)).toEqual([{ row_num: 1, claim: TAKE_A, active: true }, { row_num: 2, claim: TAKE_B, active: true }]);
        expect(await fenceTakes(engine, slug)).toEqual([TAKE_A, TAKE_B].sort());
        expect(await held(engine, slug)).toEqual([]);
        await checkFileHolds(engine, root, storage, slug, [TAKE_A, TAKE_B]);
      }, opts), 180_000);

      test('a forgotten fact stays forgotten: it is not rendered back into the re-created section', () => managedBrain(async ({ engine, ctx }) => {
        const slug = 'people/alice-example';
        await put(ctx, slug, PERSON('Alice v1.\n'));
        const { id } = await remember(ctx, slug, FACT_A) as { id: number };
        await op(ctx, 'forget', { id: String(id), reason: 'the user withdrew it' });
        await put(ctx, slug, PERSON('Alice v2, rewritten by an agent without the facts section.\n'));
        await remember(ctx, slug, FACT_B);
        await op(ctx, 'add_tag', { slug, tag: 'example' });
        const rows = await facts(engine, slug);
        expect(rows.find(f => f.fact === FACT_A)).toMatchObject({ expired: true });
        expect(rows.find(f => f.fact === FACT_B)).toMatchObject({ expired: false });
        expect(await fenceFacts(engine, slug)).toEqual([FACT_B]);
      }, opts), 180_000);

      test('facts retired by an explicit empty section stay retired after a later fenceless put and remember', () => managedBrain(async ({ engine, ctx }) => {
        const slug = 'people/alice-example';
        await put(ctx, slug, PERSON('Alice v1.\n'));
        await remember(ctx, slug, FACT_A);
        await put(ctx, slug, PERSON(`Alice v2.\n\n${emptyFenceBlock('facts')}`));
        expect((await facts(engine, slug)).map(f => [f.fact, f.expired])).toEqual([[FACT_A, true]]);
        await put(ctx, slug, PERSON('Alice v3, rewritten by an agent without the facts section.\n'));
        await remember(ctx, slug, FACT_B);
        await op(ctx, 'add_tag', { slug, tag: 'example' });
        expect((await facts(engine, slug)).map(f => [f.fact, f.expired])).toEqual([[FACT_A, true], [FACT_B, false]]);
        expect(await fenceFacts(engine, slug)).toEqual([FACT_B]);
      }, opts), 180_000);

      test('a removed take stays removed: it is not rendered back into the re-created section', () => managedBrain(async ({ engine, ctx }) => {
        const slug = 'companies/acme-example';
        await put(ctx, slug, COMPANY('Acme v1.\n'));
        await op(ctx, 'takes_add', { slug, claim: TAKE_A, kind: 'bet', holder: 'world' });
        await op(ctx, 'takes_remove', { slug, row_num: 1 });
        await put(ctx, slug, COMPANY('Acme v2, rewritten without the takes section.\n'));
        await op(ctx, 'takes_add', { slug, claim: TAKE_B, kind: 'bet', holder: 'world' });
        await op(ctx, 'add_tag', { slug, tag: 'example' });
        expect((await takes(engine, slug)).map(t => t.claim)).toEqual([TAKE_B]);
        expect((await fenceTakes(engine, slug)).filter(claim => claim !== '(removed)')).toEqual([TAKE_B]);
      }, opts), 180_000);
    });
  }
}

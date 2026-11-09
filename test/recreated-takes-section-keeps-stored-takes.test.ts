/**
 * A page whose takes section was dropped keeps its takes stored: on an unmanaged brain the takes reconcile keeps a
 * fenceless page's rows, and on a managed one the projection holds them `fence_absent` until the user decides. Three
 * gbrain writers used to build a brand-new takes section numbered from row 1 on such a page: `think --take`
 * (addTakeToPage) and unmanaged `takes extract --from-pages` (appendTakesToPageMdFirst) overwrote stored take #1 in
 * place with no record, and managed `takes extract --from-pages --include-covered` overwrote takes 1..k and deleted the
 * rest in one put. Each writer now renders the stored takes (resolutions included) into the section it creates and
 * numbers its rows after them. A take the user removed, and takes an explicit empty section retired, stay removed.
 * A page whose takes markers are malformed is skipped by the extraction run (which goes on to the next page), and a
 * stored resolution without a quality, which the section cannot carry, makes the writer refuse instead of dropping it.
 * Unmanaged brain (a plain directory and a Git repo) and managed brain (repo-less and Git); PGLite, and Postgres from
 * test/postgres-unit-arms.txt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { extractTakes } from '../src/core/cycle/extract-takes.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import { emptyFenceBlock } from '../src/core/generations/fence.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { persistTakeFromSynthesis } from '../src/core/think/persist-take.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'concepts/acme-example-outlook';
const PROSE = 'Acme Example sells widgets to mid-size teams and has been growing steadily across several regions. '.repeat(3);
const PAGE = (body: string) => `---\ntype: concept\ntitle: Acme Example outlook\n---\n\n# Acme Example outlook\n\n${PROSE}\n\n${body}`;
const TAKE_A = 'Acme Example reaches profitability in 2027';
const TAKE_A2 = 'Acme Example opens a second office';
const THINK_CLAIM = 'Acme Example should raise prices this year.';
const EXTRACTED = ['Acme Example hires a finance lead', 'Acme Example doubles its sales team'];
const FENCE = (rows: string) => `## Takes\n\n<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n${rows}<!--- gbrain:takes:end -->\n`;
const ROW_A = `| 1 | ${TAKE_A} | bet | world | 0.6 |  | manual |\n`;
const ROW_A2 = `| 2 | ${TAKE_A2} | bet | world | 0.6 |  | manual |\n`;

let extracted: string[] = EXTRACTED;
beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'test-key' } });
  __setChatTransportForTests(async () => {
    const text = JSON.stringify(extracted.map(claim => ({ claim, kind: 'bet', weight: 0.7 })));
    return { text, blocks: [{ type: 'text' as const, text }], stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic' };
  });
});
afterAll(() => { __setChatTransportForTests(null); resetGateway(); });

const takes = (engine: BrainEngine) => engine.executeRaw<{ row_num: number; claim: string; resolved_quality: string | null }>(
  "SELECT t.row_num, t.claim, t.resolved_quality FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY t.row_num", [SLUG]);
const claims = async (engine: BrainEngine) => (await takes(engine)).map(t => [t.row_num, t.claim]);
const fileTakes = (path: string) => parseTakesFence(readFileSync(path, 'utf8')).takes.map(t => [t.rowNum, t.claim]);
const extractFromPages = (engine: BrainEngine, maxPages = 1) => extractTakesFromPages(engine, { bootstrapEnabled: true, sourceIdFilter: 'default', maxPages, includeCovered: true });
const OTHER = 'concepts/beta-example-outlook';
const otherClaims = (engine: BrainEngine) => engine.executeRaw<{ row_num: number; claim: string }>(
  "SELECT t.row_num, t.claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY t.row_num", [OTHER])
  .then(rows => rows.map(t => [t.row_num, t.claim]));
const nearMiss = (content: string) => content.replaceAll('<!--- gbrain:takes:', '<!-- gbrain:takes:');
const pageId = async (engine: BrainEngine) => Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [SLUG]))[0]!.id);
const storedResolution = (engine: BrainEngine) => engine.executeRaw<{ row_num: number; claim: string; resolved: boolean; resolved_quality: string | null; resolved_outcome: boolean | null }>(
  "SELECT t.row_num, t.claim, t.resolved_at IS NOT NULL AS resolved, t.resolved_quality, t.resolved_outcome FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY t.row_num", [SLUG]);
/** A resolution recorded before takes had a quality column: outcome only. A managed brain takes it as a fixture write. */
const qualitylessResolution = async (engine: BrainEngine, managed = false) => {
  const id = await pageId(engine);
  const write = (tx: BrainEngine) => tx.executeRaw("UPDATE takes SET resolved_at=now(), resolved_outcome=true, resolved_quality=NULL, resolved_by='system' WHERE page_id=$1 AND row_num=1", [id]);
  await (managed ? withManagedFixtureWrite(engine, ['default'], write) : write(engine));
};
/** Evidence holding the literal text `<br>`, which a takes section cell reads back as a line break. */
const LOSSY_EVIDENCE = 'Evidence says use <br> tags';
const lossyResolution = async (engine: BrainEngine, managed = false) => {
  const id = await pageId(engine);
  const write = (tx: BrainEngine) => tx.executeRaw("UPDATE takes SET resolved_at=now(), resolved_outcome=true, resolved_quality='correct', resolved_source=$2, resolved_by='system' WHERE page_id=$1 AND row_num=1", [id, LOSSY_EVIDENCE]);
  await (managed ? withManagedFixtureWrite(engine, ['default'], write) : write(engine));
};
const storedEvidence = (engine: BrainEngine) => engine.executeRaw<{ row_num: number; resolved_source: string | null }>(
  "SELECT t.row_num, t.resolved_source FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY t.row_num", [SLUG]);

type Storage = 'directory' | 'git' | 'repo-less';
const gitRepo = (root: string) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

/** An unmanaged brain (no canonical owner): pages come from files through the sync import and its takes reconcile. */
async function unmanagedBrain(databaseUrl: string | undefined, storage: Storage, run: (b: { engine: BrainEngine; path: string; sync(content: string, slug?: string): Promise<void> }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-recreated-takes-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'brain');
        mkdirSync(join(root, 'concepts'), { recursive: true });
        if (storage === 'git') gitRepo(root);
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await engine.setConfig('sync.repo_path', root);
        const path = join(root, `${SLUG}.md`);
        const sync = async (content: string, slug = SLUG) => {
          writeFileSync(join(root, `${slug}.md`), content);
          expect((await importFromFile(engine, join(root, `${slug}.md`), `${slug}.md`, { noEmbed: true })).status).toBe('imported');
          await extractTakes(engine, { repoPath: root });
        };
        await run({ engine, path, sync });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const op = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, unknown>>;
const put = async (ctx: OperationContext, content: string) => {
  const prior = await ctx.engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  await op(ctx, 'put_page', { slug: SLUG, content, ...(prior ? { expected_revision: prior.revision } : {}) });
};
const held = (engine: BrainEngine) => engine.executeRaw("SELECT kind FROM derived_generations WHERE source_id='default' AND owner_key=$1 AND state='held'", [`page:${SLUG}`]);

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  for (const storage of ['directory', 'git'] as const) {
    describe(`unmanaged brain (${backend}, ${storage}): a takes section re-created by gbrain keeps the stored takes`, () => {
      test('think --take after the section was dropped keeps the stored take and its resolution', () => unmanagedBrain(databaseUrl, storage, async ({ engine, path, sync }) => {
        await sync(PAGE(FENCE(ROW_A)));
        const [{ id }] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [SLUG]);
        await engine.resolveTake(Number(id), 1, { quality: 'correct', source: 'grader note', resolvedBy: 'system' });
        await sync(PAGE('Rewritten without the takes section.\n'));
        expect(await claims(engine)).toEqual([[1, TAKE_A]]);
        const result = await persistTakeFromSynthesis(engine, { answer: THINK_CLAIM, synthesisOk: true } as never, { anchor: SLUG, sourceId: 'default' });
        expect({ row: result.take_row, warnings: result.warnings }).toEqual({ row: 2, warnings: [] });
        expect(await takes(engine)).toEqual([{ row_num: 1, claim: TAKE_A, resolved_quality: 'correct' }, { row_num: 2, claim: THINK_CLAIM, resolved_quality: null }]);
        expect(fileTakes(path)).toEqual([[1, TAKE_A], [2, THINK_CLAIM]]);
        expect(parseTakesFence(readFileSync(path, 'utf8')).takes[0]).toMatchObject({ resolvedQuality: 'correct', resolvedEvidence: 'grader note' });
        await sync(readFileSync(path, 'utf8'));
        expect(await takes(engine)).toEqual([{ row_num: 1, claim: TAKE_A, resolved_quality: 'correct' }, { row_num: 2, claim: THINK_CLAIM, resolved_quality: null }]);
      }), 180_000);

      test('takes extract --from-pages after the section was dropped keeps the stored take', () => unmanagedBrain(databaseUrl, storage, async ({ engine, path, sync }) => {
        await sync(PAGE(FENCE(ROW_A)));
        await sync(PAGE('Rewritten without the takes section.\n'));
        expect(await extractFromPages(engine)).toMatchObject({ claims_extracted: 2, pages_skipped: 0 });
        expect(await claims(engine)).toEqual([[1, TAKE_A], [2, EXTRACTED[0]], [3, EXTRACTED[1]]]);
        expect(fileTakes(path)).toEqual([[1, TAKE_A], [2, EXTRACTED[0]], [3, EXTRACTED[1]]]);
        await sync(readFileSync(path, 'utf8'));
        expect(await claims(engine)).toEqual([[1, TAKE_A], [2, EXTRACTED[0]], [3, EXTRACTED[1]]]);
      }), 180_000);

      test('a take the user deleted from the section stays deleted after the section is dropped and re-created', () => unmanagedBrain(databaseUrl, storage, async ({ engine, path, sync }) => {
        await sync(PAGE(FENCE(ROW_A + ROW_A2)));
        await sync(PAGE(FENCE(ROW_A2)));
        expect(await claims(engine)).toEqual([[2, TAKE_A2]]);
        await sync(PAGE('Rewritten without the takes section.\n'));
        const result = await persistTakeFromSynthesis(engine, { answer: THINK_CLAIM, synthesisOk: true } as never, { anchor: SLUG, sourceId: 'default' });
        expect(result.take_row).toBe(3);
        expect(await claims(engine)).toEqual([[2, TAKE_A2], [3, THINK_CLAIM]]);
        expect(fileTakes(path)).toEqual([[2, TAKE_A2], [3, THINK_CLAIM]]);
      }), 180_000);

      test('takes retired by an explicit empty section stay retired after the section is dropped and re-created', () => unmanagedBrain(databaseUrl, storage, async ({ engine, path, sync }) => {
        await sync(PAGE(FENCE(ROW_A)));
        await sync(PAGE(`Emptied.\n\n${emptyFenceBlock('takes')}\n`));
        expect(await claims(engine)).toEqual([]);
        await sync(PAGE('Rewritten without the takes section.\n'));
        expect(await extractFromPages(engine)).toMatchObject({ claims_extracted: 2 });
        expect(await claims(engine)).toEqual([[1, EXTRACTED[0]], [2, EXTRACTED[1]]]);
        expect(fileTakes(path)).toEqual([[1, EXTRACTED[0]], [2, EXTRACTED[1]]]);
      }), 180_000);

      test('takes extract --from-pages skips a page with malformed takes markers and goes on to the next page', () => unmanagedBrain(databaseUrl, storage, async ({ engine, path, sync }) => {
        await sync(PAGE('Another page with no takes yet.\n'), OTHER);
        await sync(PAGE(FENCE(ROW_A)));
        const malformed = nearMiss(PAGE(FENCE(ROW_A)));
        writeFileSync(path, malformed);
        expect((await importFromFile(engine, path, `${SLUG}.md`, { noEmbed: true })).fences_normalized).toMatchObject([{ fence: 'takes', class: 'marker_form' }]);
        await extractTakes(engine, { repoPath: join(path, '..', '..') });
        expect(await claims(engine)).toEqual([[1, TAKE_A]]);
        expect(await extractFromPages(engine, 2)).toMatchObject({ pages_scanned: 2, claims_extracted: 2, pages_skipped: 1, skipped: [{ slug: SLUG, reason: 'fence_unparsed' }] });
        expect(await claims(engine)).toEqual([[1, TAKE_A]]);
        expect(readFileSync(path, 'utf8')).toBe(malformed);
        expect(await otherClaims(engine)).toEqual([[1, EXTRACTED[0]], [2, EXTRACTED[1]]]);
      }), 180_000);

      test('think --take refuses, and keeps the stored take, when its stored resolution has no quality', () => unmanagedBrain(databaseUrl, storage, async ({ engine, path, sync }) => {
        await sync(PAGE(FENCE(ROW_A)));
        await qualitylessResolution(engine);
        const rewritten = PAGE('Rewritten without the takes section.\n');
        await sync(rewritten);
        const stored = [{ row_num: 1, claim: TAKE_A, resolved: true, resolved_quality: null, resolved_outcome: true }];
        expect(await storedResolution(engine)).toEqual(stored);
        const result = await persistTakeFromSynthesis(engine, { answer: THINK_CLAIM, synthesisOk: true } as never, { anchor: SLUG, sourceId: 'default' });
        expect(result.take_row).toBeNull();
        expect(result.warnings).toEqual([expect.stringContaining('TAKE_WRITE_FAILED: invalid_input')]);
        expect(await storedResolution(engine)).toEqual(stored);
        expect(readFileSync(path, 'utf8')).toBe(rewritten);
      }), 180_000);

      test('think --take refuses, and keeps the stored take, when a stored cell would not read back unchanged', () => unmanagedBrain(databaseUrl, storage, async ({ engine, path, sync }) => {
        await sync(PAGE(FENCE(ROW_A)));
        await lossyResolution(engine);
        const rewritten = PAGE('Rewritten without the takes section.\n');
        await sync(rewritten);
        expect(await storedEvidence(engine)).toEqual([{ row_num: 1, resolved_source: LOSSY_EVIDENCE }]);
        const result = await persistTakeFromSynthesis(engine, { answer: THINK_CLAIM, synthesisOk: true } as never, { anchor: SLUG, sourceId: 'default' });
        expect(result.take_row).toBeNull();
        expect(result.warnings).toEqual([expect.stringContaining('TAKE_WRITE_FAILED: invalid_input')]);
        expect(await storedEvidence(engine)).toEqual([{ row_num: 1, resolved_source: LOSSY_EVIDENCE }]);
        expect(readFileSync(path, 'utf8')).toBe(rewritten);
      }), 180_000);
    });
  }

  for (const storage of ['repo-less', 'git'] as const) {
    const opts = { databaseUrl, ...(storage === 'git' ? { setup: ({ root }: { root: string }) => gitRepo(root) } : {}) };
    const fileHolds = async (engine: BrainEngine, root: string, expected: string[]) => {
      if (storage === 'git') await settleManagedGitEffects(engine);
      expect(fileTakes(join(root, `${SLUG}.md`)).map(([, claim]) => claim)).toEqual(expected);
    };

    describe(`managed brain (${backend}, ${storage}): takes extract --from-pages --include-covered keeps held takes`, () => {
      test('the held takes are kept and the extracted rows are numbered after them', () => managedBrain(async ({ engine, ctx, root }) => {
        await put(ctx, PAGE('First version.\n'));
        await op(ctx, 'takes_add', { slug: SLUG, claim: TAKE_A, kind: 'bet', holder: 'world' });
        await op(ctx, 'takes_add', { slug: SLUG, claim: TAKE_A2, kind: 'bet', holder: 'world' });
        await put(ctx, PAGE('Rewritten without the takes section.\n'));
        expect(await claims(engine)).toEqual([[1, TAKE_A], [2, TAKE_A2]]);
        extracted = EXTRACTED.slice(0, 1);
        try { expect(await extractFromPages(engine)).toMatchObject({ claims_extracted: 1, pages_skipped: 0 }); } finally { extracted = EXTRACTED; }
        expect(await claims(engine)).toEqual([[1, TAKE_A], [2, TAKE_A2], [3, EXTRACTED[0]]]);
        await op(ctx, 'add_tag', { slug: SLUG, tag: 'example' });
        expect(await claims(engine)).toEqual([[1, TAKE_A], [2, TAKE_A2], [3, EXTRACTED[0]]]);
        expect(await held(engine)).toEqual([]);
        await fileHolds(engine, root, [TAKE_A, TAKE_A2, EXTRACTED[0]]);
      }, opts), 180_000);

      test('a removed take stays removed when the extraction re-creates the section', () => managedBrain(async ({ engine, ctx, root }) => {
        await put(ctx, PAGE('First version.\n'));
        await op(ctx, 'takes_add', { slug: SLUG, claim: TAKE_A, kind: 'bet', holder: 'world' });
        await op(ctx, 'takes_add', { slug: SLUG, claim: TAKE_A2, kind: 'bet', holder: 'world' });
        await op(ctx, 'takes_remove', { slug: SLUG, row_num: 1 });
        await put(ctx, PAGE('Rewritten without the takes section.\n'));
        expect(await claims(engine)).toEqual([[2, TAKE_A2]]);
        expect(await extractFromPages(engine)).toMatchObject({ claims_extracted: 2 });
        await op(ctx, 'add_tag', { slug: SLUG, tag: 'example' });
        expect((await claims(engine)).map(([, claim]) => claim)).toEqual([TAKE_A2, ...EXTRACTED]);
        await fileHolds(engine, root, [TAKE_A2, ...EXTRACTED]);
      }, opts), 180_000);

      test('takes retired by an explicit empty section stay retired when the extraction re-creates the section', () => managedBrain(async ({ engine, ctx, root }) => {
        await put(ctx, PAGE('First version.\n'));
        await op(ctx, 'takes_add', { slug: SLUG, claim: TAKE_A, kind: 'bet', holder: 'world' });
        await put(ctx, PAGE(`Emptied.\n\n${emptyFenceBlock('takes')}\n`));
        expect(await claims(engine)).toEqual([]);
        await put(ctx, PAGE('Rewritten without the takes section.\n'));
        expect(await extractFromPages(engine)).toMatchObject({ claims_extracted: 2 });
        await op(ctx, 'add_tag', { slug: SLUG, tag: 'example' });
        expect(await claims(engine)).toEqual([[1, EXTRACTED[0]], [2, EXTRACTED[1]]]);
        await fileHolds(engine, root, EXTRACTED);
      }, opts), 180_000);

      test('a stored resolution without a quality skips the page instead of being dropped', () => managedBrain(async ({ engine, ctx }) => {
        await put(ctx, PAGE('First version.\n'));
        await op(ctx, 'takes_add', { slug: SLUG, claim: TAKE_A, kind: 'bet', holder: 'world' });
        await qualitylessResolution(engine, true);
        await put(ctx, PAGE('Rewritten without the takes section.\n'));
        const stored = [{ row_num: 1, claim: TAKE_A, resolved: true, resolved_quality: null, resolved_outcome: true }];
        expect(await storedResolution(engine)).toEqual(stored);
        expect(await extractFromPages(engine)).toMatchObject({ claims_extracted: 0, pages_skipped: 1, skipped: [{ slug: SLUG, reason: 'invalid_input' }] });
        await op(ctx, 'add_tag', { slug: SLUG, tag: 'example' });
        expect(await storedResolution(engine)).toEqual(stored);
      }, opts), 180_000);

      test('a stored cell that would not read back unchanged skips the page instead of being rewritten', () => managedBrain(async ({ engine, ctx }) => {
        await put(ctx, PAGE('First version.\n'));
        await op(ctx, 'takes_add', { slug: SLUG, claim: TAKE_A, kind: 'bet', holder: 'world' });
        await lossyResolution(engine, true);
        await put(ctx, PAGE('Rewritten without the takes section.\n'));
        expect(await storedEvidence(engine)).toEqual([{ row_num: 1, resolved_source: LOSSY_EVIDENCE }]);
        expect(await extractFromPages(engine)).toMatchObject({ claims_extracted: 0, pages_skipped: 1, skipped: [{ slug: SLUG, reason: 'invalid_input' }] });
        await op(ctx, 'add_tag', { slug: SLUG, tag: 'example' });
        expect(await storedEvidence(engine)).toEqual([{ row_num: 1, resolved_source: LOSSY_EVIDENCE }]);
      }, opts), 180_000);
    });
  }
}

/**
 * Managed `takes extract --from-pages` republishes the page with its
 * appended takes fence; the canonical projection writes every resolution
 * column from the fence, so a resolution recorded only in the database (a
 * pre-activation grade) must be carried into the fence first or it is
 * cleared. Pins: the grade survives in the database and in the canonical
 * file, and the new take lands beside it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'concepts/graded-in-database';
const BODY = 'A durable opinion with enough context to be classified as a stable claim. '.repeat(5);

beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'test-key' } });
  __setChatTransportForTests(async () => {
    const text = JSON.stringify([{ claim: 'a new bootstrap claim', kind: 'take', weight: 0.7 }]);
    return { text, blocks: [{ type: 'text' as const, text }], stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic' };
  });
});
afterAll(() => { __setChatTransportForTests(null); resetGateway(); });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`${backend}: managed extraction keeps a take resolution recorded only in the database`, async () => {
    await managedBrain(async ({ engine, root }) => {
      const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, sourceIdFilter: 'default', maxPages: 1, includeCovered: true });
      expect(result).toMatchObject({ claims_extracted: 1 });
      expect(await engine.executeRaw('SELECT t.row_num, t.claim, t.resolved_quality, t.resolved_source FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 ORDER BY t.row_num', [SLUG]))
        .toEqual([
          { row_num: 1, claim: 'an earlier graded take', resolved_quality: 'correct', resolved_source: 'grader note' },
          { row_num: 2, claim: 'a new bootstrap claim', resolved_quality: null, resolved_source: null },
        ]);
      expect(parseTakesFence(readFileSync(join(root, `${SLUG}.md`), 'utf8')).takes[0]).toMatchObject({ resolvedQuality: 'correct', resolvedEvidence: 'grader note' });
    }, { databaseUrl, setup: async ({ engine, root }) => {
      const compiledTruth = `${BODY}\n\n## Takes\n\n<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | an earlier graded take | bet | system | 0.6 |  | manual |\n<!--- gbrain:takes:end -->`;
      const page = await engine.putPage(SLUG, { type: 'concept', title: SLUG, compiled_truth: compiledTruth, timeline: '', frontmatter: {} });
      await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${SLUG}.md`, page.id]);
      await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'an earlier graded take', kind: 'bet', holder: 'system', weight: 0.6, source: 'manual', active: true, superseded_by: null }]);
      await engine.resolveTake(page.id, 1, { quality: 'correct', source: 'grader note', resolvedBy: 'system' });
      const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      const path = join(root, `${SLUG}.md`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
    } });
  }, 120_000);

  const refusals: Array<[string, string, (engine: import('../src/core/engine.ts').BrainEngine, pageId: number) => Promise<void>, string]> = [
    ['a resolution without a quality', 'invalid_input', async (engine, id) => {
      await engine.executeRaw("UPDATE takes SET resolved_at=now(), resolved_value=42, resolved_unit='USD' WHERE page_id=$1 AND row_num=1", [id]);
    }, ''],
    ['multi-line resolution evidence', 'invalid_input', async (engine, id) => {
      await engine.resolveTake(id, 1, { quality: 'correct', source: 'Line one\nLine two', resolvedBy: 'system' });
    }, ''],
    ['a malformed fence row beside the graded one', 'fence_unparsed', async (engine, id) => {
      await engine.resolveTake(id, 1, { quality: 'correct', source: 'grader note', resolvedBy: 'system' });
    }, '| 2 | a malformed row | bet | system | not-a-weight |  | manual |\n'],
  ];
  for (const [name, code, grade, extraRow] of refusals) {
    test(`${backend}: ${name} refuses the page instead of clearing its database resolution`, async () => {
      await managedBrain(async ({ engine, root }) => {
        const before = await engine.executeRaw('SELECT row_num, resolved_at, resolved_quality, resolved_source, resolved_value, resolved_unit FROM takes ORDER BY row_num');
        const file = readFileSync(join(root, `${SLUG}.md`), 'utf8');
        const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, sourceIdFilter: 'default', maxPages: 1, includeCovered: true });
        expect(result).toMatchObject({ claims_extracted: 0, pages_skipped: 1, skipped: [{ slug: SLUG, reason: code }] });
        expect(await engine.executeRaw('SELECT row_num, resolved_at, resolved_quality, resolved_source, resolved_value, resolved_unit FROM takes ORDER BY row_num')).toEqual(before);
        expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(file);
      }, { databaseUrl, setup: async ({ engine, root }) => {
        const compiledTruth = `${BODY}\n\n## Takes\n\n<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | an earlier graded take | bet | system | 0.6 |  | manual |\n${extraRow}<!--- gbrain:takes:end -->`;
        const page = await engine.putPage(SLUG, { type: 'concept', title: SLUG, compiled_truth: compiledTruth, timeline: '', frontmatter: {} });
        await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${SLUG}.md`, page.id]);
        await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'an earlier graded take', kind: 'bet', holder: 'system', weight: 0.6, source: 'manual', active: true, superseded_by: null }]);
        await grade(engine, page.id);
        const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
        const path = join(root, `${SLUG}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
      } });
    }, 120_000);
  }
}

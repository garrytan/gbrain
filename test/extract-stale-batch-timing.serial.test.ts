/**
 * 产品经理能看懂的测试说明：
 * 用一份隔离的临时库，连续补扫真实页面，打印每一批的读取、解析、解析目标、
 * 写关系、写时间线、标记水位和总耗时。
 * 停止信号必须在当前批写完后停住，后面的页面保持未处理。
 * 100、500、1000 页附近的耗时不能出现无法解释的暴涨。
 * 这个库不是用户自己的知识库。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { extractStaleFromDB } from '../src/commands/extract-stale.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

const batchSize = Math.max(1, Number(process.env.PMBRAIN_EXTRACT_STALE_BATCH || process.env.GBRAIN_EXTRACT_STALE_BATCH) || 25);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function insertPages(count: number, prefix: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
     VALUES ('default', $1, 'note', '中心页', '关系补扫的中心页', '', '{}'::jsonb)`,
    [`${prefix}/hub`],
  );
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
     SELECT 'default', $1 || i::text, 'note', '页面 ' || i::text,
            '参见 [[${prefix}/hub]] 编号 ' || i::text,
            '', '{}'::jsonb
       FROM generate_series(1, $2::int) AS i`,
    [prefix + '/', count],
  );
}

test('停止后不再写后续批次', async () => {
  await insertPages(40, 'notes/stop');
  const controller = new AbortController();
  let yielded = 0;
  await expect(extractStaleFromDB(engine, {
    dryRun: false,
    jsonMode: true,
    includeFrontmatter: false,
    catchUp: true,
    quiet: true,
    catalogAware: false,
    signal: controller.signal,
    yieldDuringPhase: async () => {
      yielded += 1;
      controller.abort();
    },
  })).rejects.toThrow();
  expect(yielded).toBe(1);
  const rows = await engine.executeRaw<{ extracted: number; pending: number }>(
    `SELECT count(*) FILTER (WHERE links_extracted_at IS NOT NULL)::int AS extracted,
            count(*) FILTER (WHERE links_extracted_at IS NULL)::int AS pending
       FROM pages
      WHERE slug LIKE 'notes/stop/%' OR slug = 'notes/stop/hub'`,
  );
  expect(Number(rows[0]?.extracted)).toBe(batchSize);
  expect(Number(rows[0]?.pending)).toBe(41 - batchSize);
}, 60_000);

test('连续补扫 1000 页时各阶段耗时不随累计页数暴涨', async () => {
  await insertPages(1000, 'notes/bench');
  const result = await extractStaleFromDB(engine, {
    dryRun: false,
    jsonMode: true,
    includeFrontmatter: false,
    catchUp: true,
    quiet: true,
    catalogAware: false,
  });
  expect(result.pagesProcessed).toBe(1001);
  expect(result.staleRemaining).toBe(0);
  expect(result.linksCreated).toBe(1000);
  const timings = result.batchTimings;
  expect(timings.length).toBeGreaterThan(0);
  expect(timings.every(row => row.engine === 'pglite')).toBe(true);
  const nearest = (pages: number) => timings.find(row => row.pagesProcessed >= pages)!;
  const marks = [100, 500, 1000].map(pages => nearest(pages));
  for (const row of marks) {
    console.log(
      `[extract-stale-bench] ${row.range} read=${Math.round(row.readMs)} parse=${Math.round(row.parseMs)} resolve=${Math.round(row.resolveMs)} write_links=${Math.round(row.writeLinksMs)} write_timeline=${Math.round(row.writeTimelineMs)} mark_extracted=${Math.round(row.markExtractedMs)} total=${Math.round(row.totalMs)} cumulative=${row.pagesProcessed}`,
    );
  }
  const first = timings[0]!;
  const last = timings[timings.length - 1]!;
  const limit = (value: number) => Math.max(value, 1) * 20 + 500;
  expect(last.totalMs).toBeLessThan(limit(first.totalMs));
  expect(last.markExtractedMs).toBeLessThan(limit(first.markExtractedMs));
  expect(last.readMs).toBeLessThan(limit(first.readMs));
  expect(last.parseMs).toBeLessThan(limit(first.parseMs));
  expect(last.resolveMs).toBeLessThan(limit(first.resolveMs));
  expect(last.writeLinksMs).toBeLessThan(limit(first.writeLinksMs));
  expect(last.writeTimelineMs).toBeLessThan(limit(first.writeTimelineMs));
}, 180_000);

/**
 * Lane 3 code on segmented page storage (#6787): a segmented page keeps its
 * body in segments, so its body columns are NULL and its page object's body
 * fields throw `page_body_segmented`.
 *
 * - Patterns quote verification (#6302) reads a segmented reflection through
 *   the segment reader, so its quotes still ground; one over the
 *   single-string ceiling is not a grounding source.
 * - A segmented pattern page with appended entries is read back as strings,
 *   verified and rewritten; over the ceiling it is skipped
 *   (`segmented_skipped`) and left as written.
 * - The child read budget (#6297) sizes a read from its result, never the
 *   body, and names a segmented page's stored `body_bytes`.
 *
 * Runs on PGLite, and on Postgres with a safe DATABASE_URL
 * (test/e2e/cycle-patterns-segmented-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { groundTimelineAppends, type TimelineAppend } from '../src/core/cycle/patterns.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { budgetedPageRead } from '../src/core/minions/tools/read-budget.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const STAGING = '- **2026-10-10** | wiki/personal/reflections/r1 — You wrote "always test on staging" again';
const DIARY = '- **2026-10-11** | wiki/personal/reflections/r2 — You keep a "weekly launch diary"';

const append = (slug: string, block: string): TimelineAppend => ({ slug, requestId: randomUUID(), block, marker: '<!-- none -->',
  entry: { date: block.slice(4, 14), source: block.split(' | ')[1]!.split(' — ')[0]!, summary: block.split(' — ')[1]! } });

for (const kind of testBackends()) {
  describe(`patterns grounding and read budget on segmented pages (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let n = 0;
    /** Fresh slugs per test: reflections r1 (inline, no diary quote) and r2 (segmented, holds it). */
    const fixture = async () => {
      n++;
      const r1 = `wiki/personal/reflections/t${n}-r1`;
      const r2 = `wiki/personal/reflections/t${n}-r2`;
      await importFromContent(engine, r1, '---\ntype: note\ntitle: r1\n---\nShipping went fine.\n', { noEmbed: true, sourceId: 'default' });
      const segmented = await createSegmentedPage(engine, { slug: r2, truth: 'Mondays I update my "weekly launch diary".\n' });
      return { r1, r2, reflections: [{ slug: r1 }, { slug: r2 }] as never, segmentedId: segmented.id,
        staging: STAGING.replace('reflections/r1', `reflections/t${n}-r1`), diary: DIARY.replace('reflections/r2', `reflections/t${n}-r2`) };
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('dream.quote_verify', 'true');
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('a segmented reflection grounds a quote through the segment reader', async () => {
      const f = await fixture();
      const slug = `wiki/personal/patterns/t${n}-diary`;
      await importFromContent(engine, slug, `---\ntype: note\ntitle: Diary\ndream_generated: true\n---\nA diary theme.\n\n## Timeline\n\n${f.diary}\n`, { noEmbed: true, sourceId: 'default' });
      const stats = await groundTimelineAppends(engine, null, [append(slug, f.diary)], f.reflections, 'default', '2026-10-15');
      expect(stats).toEqual({ entries: 1, quarantined: 0, repaired: 0, segmented_skipped: 0 });
      expect((await engine.getPage(slug))!.timeline).toContain('weekly launch diary');
    });

    test('a segmented reflection over the single-string ceiling is not a grounding source', async () => {
      const f = await fixture();
      await engine.executeRaw('UPDATE pages SET body_bytes = $2 WHERE id = $1', [f.segmentedId, PAGE_MAX_BYTES + 1]);
      const slug = `wiki/personal/patterns/t${n}-diary`;
      await importFromContent(engine, slug, `---\ntype: note\ntitle: Diary\ndream_generated: true\n---\nA diary theme.\n\n## Timeline\n\n${f.diary}\n`, { noEmbed: true, sourceId: 'default' });
      const stats = await groundTimelineAppends(engine, null, [append(slug, f.diary)], f.reflections, 'default', '2026-10-15');
      expect(stats).toEqual({ entries: 1, quarantined: 1, repaired: 0, segmented_skipped: 0 });
      expect((await engine.getPage(slug))!.timeline).not.toContain('weekly launch diary');
    });

    test('an appended segmented pattern page is read back as strings, verified and rewritten', async () => {
      const f = await fixture();
      const slug = `wiki/personal/patterns/t${n}-segmented`;
      await createSegmentedPage(engine, { slug, truth: 'A theme stored in segments.\n', timeline: `${f.staging}\n${f.diary}\n`,
        meta: { type: 'note', title: 'Segmented theme', frontmatter: { dream_generated: true } } });
      const stats = await groundTimelineAppends(engine, null, [append(slug, f.staging), append(slug, f.diary)], f.reflections, 'default', '2026-10-15');
      expect(stats).toEqual({ entries: 2, quarantined: 1, repaired: 0, segmented_skipped: 0 });
      const page = (await engine.getPage(slug))!;
      expect(page.timeline).not.toContain('always test on staging');
      expect(page.timeline).toContain('weekly launch diary');
      expect((page.frontmatter.unverified_claims as Array<{ text: string }>)[0]!.text).toContain('always test on staging');
    });

    test('a segmented pattern page over the ceiling is skipped and left as written', async () => {
      const f = await fixture();
      const slug = `wiki/personal/patterns/t${n}-huge`;
      const { id } = await createSegmentedPage(engine, { slug, truth: 'A huge theme.\n', timeline: `${f.staging}\n` });
      await engine.executeRaw('UPDATE pages SET body_bytes = $2 WHERE id = $1', [id, PAGE_MAX_BYTES + 1]);
      const stats = await groundTimelineAppends(engine, null, [append(slug, f.staging)], f.reflections, 'default', '2026-10-15');
      expect(stats).toEqual({ entries: 0, quarantined: 0, repaired: 0, segmented_skipped: 1 });
      const [row] = await engine.executeRaw<{ body_storage: string; frontmatter: Record<string, unknown> | string }>('SELECT body_storage, frontmatter FROM pages WHERE id = $1', [id]);
      expect(row!.body_storage).toBe('segmented');
      const fm = typeof row!.frontmatter === 'string' ? JSON.parse(row!.frontmatter) : row!.frontmatter;
      expect(fm.unverified_claims).toBeUndefined();
    });

    test('the read budget sizes a segmented page from its result and names its stored body_bytes', async () => {
      const slug = `wiki/personal/patterns/t${++n}-read`;
      const { id } = await createSegmentedPage(engine, { slug, truth: 'A theme stored in segments.\n'.repeat(50) });
      const [row] = await engine.executeRaw<{ body_bytes: number | string }>('SELECT body_bytes FROM pages WHERE id = $1', [id]);
      const tools = buildBrainTools({ subagentId: 999, engine, config: { engine: engine.kind } as GBrainConfig,
        allowedSlugPrefixes: ['wiki/personal/patterns/*'], sourceId: 'default', readBudgetBytes: 64 });
      const out = await tools.find(t => t.name === 'brain_get_page')!.execute({ slug, body: 'none' }, { engine, jobId: 999, remote: true }) as Record<string, any>;
      expect(out).toMatchObject({ truncated: true, code: 'read_budget_exhausted', slug });
      expect(out.read_budget.body_bytes).toBe(Number(row!.body_bytes));
      expect(out.excerpt).toBeUndefined();
    });

    test('the read-budget excerpt is a bounded prefix of the rendered content, cut on a code point', async () => {
      const out = await budgetedPageRead(engine, 998, 300, 'wiki/personal/patterns/x', { slug: 'wiki/personal/patterns/x', content: '思'.repeat(1000) }) as Record<string, any>;
      expect(out.truncated).toBe(true);
      expect(Buffer.byteLength(out.excerpt, 'utf8')).toBeLessThanOrEqual(300);
      expect(out.excerpt).toMatch(/^思+$/);
    });
  });
}

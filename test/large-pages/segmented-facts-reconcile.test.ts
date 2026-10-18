/**
 * Wave B PR 2 lane 2e2 (spec 8.2 fences, full-pass mode): extract_facts
 * reconciles the facts fence of a segmented page from its segments.
 *
 * 1. Protects: for pages over the inline threshold stored both inline
 *    (segmented storage off) and segmented (on), with a fence mid-body, a
 *    lone fence below the timeline sentinel, a fence in each section, an
 *    unbalanced fence, a marker quoted in code before the fence and a stray
 *    end marker before it, an end marker quoted in code inside the fence (the
 *    fence then crosses a segment cut), a begin marker split by a forced cut
 *    (balanced and unbalanced), a fence over several segments and a row longer than a segment (a forced cut
 *    inside the fence), runExtractFacts gives the same counts, warnings
 *    and facts rows, from an empty index and from a drifted one (a changed
 *    cell, a rewritten claim, a row the fence no longer holds);
 *    segmentedFactsFenceView equals factsFenceView of the strings, reading
 *    only the segments that hold a marker; segmentedBodyMatchesFile agrees
 *    with the inline stale-cache comparison; a fence longer than
 *    BLOCK_MAX_BYTES refuses with page_body_segmented and keeps the index.
 * 2. Fails when: the reconcile skips segmented pages (FACTS_RECONCILE_SEGMENTED),
 *    a marker block is not read, a fence is parsed from a block where it
 *    spans more, a marker split by a forced cut is missed, the view reads
 *    segments without a marker, or an oversized fence is read whole.
 * 3. Why existing coverage misses it: extract-facts tests use inline pages.
 * Seams: none; the readSegmentTexts spy wraps the engine method.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { runMaintenanceSweep } from '../../src/core/sweep.ts';
import { factsFenceView, FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { segmentedBodyMatchesFile, segmentedFactsFenceView } from '../../src/core/page-body/segment-facts.ts';
import { materializedPage } from '../../src/core/persistence/segmented-apply.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let dir: string;

const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const ROWS = [
  '| 1 | ~~Works at Acme Example~~ | fact | 1.0 | world | medium | 2020-01-01 |  | notes | superseded by #2 |',
  '| 2 | Works at Beta Example | fact | 0.9 | world | high | 2022-01-01 |  | notes |  |',
  '| 3 | Prefers short meetings | preference | 0.7 | private | low |  |  | chat |  |',
  '| 4 | Plans to ship in May | commitment | 0.8 | world | medium | 2026-03-01 |  | chat | roadmap |',
];
const fence = (rows = ROWS) => `${FACTS_FENCE_BEGIN}\n${HEADER}${rows.join('\n')}\n${FACTS_FENCE_END}`;
const prose = (bytes: number, seed: number) => conversationBody(bytes, { seed });
/** A line that starts a segment (it does not fit the one before) and ends 10 bytes before its second forced cut, so a marker after it straddles that cut. */
const STRADDLE = 'y'.repeat(2 * 1024 * 1024 - 10);

/** Pages over the inline threshold, each with its fence away from the first segment. */
const VARIANTS: Record<string, string> = {
  body: `${prose(700_000, 1)}\n\n## Facts\n\n${fence()}\n\n${prose(700_000, 2)}\n`,
  lone_timeline: `${prose(900_000, 3)}\n\n<!-- timeline -->\n\n${prose(500_000, 4)}\n\n## Facts\n\n${fence()}\n\n- **2026-01-02** | Met\n`,
  split: `${prose(600_000, 5)}\n\n## Facts\n\n${fence(ROWS.slice(0, 2))}\n\n${prose(500_000, 6)}\n\n<!-- timeline -->\n\n${fence(ROWS.slice(2))}\n`,
  unbalanced: `${prose(700_000, 7)}\n\n## Facts\n\n${FACTS_FENCE_BEGIN}\n${HEADER}${ROWS[1]}\n\n${prose(700_000, 8)}\n`,
  quoted_first: `${prose(400_000, 9)}\n\n\`\`\`md\n${fence(ROWS.slice(0, 1))}\n\`\`\`\n\n${prose(500_000, 10)}\n\n## Facts\n\n${fence()}\n\n${prose(400_000, 11)}\n`,
  forced_row: `${prose(700_000, 15)}\n\n## Facts\n\n${fence([ROWS[0], ROWS[1].replace('|  |', `| ${'context words '.repeat(110_000)}|`), ROWS[2], ROWS[3]])}\n\n${prose(700_000, 16)}\n`,
  long_fence: `${prose(500_000, 18)}\n\n## Facts\n\n${fence(Array.from({ length: 40 }, (_, i) => `| ${i + 1} | Long claim ${i + 1} | fact | 1.0 | world | medium |  |  | notes | ${'fence context '.repeat(1_100)}|`))}\n\n${prose(500_000, 19)}\n`,
  end_quoted_inside: `${prose(400_000, 20)}\n\n## Facts\n\n${FACTS_FENCE_BEGIN}\n${HEADER}${ROWS[0]}\n${ROWS[1]}\n\n\`\`\`md\n${FACTS_FENCE_END}\n\`\`\`\n\n${prose(600_000, 21)}\n\n${ROWS[2]}\n${FACTS_FENCE_END}\n\n${prose(300_000, 22)}\n`,
  straddled_begin: `${prose(700_000, 23)}\n\n## Facts\n\n${STRADDLE}${fence()}\n\n${prose(500_000, 24)}\n`,
  straddled_unbalanced: `${prose(700_000, 25)}\n\n## Facts\n\n${STRADDLE}${FACTS_FENCE_BEGIN}\n${HEADER}${ROWS[1]}\n\n${prose(500_000, 26)}\n`,
  stray_end_first: `${prose(400_000, 12)}\n\nOld end: \n\n${FACTS_FENCE_END}\n\n${prose(500_000, 13)}\n\n## Facts\n\n${fence()}\n\n${prose(400_000, 14)}\n`,
};
/**
 * A fence longer than BLOCK_MAX_BYTES (8 MiB). The segmenter never cuts inside a fence, so it is one run of forced
 * cuts, and every derived pass refuses a run that long (segment-blocks.ts).
 */
const OVERSIZED_FENCE = `${prose(400_000, 17)}\n\n## Facts\n\n${fence(Array.from({ length: 90 }, (_, i) => `| ${i + 1} | Claim ${i + 1} | fact | 1.0 | world | medium |  |  | notes | ${'row context '.repeat(8_500)}|`))}\n`;
const page = (body: string) => `---\ntype: person\ntitle: Fence Example\n---\n\n${body}`;
const slugOf = (variant: string, storage: 'inline' | 'segmented') => `people/fence-${variant.replace(/_/g, '-')}-${storage}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'segmented-facts-'));
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) {
    for (const storage of ['inline', 'segmented'] as const) {
      await engine.setConfig('pages.segmented_storage', storage === 'segmented' ? 'on' : 'off');
      for (const [variant, body] of Object.entries(VARIANTS)) {
        expect(await importFromContent(engine, slugOf(variant, storage), page(body), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
      }
      expect(await importFromContent(engine, slugOf('oversized', storage), page(OVERSIZED_FENCE), { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
    }
  }
}, 600_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: dir }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.();
  rmSync(dir, { recursive: true, force: true });
});

async function stored(engine: BrainEngine, slug: string) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  return snapshot.page;
}

/** The page's facts rows without ids, timestamps or its slug. */
async function factsOf(engine: BrainEngine, slug: string) {
  const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT row_num, fact, kind, visibility, notability, confidence, source, context,
      valid_from, valid_until, expired_at IS NOT NULL AS expired, superseded_by IS NOT NULL AS superseded, entity_slug
    FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY row_num NULLS LAST, fact`, [slug]);
  // A row without a valid_from cell takes the write time (the page's effective date is the import time here).
  const recent = (value: unknown) => value instanceof Date && Math.abs(Date.now() - value.getTime()) < 3_600_000;
  return rows.map(row => ({ ...row, entity_slug: row.entity_slug === slug ? 'SELF' : row.entity_slug, valid_from: recent(row.valid_from) ? 'WRITE_TIME' : row.valid_from }));
}

async function reconcile(engine: BrainEngine, slug: string) {
  const r = await runExtractFacts(engine, { slugs: [slug] });
  return { inserted: r.factsInserted, updated: r.factsUpdated, deleted: r.factsDeleted, withFacts: r.pagesWithFacts,
    warnings: r.warnings.map(w => w.replaceAll(slug, 'SLUG')) };
}

/** Drift the index: change a cell, rewrite a claim, add a row the fence does not hold. */
async function drift(engine: BrainEngine, slug: string) {
  await engine.executeRaw(`UPDATE facts SET notability='low' WHERE source_markdown_slug=$1 AND row_num=2`, [slug]);
  await engine.executeRaw(`UPDATE facts SET fact='Plans to ship in June' WHERE source_markdown_slug=$1 AND row_num=4`, [slug]);
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, source_markdown_slug, row_num, confidence)
    VALUES ('default', $1, 'Lives in Example City', 'fact', 'world', 'medium', 'notes', $1, 999, 1.0)`, [slug]);
}

describe('fence reconcile of a segmented page (full-pass mode)', () => {
  test('each variant is segmented with its fence past the first segment', async () => {
    for (const engine of engines) {
      for (const variant of Object.keys(VARIANTS)) {
        const p = await stored(engine, slugOf(variant, 'segmented'));
        expect(p.body_storage).toBe('segmented');
        expect((await stored(engine, slugOf(variant, 'inline'))).body_storage ?? 'inline').toBe('inline');
        const [m] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1 AND gen_to IS NULL', [p.id]);
        expect(m!.n).toBeGreaterThan(2);
      }
    }
  }, 300_000);

  test('segmentedFactsFenceView equals factsFenceView of the strings, reading only marker segments', async () => {
    for (const engine of engines) {
      for (const variant of Object.keys(VARIANTS)) {
        const p = await stored(engine, slugOf(variant, 'segmented'));
        const inline = await materializedPage(engine, p);
        const original = engine.readSegmentTexts.bind(engine);
        let reads = 0;
        engine.readSegmentTexts = (async (sourceId: string, shas: Uint8Array[]) => { reads += shas.length; return original(sourceId, shas); }) as BrainEngine['readSegmentTexts'];
        try {
          expect(await segmentedFactsFenceView(engine, p)).toEqual(factsFenceView(inline));
        } finally {
          // The spy is an own property; deleting it restores the prototype method a transaction engine inherits.
          delete (engine as { readSegmentTexts?: unknown }).readSegmentTexts;
        }
        // A segment can hold a marker, or sit in a run joined by a forced cut (a forced segment or the one after it).
        const [marked] = await engine.executeRaw<{ n: number; all: number }>(`SELECT count(*) FILTER (WHERE marker OR forced OR after_forced)::int AS n, count(*)::int AS all
            FROM (SELECT position($2::bytea in t.body)>0 OR position($3::bytea in t.body)>0 AS marker, m.cut_kind='forced' AS forced,
                         coalesce(lag(m.cut_kind='forced') OVER (ORDER BY m.seq), false) AS after_forced
                    FROM page_body_manifest m JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256 WHERE m.page_id=$1 AND m.gen_to IS NULL) s`,
        [p.id, Buffer.from(FACTS_FENCE_BEGIN), Buffer.from(FACTS_FENCE_END)]);
        expect(reads).toBeGreaterThan(0);
        expect(reads).toBeLessThanOrEqual(marked!.n);
        expect(reads).toBeLessThan(marked!.all);
      }
    }
  }, 300_000);

  test('runExtractFacts gives the inline counts, warnings and rows, from an empty index and from a drifted one', async () => {
    for (const engine of engines) {
      for (const variant of Object.keys(VARIANTS)) {
        const outcomes: Record<string, unknown>[] = [];
        for (const storage of ['inline', 'segmented'] as const) {
          const slug = slugOf(variant, storage);
          await engine.executeRaw('UPDATE facts SET superseded_by=NULL WHERE source_markdown_slug=$1', [slug]);
          await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug=$1', [slug]);
          const fresh = await reconcile(engine, slug);
          const afterFresh = await factsOf(engine, slug);
          await drift(engine, slug);
          const drifted = await reconcile(engine, slug);
          outcomes.push({ fresh, afterFresh, drifted, afterDrift: await factsOf(engine, slug), again: await reconcile(engine, slug) });
        }
        expect(outcomes[1]).toEqual(outcomes[0]!);
        if (variant === 'body') {
          expect(outcomes[0]).toMatchObject({ fresh: { inserted: 4 }, drifted: { updated: 1 } });
          expect((outcomes[0]!.afterDrift as unknown[]).length).toBeGreaterThan(4);
        }
        if (variant === 'unbalanced' || variant === 'split') expect((outcomes[0]!.fresh as { warnings: string[] }).warnings.length).toBeGreaterThan(0);
      }
    }
  }, 600_000);

  test('forced cuts: forced_row crosses one inside its fence; in the straddled variants no segment holds the whole begin marker', async () => {
    for (const engine of engines) {
      for (const variant of ['forced_row', 'straddled_begin', 'straddled_unbalanced']) {
        const p = await stored(engine, slugOf(variant, 'segmented'));
        const [m] = await engine.executeRaw<{ forced: number; begin: number }>(`SELECT count(*) FILTER (WHERE m.cut_kind='forced')::int AS forced,
            count(*) FILTER (WHERE position($2::bytea in t.body)>0)::int AS begin
          FROM page_body_manifest m JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256 WHERE m.page_id=$1 AND m.gen_to IS NULL`,
        [p.id, Buffer.from(FACTS_FENCE_BEGIN)]);
        expect(m!.forced).toBeGreaterThan(0);
        expect(m!.begin).toBe(variant === 'forced_row' ? 1 : 0);
      }
    }
  }, 300_000);

  test('a fence longer than BLOCK_MAX_BYTES refuses with page_body_segmented and keeps the index; the inline page reconciles', async () => {
    for (const engine of engines) {
      const inline = await reconcile(engine, slugOf('oversized', 'inline'));
      expect({ inserted: inline.inserted, withFacts: inline.withFacts }).toEqual({ inserted: 90, withFacts: 1 });
      const slug = slugOf('oversized', 'segmented');
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, source_markdown_slug, row_num, confidence)
        VALUES ('default', $1, 'Kept row', 'fact', 'world', 'medium', 'notes', $1, 1, 1.0)`, [slug]);
      const before = await factsOf(engine, slug);
      const r = await runExtractFacts(engine, { slugs: [slug] });
      expect(r.pagesFailed).toBe(1);
      expect(r.warnings.join('\n')).toMatch(/FACTS_RECONCILE_FAILED: .*a derived pass must read whole.*over its \d+-byte bound/);
      expect(await factsOf(engine, slug)).toEqual(before);
    }
  }, 300_000);

  test('the maintenance sweep picks a recently written segmented page with a facts fence for reconcile, as an inline one', async () => {
    for (const engine of engines) {
      const inserted: number[] = [];
      for (const storage of ['inline', 'segmented'] as const) {
        const slug = slugOf('body', storage);
        await engine.executeRaw('UPDATE facts SET superseded_by=NULL WHERE source_markdown_slug=$1', [slug]);
        await engine.executeRaw('DELETE FROM facts WHERE source_markdown_slug=$1', [slug]);
        await engine.executeRaw(`UPDATE pages SET updated_at = CASE WHEN slug=$1 THEN now() ELSE now() - interval '30 days' END WHERE source_id='default'`, [slug]);
        inserted.push((await runMaintenanceSweep(engine, { sourceId: 'default', budgetMs: 600_000 })).factsReconciled);
      }
      expect(inserted).toEqual([4, 4]);
    }
  }, 300_000);

  test('with a canonical checkout, a destructive reconcile runs when the file matches and refuses FACTS_PAGE_CACHE_STALE when it does not, both ways', async () => {
    for (const engine of engines) {
      const root = mkdtempSync(join(dir, 'checkout-'));
      await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [root]);
      try {
        const outcomes: unknown[] = [];
        for (const storage of ['inline', 'segmented'] as const) {
          const slug = slugOf('body', storage);
          mkdirSync(join(root, 'people'), { recursive: true });
          const outcome: unknown[] = [];
          for (const content of [page(VARIANTS.body!), page(VARIANTS.body!.replace('Works at Beta Example', 'Works at Gamma Example'))]) {
            writeFileSync(join(root, `${slug}.md`), content);
            await reconcile(engine, slug);
            await drift(engine, slug);
            outcome.push(await reconcile(engine, slug), await factsOf(engine, slug));
          }
          outcomes.push(outcome);
        }
        expect(outcomes[1]).toEqual(outcomes[0]);
        const [fresh, , stale] = outcomes[0] as Array<{ deleted: number; warnings: string[] }>;
        expect(fresh!.deleted).toBeGreaterThan(0);
        expect(stale!.warnings.some(w => w.includes('FACTS_PAGE_CACHE_STALE'))).toBe(true);
      } finally {
        await engine.executeRaw(`UPDATE sources SET local_path=NULL WHERE id='default'`);
      }
    }
  }, 300_000);

  test('on a managed brain the reconcile of a segmented page publishes through the fence-facts maintenance request', async () => {
    for (const engine of engines) {
      const sourceId = `fences-${engines.indexOf(engine)}`;
      const root = join(dir, sourceId);
      mkdirSync(join(root, 'people'), { recursive: true });
      await withEnv({ GBRAIN_HOME: dir }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('pages.segmented_storage', 'on');
        await registerLocalWriter(engine, 'cli');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try {
          writeFileSync(join(root, 'people/managed-fence.md'), page(VARIANTS.body!));
          expect(await importManagedFile(engine, join(root, 'people/managed-fence.md'), 'people/managed-fence.md', { sourceId, noEmbed: true }))
            .toMatchObject({ status: 'imported' });
          const [p] = await engine.executeRaw<{ body_storage: string }>("SELECT body_storage FROM pages WHERE source_id=$1 AND slug='people/managed-fence'", [sourceId]);
          expect(p!.body_storage).toBe('segmented');
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          await engine.executeRaw('UPDATE facts SET superseded_by=NULL WHERE source_id=$1', [sourceId]);
          await engine.executeRaw('DELETE FROM facts WHERE source_id=$1', [sourceId]);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
          const result = await runExtractFacts(engine, { sourceId, slugs: ['people/managed-fence'] });
          expect(result.warnings.filter(w => w.includes('SEGMENTED'))).toEqual([]);
          expect(result.factsInserted).toBe(4);
          const rows = await engine.executeRaw<{ row_num: number; fact: string }>(
            'SELECT row_num, fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY row_num', [sourceId]);
          expect(rows.map(r => [Number(r.row_num), r.fact])).toEqual([[2, 'Works at Beta Example'], [3, 'Prefers short meetings'], [4, 'Plans to ship in May']]);
          const kinds = await engine.executeRaw<{ kind: string }>("SELECT intent->>'kind' AS kind FROM persistence_requests WHERE source_id=$1 AND state='committed'", [sourceId]);
          expect(kinds.map(k => k.kind)).toContain('managed_maintenance_fence_facts');
        } finally {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        }
      });
    }
  }, 300_000);

  test('segmentedBodyMatchesFile agrees with the inline stale-cache comparison', async () => {
    for (const engine of engines) {
      for (const variant of ['body', 'lone_timeline']) {
        const p = await stored(engine, slugOf(variant, 'segmented'));
        const inline = await materializedPage(engine, p);
        const path = join(dir, `${variant}.md`);
        for (const content of [page(VARIANTS[variant]!), page(VARIANTS[variant]!.replace('Works at Beta Example', 'Works at Gamma Example'))]) {
          writeFileSync(path, content);
          const canonical = parseMarkdown(content, path);
          const expected = canonical.compiled_truth === inline.compiled_truth.trim() && canonical.timeline === (inline.timeline ?? '').trim() ? 'fresh' : 'stale';
          expect(await segmentedBodyMatchesFile(engine, p, path)).toBe(expected);
        }
        expect(await segmentedBodyMatchesFile(engine, p, path)).toBe('stale');
      }
    }
  }, 300_000);
});

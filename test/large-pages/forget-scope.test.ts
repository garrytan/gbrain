/**
 * Forget (withdrawal) on segmented pages (Wave B, spec 11).
 *
 * 1. Protects: withdrawing a claim strikes its row in the segment holding the
 *    fence and publishes a new generation; only the chunk rows of that
 *    occurrence are replaced (every other occurrence keeps its rows, ids
 *    unchanged), the fence's other row is untouched and the stored
 *    content_hash is the reconstructed body's. Discovery finds a segmented page that states
 *    the claim in a fence without any fact row pointing at it, by scanning
 *    only segments flagged with facts slots.
 * 2. Fails when: forget deletes every chunk of a segmented page, leaves the
 *    row unstruck in the segment, or discovery reads only inline bodies.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { discoverWithdrawalTargets } from '../../src/core/facts/withdrawal-discovery.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { reconstructedPage, segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';

const CLAIM = 'Prefers the window seat';
const home = mkdtempSync(join(tmpdir(), 'gbrain-forget-scope-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const row = (n: number, claim: string, visibility = 'world') => `| ${n} | ${claim} | preference | 1.0 | ${visibility} | medium | 2026-01-01 |  | chat |  |`;
function filler(tag: string, bytes: number): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = `## ${tag} ${i}\n\n${`Meeting notes on hiring, budget and the design review, item ${i}. `.repeat(30)}\n\n`;
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const body = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n# ${title}\n\n${filler('Part one', 700_000)}`
  + `## Facts\n\n${fence([row(1, CLAIM), row(2, 'Walks to work')])}\n\n${filler('Part two', 700_000)}`;

const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) { await registerLocalWriter(engine, 'cli'); await engine.setConfig('pages.segmented_storage', 'on'); }
}), 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

/** Live chunk ids by occurrence, and the occurrence whose segment holds `text`. */
async function liveChunks(engine: BrainEngine, pageId: number, text: string) {
  const rows = await engine.executeRaw<{ id: number; occurrence_id: number; holds: boolean }>(`SELECT c.id,c.occurrence_id,
      position(convert_to($2::text,'UTF8') in t.body)>0 AS holds
    FROM content_chunks c JOIN page_body_manifest m ON m.page_id=c.page_id AND m.occurrence_id=c.occurrence_id AND m.gen_to IS NULL AND m.staging_id IS NULL
    JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256 WHERE c.page_id=$1 ORDER BY c.id`, [pageId, text]);
  return { all: rows.map(r => Number(r.id)), holding: rows.filter(r => r.holds).map(r => Number(r.id)), occurrences: new Set(rows.filter(r => r.holds).map(r => Number(r.occurrence_id))) };
}

describe('forget on segmented pages', () => {
  test('strikes the row in its segment and replaces only that occurrence\'s chunks, on every page stating the claim', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'notes/seating', body('Seating'), { noEmbed: true, sourceId: 'default' });
      await importFromContent(engine, 'notes/seating-copy', body('Seating copy'), { noEmbed: true, sourceId: 'default' });
      const page = await segmentedPageRow(engine, 'notes/seating'), copy = await segmentedPageRow(engine, 'notes/seating-copy');
      expect(page.body_storage).toBe('segmented');
      const before = await liveChunks(engine, page.id, CLAIM);
      expect(before.occurrences.size).toBe(1);
      expect(before.all.length).toBeGreaterThan(before.holding.length);
      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test','notes/seating',1) RETURNING id`, [CLAIM]));

      const result = await coordinated(engine, tx => recordFactWithdrawal(tx, Number(fact!.id), 'default'));
      expect(result.withdrawn).toBe(true);
      expect(result.pages.map(p => p.slug).sort()).toEqual(['notes/seating', 'notes/seating-copy']);

      for (const target of [page, copy]) {
        const after = await segmentedPageRow(engine, target.id === page.id ? 'notes/seating' : 'notes/seating-copy');
        expect(after.body_generation).toBe(target.body_generation + 1);
        const { body: stored, hash } = await reconstructedPage(engine, target.id === page.id ? 'notes/seating' : 'notes/seating-copy');
        expect(stored.compiled_truth).toMatch(new RegExp(`\\| 1 \\| ~~${CLAIM}~~ \\| preference \\|.*\\| forgotten: memory withdrawn \\|`));
        expect(stored.compiled_truth).not.toContain(`| ${CLAIM} |`);
        expect(stored.compiled_truth).toContain(row(2, 'Walks to work'));
        expect(after.content_hash).toBe(hash);
      }
      const after = await liveChunks(engine, page.id, 'forgotten: memory withdrawn');
      const kept = before.all.filter(id => !before.holding.includes(id));
      expect(after.all.filter(id => kept.includes(id))).toEqual(kept);
      expect(after.all.filter(id => before.holding.includes(id))).toEqual([]);
      expect(after.holding.length).toBeGreaterThan(0);
      expect([...after.occurrences].some(id => before.occurrences.has(id))).toBe(false);
    }
  }), 300_000);

  test('a superseded row is struck in its segment (DB-only forget path), not skipped as an inline-only body', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'notes/commute', body('Commute'), { noEmbed: true, sourceId: 'default' });
      const page = await segmentedPageRow(engine, 'notes/commute');
      expect(page.body_storage).toBe('segmented');
      const prior = (await reconstructedPage(engine, 'notes/commute')).body.compiled_truth;
      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default','Walks to work',NULL,'world','test','notes/commute',2) RETURNING id`));
      const result = await withCoordinatedWrite(engine, ['default'], () => forgetFactInFence(engine, Number(fact!.id), { supersededBy: { rowNum: 3 } }), TEST_WRITE_ATTRIBUTION);
      expect(result.path).toBe('legacy_db');
      expect((await segmentedPageRow(engine, 'notes/commute')).body_generation).toBe(page.body_generation + 1);
      const { body: stored, hash } = await reconstructedPage(engine, 'notes/commute');
      const struck = stored.compiled_truth.match(/\| 2 \| ~~Walks to work~~ \|.*\| superseded by #3 \|/)?.[0];
      expect(struck).toBeDefined();
      expect(stored.compiled_truth).toBe(prior.replace(row(2, 'Walks to work'), struck!));
      expect((await segmentedPageRow(engine, 'notes/commute')).content_hash).toBe(hash);
    }
  }), 300_000);

  test('discovery finds a private fence row that only the segment holds (chunks never carry private rows)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const secret = 'Keeps a spare key under the mat';
    for (const engine of engines) {
      const text = body('Spare key').replace(row(2, 'Walks to work'), row(2, secret, 'private'));
      await importFromContent(engine, 'notes/spare-key', text, { noEmbed: true, sourceId: 'default' });
      const page = await segmentedPageRow(engine, 'notes/spare-key');
      expect(page.body_storage).toBe('segmented');
      const [chunked] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks WHERE page_id=$1 AND chunk_text LIKE '%spare key%'`, [page.id]);
      expect(Number(chunked!.n)).toBe(0);
      const [hash] = await engine.executeRaw<{ h: string }>('SELECT gbrain_fact_fingerprint($1) AS h', [secret]);
      const targets = await discoverWithdrawalTargets(engine, 'default', [{ visibility: 'private', fact_hash: hash!.h, claim: secret }]);
      expect(targets.map(t => t.slug)).toEqual(['notes/spare-key']);
    }
  }), 300_000);

  test('discovery joins a facts fence a forced cut split, finding a private row after the cut, and the withdrawal strikes it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const secret = 'Hides the vault code inside the atlas';
    const rows = Array.from({ length: 12_000 }, (_, i) => row(i + 1, `Routine note number ${i + 1} about the weekly planning meeting`));
    rows.push(row(12_001, secret, 'private'));
    const text = `---\ntitle: Ledger\ntype: note\n---\n\n# Ledger\n\n${filler('Part one', 300_000)}## Facts\n\n${fence(rows)}\n\n${filler('Part two', 300_000)}`;
    for (const engine of engines) {
      await importFromContent(engine, 'notes/ledger', text, { noEmbed: true, sourceId: 'default' });
      const page = await segmentedPageRow(engine, 'notes/ledger');
      expect(page.body_storage).toBe('segmented');
      const split = await engine.executeRaw<{ seq: number; holds: boolean; opens: boolean }>(`SELECT m.seq,position(convert_to($2::text,'UTF8') in t.body)>0 AS holds,
          EXISTS (SELECT 1 FROM jsonb_array_elements(m.facts_slots) s WHERE s ? 'open_start' AND NOT s ? 'open_end') AS opens
        FROM page_body_manifest m JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
        WHERE m.page_id=$1 AND m.gen_to IS NULL AND m.staging_id IS NULL ORDER BY m.seq`, [page.id, secret]);
      const opened = split.findIndex(r => r.opens), holding = split.findIndex(r => r.holds);
      expect(opened).toBeGreaterThanOrEqual(0);
      expect(holding).toBeGreaterThan(opened);
      const [hash] = await engine.executeRaw<{ h: string }>('SELECT gbrain_fact_fingerprint($1) AS h', [secret]);
      expect((await discoverWithdrawalTargets(engine, 'default', [{ visibility: 'private', fact_hash: hash!.h, claim: secret }])).map(t => t.slug)).toEqual(['notes/ledger']);

      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source)
        VALUES ('default',$1,NULL,'private','test') RETURNING id`, [secret]));
      const result = await coordinated(engine, tx => recordFactWithdrawal(tx, Number(fact!.id), 'default'));
      expect(result.pages.map(p => p.slug)).toEqual(['notes/ledger']);
      expect((await segmentedPageRow(engine, 'notes/ledger')).body_generation).toBe(page.body_generation + 1);
      const { body: stored } = await reconstructedPage(engine, 'notes/ledger');
      expect(stored.compiled_truth).toContain(`| 12001 | ~~${secret}~~ |`);
      expect(stored.compiled_truth).toContain(row(12_000, 'Routine note number 12000 about the weekly planning meeting'));
      // A split fence above the single-string ceiling is refused, never skipped (its slot extent stretched past it here).
      await coordinated(engine, tx => tx.executeRaw(`UPDATE page_body_manifest SET facts_slots=jsonb_set(facts_slots,'{0,end}',to_jsonb($2::bigint))
        WHERE page_id=$1 AND gen_to IS NULL AND staging_id IS NULL AND facts_slots->0 ? 'open_start'`, [page.id, PAGE_MAX_BYTES + 1]));
      const refused = await discoverWithdrawalTargets(engine, 'default', [{ visibility: 'private', fact_hash: hash!.h, claim: secret }]).then(() => 'ok', (e: { code?: string }) => e.code);
      expect(refused).toBe('page_body_segmented');
    }
  }), 300_000);

  test('with two facts fences carrying the same row number, the segmented strike matches the inline one exactly', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    // A second fence whose header orders its columns differently: import cannot merge it into the first (both stay).
    const reordered = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | kind | claim | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|------|-------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
    const fences = (big: boolean) => {
      const pad = (tag: string) => big ? filler(tag, 700_000) : '';
      return {
        both: `# Twins\n\n${pad('One')}## First\n\n${fence([row(1, 'Alpha twin claim'), row(2, 'Alpha second claim')])}\n\n${pad('Two')}## Second\n\n${reordered([`| 1 | preference | Beta twin claim | 1.0 | world | medium | 2026-01-01 |  | chat |  |`, `| 3 | preference | Beta third claim | 1.0 | world | medium | 2026-01-01 |  | chat |  |`])}\n`,
        timelineOnly: `# Twins\n\n${pad('One')}No fence in the truth.\n\n<!-- timeline -->\n\n${pad('Two')}${fence([row(1, 'Gamma timeline claim')])}\n`,
      };
    };
    const cases = [{ name: 'both', rowNum: 1 }, { name: 'both', rowNum: 3 }, { name: 'timelineOnly', rowNum: 1 }] as const;
    const blocks = (text: string) => text.match(/<!--- gbrain:facts:begin -->[\s\S]*?<!--- gbrain:facts:end -->/g) ?? [];
    for (const engine of engines) {
      for (const [n, c] of cases.entries()) {
        const results: string[][] = [];
        for (const big of [false, true]) {
          const slug = `notes/twins-${n}-${big ? 'segmented' : 'inline'}`;
          await importFromContent(engine, slug, `---\ntitle: Twins\ntype: note\n---\n\n${fences(big)[c.name]}`, { noEmbed: true, sourceId: 'default' });
          expect((await segmentedPageRow(engine, slug)).body_storage).toBe(big ? 'segmented' : 'inline');
          const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
            VALUES ('default','Twin row claim',NULL,'world','test',$1,$2) RETURNING id`, [slug, c.rowNum]));
          await withCoordinatedWrite(engine, ['default'], () => forgetFactInFence(engine, Number(fact!.id), { supersededBy: { rowNum: 9 } }), TEST_WRITE_ATTRIBUTION);
          const body = big ? (await reconstructedPage(engine, slug)).body : (await engine.getPage(slug, { sourceId: 'default' }))!;
          results.push([...blocks(body.compiled_truth ?? ''), '<timeline>', ...blocks(body.timeline ?? '')]);
        }
        expect(results[1]).toEqual(results[0]!);
        expect(results[0]!.indexOf('<timeline>')).toBe(c.name === 'both' ? 2 : 0);
        expect(results[0]!.join('\n').includes('superseded by #9')).toBe(c.name === 'both' && c.rowNum === 1);
      }
    }
  }), 300_000);
});

/**
 * Wave B PR 2 lane 2r-maint: the repair kinds and the doctor check whose scans
 * read a page's body columns straight from SQL, against a segmented page
 * (compiled_truth and timeline NULL, body in segments).
 *
 * 1. Protects: `gbrain repair timeline` (preview and apply) never crashes on a
 *    segmented page carrying database-only timeline rows: it repairs the
 *    inline pages and reports the segmented page as a residual (count + slug),
 *    and doctor timeline_history counts it separately without recommending a
 *    repair that cannot clear it. A per-item `page_body_segmented` refusal is
 *    recorded in failed[] and the run goes on. timeline-comments no longer
 *    plans an item it cannot apply (its apply aborted the run), and
 *    connector-fences, split-facts and conversation-labels report the
 *    segmented pages their SQL filters silently skipped.
 * 2. Fails when: a scan reads `p.compiled_truth.length` of a segmented row,
 *    a segmented page is planned as an item whose apply refuses, or a scan
 *    drops a segmented page it should have handled without saying so.
 * 3. Why existing coverage misses it: every repair test writes inline pages.
 * Seams: none.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { upsertFactRow } from '../../src/core/facts-fence.ts';
import { resolveRepairScope, runRepair, type RepairHandler } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { timelineRepair } from '../../src/core/repair/timeline.ts';
import { timelineHistoryCheck } from '../../src/commands/doctor/checks/timeline-history.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-repair-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const logger = { info() {}, warn() {}, error() {} };
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) await engine.setConfig('pages.segmented_storage', 'on');
}, 120_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

const ctx = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true },
  dryRun: false, logger }) as never;
const fence = (rowNum: number, claim: string) => upsertFactRow('', { rowNum, claim, kind: 'fact', visibility: 'world', confidence: 1, notability: 'medium', source: 'fixture' }).body;

async function source(engine: BrainEngine, id: string, kind?: string): Promise<string> {
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,$2::text::jsonb) ON CONFLICT DO NOTHING`, [id, JSON.stringify(kind ? { kind } : {})]);
  return id;
}

/** A page over 1 MiB (segmented with the switch on): conversation prose, then `truth`, then the timeline. */
async function bigPage(engine: BrainEngine, sourceId: string, slug: string, opts: { truth?: string; timeline?: string; type?: string } = {}): Promise<number> {
  const content = `---\ntype: ${opts.type ?? 'note'}\ntitle: ${slug}\n---\n\n${conversationBody(1_200_000, { seed: slug.length })}\n\n${opts.truth ?? ''}\n\n<!-- timeline -->\n\n${opts.timeline ?? '- **2026-01-10** | Met about the launch'}\n`;
  expect(await importFromContent(engine, slug, content, { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
  const [row] = await engine.executeRaw<{ id: number; body_storage: string }>('SELECT id, body_storage FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  expect(row!.body_storage).toBe('segmented');
  return Number(row!.id);
}

async function smallPage(engine: BrainEngine, sourceId: string, slug: string): Promise<number> {
  await importFromContent(engine, slug, `---\ntype: note\ntitle: ${slug}\n---\n\nA short page.\n\n<!-- timeline -->\n\n- **2026-01-10** | Met about the launch\n`, { sourceId, noEmbed: true });
  const [row] = await engine.executeRaw<{ id: number; body_storage: string }>('SELECT id, body_storage FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  expect(row!.body_storage).toBe('inline');
  return Number(row!.id);
}

const dbOnlyRow = (engine: BrainEngine, pageId: number, summary = 'A database-only event') =>
  engine.executeRaw("INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES($1,'2026-08-01','legacy',$2,'')", [pageId, summary]);
const rowCount = async (engine: BrainEngine, pageId: number) =>
  Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM timeline_entries WHERE page_id=$1', [pageId]))[0]!.n);

describe('repair scans over segmented pages', () => {
  test('repair timeline: preview and apply repair the inline page and report the segmented page as a residual', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = await source(engine, 'tl-mixed');
      const segmented = await bigPage(engine, sourceId, 'notes/segmented-timeline');
      const inline = await smallPage(engine, sourceId, 'notes/inline-timeline');
      await dbOnlyRow(engine, segmented);
      await dbOnlyRow(engine, inline);
      const segmentedRows = await rowCount(engine, segmented);
      const scope = await resolveRepairScope(engine, sourceId);
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('timeline', scope, { sourceFlag: sourceId });
      expect(preview.sample).toEqual([`${sourceId}:notes/inline-timeline`]);
      expect(preview.residuals).toMatchObject({ materializable_rows: 1, segmented_pages: 1, segmented_rows: segmentedRows });
      expect(preview.warnings?.join('\n')).toContain(`segmented page(s) (${sourceId}:notes/segmented-timeline)`);
      const applied = await runRepair(ctx(engine, sourceId), timelineRepair, scope, { apply: true });
      expect({ applied: applied.applied, failed: applied.failed, complete: applied.complete }).toEqual({ applied: 1, failed: [], complete: true });
      expect(applied.residuals).toMatchObject({ segmented_pages: 1 });
      expect(await rowCount(engine, segmented)).toBe(segmentedRows);
    }
  }), 300_000);

  test('doctor timeline_history counts a segmented page separately and does not recommend repair timeline for it', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = await source(engine, 'tl-doctor');
      const segmented = await bigPage(engine, sourceId, 'notes/segmented-doctor');
      await dbOnlyRow(engine, segmented);
      const check = await timelineHistoryCheck(engine, sourceId);
      expect(check.status).toBe('ok');
      expect(check.message).not.toContain('gbrain repair timeline --apply');
      expect(check.message).toContain(`${sourceId}:notes/segmented-doctor`);
      expect(check.message).toContain('no command does yet');
      expect(check.details).toMatchObject({ materializable_rows: 0, segmented_pages: 1, segmented_sample: [`${sourceId}:notes/segmented-doctor`] });
    }
  }), 300_000);

  test('an item whose apply refuses page_body_segmented is recorded in failed[] and the run goes on', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = await source(engine, 'tl-failed');
      const segmented = await bigPage(engine, sourceId, 'notes/segmented-item');
      const attempts: string[] = [];
      const handler: RepairHandler = {
        kind: 'timeline', publication: 'projection', embeds: false,
        async plan() {
          return { residuals: {}, items: [
            { cursor: { phase: 0, id: segmented }, source_id: sourceId, slug: 'notes/segmented-item', chars: 0, action: 'materialize 1 row(s)' },
            { cursor: { phase: 0, id: segmented + 1_000_000 }, source_id: sourceId, slug: 'notes/after', chars: 0, action: 'stub' },
          ] };
        },
        async apply(c, item) {
          attempts.push(item.slug);
          return item.slug === 'notes/after' ? true : timelineRepair.apply(c, item);
        },
      };
      const result = await runRepair(ctx(engine, sourceId), handler, await resolveRepairScope(engine, sourceId), { apply: true });
      expect(attempts).toEqual(['notes/segmented-item', 'notes/after']);
      expect(result.applied).toBe(1);
      expect(result.failed.map(f => [f.slug, f.reason])).toEqual([['notes/segmented-item', 'page_body_segmented']]);
    }
  }), 300_000);

  test('repair timeline-comments: rows with markup on a segmented page are a residual, not an item whose apply aborts the run', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = await source(engine, 'tl-comments');
      const segmented = await bigPage(engine, sourceId, 'notes/segmented-comments');
      await dbOnlyRow(engine, segmented, 'Talked about the launch. <!-- AUTO:slack END -->');
      const scope = await resolveRepairScope(engine, sourceId);
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('timeline-comments', scope, { explicit: true, sourceFlag: sourceId });
      expect(preview.affected).toBe(0);
      expect(preview.residuals).toMatchObject({ segmented_pages: 1, segmented_rows: 1 });
      expect(preview.warnings?.join('\n')).toContain(`${sourceId}:notes/segmented-comments`);
      const applied = await (await repairRunner(engine, { apply: true, logger })).run('timeline-comments', scope, { explicit: true, sourceFlag: sourceId });
      expect({ complete: applied.complete, applied: applied.applied, failed: applied.failed }).toEqual({ complete: true, applied: 0, failed: [] });
      expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM timeline_entries WHERE page_id=$1 AND summary LIKE '%<!--%'", [segmented]))[0]!.n).toBe(1);
    }
  }), 300_000);

  test('repair connector-fences: a segmented connector page with a fence below the timeline is reported, not skipped silently', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = await source(engine, 'gh-fences', 'github');
      await bigPage(engine, sourceId, 'notes/segmented-fence', { timeline: `- **2026-01-10** | Met about the launch\n\n${fence(1, 'Ships quarterly')}` });
      await bigPage(engine, sourceId, 'notes/segmented-plain');
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('connector-fences', await resolveRepairScope(engine, sourceId), { sourceFlag: sourceId });
      expect(preview.affected).toBe(0);
      expect(preview.residuals).toMatchObject({ segmented_pages: 1 });
      expect(preview.warnings?.join('\n')).toContain(`(${sourceId}:notes/segmented-fence)`);
    }
  }), 300_000);

  test('repair split-facts: a segmented page with a facts fence in its body and its timeline is listed, not skipped silently', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = await source(engine, 'split-seg');
      await bigPage(engine, sourceId, 'people/split-segmented', { type: 'person', truth: fence(1, 'Above claim'),
        timeline: `- **2026-01-10** | Met about the launch\n\n${fence(2, 'Below claim')}` });
      await bigPage(engine, sourceId, 'people/one-fence', { type: 'person', truth: fence(1, 'Only claim') });
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('split-facts', await resolveRepairScope(engine, sourceId), { explicit: true, sourceFlag: sourceId });
      expect(preview.residuals).toMatchObject({ segmented: 1 });
      expect(preview.listing?.filter(entry => entry.class === 'segmented').map(entry => entry.item)).toEqual([`${sourceId}:people/split-segmented`]);
    }
  }), 300_000);

  test('repair conversation-labels: conversation facts on a segmented page are reported, not skipped silently', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const sourceId = await source(engine, 'labels-seg');
      await bigPage(engine, sourceId, 'meetings/segmented-labels', { type: 'meeting', truth: '**Date:** 2026-01-10' });
      await engine.insertFacts([{ fact: 'Date said the launch slips', entity_slug: null, source_markdown_slug: 'meetings/segmented-labels', kind: 'fact',
        visibility: 'private', source: 'cli:extract-conversation-facts', context: 'segment 1970-01-01', confidence: 1, row_num: 1 }], { source_id: sourceId });
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('conversation-labels', await resolveRepairScope(engine, sourceId), { explicit: true, sourceFlag: sourceId });
      expect(preview.residuals).toMatchObject({ segmented_pages: 1, segmented_facts: 1 });
      expect(preview.warnings?.join('\n')).toContain(`${sourceId}:meetings/segmented-labels`);
    }
  }), 300_000);
});

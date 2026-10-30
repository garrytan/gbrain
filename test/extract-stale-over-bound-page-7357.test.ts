/**
 * #7357: one page whose body holds a run longer than the block bound (a line or fence over 8 MiB) used to fail
 * `gbrain extract --stale` with page_body_segmented, managed or not, after the link phase spent its half of the budget:
 * the mention pass read the page block by block and the refusal escaped the run, so no later page was scanned and the
 * run exited 1 every time. Now the link phase and the mention pass each report that page, leave it stale and due, and
 * finish the other pages.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { BLOCK_MAX_BYTES } from '../src/core/page-body/segment-blocks.ts';
import { countMentionDuePages } from '../src/core/mentions/pass.ts';
import { formatMentionSummary } from '../src/core/mentions/stale.ts';
import { formatManagedStaleExtraction, runManagedStaleExtraction } from '../src/core/persistence/links-maintenance.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { mentionBrain, mentionLinks, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

const MB = 1024 * 1024;
const ARCHIVE = 'notes/archive';

/** A note whose code fence runs past BLOCK_MAX_BYTES: segmented on import, and every block reader refuses it. */
function longFence(bytes: number): string {
  const body = Array.from({ length: Math.ceil(bytes / 32) }, (_, i) => 'code line ' + String(i).padStart(10, '0') + ' x = 1;\n').join('');
  return '---\ntitle: Archive\ntype: note\n---\nAlice Example pasted this.\n\n\`\`\`ts\n' + body + '\`\`\`\n\nAfter the fence.\n';
}

async function fixture(engine: BrainEngine): Promise<void> {
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  await engine.setConfig('pages.segmented_storage', 'on');
  await page(engine, 'people/alice-example', 'person', 'Alice Example', 'Alice Example fixture.');
  await page(engine, 'notes/meeting', 'note', 'Meeting', 'Met Alice Example about the plan.');
  expect((await importFromContent(engine, ARCHIVE, longFence(BLOCK_MAX_BYTES + 2 * MB), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
  expect((await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [ARCHIVE]))[0]!.body_storage).toBe('segmented');
}

const linkStale = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ stale: boolean }>(
  'SELECT links_extracted_at IS NULL AS stale FROM pages WHERE slug=$1', [slug]))[0]!.stale;

describe('extract --stale with an over-bound page (#7357), unmanaged', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetMentionBrain(engine); await fixture(engine); }, 300_000);

  test('the sweep finishes the other pages, and the page is reported, left stale and still due', async () => {
    const r = await sweep(engine);
    expect(r.linkFailed).toBe(1);
    expect(await linkStale(engine, ARCHIVE)).toBe(true);
    expect(await linkStale(engine, 'notes/meeting')).toBe(false);
    expect(await mentionLinks(engine)).toContain('notes/meeting -> people/alice-example');
    expect(r.mentions?.failed).toBe(1);
    expect(r.mentions?.failures).toEqual([expect.objectContaining({ slug: ARCHIVE, source_id: 'default', code: 'page_body_segmented' })]);
    expect(await countMentionDuePages(engine)).toBe(1);
    const again = await sweep(engine);
    expect(again.linkFailed).toBe(1);
    expect(again.mentions?.failed).toBe(1);
  }, 600_000);

  test('the report names the page and its code, and does not tell the user a re-run will finish it', async () => {
    const r = await sweep(engine);
    const line = formatMentionSummary(r.mentions!)!;
    expect(line).toContain(`default:${ARCHIVE}: page_body_segmented`);
    expect(line).toContain('1 page(s) could not be scanned for mentions and stay due until they change');
    expect(line).not.toContain('re-run');
  }, 600_000);
});

describe('extract --stale with an over-bound page (#7357), managed', () => {
  test('the managed run finishes the other pages and reports the page from both phases', async () => {
    await managedBrain(async ({ engine }) => {
      const r = await runManagedStaleExtraction(engine, { catchUp: true, counts: false });
      expect(r.failed).toBe(1);
      expect(r.failures?.[0]).toMatchObject({ slug: ARCHIVE, code: 'page_body_segmented' });
      expect(await linkStale(engine, ARCHIVE)).toBe(true);
      expect(await mentionLinks(engine)).toContain('notes/meeting -> people/alice-example');
      expect(r.mentions?.failures).toEqual([expect.objectContaining({ slug: ARCHIVE, code: 'page_body_segmented' })]);
      expect(await countMentionDuePages(engine)).toBe(1);
      const json = JSON.parse(formatManagedStaleExtraction(r, false, true)) as Record<string, unknown>;
      expect(json).toMatchObject({ failed: 1, mention_failed: 1 });
    }, { setup: ({ engine }) => fixture(engine) });
  }, 600_000);
});

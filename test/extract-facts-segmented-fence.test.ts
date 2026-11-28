/**
 * #9740: extract_facts fences unfenced rows on a segmented page.
 *
 * Protects: a managed brain's segmented entity page gets its `row_num IS NULL` row fenced (row_num 1, fence row in the
 * body) with no FACTS_FENCE_FAILED warning, and a second cycle changes nothing.
 * Fails when: the fence planner reads the body through the throwing segmented getters (`page_body_segmented`).
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { wholeBodySnapshot } from '../src/core/persistence/segmented-apply.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle } from '../src/core/cycle.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';

const SLUG = 'people/alice-example';

test('managed: a segmented page gets its unfenced row fenced', async () => {
  await managedBrain(async ({ engine, root }) => {
    const run = async () => (await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] })).phases.find(p => p.phase === 'extract_facts')!;
    const first = await run();
    const warnings = JSON.stringify(first);
    expect(warnings).not.toContain('FACTS_FENCE_FAILED');
    const rows = await engine.executeRaw<{ row_num: number | null }>('SELECT row_num FROM facts WHERE entity_slug=$1', [SLUG]);
    expect(rows.map(r => r.row_num)).toEqual([1]);
    const second = await run();
    expect(JSON.stringify(second)).not.toContain('FACTS_FENCE_FAILED');
    expect((await engine.executeRaw<{ row_num: number | null }>('SELECT row_num FROM facts WHERE entity_slug=$1', [SLUG])).map(r => r.row_num)).toEqual([1]);
  }, { setup: async ({ engine }) => { await createSegmentedPage(engine, { slug: SLUG, truth: '# Alice Example\n\nProse.\n', meta: { type: 'person', title: 'Alice Example' } });
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
      VALUES ('default', $1, 'Alice example moved to Porto', 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.9)`, [SLUG]);
  } });
}, 120_000);

test('unmanaged: a segmented page whose file matches its body gets its row fenced in the file and the body', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-fence-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(undefined);
      try {
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await createSegmentedPage(engine, { slug: SLUG, truth: '# Alice Example\n\nProse.', meta: { type: 'person', title: 'Alice Example' } });
        await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE slug = $2', [`${SLUG}.md`, SLUG]);
        const path = join(root, `${SLUG}.md`);
        mkdirSync(dirname(path), { recursive: true });
        const snapshot = (await wholeBodySnapshot(engine, await engine.readPageSnapshot(SLUG, { sourceId: 'default' }), 'test'))!;
        writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
          VALUES ('default', $1, 'Alice example moved to Porto', 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.9)`, [SLUG]);
        const phase = (await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] })).phases.find(p => p.phase === 'extract_facts')!;
        expect(JSON.stringify(phase)).not.toContain('FACTS_FENCE_FAILED');
        expect((await engine.executeRaw<{ row_num: number | null }>('SELECT row_num FROM facts WHERE entity_slug=$1', [SLUG])).map(r => r.row_num)).toEqual([1]);
        expect(readFileSync(path, 'utf8')).toContain('Alice example moved to Porto');
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);

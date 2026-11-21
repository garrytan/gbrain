/** #9087: relink must publish a segmented entity's fence without reading throwing body getters.
 * Real segmented imports and coordinator receipts on both engines; all data is synthetic.
 * Also pins lone-timeline fences, stable fact identity/provenance and revision-bound preparation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { materializedSnapshot } from '../src/core/persistence/segmented-apply.ts';
import { conversationBody } from './helpers/conversation-page.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFromFile } from '../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';

const SLUG = 'people/alice-example';
const config = { engine: 'pglite', embedding_disabled: true } as unknown as GBrainConfig;
const prose = conversationBody(1_100_000, { seed: 9087 });
const fence = upsertFactRow('', { rowNum: 7, claim: 'Alice Example likes synthetic fixtures.', kind: 'fact', confidence: 1,
  visibility: 'private', notability: 'medium', validFrom: '2026-01-01', source: 'notes' }).body;
const content = (timeline: boolean, suffix = '') => `---\ntitle: Alice Example\ntype: person\n---\n\n${prose}\n\n${timeline ? '<!-- timeline -->\n\n' : ''}${fence}\n\n${suffix}`;

for (const backend of testBackends()) describe(`[${backend}] #9087 segmented facts relink`, () => {
  let engine: BrainEngine;
  let lite: PGLiteEngine | undefined;
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
    else { lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); }
  }, 120_000);
  afterAll(async () => { await template?.dispose(); await lite?.disconnect(); }, 120_000);
  beforeEach(async () => {
    if (lite) { engine = lite; await resetPgliteState(lite); }
    else { const clone = await template!.clone(); engine = clone.engine; close = clone.close; }
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('decide.slots.conflict.mode', 'off');
  }, 120_000);
  afterEach(async () => { await disposePersistenceConsumer(engine); await close?.(); close = undefined; }, 120_000);

  async function seed(fact: string): Promise<number> {
    return engine.transaction(tx => withWriteTrust(tx, { tier: 'external_untrusted', origin: { channel: 'derive:facts_backstop' } }, async () => {
      const [row] = await tx.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, fact, kind, visibility, source, valid_from)
        VALUES ('default', $1, 'fact', 'private', 'chat', '2026-01-02T12:03:04.123Z') RETURNING id`, [fact]);
      return Number(row!.id);
    }));
  }
  const relink = (dryRun = false, limit = 1000, afterId = 0) => runFactsRelink(engine, { sourceId: 'default', config, llm: false, dryRun, limit, afterId });
  const snapshot = async () => (await materializedSnapshot(engine, await engine.readPageSnapshot(SLUG, { sourceId: 'default' })))!;
  const stored = async (id: number) => (await engine.executeRaw('SELECT * FROM facts WHERE id=$1', [id]))[0]!;

  for (const timeline of [false, true]) test(`publishes into the ${timeline ? 'timeline' : 'body'} fence and preserves old rows, provenance and retry identity`, async () => {
    expect(await importFromContent(engine, SLUG, content(timeline), { noEmbed: true })).toMatchObject({ status: 'imported' });
    expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.page.body_storage).toBe('segmented');
    await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG] });
    const beforePage = await snapshot();
    const oldRows = await engine.executeRaw('SELECT id, row_num, fact FROM facts WHERE source_markdown_slug=$1 ORDER BY id', [SLUG]);
    expect(oldRows).toHaveLength(1);
    const id = await seed('Alice Example will review the synthetic test plan.');
    const beforeFact = await stored(id);
    expect((await relink(true)).linked).toBe(1);
    expect(await stored(id)).toEqual(beforeFact);
    expect((await snapshot()).revision).toBe(beforePage.revision);
    expect(await relink()).toMatchObject({ linked: 1, deduped: 0, skipped: {} });
    const after = await snapshot();
    expect(after.page.body_storage).toBe('segmented');
    const section = timeline ? 'timeline' : 'compiled_truth';
    const other = timeline ? 'compiled_truth' : 'timeline';
    expect(after.page[other]).toBe(beforePage.page[other]);
    expect(after.page[section]).toContain('Alice Example will review');
    const cells = parseFactsFence(after.page[section] ?? '').facts;
    expect(cells.map(c => c.rowNum)).toEqual([7, 8]);
    expect(cells[0]!.claim).toBe('Alice Example likes synthetic fixtures.');
    expect(await stored(id)).toMatchObject({ entity_slug: SLUG, source_markdown_slug: SLUG, row_num: 8,
      trust_tier: beforeFact.trust_tier, write_origin: beforeFact.write_origin, valid_from: beforeFact.valid_from, source: beforeFact.source });
    expect(await engine.executeRaw('SELECT id, row_num, fact FROM facts WHERE source_markdown_slug=$1 AND id<>$2 ORDER BY id', [SLUG, id])).toEqual(oldRows);
    expect((await engine.executeRaw("SELECT state FROM persistence_requests WHERE operation='relink_facts'"))).toEqual([{ state: 'committed' }]);
    expect((await relink()).linked).toBe(0);
    expect((await snapshot()).revision).toBe(after.revision);
  }, 120_000);

  test('bounded windows continue to a healthy sibling and exact duplicates retire without adding a fence row', async () => {
    await importFromContent(engine, SLUG, content(false), { noEmbed: true });
    await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG] });
    const duplicate = await seed('Alice Example likes synthetic fixtures.');
    // Matching source is part of exact-duplicate identity.
    await engine.executeRaw("UPDATE facts SET source='notes' WHERE id=$1", [duplicate]);
    const first = await seed('Alice Example will validate window one.');
    await importFromContent(engine, 'people/bob-example', '---\ntitle: Bob Example\ntype: person\n---\n\nA healthy sibling.', { noEmbed: true });
    const sibling = await seed('Bob Example will validate window two.');
    const one = await relink(false, 2);
    expect(one).toMatchObject({ linked: 1, deduped: 1, has_more: true, next_after_id: first });
    expect((await stored(duplicate)).expired_at).not.toBeNull();
    expect((await stored(sibling)).entity_slug).toBeNull();
    expect(await relink(false, 2, one.next_after_id!)).toMatchObject({ linked: 1, has_more: false });
    expect((await stored(sibling)).entity_slug).toBe('people/bob-example');
    const cells = parseFactsFence((await snapshot()).page.compiled_truth).facts;
    expect(cells.map(c => c.rowNum)).toEqual([7, 8]);
  }, 120_000);

  test('over-ceiling targets are skipped in preview and apply without starving siblings or later windows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-relink-large-'));
    try {
      const file = join(dir, 'alice.md');
      writeFileSync(file, `---\ntitle: Alice Example\ntype: note\n---\n\n${conversationBody(PAGE_MAX_BYTES + 1024, { seed: 9088 })}`);
      expect(await importFromFile(engine, file, `${SLUG}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
      // Current streamed imports refuse derived person aliases above the ceiling.
      // Model an existing hub promoted to an entity without materializing its body.
      await engine.executeRaw("UPDATE pages SET type='person' WHERE source_id='default' AND slug=$1", [SLUG]);
      const page = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
      expect(page.page.body_storage).toBe('segmented');
      expect(Number(page.page.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
      const id = await seed('Alice Example will stay saved without a page link.');
      const before = await stored(id);
      await importFromContent(engine, 'people/bob-example', '---\ntitle: Bob Example\ntype: person\n---\n\nHealthy sibling.', { noEmbed: true });
      const sibling = await seed('Bob Example will publish despite the oversized sibling.');
      expect(await relink(true, 1)).toMatchObject({ linked: 0, skipped: { page_too_large: 1 }, has_more: true, next_after_id: id });
      expect(await relink(false, 1)).toMatchObject({ linked: 0, skipped: { page_too_large: 1 }, has_more: true, next_after_id: id });
      expect(await stored(id)).toEqual(before);
      expect(await relink(false, 1, id)).toMatchObject({ linked: 1, has_more: false });
      expect((await stored(sibling)).entity_slug).toBe('people/bob-example');
      expect((await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision).toBe(page.revision);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 600_000);

  test('a revision change during segmented materialization refuses the stale plan without moving facts; retry preserves the new body', async () => {
    await importFromContent(engine, SLUG, content(false), { noEmbed: true });
    const id = await seed('Alice Example will verify the revised fixture.');
    const before = await stored(id);
    const original = engine.readSegmentTexts;
    let changed = false;
    engine.readSegmentTexts = async function (...args) {
      if (!changed) { changed = true; await importFromContent(engine, SLUG, content(false, 'NEWER USER CONTENT'), { noEmbed: true }); }
      return original.call(this, ...args);
    };
    let report;
    try { report = await relink(); } finally { engine.readSegmentTexts = original; }
    expect(changed).toBe(true);
    expect(report).toMatchObject({ linked: 0, skipped: { revision_conflict: 1 } });
    expect(await stored(id)).toEqual(before);
    expect((await snapshot()).page.compiled_truth).toContain('NEWER USER CONTENT');
    expect((await relink()).linked).toBe(1);
    expect((await snapshot()).page.compiled_truth).toContain('NEWER USER CONTENT');
  }, 120_000);
});

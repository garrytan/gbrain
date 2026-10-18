/**
 * #6686 (D8): `gbrain repair split-facts` merges a page's two ## Facts fences (one below the timeline sentinel, one a
 * managed writer added above it) into the fence below the sentinel, keeping every row number and fact id; a row number
 * in both fences is listed for a person and never merged. Real journal publication on PGLite, no providers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { FACTS_FENCE_BEGIN, parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { mergeSplitFacts } from '../src/core/repair/split-facts.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-split-facts-'));
const logger = { info() {}, warn() {}, error() {} };
const biography = 'Synthetic biography with preserved prose.';
const history = '## Timeline\n\n- 2026-10-01: Preserved historical event.';
let engine: PGLiteEngine;
const config = { embedding_disabled: true };

const fence = (rows: Array<[number, string, 'world' | 'private']>) => rows.reduce((body, [rowNum, claim, visibility]) =>
  upsertFactRow(body, { rowNum, claim, kind: 'fact', visibility, confidence: 1, notability: 'medium', source: 'fixture' }).body, '');

beforeAll(async () => {
  configureGateway({ ...config, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway(); rmSync(home, { recursive: true, force: true });
});

/** A page split the way a writer before this release left it: the original fence below the sentinel, a second one added above it. */
async function splitPage(sourceId: string, slug: string, below: Array<[number, string, 'world' | 'private']>, above: Array<[number, string, 'world' | 'private']>) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
  await engine.putPage(slug, { type: 'person', title: 'Example', compiled_truth: `${biography}\n\n${fence(above)}`,
    timeline: `${history}\n\n${fence(below)}`, frontmatter: { private_metadata: 'kept' } }, { sourceId });
  const ids = (await engine.insertFacts([...below, ...above].map(([row_num, fact, visibility]) => ({ fact, entity_slug: slug, source_markdown_slug: slug, row_num,
    kind: 'fact' as const, visibility, source: 'fixture', confidence: 1 })), { source_id: sourceId })).ids;
  await registerLocalWriter(engine, 'cli');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return ids;
}
const facts = (sourceId: string, slug: string) => engine.executeRaw<{ id: number; fact: string; row_num: number; expired: boolean }>(
  'SELECT id,fact,row_num,expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num', [sourceId, slug]);

describe('gbrain repair split-facts', () => {
  test('merges the split fences below the sentinel, keeping row numbers and fact ids; a collision page is listed and kept', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const sourceId = `split-${randomUUID().slice(0, 8)}`;
    const slug = 'people/split-example', clash = 'people/clash-example';
    const ids = await splitPage(sourceId, slug, [[7, 'Private historical preference', 'private']], [[8, 'Prefers asynchronous weekly reports', 'world']]);
    await splitPage(sourceId, clash, [[1, 'Original row one', 'world']], [[1, 'Colliding row one', 'world']]);
    const clashBefore = (await engine.readPageSnapshot(clash, { sourceId }))!;

    // Detection: extract_facts names the repair instead of reconciling a split page.
    const extracted = await runExtractFacts(engine, { slugs: [slug], sourceId });
    expect(extracted.warnings.join('\n')).toContain(`gbrain repair split-facts --source ${sourceId}`);

    // Explicit-only: never in --all, the remediation plan or the maintenance cycle.
    expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('split-facts');
    const scope = await resolveRepairScope(engine, sourceId);
    const preview = await (await repairRunner(engine, { apply: false, logger })).run('split-facts', scope, { explicit: true, sourceFlag: sourceId });
    expect(preview.affected).toBe(1);
    expect(preview.residuals).toEqual({ row_collision: 1 });
    expect(preview.listing?.find(entry => entry.item.includes(clash))?.detail).toContain('rows 1 are numbered in both fences');
    // A preview writes nothing.
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.compiled_truth).toContain(FACTS_FENCE_BEGIN);

    const expect_ = preview.apply_command.split('--expect ')[1];
    const applied = await (await repairRunner(engine, { apply: true, logger })).run('split-facts', scope, { explicit: true, sourceFlag: sourceId, expect: expect_ });
    expect(applied.applied).toBe(1);
    const after = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(after.page.compiled_truth).toBe(biography);
    expect(after.page.timeline).toContain(history);
    expect(parseFactsFence(after.page.timeline ?? '').facts.map(row => [row.rowNum, row.claim, row.visibility])).toEqual([
      [7, 'Private historical preference', 'private'], [8, 'Prefers asynchronous weekly reports', 'world']]);
    expect(after.page.frontmatter.private_metadata).toBe('kept');
    expect((await facts(sourceId, slug)).map(row => [Number(row.id), Number(row.row_num), row.expired])).toEqual([[ids[0], 7, false], [ids[1], 8, false]]);
    // The merged page is a lone timeline fence, which extract_facts now reconciles in place.
    expect((await runExtractFacts(engine, { slugs: [slug], sourceId })).warnings).toEqual([]);
    expect((await facts(sourceId, slug)).map(row => Number(row.id))).toEqual(ids);

    // The collision page is untouched.
    expect((await engine.readPageSnapshot(clash, { sourceId }))!.revision).toBe(clashBefore.revision);

    // The hash approved one set: applying it again merges nothing, and a stale hash refuses.
    const fresh = await (await repairRunner(engine, { apply: false, logger })).run('split-facts', scope, { explicit: true, sourceFlag: sourceId });
    expect(fresh.affected).toBe(0);
    await expect((await repairRunner(engine, { apply: true, logger })).run('split-facts', scope, { explicit: true, sourceFlag: sourceId, expect: expect_ }))
      .rejects.toMatchObject({ code: 'preview_changed' });
  }), 120_000);
});

describe('mergeSplitFacts', () => {
  const page = (compiled_truth: string, timeline: string) => ({ slug: 'people/x', type: 'person', title: 'X', frontmatter: {}, compiled_truth, timeline }) as never;
  test('keeps a ## Facts heading that holds more than the fence, and the prose under it', () => {
    const body = `Bio.\n\n## Facts\n\nA note people wrote.\n\n${fence([[2, 'Above', 'world']]).replace('## Facts\n\n', '')}\n\n## Later\n\nMore prose.`;
    const merged = mergeSplitFacts(page(body, `${history}\n\n${fence([[1, 'Below', 'world']])}`), []) as { compiled_truth: string; timeline: string };
    expect(merged.compiled_truth).toBe('Bio.\n\n## Facts\n\nA note people wrote.\n\n## Later\n\nMore prose.');
    expect(parseFactsFence(merged.timeline).facts.map(row => row.claim)).toEqual(['Below', 'Above']);
  });
  test('a page with one fence is not split', () => {
    expect(mergeSplitFacts(page('Bio.', `${history}\n\n${fence([[1, 'Below', 'world']])}`), [])).toBeNull();
    expect(mergeSplitFacts(page(`Bio.\n\n${fence([[1, 'Above', 'world']])}`, history), [])).toBeNull();
  });
});

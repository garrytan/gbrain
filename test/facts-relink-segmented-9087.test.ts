/**
 * #9087 — relink on a fact whose entity page is stored in segments: the write
 * must not fail the run, and the dry run must agree with it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' } as never;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('relink onto a segmented entity page', () => {
  test('dry run and apply both skip it as page_segmented and the run completes', async () => {
    await resetPgliteState(engine);
    await engine.setConfig('decide.slots.conflict.mode', 'off');
    await importFromContent(engine, 'companies/acme-example', '---\ntitle: Acme Example\ntype: company\n---\n\n# Acme Example\n\nA company.\n', { noEmbed: true });
    await engine.executeRaw(
      "UPDATE pages SET body_storage = 'segmented', compiled_truth = NULL, timeline = NULL, body_bytes = 1 WHERE source_id = 'default' AND slug = 'companies/acme-example'");
    await engine.insertFact({ fact: 'Acme Example raised a seed round', kind: 'fact', entity_slug: null, visibility: 'world', source: 'chat 2026-10-01' } as never,
      { source_id: 'default' });

    const run = (dryRun: boolean) => runFactsRelink(engine, { sourceId: 'default', config, llm: false, dryRun })
      .then(report => ({ report, error: null as unknown }), error => ({ report: null, error }));
    const dry = await run(true);
    const applied = await run(false);

    expect(dry.error).toBeNull();
    expect(applied.error).toBeNull();
    expect(dry.report?.linked).toBe(0);
    expect(applied.report?.linked).toBe(0);
    expect(applied.report?.skipped.page_segmented).toBe(1);
    expect(dry.report?.skipped.page_segmented).toBe(1);
    const [fact] = await engine.executeRaw<{ entity_slug: string | null }>('SELECT entity_slug FROM facts');
    expect(fact?.entity_slug).toBeNull();
  });
});

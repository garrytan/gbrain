/**
 * GST-2460: a page that turns stale after extract --stale's pre-flight count is still extracted.
 * The run used to take the wanted-link read time only when the count was non-zero, so a bare-name
 * row from such a page reached replaceWantedLinks without one and the whole run threw.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

test('a page that turns stale after the pre-flight count is extracted and stamped', async () => {
  await engine.putPage('notes/call', { type: 'note', title: 'Call', compiled_truth: 'Call about [[Acme Toolkit]].', timeline: '' });
  const count = engine.countStalePagesForExtraction.bind(engine);
  let first = true;
  engine.countStalePagesForExtraction = async opts => {
    if (!first) return count(opts);
    first = false;
    return 0;
  };
  await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
  expect(await engine.executeRaw('SELECT target_ref, ref_kind FROM wanted_links')).toEqual([{ target_ref: 'acme-toolkit', ref_kind: 'name' }]);
  const [page] = await engine.executeRaw<{ stamped: boolean }>("SELECT links_extracted_at IS NOT NULL AS stamped FROM pages WHERE slug = 'notes/call'");
  expect(page!.stamped).toBe(true);
}, 120_000);

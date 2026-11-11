import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';

describe('bare-name frontmatter ref equal to a top-level slug', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);

  test('the origin settles after one sweep instead of staying stale', async () => {
    await engine.putPage('acme-toolkit', { type: 'note', title: 'Toolkit', compiled_truth: 'Top level.', timeline: '' });
    await engine.putPage('people/founder-example', { type: 'person', title: 'Founder', compiled_truth: 'Founder.', timeline: '',
      frontmatter: { founded: ['acme-toolkit'] } });
    const opts = { dryRun: false, jsonMode: true, quiet: true, catchUp: true, includeFrontmatter: true };
    await extractStaleFromDB(engine, opts);
    await extractStaleFromDB(engine, opts);
    const stale = await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS });
    const rows = await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM wanted_links WHERE checked_at = '-infinity'");
    expect({ stale, infinity: rows[0]!.n }).toEqual({ stale: 0, infinity: 0 });
  }, 120_000);
});

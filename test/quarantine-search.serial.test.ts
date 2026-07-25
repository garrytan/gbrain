import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { stampContentFlags } from '../src/core/search/hybrid.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('quarantine and content warning retrieval contract', () => {
  test('quarantines junk without deleting it, then recovers on clean re-import', async () => {
    const junk = [
      '---',
      'title: Just a moment...',
      '---',
      '',
      'Just a moment... /cdn-cgi/challenge-platform Cloudflare Ray ID: abc',
    ].join('\n');
    const quarantined = await importFromContent(engine, 'fixtures/quarantine', junk, {
      noEmbed: true,
    });
    expect(quarantined.quarantined).toBe(true);
    expect(quarantined.chunks).toBe(0);
    const stored = await engine.getPage('fixtures/quarantine');
    expect(stored?.frontmatter.quarantine).toBeTruthy();
    expect(await engine.searchKeyword('Cloudflare', { limit: 10 })).toHaveLength(0);

    const clean = [
      '---',
      'title: Browser challenge research',
      '---',
      '',
      'Browser challenge research explains reliable scraper diagnostics.',
    ].join('\n');
    const recovered = await importFromContent(engine, 'fixtures/quarantine', clean, {
      noEmbed: true,
    });
    expect(recovered.quarantined).toBeUndefined();
    expect(recovered.chunks).toBeGreaterThan(0);
    expect((await engine.getPage('fixtures/quarantine'))?.frontmatter.quarantine).toBeUndefined();
  });

  test('flagged pages stay searchable and carry a warning after stamping', async () => {
    await engine.setConfig('content_sanity.bytes_warn', '20');
    await engine.setConfig('content_sanity.bytes_block', '5000');
    await engine.setConfig('content_sanity.max_markup_ratio', '0.1');
    const markdown = [
      '---',
      'title: Delivery Matrix',
      '---',
      '',
      '| Project | Owner | Status |',
      '| --- | --- | --- |',
      '| Aurora | Alice | delayed |',
      '| Borealis | Bob | blocked |',
    ].join('\n');
    const result = await importFromContent(engine, 'fixtures/flagged', markdown, {
      noEmbed: true,
    });
    expect(result.flagged).toBe(true);
    expect(result.flag_reason).toBe('markup_heavy');

    const hits = await engine.searchKeyword('Aurora', { limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    await stampContentFlags(engine, hits);
    expect(hits[0]?.content_flag?.reason).toBe('markup_heavy');
  });
});

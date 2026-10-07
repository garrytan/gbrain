import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { isEmbedSkipped } from '../../src/core/embed-skip.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const suite = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;

suite('local import size-gate recovery on Postgres', () => {
  beforeAll(async () => { engine = await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('unchanged source rebuilds chunks after a threshold increase and removes them after a decrease', async () => {
    const slug = 'test/size-gate-threshold';
    const content = '---\ntitle: Garden planning\ntype: note\n---\n\n' + 'Useful garden planning observations. '.repeat(100);
    await engine.setConfig('content_sanity.bytes_block', '1000');
    try {
      await importFromContent(engine, slug, content, { noEmbed: true, remote: false });
      expect(isEmbedSkipped((await engine.getPage(slug))!.frontmatter)).toBe(true);
      expect(await engine.getChunks(slug)).toHaveLength(0);
      await engine.setConfig('content_sanity.bytes_block', '10000');
      expect((await importFromContent(engine, slug, content, { noEmbed: true, remote: false })).status).toBe('imported');
      expect(isEmbedSkipped((await engine.getPage(slug))!.frontmatter)).toBe(false);
      expect((await engine.getChunks(slug)).length).toBeGreaterThan(0);
      expect((await importFromContent(engine, slug, content, { noEmbed: true, remote: false })).status).toBe('skipped');
      await engine.setConfig('content_sanity.bytes_block', '1000');
      expect((await importFromContent(engine, slug, content, { noEmbed: true, remote: false })).status).toBe('imported');
      expect(await engine.getChunks(slug)).toHaveLength(0);
    } finally {
      await engine.unsetConfig('content_sanity.bytes_block');
    }
  });

  test('a trusted exported stale marker does not suppress clean content', async () => {
    const slug = 'test/size-gate-export';
    const content = '---\ntitle: Garden notes\ntype: note\nembed_skip:\n  reason: oversized\n---\n\nA useful short note about garden planning.';
    expect((await importFromContent(engine, slug, content, { noEmbed: true, remote: false })).status).toBe('imported');
    expect(isEmbedSkipped((await engine.getPage(slug))!.frontmatter)).toBe(false);
    expect((await engine.getChunks(slug)).length).toBeGreaterThan(0);
  });
});

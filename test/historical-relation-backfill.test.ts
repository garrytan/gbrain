import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract-stale.ts';
import { runByMentionCore } from '../src/commands/extract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  extractEntityRefs,
  extractFrontmatterLinks,
  extractPageLinks,
  makeResolver,
} from '../src/core/link-extraction.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('historical relation backfill — extraction coverage', () => {
  test('recognizes custom-directory and bare wikilinks without enabling global basename matching', async () => {
    const refs = extractEntityRefs(
      'See [[reference/source-card]] and [[local-target\\|Local Target]].',
    );

    expect(refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'reference/source-card' }),
      expect.objectContaining({ slug: 'local-target' }),
    ]));

    const resolver = {
      async resolve() { return null; },
      async resolveLocalExact(slug: string) {
        return slug === 'notes/local-target'
          ? { slug, sourceId: 'vault', resolutionType: 'unqualified' as const }
          : null;
      },
      async resolveExact() { return null; },
    };
    const extracted = await extractPageLinks(
      'notes/history',
      'See [[local-target]].',
      {},
      'note',
      resolver,
    );

    expect(extracted.candidates).toEqual([
      expect.objectContaining({
        targetSlug: 'notes/local-target',
        targetSourceId: 'vault',
        linkSource: 'markdown',
      }),
    ]);
  });

  test('unwraps wikilinks stored in frontmatter before exact resolution', async () => {
    const seen: string[] = [];
    const result = await extractFrontmatterLinks(
      'notes/history',
      'note',
      { related: ['[[concepts/frontmatter-target|Frontmatter Target]]'] },
      {
        async resolve(name: string) {
          seen.push(name);
          return name === 'concepts/frontmatter-target' ? name : null;
        },
      },
    );

    expect(seen).toEqual(['concepts/frontmatter-target']);
    expect(result.unresolved).toEqual([]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        fromSlug: 'notes/history',
        targetSlug: 'concepts/frontmatter-target',
        linkType: 'related_to',
        linkSource: 'frontmatter',
      }),
    ]);
  });
});

describe('historical relation backfill — PGLite end to end', () => {
  test('backfills explicit, frontmatter, and entity relations inside the selected Source and is idempotent', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config, created_at)
       VALUES ('vault', 'vault', '{}'::jsonb, NOW())`,
    );
    await engine.executeRaw(
      `INSERT INTO pages
         (source_id, slug, type, title, compiled_truth, timeline, frontmatter, updated_at, created_at)
       VALUES
         ('vault', 'notes/history', 'note', 'History',
          'See [[concepts/wiki-target]], [[local-target]], [Markdown](../projects/markdown-target.md), and [Reference](../reference/source-card.md). 张三参与了这个项目。',
          '', '{"related":["[[concepts/frontmatter-target|Frontmatter Target]]"]}'::jsonb, NOW(), NOW()),
         ('vault', 'concepts/wiki-target', 'concept', 'Wiki Target', '', '', '{}'::jsonb, NOW(), NOW()),
         ('vault', 'notes/local-target', 'note', 'Local Target', '', '', '{}'::jsonb, NOW(), NOW()),
         ('vault', 'projects/markdown-target', 'project', 'Markdown Target', '', '', '{}'::jsonb, NOW(), NOW()),
         ('vault', 'reference/source-card', 'note', 'Source Card', '', '', '{}'::jsonb, NOW(), NOW()),
         ('vault', 'concepts/frontmatter-target', 'concept', 'Frontmatter Target', '', '', '{}'::jsonb, NOW(), NOW()),
         ('vault', 'people/zhang-san', 'person', '张三', '', '', '{}'::jsonb, NOW(), NOW()),
         ('default', 'concepts/wiki-target', 'concept', 'Wrong Source Duplicate', '', '', '{}'::jsonb, NOW(), NOW())`,
    );
    const first = await extractStaleFromDB(engine, {
      dryRun: false,
      jsonMode: true,
      includeFrontmatter: true,
      sourceIdFilter: 'vault',
      catchUp: true,
    });
    const mentions = await runByMentionCore(engine, {
      sourceIdFilter: 'vault',
      quiet: true,
    });

    expect(first.pagesProcessed).toBe(7);
    expect(first.staleRemaining).toBe(0);
    expect(mentions.created).toBe(0);

    const rows = await engine.executeRaw<{
      to_slug: string;
      to_source_id: string;
      link_source: string;
    }>(
      `SELECT t.slug AS to_slug, t.source_id AS to_source_id, l.link_source
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
        WHERE f.source_id = 'vault' AND f.slug = 'notes/history'
        ORDER BY t.slug, l.link_source`,
    );

    expect(rows).toEqual(expect.arrayContaining([
      { to_slug: 'concepts/frontmatter-target', to_source_id: 'vault', link_source: 'frontmatter' },
      { to_slug: 'concepts/wiki-target', to_source_id: 'vault', link_source: 'markdown' },
      { to_slug: 'notes/local-target', to_source_id: 'vault', link_source: 'markdown' },
      { to_slug: 'people/zhang-san', to_source_id: 'vault', link_source: 'mentions' },
      { to_slug: 'projects/markdown-target', to_source_id: 'vault', link_source: 'markdown' },
      { to_slug: 'reference/source-card', to_source_id: 'vault', link_source: 'markdown' },
    ]));

    const second = await extractStaleFromDB(engine, {
      dryRun: false,
      jsonMode: true,
      includeFrontmatter: true,
      sourceIdFilter: 'vault',
      catchUp: true,
    });
    const secondMentions = await runByMentionCore(engine, {
      sourceIdFilter: 'vault',
      quiet: true,
    });
    expect(second.pagesProcessed).toBe(0);
    expect(second.linksCreated).toBe(0);
    expect(secondMentions.created).toBe(0);
    expect(secondMentions.historicalPages).toBe(0);
  }, 60_000);
});

describe('historical relation backfill — fail closed resume', () => {
  test('does not stamp pages fresh when a relation batch fails, then succeeds on retry', async () => {
    await engine.executeRaw(
      `INSERT INTO pages
         (source_id, slug, type, title, compiled_truth, timeline, frontmatter, updated_at, created_at)
       VALUES
         ('default', 'notes/retry-source', 'note', 'Retry Source', 'See [[concepts/retry-target]].', '', '{}'::jsonb, NOW(), NOW()),
         ('default', 'concepts/retry-target', 'concept', 'Retry Target', '', '', '{}'::jsonb, NOW(), NOW())`,
    );

    const originalAddLinksBatch = engine.addLinksBatch;
    engine.addLinksBatch = async () => {
      throw new Error('injected relation write failure');
    };

    const writeError=await extractStaleFromDB(engine, {
      dryRun: false,
      jsonMode: true,
      includeFrontmatter: true,
      catchUp: true,
      quiet: true,
    }).catch(error=>error);
    expect(writeError.message).toBe('injected relation write failure');

    expect(await engine.countStalePagesForExtraction()).toBe(2);
    engine.addLinksBatch = originalAddLinksBatch;

    const retry = await extractStaleFromDB(engine, {
      dryRun: false,
      jsonMode: true,
      includeFrontmatter: true,
      catchUp: true,
      quiet: true,
    });
    expect(retry.pagesProcessed).toBe(2);
    expect(retry.linksCreated).toBe(1);
    expect(await engine.countStalePagesForExtraction()).toBe(0);
  }, 60_000);
});

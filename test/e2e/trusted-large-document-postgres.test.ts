/**
 * Behavioral Postgres parity for Trusted Large Document Mode.
 * Run with DATABASE_URL pointing at an isolated test database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { importTrustedStructuredContent, type ParentSectionInput } from '../../src/core/import-file.ts';
import { isEmbedSkipped } from '../../src/core/embed-skip.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
let engine: PostgresEngine;
const slug = 'tests/trusted-large-document-postgres';

function sections(): ParentSectionInput[] {
  return Array.from({ length: 120 }, (_, index) => ({
    title: `Chapter ${index + 1}`,
    locator: `page ${index + 1}`,
    text: `section-${index}-` + 'p'.repeat(5_000),
  }));
}

function content(parentSections: ParentSectionInput[]): string {
  return [
    '---',
    'type: source',
    'title: "Postgres large document"',
    'document_structured: true',
    '---',
    '',
    '# Postgres large document',
    '',
    ...parentSections.flatMap(section => [`## ${section.title}`, section.text, '']),
  ].join('\n');
}

describe.skipIf(skip)('Trusted Large Document Mode - Postgres parity', () => {
  beforeAll(async () => {
    configureGateway({embedding_model:'openai:text-embedding-3-large',embedding_dimensions:1536,env:{}});
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl! });
    await engine.initSchema();
    await engine.executeRaw(`DELETE FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]);
  });

  afterAll(async () => {
    if (!engine) return;
    await engine.executeRaw(`DELETE FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]);
    await engine.disconnect();
    resetGateway();
  });

  test('stores a >500KB structured page and its section chunks without embed_skip', async () => {
    const parentSections = sections();
    const result = await importTrustedStructuredContent(engine, slug, content(parentSections), {
      noEmbed: true,
      sourceId: 'default',
      parentSections,
    });
    expect(result.status).toBe('imported');
    expect(result.largeDocument?.phase).toBe('completed');
    expect(result.largeDocument?.chunksTotal).toBeGreaterThanOrEqual(parentSections.length);
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    expect(isEmbedSkipped(page!.frontmatter)).toBe(false);
    const chunks = await engine.getChunks(slug, { sourceId: 'default' });
    expect(chunks).toHaveLength(result.largeDocument!.chunksTotal);
    expect(chunks[0].chunk_text).toContain('Locator: page 1');
    const stored=chunks.map(chunk=>chunk.chunk_text).join('\n');
    for(const section of parentSections)expect(stored).toContain(`Locator: ${section.locator}\n`);
    expect(page!.compiled_truth).toContain(parentSections.at(-1)!.text);
  });
});

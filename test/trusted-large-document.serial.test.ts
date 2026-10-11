import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let embedCalls: string[][] = [];
let failOnCall: number | null = null;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    embedCalls.push([...texts]);
    if (failOnCall !== null && embedCalls.length === failOnCall) {
      throw new Error('simulated embedding outage');
    }
    return texts.map(() => new Float32Array(1536));
  },
  embedMultimodal: async () => [],
  embedQuery: async () => new Float32Array(1536),
  getEmbeddingDimensions: () => 1536,
}));

type PGLiteEngineType = import('../src/core/pglite-engine.ts').PGLiteEngine;
type ParentSectionInput = import('../src/core/import-file.ts').ParentSectionInput;

let engine: PGLiteEngineType;
let importFromContent: typeof import('../src/core/import-file.ts').importFromContent;
let importTrustedStructuredContent: typeof import('../src/core/import-file.ts').importTrustedStructuredContent;
let importStructuredDocument: typeof import('../src/core/document/document-import.ts').importStructuredDocument;
let isEmbedSkipped: typeof import('../src/core/embed-skip.ts').isEmbedSkipped;

beforeAll(async () => {
  const [{ PGLiteEngine }, importFile, embedSkip, documentImport] = await Promise.all([
    import('../src/core/pglite-engine.ts'),
    import('../src/core/import-file.ts'),
    import('../src/core/embed-skip.ts'),
    import('../src/core/document/document-import.ts'),
  ]);
  importFromContent = importFile.importFromContent;
  importTrustedStructuredContent = importFile.importTrustedStructuredContent;
  isEmbedSkipped = embedSkip.isEmbedSkipped;
  importStructuredDocument = documentImport.importStructuredDocument;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  embedCalls = [];
  failOnCall = null;
});

async function isolated<T>(fn: () => Promise<T>): Promise<T> {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'trusted-large-home-'));
  const isolatedAudit = mkdtempSync(join(tmpdir(), 'trusted-large-audit-'));
  try {
    return await withEnv({
      PMBRAIN_HOME: undefined,
      GBRAIN_HOME: isolatedHome,
      GBRAIN_AUDIT_DIR: isolatedAudit,
    }, fn);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(isolatedAudit, { recursive: true, force: true });
  }
}

function sections(count: number, charsPerSection: number, changed = -1): ParentSectionInput[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Chapter ${index + 1} > Topic ${index + 1}`,
    locator: `page ${index + 1}`,
    text: `${index === changed ? 'changed' : 'stable'}-${index}-` + 'a'.repeat(charsPerSection),
  }));
}

function markdown(title: string, parentSections: ParentSectionInput[]): string {
  return [
    '---',
    'type: source',
    `title: ${JSON.stringify(title)}`,
    'document_structured: true',
    '---',
    '',
    `# ${title}`,
    '',
    ...parentSections.flatMap(section => [`## ${section.title}`, '', section.text, '']),
  ].join('\n');
}

async function trustedImport(slug: string, title: string, parentSections: ParentSectionInput[]) {
  return isolated(() => importTrustedStructuredContent(
    engine,
    slug,
    markdown(title, parentSections),
    { parentSections, sourceId: 'default', filename: title },
  ));
}

async function embeddedCount(slug: string): Promise<number> {
  const chunks = await engine.getChunks(slug);
  return (await engine.getEmbeddingsByChunkIds(chunks.map(chunk => chunk.id))).size;
}

describe('Trusted Large Document Mode - PGLite behavior', () => {
  test('the local StructuredDocument importer is the trusted entry point', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'trusted-large-source-'));
    const sourcePath = join(tempDir, 'large.docx');
    writeFileSync(sourcePath, 'local parser fixture');
    try {
      const documentSections = sections(110, 5_000).map((section, index) => ({
        id: `section-${index}`,
        type: 'paragraph' as const,
        heading: section.title,
        text: section.text,
        locator: { page: index + 1, headingPath: section.title.split(' > ') },
      }));
      const result = await isolated(() => importStructuredDocument(engine, {
        title: 'Local structured Word',
        format: 'docx',
        sections: documentSections,
        metadata: {
          parser: 'test-local-docx',
          local: true,
          structured: true,
          tableCount: 0,
          imageCount: 0,
          ocrUsed: false,
        },
      }, sourcePath, 'docs/local-structured.docx'));
      expect(result.status).toBe('imported');
      expect(result.largeDocument?.mode).toBe('trusted_structured');
      expect(isEmbedSkipped((await engine.getPage(result.slug))!.frontmatter)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('small structured document keeps the pre-existing single-call behavior', async () => {
    const result = await trustedImport('docs/small', 'Small document', sections(20, 2_000));
    expect(result.status).toBe('imported');
    expect(result.largeDocument).toBeUndefined();
    expect(embedCalls).toHaveLength(1);
    expect((await engine.getChunks('docs/small')).length).toBeGreaterThan(0);
  });

  test.each([
    ['700KB', 140, 5_000],
    ['1MB', 200, 5_000],
    ['3MB', 600, 5_000],
  ])('%s structured document lands, chunks and embeds without embed_skip', async (_label, count, chars) => {
    const slug = `docs/large-${count}`;
    const result = await trustedImport(slug, `Large ${count}`, sections(count, chars));
    expect(result.status).toBe('imported');
    expect(result.largeDocument?.phase).toBe('completed');
    expect(result.largeDocument?.chunksTotal).toBeGreaterThan(0);
    expect(result.largeDocument?.embedded).toBe(result.largeDocument?.chunksTotal);
    expect(embedCalls.every(call => call.length <= 100)).toBe(true);
    const page = await engine.getPage(slug);
    expect(page).not.toBeNull();
    expect(isEmbedSkipped(page!.frontmatter)).toBe(false);
    const chunks = await engine.getChunks(slug);
    expect(chunks.length).toBe(result.largeDocument!.chunksTotal);
    expect(await embeddedCount(slug)).toBe(chunks.length);
  }, 60_000);

  test('ordinary Markdown and spoofed trusted flag remain protected above 500KB', async () => {
    const parentSections = sections(110, 5_000);
    const result = await isolated(() => importFromContent(
      engine,
      'docs/untrusted',
      markdown('Untrusted markdown', parentSections),
      {
        parentSections,
        trustedStructuredImport: true,
        remote: true,
      } as Parameters<typeof importFromContent>[3] & { trustedStructuredImport: boolean },
    ));
    expect(result.status).toBe('imported');
    expect(result.largeDocument).toBeUndefined();
    expect(embedCalls).toHaveLength(0);
    const page = await engine.getPage('docs/untrusted');
    expect(isEmbedSkipped(page!.frontmatter)).toBe(true);
    expect(await engine.getChunks('docs/untrusted')).toHaveLength(0);
  });

  test('child chunks preserve document, section and locator context', async () => {
    const result = await trustedImport('docs/context', 'Sichuan Plan', sections(110, 5_000));
    expect(result.status).toBe('imported');
    const [first] = await engine.getChunks('docs/context');
    expect(first.chunk_text).toContain('Parent document: Sichuan Plan');
    expect(first.chunk_text).toContain('Section: Chapter 1 > Topic 1');
    expect(first.chunk_text).toContain('Locator: page 1');
  });

  test('large table chunks repeat column headers on every child chunk', async () => {
    const parentSections: ParentSectionInput[] = [{
      title: 'Inventory table',
      locator: 'Sheet: Sichuan > Table 2',
      chunkContext: 'Table columns: City | Inventory | Date',
      text: 'Chengdu | 1200 | 2026-08-09\n'.repeat(18_000),
    }];
    const result = await trustedImport('docs/large-table', 'Inventory workbook', parentSections);
    expect(result.largeDocument?.chunksTotal).toBeGreaterThan(1);
    const chunks = await engine.getChunks('docs/large-table');
    expect(chunks.every(chunk => chunk.chunk_text.includes('Table columns: City | Inventory | Date'))).toBe(true);
  });

  test('resume embeds only the 40 missing chunks after 60 of 100 are present', async () => {
    const parentSections = sections(100, 5_200);
    const first = await trustedImport('docs/resume', 'Resume document', parentSections);
    expect(first.largeDocument?.chunksTotal).toBe(100);
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = NULL, model = NULL, embedded_at = NULL
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')
         AND chunk_index >= 60`,
      ['docs/resume'],
    );
    embedCalls = [];
    const resumed = await trustedImport('docs/resume', 'Resume document', parentSections);
    expect(resumed.status).toBe('imported');
    expect(resumed.largeDocument?.reused).toBe(60);
    expect(embedCalls.flat()).toHaveLength(40);
    expect(await embeddedCount('docs/resume')).toBe(100);
  });

  test('changing one section reuses the other 99 chunks', async () => {
    await trustedImport('docs/incremental', 'Incremental document', sections(100, 5_200));
    embedCalls = [];
    const updated = await trustedImport('docs/incremental', 'Incremental document', sections(100, 5_200, 42));
    expect(updated.status).toBe('imported');
    expect(updated.largeDocument?.reused).toBe(99);
    expect(embedCalls.flat()).toHaveLength(1);
  });

  test('embedding failure preserves successful batches and retry resumes', async () => {
    const parentSections = sections(250, 2_200);
    failOnCall = 2;
    const partial = await trustedImport('docs/partial', 'Partial document', parentSections);
    expect(partial.status).toBe('partial');
    expect(partial.largeDocument?.phase).toBe('partial');
    expect(partial.largeDocument?.embedded).toBe(100);
    expect(partial.largeDocument?.pending).toBe(150);
    expect(await embeddedCount('docs/partial')).toBe(100);

    embedCalls = [];
    failOnCall = null;
    const resumed = await trustedImport('docs/partial', 'Partial document', parentSections);
    expect(resumed.status).toBe('imported');
    expect(resumed.largeDocument?.reused).toBe(100);
    expect(embedCalls.flat()).toHaveLength(150);
    expect(await embeddedCount('docs/partial')).toBe(250);
  });
});
